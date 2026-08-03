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

export function createMeterConnectionHandler(store, log = console, { commands = null } = {}) {
  return function handleConnection(socket) {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    const splitter = new FrameSplitter();
    let frames = 0;
    let bytes = 0;

    log.info?.(formatTcpEvent('open', { peer }));
    socket.setTimeout(IDLE_TIMEOUT_MS);

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

      // A queued command can only be delivered while the meter is awake, and it
      // only stays awake if the acknowledgement says so. So the queue has to be
      // consulted before the ack is built, not after.
      const pending = commands?.nextFor(envelope.address) ?? null;

      // Acknowledge before decoding the payload: a packet type we cannot read
      // must still be acknowledged, or an unsupported report costs battery.
      sendAck(envelope, { powerOff: !pending });
      if (pending) sendCommand(pending, envelope);

      const reading = { ...envelope, payload: decodePayload(envelope, frame) };
      const { duplicate } = store.saveCat1Reading(reading, hex);
      log.info?.(formatCat1Reading(reading, hex, { duplicate, source: 'tcp' }));
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
