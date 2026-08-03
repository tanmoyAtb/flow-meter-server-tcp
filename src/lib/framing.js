// Splits a TCP byte stream into CJ/T 188 frames.
//
// TCP gives no message boundaries: one read can hold half a frame, two frames,
// or a frame plus a heartbeat. This buffers until a complete frame is present.
//
// Frames are located by CHECKSUM, not by the length byte. The documented layout
// puts L at offset 10 and makes the total L+13, but a real registration frame
// observed from meter 00102608220004 carries L=97H (implying 164 bytes) in an
// 88-byte frame. Trusting L would desynchronise the stream permanently. The
// checksum from section 2.7 holds for every frame type we have seen, so we scan
// for a 16H whose preceding byte equals the running sum and treat that as the
// boundary. The length path is still tried first because it is unambiguous when
// it does agree.

import { checksum } from './cjt188.js';
import { bcdReverse, isBcd } from './bcd.js';

const FRAME_START = 0x68;
const FRAME_END = 0x16;

// Smallest plausible frame: 68 | T | A0-A6 | C | L | CS | 16.
const MIN_FRAME = 12;

// A 9097 upload is 185 bytes and a registration frame 88. The cap bounds how far
// we scan before deciding a 68H was not a real frame start.
const MAX_FRAME = 512;

// Guards against a peer that streams bytes forever without a valid frame.
const MAX_BUFFER = 8192;

/**
 * Best-effort envelope read that never throws.
 *
 * Unrecognised frame types still carry a usable meter address in A0-A6, and
 * that is the single most useful thing to log when the payload cannot be
 * decoded -- it identifies which device is talking.
 */
export function peekEnvelope(frame) {
  const out = { meterTypeCode: null, address: null, control: null, dataLength: null };
  if (frame.length < 11) return out;
  out.meterTypeCode = frame[1];
  const addressBytes = frame.subarray(2, 9);
  if (isBcd(addressBytes)) out.address = bcdReverse(addressBytes);
  out.control = frame[9];
  out.dataLength = frame[10];
  return out;
}

/**
 * Locate the end of the frame starting at buf[0].
 *
 * Returns the frame length, 0 when buf[0] cannot start a frame, or -1 when more
 * bytes are needed before a decision can be made.
 */
function frameLength(buf) {
  // Fast path: believe L when the frame it describes actually checks out.
  if (buf.length > 10) {
    const total = buf[10] + 13;
    if (total >= MIN_FRAME && total <= MAX_FRAME) {
      if (buf.length < total) {
        // Might still be the answer once the rest arrives, but the scan below
        // may find a shorter valid frame first, so do not return early.
      } else if (buf[total - 1] === FRAME_END && checksum(buf, total - 2) === buf[total - 2]) {
        return total;
      }
    }
  }

  // Checksum scan: i is the candidate 16H, so CS sits at i-1 and covers [0, i-1).
  const limit = Math.min(buf.length, MAX_FRAME);
  for (let i = MIN_FRAME - 1; i < limit; i++) {
    if (buf[i] !== FRAME_END) continue;
    if (checksum(buf, i - 1) === buf[i - 1]) return i + 1;
  }

  // Nothing yet. Only give up once no larger frame could still fit.
  return buf.length >= MAX_FRAME ? 0 : -1;
}

/**
 * Accumulates stream bytes and yields events in arrival order.
 *
 * Events are `{ type: 'frame' | 'unframed', bytes }`. Bytes that are not part of
 * a frame are surfaced rather than dropped -- the 6-byte packet this device
 * sends before its data frame is not CJ/T 188 at all, and silently discarding it
 * is how you end up running tcpdump to find out what a device is doing.
 */
export class FrameSplitter {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const events = [];

    for (;;) {
      if (this.buffer.length === 0) break;

      const start = this.buffer.indexOf(FRAME_START);
      if (start === -1) {
        // No frame start anywhere: the whole buffer is something else.
        events.push({ type: 'unframed', bytes: this.buffer });
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (start > 0) {
        events.push({ type: 'unframed', bytes: this.buffer.subarray(0, start) });
        this.buffer = this.buffer.subarray(start);
      }

      const len = frameLength(this.buffer);
      if (len === -1) break; // incomplete, wait for more
      if (len === 0) {
        // This 68H did not begin a frame. Drop it and resync on the next one.
        events.push({ type: 'unframed', bytes: this.buffer.subarray(0, 1) });
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      events.push({ type: 'frame', bytes: this.buffer.subarray(0, len) });
      this.buffer = this.buffer.subarray(len);
    }

    if (this.buffer.length > MAX_BUFFER) {
      const bytes = this.buffer;
      this.buffer = Buffer.alloc(0);
      events.push({ type: 'unframed', bytes });
    }
    return events;
  }

  /** Anything still buffered when the peer disconnects. */
  flush() {
    if (this.buffer.length === 0) return [];
    const bytes = this.buffer;
    this.buffer = Buffer.alloc(0);
    return [{ type: 'unframed', bytes }];
  }
}
