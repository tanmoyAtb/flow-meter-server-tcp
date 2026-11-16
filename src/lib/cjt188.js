// CJ/T 188 reports, as spoken by the Shenzhen Jiaronghua 515A ultrasonic meter.
//
// This is NOT the protocol the original fleet speaks. Both wrap their payload
// in the envelope described in frame.js, and there the resemblance stops:
//
//            byte 9      byte 10
//   CAT-1    device type control      (length lives at 15)
//   CJ/T 188 control     length
//
// So the two cannot share a decoder, and deliberately do not. isCat1Frame runs
// first at the door in tcp.js and this is only asked about what it rejects.
// Keeping them apart means neither protocol's quirks leak into the other.
//
// What is decoded here is only what the bytes themselves prove. The vendor sent
// two documents -- a valve-control command protocol (data identifier A0 17) and
// a user manual -- and the report we actually receive carries identifier 92 1F,
// which appears in neither. The "Read Metering Data" message the valve document
// cross-references has not been supplied. So every field below is either
// verified against observed reality or explicitly marked unknown and kept as
// raw hex. Nothing is guessed at silently.
//
// Verified so far:
//   - the envelope and checksum, byte for byte (CS 0xB4 computed = 0xB4 carried)
//   - the timestamp: read back 2026-11-16 15:17 on a frame that arrived at
//     09:17:36Z, which is exactly Dhaka time
//   - the daily records: three of them, dated 16, 15 and 14 November 2026,
//     matching the manual's "30 days of daily cycle data"
//   - the 2BH sign bytes: ASCII '+', matching the manual's bidirectional
//     metering and CJ/T 188's habit of signing a direction with an ASCII byte

import { bcdByte, bcdReverse, isBcd } from './bcd.js';
import { FrameError, TRAILER_BYTES, checksum } from './frame.js';

/** T, byte 1. The 515A reports as a water meter; the others are for company. */
export const CJT188_METER_TYPES = {
  0x10: 'cold water',
  0x11: 'domestic hot water',
  0x20: 'heat',
  0x30: 'gas',
  0x40: 'electricity',
};

/** C, byte 9. The high bit marks a reply; 0x40 marks an abnormal one. */
export const CJT188_CONTROLS = {
  0x01: 'read',
  0x04: 'write',
  0x81: 'read_response',
  0x84: 'write_response',
  0xc1: 'read_error',
  0xc4: 'write_error',
};

/** DI0 DI1 of the report this meter uploads unbidden. Undocumented by the vendor. */
export const METERING_DATA_IDENTIFIER = 0x921f;

/** DI0 DI1 of the valve-control command, the one identifier the vendor did document. */
export const VALVE_CONTROL_IDENTIFIER = 0xa017;

/**
 * The preamble. Every example in the vendor's protocol document is written
 * `FE FE FE 68 ...`, and the meter does send it -- it is the tail of the
 * six-byte packet that arrives between the registration frame and the report.
 * It is not part of any frame, so the splitter surfaces it as unframed bytes
 * and this is how tcp.js recognises it rather than warning about it.
 */
export const PREAMBLE_BYTE = 0xfe;

/** True when every byte is FEH, i.e. this is preamble rather than a stray read. */
export function isPreamble(buf) {
  return buf.length > 0 && Array.prototype.every.call(buf, (b) => b === PREAMBLE_BYTE);
}

/**
 * How many FEH bytes end this run of non-frame bytes.
 *
 * The splitter hands over everything between two frames as one chunk, and what
 * this meter sends there is `00 00 A1 FE FE FE`: three bytes nobody has
 * documented, then the preamble. Counting from the end separates the part we
 * can name from the part we cannot, so the preamble stops being reported as a
 * fault while the three unknown bytes stay visible.
 */
export function trailingPreamble(buf) {
  let n = 0;
  for (let i = buf.length - 1; i >= 0 && buf[i] === PREAMBLE_BYTE; i--) n++;
  return n;
}

const HEADER_BYTES = 11; // 68 | T | A0-A6(7) | C | L
const SIGN_POSITIVE = 0x2b; // '+'
const SIGN_NEGATIVE = 0x2d; // '-'

/**
 * Where a daily record block starts, and how long one is.
 *
 * 17 bytes: forward register (sign + 4), reverse register (sign + 4), four
 * bytes that have been constant at 40 01 80 00 in every frame seen, then a
 * three-byte BCD date, low byte first. Derived from the frames rather than
 * from a document -- the three dates landed 17 bytes apart.
 */
const RECORDS_AT = 46;
const RECORD_BYTES = 17;

/**
 * Decimal places in a 4-byte BCD register.
 *
 * CJ/T 188 carries cumulative volume as eight BCD digits, and for water that is
 * conventionally XXXXXX.XX m3. The manual claims a display resolution of
 * 0.001 m3, which disagrees, and every register this meter has sent so far has
 * read zero -- so nothing observed can settle it yet. One constant, one place
 * to change, and the raw hex is kept on every reading so a correction can be
 * applied retrospectively.
 */
export const REGISTER_DECIMALS = 2;

/** True when the buffer is a well-formed CJ/T 188 frame. Ask isCat1Frame first. */
export function isCjt188Frame(buf) {
  if (buf.length < HEADER_BYTES + TRAILER_BYTES) return false;
  if (buf[0] !== 0x68 || buf[buf.length - 1] !== 0x16) return false;
  // The length byte must account for the frame exactly. This is what separates
  // the two protocols: a CAT-1 report carries its control code at byte 10, and
  // reading that as a length never lands on the real end of the frame.
  if (HEADER_BYTES + buf[10] + TRAILER_BYTES !== buf.length) return false;
  return checksum(buf) === buf[buf.length - TRAILER_BYTES];
}

/**
 * Envelope only: who is talking and what kind of message this is.
 *
 * Address is seven BCD bytes, least significant first, exactly as the vendor's
 * valve document describes -- `78 56 34 12 00 00 00` reads as 00000012345678.
 */
export function decodeCjt188Frame(buf) {
  if (!isCjt188Frame(buf)) throw new FrameError('not_cjt188', 'not a well-formed CJ/T 188 frame');

  const addressBytes = buf.subarray(2, 9);
  if (!isBcd(addressBytes)) throw new FrameError('bad_address', 'address bytes are not BCD');

  const control = buf[9];
  const dataLength = buf[10];
  const data = buf.subarray(HEADER_BYTES, HEADER_BYTES + dataLength);

  return {
    protocol: 'cjt188',
    meterTypeCode: buf[1],
    meterType: CJT188_METER_TYPES[buf[1]] ?? `unknown (0x${buf[1].toString(16)})`,
    address: bcdReverse(addressBytes),
    control,
    controlName: CJT188_CONTROLS[control] ?? `unknown (0x${control.toString(16)})`,
    dataLength,
    identifier: dataLength >= 2 ? (data[0] << 8) | data[1] : null,
    sequence: dataLength >= 3 ? data[2] : null,
    data,
  };
}

/** A signed 4-byte BCD register: one sign byte then eight digits. */
function readRegister(buf, at) {
  const signByte = buf[at];
  const bytes = buf.subarray(at + 1, at + 5);
  const digits = bcdReverse(bytes);
  const valid = isBcd(bytes) && (signByte === SIGN_POSITIVE || signByte === SIGN_NEGATIVE);
  const magnitude = valid ? Number(digits) / 10 ** REGISTER_DECIMALS : null;
  return {
    sign: signByte === SIGN_NEGATIVE ? '-' : signByte === SIGN_POSITIVE ? '+' : null,
    cubicMetres: magnitude === null ? null : signByte === SIGN_NEGATIVE ? -magnitude : magnitude,
    digits,
    raw: buf.subarray(at, at + 5).toString('hex').toUpperCase(),
    valid,
  };
}

/** Three BCD bytes, low first: DD MM YY -> an ISO date in the meter's own zone. */
function readDate(buf, at) {
  const [d, m, y] = [bcdByte(buf[at]), bcdByte(buf[at + 1]), bcdByte(buf[at + 2])];
  if (d === null || m === null || y === null) return null;
  if (d < 1 || d > 31 || m < 1 || m > 12) return null;
  return `20${String(y).padStart(2, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The meter's clock: five BCD bytes, low first -- mm HH DD MM YY.
 *
 * This is the field that confirmed the whole layout. A frame that reached the
 * server at 09:17:36Z carried 17 15 16 11 26, which reads as 2026-11-16 15:17:
 * Dhaka time to the minute, with no correction applied. It is also why no clock
 * rung is needed for this meter the way it is for the CAT-1 fleet.
 */
function readClock(buf, at) {
  const [mi, h, d, m, y] = Array.from(buf.subarray(at, at + 5), bcdByte);
  if ([mi, h, d, m, y].some((v) => v === null)) return { iso: null, raw: buf.subarray(at, at + 5).toString('hex').toUpperCase() };
  const pad = (v) => String(v).padStart(2, '0');
  return {
    iso: `20${pad(y)}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(mi)}:00`,
    raw: buf.subarray(at, at + 5).toString('hex').toUpperCase(),
  };
}

/**
 * The 92 1F metering report.
 *
 * Walks the daily records rather than trusting a count, because no document
 * says where the count lives: a record is accepted while its two sign bytes and
 * its date both parse, and the walk stops at the first block that does not.
 * Everything the walk does not claim is returned under `unknown` as raw hex, so
 * a later correction has the bytes to work from.
 */
export function decodeCjt188Report(envelope) {
  const d = envelope.data;
  if (envelope.identifier !== METERING_DATA_IDENTIFIER) {
    throw new FrameError('unexpected_identifier', `data identifier ${hex16(envelope.identifier)} is not the metering report`);
  }
  if (d.length < RECORDS_AT) {
    throw new FrameError('short_report', `metering report is ${d.length} bytes, need at least ${RECORDS_AT}`);
  }

  const meterClock = readClock(d, 4);
  const forward = readRegister(d, 17);
  const reverse = readRegister(d, 22);

  const daily = [];
  for (let at = RECORDS_AT; at + RECORD_BYTES <= d.length; at += RECORD_BYTES) {
    const date = readDate(d, at + 14);
    const f = readRegister(d, at);
    const r = readRegister(d, at + 5);
    if (!date || !f.valid || !r.valid) break;
    daily.push({ date, forward: f, reverse: r, raw: d.subarray(at, at + RECORD_BYTES).toString('hex').toUpperCase() });
  }

  const recordsEnd = RECORDS_AT + daily.length * RECORD_BYTES;
  return {
    meterClock,
    forward,
    reverse,
    daily,
    // Named so nobody mistakes these for decoded values. They are kept because
    // the vendor document that explains them has not arrived yet.
    unknown: {
      beforeClock: d.subarray(3, 4).toString('hex').toUpperCase(),
      afterClock: d.subarray(9, 17).toString('hex').toUpperCase(),
      afterRegisters: d.subarray(27, RECORDS_AT).toString('hex').toUpperCase(),
      afterRecords: d.subarray(recordsEnd).toString('hex').toUpperCase(),
    },
  };
}

const hex16 = (v) => (v === null ? 'null' : `0x${v.toString(16).padStart(4, '0').toUpperCase()}`);
