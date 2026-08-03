// BCD helpers. Every numeric field in CJ/T 188-2004 is packed BCD: each byte
// holds two decimal digits, high nibble first.

const hex = (b) => b.toString(16).padStart(2, '0');

/** Digits in transmission order (high byte first). */
export function bcdForward(buf) {
  return Array.from(buf, hex).join('');
}

/** Digits with byte order reversed (for "low byte first" fields). */
export function bcdReverse(buf) {
  return Array.from(buf).reverse().map(hex).join('');
}

/** True when every nibble is 0-9, i.e. the bytes are valid BCD and not raw hex. */
export function isBcd(buf) {
  for (const b of buf) {
    if ((b >> 4) > 9 || (b & 0x0f) > 9) return false;
  }
  return true;
}

/** One BCD byte as a number, or null if the nibbles are not decimal. */
export function bcdByte(b) {
  const hi = b >> 4;
  const lo = b & 0x0f;
  return hi > 9 || lo > 9 ? null : hi * 10 + lo;
}
