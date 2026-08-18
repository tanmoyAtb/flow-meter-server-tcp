// Forwarding every reading on to the partner's ingest server.
//
// This is a side channel and nothing more. Ingest, the command queue and the
// auto-configure policy are ours and are untouched by anything in this file:
// the meter has already been answered by the time `forward` is called, and the
// call returns immediately without being awaited. A partner outage, a hung
// socket or a malformed reply must never cost a meter its contact -- these are
// battery devices that get one exchange per interval, and a contact spent
// waiting on somebody else's server is a reading we do not have.
//
// So every failure here is counted and logged, and none of it propagates.
//
// One frame per TCP connection, the way a real meter behaves and the way this
// endpoint expects it: dial, send, wait for the ack, hang up. See
// jobs/partner-replay.js, which does the same thing by hand from a pinned file.

import net from 'node:net';
import { encodeReportAck } from './lib/cat1.js';
import { formatTcpEvent } from './lib/format.js';

/**
 * The switch. `false` stops all forwarding; nothing else has to change.
 *
 * Deliberately a constant rather than an environment variable. Sending a
 * customer's meter data to a third party is a decision that should be visible
 * in the diff and reviewable in the history -- not something that can be turned
 * on by a unit file on one box and off on another, where the only way to know
 * which is true is to shell in and read the environment. Flip it here, commit,
 * redeploy: the code says what the system does.
 */
export const PARTNER_FORWARDING = true;

/** Where the partner listens. Raw TCP, same envelope the meters speak. */
export const PARTNER_ENDPOINT = { host: '31.220.109.95', port: 5001 };

const DEFAULTS = {
  /** Long enough for a slow reply, short enough that sockets do not pile up. */
  ackTimeoutMs: 8000,
  /**
   * Concurrent connections to the partner.
   *
   * The fleet reports every 12 hours, and meters cluster: fourteen contacts can
   * land inside a couple of minutes. Four at a time keeps that civil rather
   * than opening a socket per meter simultaneously. Widening the interval has
   * only ever made the bursts rarer, never smaller -- it is the burst this
   * number is sized for, so it does not move when the interval does.
   */
  maxInFlight: 4,
  /**
   * Backlog ceiling. If the partner is down, the queue must not grow without
   * bound -- this process holds everything in memory. Past this we drop the
   * OLDEST pending frame: when only some readings can get through, the recent
   * ones are worth more than a backlog from an hour ago.
   */
  maxQueued: 200,
};

/**
 * @param log   anything with .info/.warn; console by default
 * @param options.enabled  overrides PARTNER_FORWARDING, for tests
 */
export function createPartnerForwarder(log = console, options = {}) {
  const config = { ...DEFAULTS, ...PARTNER_ENDPOINT, ...options };
  const enabled = options.enabled ?? PARTNER_FORWARDING;

  const counters = {
    accepted: 0, // handed to us by the ingest path
    forwarded: 0, // actually put on a socket
    acked: 0, // answered with a byte-correct §6 ack
    wrongReply: 0, // answered with something else
    silent: 0, // connected, sent, no reply before the timeout
    failed: 0, // could not connect, or the socket errored
    duplicate: 0, // skipped: the same frame already went
    dropped: 0, // skipped: backlog full
  };
  let lastEvent = null;

  const queue = [];
  let inFlight = 0;

  const note = (verdict, detail) => {
    lastEvent = { at: new Date().toISOString(), verdict, detail };
  };

  function send(job) {
    inFlight += 1;
    const started = Date.now();
    const chunks = [];
    let settled = false;

    const socket = new net.Socket();
    // Never hold the process open for a partner reply on shutdown.
    socket.unref();

    const done = (verdict, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      counters[verdict] += 1;
      note(verdict, detail);
      const line = `${job.address} ${verdict} in ${Date.now() - started}ms${detail ? ` -- ${detail}` : ''}`;
      if (verdict === 'acked') log.info?.(formatTcpEvent('partner', { peer: peerName(), detail: line }));
      else log.warn?.(formatTcpEvent('partner', { peer: peerName(), detail: line }));
      inFlight -= 1;
      pump();
    };

    const timer = setTimeout(() => done(chunks.length ? 'wrongReply' : 'silent', 'no ack before timeout'), config.ackTimeoutMs);

    socket.setNoDelay(true);
    socket.on('error', (err) => done('failed', err.code ?? err.message));
    socket.on('close', () => done(chunks.length ? 'wrongReply' : 'silent', 'closed without a full ack'));
    socket.on('data', (buf) => {
      chunks.push(buf);
      const reply = Buffer.concat(chunks);
      if (reply.length < job.expectedAck.length) return; // wait for the rest
      done(reply.equals(job.expectedAck) ? 'acked' : 'wrongReply', reply.equals(job.expectedAck) ? '' : `got ${reply.toString('hex').toUpperCase()}`);
    });

    socket.connect(config.port, config.host, () => {
      counters.forwarded += 1;
      socket.write(job.frame);
    });
  }

  const peerName = () => `${config.host}:${config.port}`;

  function pump() {
    while (inFlight < config.maxInFlight && queue.length) send(queue.shift());
  }

  return {
    enabled,
    config: { host: config.host, port: config.port, ...DEFAULTS },

    /**
     * Hand a reading to the partner. Returns immediately; never throws.
     *
     * `envelope` is the decoded CAT-1 frame, used only to work out the ack we
     * should get back -- §6 says it echoes the address, reporting type and
     * packet type, so the expected bytes are derivable and a reply that does
     * not match is worth counting rather than assuming success.
     */
    forward(hex, envelope, { duplicate = false } = {}) {
      if (!enabled) return false;
      counters.accepted += 1;
      if (duplicate) {
        counters.duplicate += 1;
        return false; // already sent once; sending again would double-count
      }
      try {
        const job = {
          address: envelope.address,
          frame: Buffer.from(hex, 'hex'),
          expectedAck: encodeReportAck(envelope),
        };
        if (queue.length >= config.maxQueued) {
          queue.shift();
          counters.dropped += 1;
        }
        queue.push(job);
        pump();
        return true;
      } catch (err) {
        // A forwarding bug must not become an ingest bug.
        counters.failed += 1;
        note('failed', err.message);
        log.warn?.(formatTcpEvent('partner', { peer: peerName(), detail: `forward failed: ${err.message}` }));
        return false;
      }
    },

    /** For the debug route: is it on, where is it pointed, how is it doing. */
    stats() {
      return {
        enabled,
        endpoint: peerName(),
        inFlight,
        queued: queue.length,
        counters: { ...counters },
        lastEvent,
      };
    },
  };
}
