// Primitives shared by every frame this server speaks.
//
// Both protocols the meters use wrap their payload in the same envelope:
//   68H | T(1) | A0-A6(7) | C(1) | L(1) | DATA(L) | CS(1) | 16H
//
// Only the checksum and the error type are genuinely common; the payload
// layouts have nothing in common beyond that. They live here rather than in a
// protocol module so that adding or removing a protocol does not disturb the
// framing layer, which is the one piece nothing can work without.

/** CS | 16H -- the two bytes after the payload that the checksum excludes. */
export const TRAILER_BYTES = 2;

export class FrameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FrameError';
    this.code = code;
  }
}

/**
 * Sum of bytes [0, end), truncated to one byte.
 *
 * This is what locates frame boundaries in the TCP stream -- see framing.js for
 * why the length byte cannot be trusted to do it.
 */
export function checksum(buf, end = buf.length - TRAILER_BYTES) {
  let sum = 0;
  for (let i = 0; i < end; i++) sum = (sum + buf[i]) & 0xff;
  return sum;
}
