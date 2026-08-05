// Raw TCP collector for meters that push CJ/T 188 frames straight down a socket.
//
// These devices speak no application protocol at all: they open a connection and
// write the frame. There is no HTTP request to parse, which is why an Express
// server answers them with 400 Bad Request and loses the data.
//
// Everything received is logged raw, whether or not it decodes. A frame type we
// do not recognise is still evidence about the device, and dropping it silently
// is how an integration ends up being debugged with a packet capture.

import { parseUplink, FrameError } from './lib/cjt188.js';
import {
  decodeCat1Frame,
  decodePayload,
  decodeReadResponse,
  decodeWriteResponse,
  encodeReportAck,
  isCat1Frame,
  CAT1_REPORT_CONTROL,
  READ_RESPONSE_CONTROL,
  WRITE_RESPONSE_CONTROL,
} from './lib/cat1.js';
import { FrameSplitter, peekEnvelope } from './lib/framing.js';
import {
  formatMeterReading,
  formatCat1Reading,
  formatReadResponse,
  formatTcpEvent,
  formatUnrecognisedFrame,
  formatUnframedBytes,
} from './lib/format.js';

// Battery devices connect, push, and vanish without closing cleanly. Without a
// timeout their sockets accumulate until the process runs out of handles.
const IDLE_TIMEOUT_MS = 120_000;

/**
 * Gap between the acknowledgement and the command that follows it.
 *
 * Writing both in the same tick lets Nagle coalesce them into a single TCP
 * segment, so the meter sees the ack and the command arrive as one delivery --
 * which no real server would produce, since a queue lookup sits between them.
 * This meter accepts a byte-identical command frame from the vendor's server
 * and refuses ours with 0BH, and after ruling out every field in the frame,
 * arrival timing is the last difference left on our side of the wire.
 */
const COMMAND_DELAY_MS = Number(process.env.COMMAND_DELAY_MS ?? 300);

/**
 * Whether to acknowledge a report before sending a queued command.
 *
 * Section 3 says to: acknowledge with the power-off flag at 00H so the meter
 * "will extend the waiting time to wait for instructions". But this meter
 * answers that acknowledgement with an 84H frame carrying 0BH -- and once the
 * command was delayed by 300ms it became clear that error arrives *before* the
 * command is even sent. It is the ack being refused, not the command. With the
 * flag at AFH the meter says nothing at all.
 *
 * So when something is queued we now skip the acknowledgement, send the command
 * on its own, and acknowledge with AFH after the reply. Set ACK_BEFORE_COMMAND=1
 * to restore the documented order without a redeploy.
 */
const ACK_BEFORE_COMMAND = process.env.ACK_BEFORE_COMMAND === '1';

export function createMeterConnectionHandler(
  store,
  log = console,
  {
    commands = null,
    reconciler = null,
    commandDelayMs = COMMAND_DELAY_MS,
    ackBeforeCommand = ACK_BEFORE_COMMAND,
  } = {},
) {
  return function handleConnection(socket) {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    const splitter = new FrameSplitter();
    let frames = 0;
    let bytes = 0;

    // Held so the exchange can be closed off with a power-off ack once the
    // meter has answered the last command.
    let openReport = null;

    log.info?.(formatTcpEvent('open', { peer }));
    socket.setTimeout(IDLE_TIMEOUT_MS);
    // Keep the ack in its own segment rather than letting it wait for company.
    socket.setNoDelay?.(true);

    const handle = (event) => {
      if (event.type === 'unframed') {
        log.warn?.(formatUnframedBytes(event.bytes, { peer }));
        store.recordFailure('tcp', 'unframed_bytes', event.bytes.toString('hex').toUpperCase());
        return;
      }

      frames++;
      const frame = event.bytes;
      const hex = frame.toString('hex').toUpperCase();

      // Two protocols share the 68H…16H envelope. They disagree about byte 10,
      // so the dispatch has to happen before either decoder sees the frame.
      const decode = isCat1Frame(frame) ? decodeCat1 : decodeCjt188;
      try {
        decode(frame, hex);
      } catch (err) {
        if (!(err instanceof FrameError)) throw err;
        log.warn?.(formatUnrecognisedFrame(frame, peekEnvelope(frame), `${err.code}: ${err.message}`, { peer }));
        store.recordFailure('tcp', `${err.code}: ${err.message}`, hex);
      }
    };

    const decodeCat1 = (frame, hex) => {
      const envelope = decodeCat1Frame(frame);

      if (envelope.control === WRITE_RESPONSE_CONTROL) return handleWriteResponse(frame, hex);
      if (envelope.control === READ_RESPONSE_CONTROL) return handleReadResponse(frame, hex);
      if (envelope.control !== CAT1_REPORT_CONTROL) {
        throw new FrameError('unexpected_control', `control ${envelope.controlName} is not handled here`);
      }

      // The payload is decoded before anything is written back, because the
      // reconciler decides what to send from the clock and table type code
      // inside it. A packet we cannot read must still be answered -- otherwise
      // an unsupported report costs battery -- so a decode failure is held and
      // rethrown once the meter has been dealt with.
      let reading = null;
      let decodeError = null;
      try {
        reading = { ...envelope, payload: decodePayload(envelope, frame) };
      } catch (err) {
        if (!(err instanceof FrameError)) throw err;
        decodeError = err;
      }

      // The policy outranks an explicitly queued command.
      //
      // A meter whose clock or resolution is wrong is misreporting, and every
      // contact spent on something else is another day of readings that have to
      // be corrected later. So bring the meter to a known-good state first, then
      // do what was asked of it.
      //
      // A hand-issued command is not starved by this. The policy runs out of
      // work -- each rung gives up after `maxAttempts` and stops claiming -- and
      // `finishExchange` sends the queue's next command in the same contact once
      // a policy command succeeds. The exception is `AA00`, which never replies,
      // so a contact spent on a clock write ends there.
      const pending = reconcile(reading) ?? commands?.nextFor(envelope.address) ?? null;

      if (!pending) {
        sendAck(envelope, { powerOff: true });
      } else if (ackBeforeCommand) {
        sendAck(envelope, { powerOff: false });
        scheduleCommand(pending, envelope);
      } else {
        // No stay-awake ack -- that is the frame the meter refuses. The command
        // goes on its own and the exchange is closed off once it replies.
        openReport = envelope;
        sendCommand(pending, envelope);
      }

      if (decodeError) throw decodeError;

      const { duplicate } = store.saveCat1Reading(reading, hex);
      log.info?.(formatCat1Reading(reading, hex, { duplicate, source: 'tcp' }));
    };

    /**
     * Ask the policy whether this report justifies a command, and queue it if
     * so. Reconciler commands go through the same queue as hand-issued ones so
     * they get an instruction number, show up in `GET /api/v1/commands`, and are
     * completed by the reply handler like anything else.
     */
    const reconcile = (reading) => {
      if (!reconciler || !commands || !reading) return null;
      const { command, notes } = reconciler.decide(reading);
      for (const note of notes) {
        log.warn?.(formatTcpEvent('reconcile held', { peer, detail: `${reading.address} ${note}` }));
      }
      if (!command) return null;
      log.info?.(
        formatTcpEvent('reconcile', { peer, detail: `${reading.address} -> ${command.type}: ${command.reason}` }),
      );
      return commands.enqueue(reading.address, command);
    };

    const sendAck = (envelope, { powerOff }) => {
      if (!socket.writable) return;
      const ack = encodeReportAck(envelope, { powerOff });
      socket.write(ack, (err) => {
        if (err) log.warn?.(formatTcpEvent('ack failed', { peer, detail: err.message }));
      });
      log.info?.(
        formatTcpEvent('ack', {
          peer,
          detail: `${ack.toString('hex').toUpperCase()}  (${powerOff ? 'power off' : 'stay awake, command follows'})`,
        }),
      );
    };

    /** Let the acknowledgement land on its own before the command follows. */
    const scheduleCommand = (cmd, envelope) => {
      if (commandDelayMs <= 0) return sendCommand(cmd, envelope);
      const timer = setTimeout(() => sendCommand(cmd, envelope), commandDelayMs);
      timer.unref?.();
      socket.once('close', () => clearTimeout(timer));
    };

    const sendCommand = (cmd, envelope) => {
      if (!socket.writable) return;
      let bytes;
      try {
        bytes = cmd.build(cmd.instructionNumber, envelope);
      } catch (err) {
        log.error?.(`command #${cmd.id} (${cmd.type}) could not be built:`, err);
        commands.complete(cmd, { success: false, detail: `build_failed: ${err.message}` });
        return;
      }
      socket.write(bytes, (err) => {
        if (err) {
          log.warn?.(formatTcpEvent('command failed', { peer, detail: err.message }));
          commands.complete(cmd, { success: false, detail: `write_failed: ${err.message}` });
        }
      });
      commands.markSent(cmd);
      log.info?.(
        formatTcpEvent('command', {
          peer,
          detail: `#${cmd.id} ${cmd.type} instr ${cmd.instructionNumber}  ${bytes.toString('hex').toUpperCase()}`,
        }),
      );
    };

    /**
     * Once the meter has answered, either send the next queued command while it
     * is still awake, or tell it to sleep. Without this it sits with the radio
     * on until the idle timeout fires.
     *
     * Nothing follows a refusal. Observed 2026-08-04: a refused AC12 clock write
     * was followed by a valve command that had succeeded on its own minutes
     * earlier, and it was refused too. This firmware appears to abandon the
     * session on the first error, so chaining past one only costs battery and
     * marks good commands failed.
     */
    const finishExchange = (ok) => {
      if (!openReport) return;
      const next = ok ? commands?.nextFor(openReport.address) ?? null : null;
      if (next) return sendCommand(next, openReport);
      sendAck(openReport, { powerOff: true });
      openReport = null;
    };

    const handleWriteResponse = (frame, hex) => {
      const response = decodeWriteResponse(frame);
      const cmd = commands?.findSentByInstruction(response.address, response.instructionNumber);
      const outcome = response.success ? 'ok' : `error code ${response.errorCode}`;

      if (cmd) {
        commands.complete(cmd, {
          success: response.success,
          detail: response.success ? null : `meter returned ${response.errorCode}`,
        });
      }

      log.info?.(
        formatTcpEvent('command reply', {
          peer,
          detail:
            `${response.address} instr ${response.instructionNumber} -> ${outcome}` +
            `${cmd ? ` (command #${cmd.id})` : ' (no matching command)'}` +
            `   meter clock now ${response.meterClock.iso ?? response.meterClock.raw}`,
        }),
      );
      log.info?.(formatTcpEvent('command reply raw', { peer, detail: hex }));
      finishExchange(response.success);
    };

    /**
     * A read response carries no success byte -- the data field *is* the answer,
     * so a well-formed 81H frame means the read succeeded.
     */
    const handleReadResponse = (frame, hex) => {
      const response = decodeReadResponse(frame);
      const cmd = commands?.findSentByInstruction(response.address, response.instructionNumber);
      if (cmd) commands.complete(cmd, { success: true, detail: 'parameters returned' });
      log.info?.(formatReadResponse(response, hex, { peer }));
      finishExchange(true);
    };

    const decodeCjt188 = (frame, hex) => {
      const reading = parseUplink(frame);
      if (reading.direction !== 'uplink') {
        throw new FrameError('not_uplink', 'control code D7 marks this as a platform-issued frame');
      }
      const { duplicate } = store.saveMeterReading(reading, hex);
      log.info?.(formatMeterReading(reading, hex, { duplicate, encoding: 'binary', source: 'tcp' }));
    };

    socket.on('data', (chunk) => {
      bytes += chunk.length;
      try {
        for (const event of splitter.push(chunk)) handle(event);
      } catch (err) {
        log.error?.(`tcp ${peer}: handler failed:`, err);
        socket.destroy();
      }
    });

    socket.on('timeout', () => {
      log.info?.(formatTcpEvent('idle timeout', { peer }));
      socket.destroy();
    });

    socket.on('error', (err) => {
      // Devices on cellular links reset connections routinely; not worth a stack.
      log.warn?.(formatTcpEvent('error', { peer, detail: err.message }));
    });

    socket.on('close', () => {
      for (const event of splitter.flush()) {
        try {
          handle(event);
        } catch {
          /* already logged */
        }
      }
      log.info?.(formatTcpEvent('close', { peer, detail: `${bytes} bytes, ${frames} frame(s)` }));
    });
  };
}
