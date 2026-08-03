// CAT-1 Remote Water Meter Communication Protocol (Shenzhen Jia Ronghua, V1.0).
//
// A different protocol from the CJ/T 188 decoder in cjt188.js, despite sharing
// the 68H…16H envelope and the same checksum rule. The two disagree on what
// byte 10 means, which matters:
//
//   CJ/T 188 : byte 10 is the data LENGTH, and the frame is L + 13 bytes
//   CAT-1    : byte 10 is a fixed CONTROL CODE 97H, and the length lives at 15
//
// Reading a CAT-1 frame with the CJ/T 188 layout yields "L=151, so this frame
// should be 164 bytes" for an 88-byte frame -- which is exactly how these
// frames were being rejected before this decoder existed.
//
// Frame layout (protocol section I, and section 3.3 for packet type 03):
//   0     68H start
//   1     T        meter type (10H water)
//   2-8   A6-A0    address, 14-digit BCD, low byte first
//   9     03H      device type
//   10    97H      control code: the meter is reporting
//   11-12 0000H    instruction number (0 when actively reported)
//   13-14          reporting type bitfield
//   15    m        data length: counts bytes 16 .. 15+m
//   16             data packet type
//   ...            packet-specific payload
//   15+m+1 CS      checksum, and 15+m+2 is 16H

import { bcdForward, bcdReverse, bcdByte, isBcd } from './bcd.js';
import { FrameError, checksum } from './cjt188.js';

const FRAME_START = 0x68;
const FRAME_END = 0x16;

export const CAT1_DEVICE_TYPE = 0x03;
export const CAT1_REPORT_CONTROL = 0x97;

const HEADER_BYTES = 16; // 68 .. data packet type at 15 is the last header byte
const LENGTH_OFFSET = 15;

export const METER_TYPES = { 0x10: 'cold water', 0x11: 'hot water', 0x12: 'drinking water', 0x13: 'reclaimed water' };

// Protocol section I.6.
export const CONTROL_CODES = {
  0x97: 'meter_report',
  0x17: 'server_ack',
  0x01: 'server_read',
  0x81: 'read_response',
  0x04: 'server_write',
  0x84: 'write_response',
};

// Protocol section 3, "Data packet type".
export const PACKET_TYPES = {
  0x01: 'prepaid_general',
  0x02: 'prepaid_tiered',
  0x03: 'postpaid_standard',
  0x04: 'hvac_valve',
  0x05: 'surcharge_minimum',
  0x06: 'daily_history',
};

// Reporting type, low bits of the section 3 bitfield.
const REPORT_TRIGGERS = [
  [0x0001, 'timed'],
  [0x0002, 'trigger'], // button press
  [0x0004, 'card_swipe'],
  [0x0008, 'valve_action'],
  [0x0010, 'magnetic_interference'],
];

const VALVE_STATES = { 0: 'open', 1: 'closed', 3: 'abnormal' };

// Control codes a meter can send us: its periodic report, and its replies to
// commands we issued. Kept narrow on purpose -- widening this to every control
// code would start pulling CJ/T 188 frames into the wrong decoder.
const METER_CONTROLS = new Set([0x97, 0x81, 0x84]);

/** True when the frame is CAT-1 rather than CJ/T 188. */
export function isCat1Frame(buf) {
  return buf.length > 16 && buf[9] === CAT1_DEVICE_TYPE && METER_CONTROLS.has(buf[10]);
}

/** 4-byte big-endian unsigned. */
const u32 = (buf, at) => buf.readUInt32BE(at);
const u16 = (buf, at) => buf.readUInt16BE(at);
/** 1-byte signed: RSSI/RSRQ/SNR are documented "with a sign, such as -68dBm". */
const i8 = (buf, at) => (buf[at] > 0x7f ? buf[at] - 0x100 : buf[at]);

/** Section 6: 0xAC00 status word. */
function decodeStatus(word) {
  return {
    raw: word,
    valve: VALVE_STATES[word & 0x03] ?? 'reserved',
    batteryUndervoltage: Boolean(word & 0x20),
    magneticInterference: Boolean(word & 0x40),
    coverOpen: Boolean(word & 0x80),
    magneticRecord: Boolean(word & 0x4000),
  };
}

/** Section 7: 0xAC10 reporting mode, 6 bytes. B0 selects the scheme. */
function decodeReportingMode(bytes) {
  const scheme = bytes[0];
  const out = { raw: bytes.toString('hex').toUpperCase(), scheme, description: null, intervalMinutes: null };
  if (scheme === 0xc0) {
    out.intervalMinutes = u16(bytes, 1);
    out.description = `every ${out.intervalMinutes} minutes`;
  } else if (scheme === 0xc1) {
    out.description = `on days ${[...bytes.subarray(1, 5)].filter((d) => d !== 0xff).join(', ')}`;
  } else if (scheme === 0xc2) {
    out.description = `at hours ${[...bytes.subarray(1, 5)].filter((h) => h !== 0xff).join(', ')}`;
  }
  return out;
}

/** BCD real-time clock: YY MM DD HH MM SS (protocol section 2.1). */
function decodeClock(bytes) {
  const parts = Array.from(bytes, bcdByte);
  if (parts.some((p) => p === null)) return { raw: bcdForward(bytes), iso: null };
  const [yy, mm, dd, hh, mi, ss] = parts;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    raw: bcdForward(bytes),
    iso: `20${pad(yy)}-${pad(mm)}-${pad(dd)}T${pad(hh)}:${pad(mi)}:${pad(ss)}`,
  };
}

/** Section 3 of the protocol: envelope common to every CAT-1 packet. */
export function decodeCat1Frame(buf) {
  if (!Buffer.isBuffer(buf)) throw new FrameError('not_buffer', 'frame must be a Buffer');
  if (buf.length < HEADER_BYTES + 2) {
    throw new FrameError('too_short', `frame is ${buf.length} bytes, minimum is ${HEADER_BYTES + 2}`);
  }
  if (buf[0] !== FRAME_START) {
    throw new FrameError('bad_start', `expected 68H start byte, got ${buf[0].toString(16)}H`);
  }
  if (buf.at(-1) !== FRAME_END) {
    throw new FrameError('bad_end', `expected 16H end byte, got ${buf.at(-1).toString(16)}H`);
  }

  const dataLength = buf[LENGTH_OFFSET];
  const expectedTotal = HEADER_BYTES + dataLength + 2;
  if (buf.length !== expectedTotal) {
    throw new FrameError(
      'bad_length',
      `m=${dataLength} implies a ${expectedTotal}-byte frame, got ${buf.length}`,
    );
  }

  const expectedCs = checksum(buf);
  if (expectedCs !== buf.at(-2)) {
    throw new FrameError(
      'bad_checksum',
      `checksum is ${buf.at(-2).toString(16).padStart(2, '0')}H, computed ${expectedCs.toString(16).padStart(2, '0')}H`,
    );
  }

  const addressBytes = buf.subarray(2, 9);
  if (!isBcd(addressBytes)) throw new FrameError('bad_address', 'address field is not valid BCD');

  const common = {
    protocol: 'cat1',
    meterTypeCode: buf[1],
    meterType: METER_TYPES[buf[1]] ?? 'unknown',
    address: bcdReverse(addressBytes),
    deviceType: buf[9],
    control: buf[10],
    controlName: CONTROL_CODES[buf[10]] ?? 'unknown',
    instructionNumber: u16(buf, 11),
    dataLength,
  };

  // Byte 16 means different things by direction: for a report it is the data
  // packet type, for a command/response it is the first byte of the data
  // identifier. Only populate the one that actually applies.
  if (buf[10] !== CAT1_REPORT_CONTROL) {
    return { ...common, dataIdentifier: buf.subarray(16, 18).toString('hex').toUpperCase() };
  }

  const reportingType = u16(buf, 13);
  return {
    ...common,
    reportingType,
    reportingTriggers: REPORT_TRIGGERS.filter(([bit]) => reportingType & bit).map(([, name]) => name),
    packetType: buf[16],
    packetName: PACKET_TYPES[buf[16]] ?? 'unknown',
  };
}

/**
 * Packet type 03 -- postpaid standard meter report (protocol section 3.3).
 *
 * Offsets are absolute frame positions, as the document states them. Note the
 * document's table ends at CS=78/end=79 (m=62), while real meters send m=70
 * with eight zero bytes at 78-85 -- the spare field every other packet in the
 * document carries, omitted from this one's table. Everything up to offset 77
 * matches byte for byte, so the extra bytes are surfaced as `spare` instead of
 * being treated as an error.
 */
export function decodePostpaid03(buf) {
  const MIN_DATA = 62; // through the real-time clock at 72-77
  if (buf[16] !== 0x03) {
    throw new FrameError('wrong_packet_type', `expected packet type 03H, got ${buf[16].toString(16)}H`);
  }
  if (buf[LENGTH_OFFSET] < MIN_DATA) {
    throw new FrameError(
      'bad_length',
      `packet 03 needs at least ${MIN_DATA} data bytes, m=${buf[LENGTH_OFFSET]}`,
    );
  }

  const imei = bcdForward(buf.subarray(25, 33));
  return {
    manufacturerCode: buf.subarray(17, 19).toString('hex').toUpperCase(),
    tableTypeCode: buf.subarray(19, 21).toString('hex').toUpperCase(),
    hardwareVersion: buf.subarray(21, 23).toString('hex').toUpperCase(),
    softwareVersion: buf.subarray(23, 25).toString('hex').toUpperCase(),
    // 15 digits plus one pad nibble, per the parameter table for 0xAB01.
    imei: imei.slice(0, 15),
    iccid: bcdForward(buf.subarray(33, 43)),
    voltageVolts: u16(buf, 43) / 1000, // documented in mV
    signalStrengthDbm: i8(buf, 45), // RSSI
    signalQualityDb: i8(buf, 46), // RSRQ
    snrDb: i8(buf, 47),
    cumulativeReportCount: u16(buf, 48),
    dailyReportCount: u16(buf, 50),
    reportingMode: decodeReportingMode(buf.subarray(52, 58)),
    status: decodeStatus(u16(buf, 58)),
    // All three are "Unit: L" in the parameter table (0xAE03 / 0xAE07 / 0xAE08).
    cumulativeUsageLitres: u32(buf, 60),
    dailyUsageLitres: u32(buf, 64),
    monthlyUsageLitres: u32(buf, 68),
    meterClock: decodeClock(buf.subarray(72, 78)),
    spare: buf.subarray(78, buf.length - 2).toString('hex').toUpperCase(),
  };
}

/** Payload decoder for an already-validated envelope. */
export function decodePayload(frame, buf) {
  if (frame.packetType === 0x03) return decodePostpaid03(buf);
  throw new FrameError(
    'unsupported_packet_type',
    `packet type ${frame.packetType.toString(16).padStart(2, '0')}H (${frame.packetName}) has no decoder yet`,
  );
}

/** Decode envelope + payload. Throws FrameError on anything malformed. */
export function parseCat1(buf) {
  const frame = decodeCat1Frame(buf);
  return { ...frame, payload: decodePayload(frame, buf) };
}

// --- server -> meter ------------------------------------------------------

export const ACK_CONTROL = 0x17; // "server response to the table report"

/** Power-off flag, protocol section 3. */
export const POWER_OFF_NOW = 0xaf; // no further instructions; meter sleeps at once
export const POWER_STAY_AWAKE = 0x00; // hold the radio open for a queued command

/**
 * Build the 17H acknowledgement for a report frame (protocol section 3).
 *
 * The meter keeps its radio powered until this arrives:
 *
 *   "If no further instructions are received, the power-off flag is set to
 *    0xAF, and the device will power off immediately upon receiving the
 *    command. If there are subsequent instructions, the shutdown flag will be
 *    set to 0x00, and the terminal will extend the waiting time."
 *
 * So 0xAF is not merely polite -- on a battery meter, withholding it burns
 * current on every single report until the meter's own timeout expires.
 *
 * Layout: 68 | T | A6-A0 | 03 | 17 | 0000 | reporting type | m | packet type |
 *         power flag | CS | 16      -- 20 bytes, m = 2.
 */
export const WRITE_CONTROL = 0x04; // server issues a write command
export const WRITE_RESPONSE_CONTROL = 0x84; // meter's reply to that write

/** Address digits back into wire order (A6..A0, low byte first). */
function addressBytes(address) {
  return Buffer.from(address.match(/../g).reverse().join(''), 'hex');
}

const toBcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);

/**
 * Clock calibration write (protocol section 2.1, data identifier AA00H).
 *
 *   68 | T | A6-A0 | 03 | 04 | instruction no. | 0000 | 11H | AA00 |
 *   5A | YY MM DD HH MM SS | backup(8) | CS | 16          -- 35 bytes, m = 11H
 *
 * Byte 18 is the calibration enable: 5AH performs the calibration, anything
 * else leaves the clock alone. The six clock bytes are plain BCD, and the
 * meter has no timezone concept -- it stores exactly what it is given, so the
 * caller decides whether that is UTC or local.
 */
export function encodeSetClock({ meterTypeCode = 0x10, address }, when, instructionNumber) {
  const cmd = Buffer.alloc(35);
  cmd[0] = FRAME_START;
  cmd[1] = meterTypeCode;
  addressBytes(address).copy(cmd, 2);
  cmd[9] = CAT1_DEVICE_TYPE;
  cmd[10] = WRITE_CONTROL;
  cmd.writeUInt16BE(instructionNumber & 0xffff, 11);
  cmd.writeUInt16BE(0x0000, 13); // spare
  cmd[15] = 0x11; // data length: 17 bytes, offsets 16..32
  cmd.writeUInt16BE(0xaa00, 16); // data identifier: clock calibration
  cmd[18] = 0x5a; // enable
  cmd[19] = toBcd(when.getUTCFullYear() % 100);
  cmd[20] = toBcd(when.getUTCMonth() + 1);
  cmd[21] = toBcd(when.getUTCDate());
  cmd[22] = toBcd(when.getUTCHours());
  cmd[23] = toBcd(when.getUTCMinutes());
  cmd[24] = toBcd(when.getUTCSeconds());
  // 25-32 backup, left zero
  cmd[33] = checksum(cmd);
  cmd[34] = FRAME_END;
  return cmd;
}

/**
 * Clock calibration via the generic parameter write (protocol section 2, with
 * data identifier 0xAC12 "Real-Time Clock, BCD, 6 bytes, R/W" from section III).
 *
 *   68 | T | A6-A0 | 03 | 04 | instruction no. | 0000 | 08H | AC12 |
 *   YY MM DD HH MM SS | CS | 16                          -- 26 bytes, m = 8
 *
 * An alternative to the AA00H form: a real meter rejected AA00H with error 0BH
 * and echoed back a zeroed instruction number and data identifier, which is
 * what a device does when it does not accept the identifier at all. Section
 * 2.1's heading calls that flow the "power-off procedure", so its clock write
 * may only be valid inside that sequence. This form uses the documented
 * read/write parameter instead.
 */
export function encodeSetClockParam({ meterTypeCode = 0x10, address }, when, instructionNumber) {
  const cmd = Buffer.alloc(26);
  cmd[0] = FRAME_START;
  cmd[1] = meterTypeCode;
  addressBytes(address).copy(cmd, 2);
  cmd[9] = CAT1_DEVICE_TYPE;
  cmd[10] = WRITE_CONTROL;
  cmd.writeUInt16BE(instructionNumber & 0xffff, 11);
  cmd.writeUInt16BE(0x0000, 13); // spare
  cmd[15] = 0x08; // data length: identifier(2) + clock(6)
  cmd.writeUInt16BE(0xac12, 16); // data identifier: real-time clock
  cmd[18] = toBcd(when.getUTCFullYear() % 100);
  cmd[19] = toBcd(when.getUTCMonth() + 1);
  cmd[20] = toBcd(when.getUTCDate());
  cmd[21] = toBcd(when.getUTCHours());
  cmd[22] = toBcd(when.getUTCMinutes());
  cmd[23] = toBcd(when.getUTCSeconds());
  cmd[24] = checksum(cmd);
  cmd[25] = FRAME_END;
  return cmd;
}

// Section 23.2, data identifier AA05H.
export const VALVE_OPEN = 0x55;
export const VALVE_CLOSED = 0x99;
export const VALVE_FORCED = 0x5a; // "0x5A: Forced Operation; !0x5A: Non-mandatory"
export const VALVE_NOT_FORCED = 0x00;

/**
 * Valve open/close (protocol section 2.6, data identifier AA05H).
 *
 *   68 | T | A6-A0 | 03 | 04 | instruction no. | 0000 | 0CH | AA05 |
 *   operation | permission | spare(8) | CS | 16          -- 30 bytes, m = 0CH
 *
 * Byte 18 is the operation (55H open, 99H close) and byte 19 the permission:
 * 5AH forces the operation, any other value leaves it advisory. This physically
 * actuates the valve, so the caller decides which -- there is no default that
 * is safe in every installation.
 */
export function encodeValveOperation({ meterTypeCode = 0x10, address }, { open, forced = false }, instructionNumber) {
  const cmd = Buffer.alloc(30);
  cmd[0] = FRAME_START;
  cmd[1] = meterTypeCode;
  addressBytes(address).copy(cmd, 2);
  cmd[9] = CAT1_DEVICE_TYPE;
  cmd[10] = WRITE_CONTROL;
  cmd.writeUInt16BE(instructionNumber & 0xffff, 11);
  cmd.writeUInt16BE(0x0000, 13); // spare
  cmd[15] = 0x0c; // data length: identifier(2) + operation + permission + spare(8)
  cmd.writeUInt16BE(0xaa05, 16); // data identifier: valve operation
  cmd[18] = open ? VALVE_OPEN : VALVE_CLOSED;
  cmd[19] = forced ? VALVE_FORCED : VALVE_NOT_FORCED;
  // 20-27 spare, left zero
  cmd[28] = checksum(cmd);
  cmd[29] = FRAME_END;
  return cmd;
}

/**
 * The meter's reply to a write (protocol section 2, "Table -> Server").
 * Byte 18 is the success flag: "0 indicates success; non-zero indicates error."
 */
export function decodeWriteResponse(buf) {
  const frame = decodeCat1Frame(buf);
  if (frame.control !== WRITE_RESPONSE_CONTROL) {
    throw new FrameError('not_write_response', `expected control 84H, got ${frame.control.toString(16)}H`);
  }
  if (buf.length < 35) {
    throw new FrameError('too_short', `write response is ${buf.length} bytes, expected 35`);
  }
  return {
    ...frame,
    success: buf[18] === 0,
    errorCode: buf[18],
    meterClock: decodeClock(buf.subarray(19, 25)),
  };
}

export function encodeReportAck(frame, { powerOff = true } = {}) {
  const ack = Buffer.alloc(20);
  ack[0] = FRAME_START;
  ack[1] = frame.meterTypeCode;
  // Address is echoed in wire order; `frame.address` is the reversed display form.
  addressBytes(frame.address).copy(ack, 2);
  ack[9] = CAT1_DEVICE_TYPE;
  ack[10] = ACK_CONTROL;
  ack.writeUInt16BE(0x0000, 11); // section 3: always 0 for report/response pairs
  ack.writeUInt16BE(frame.reportingType, 13);
  ack[15] = 2; // data length: packet type + power flag
  ack[16] = frame.packetType;
  ack[17] = powerOff ? POWER_OFF_NOW : POWER_STAY_AWAKE;
  ack[18] = checksum(ack);
  ack[19] = FRAME_END;
  return ack;
}
