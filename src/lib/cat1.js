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

// Section 23.3, 0xAB06 table type code.
const PAYMENT_TYPES = { 0: 'prepaid', 1: 'pre-ladder', 2: 'postpaid', 3: 'hvac_valve' };
const METERING_SCOPE_LITRES = { 0: 1, 1: 10, 2: 100, 3: 1000 };

/**
 * Table type code bit fields (section 23.3).
 *
 * `resolutionLitres` is the one that catches people out: a meter with a 1000 L
 * scope only increments its counters once a full cubic metre has passed, so a
 * short run of water leaves every usage field looking frozen.
 */
export function decodeTableTypeCode(code) {
  return {
    raw: code.toString(16).toUpperCase().padStart(4, '0'),
    paymentType: PAYMENT_TYPES[(code >> 4) & 0b11],
    valveType: (code >> 2) & 0b1 ? 'switch' : 'blocked_turn',
    resolutionLitres: METERING_SCOPE_LITRES[code & 0b11],
  };
}

// Control codes a meter can send us: its periodic report, and its replies to
// commands we issued. Kept narrow on purpose -- widening this to every control
// code would start pulling CJ/T 188 frames into the wrong decoder.
const METER_CONTROLS = new Set([0x97, 0x81, 0x84]);

/**
 * Byte 9 as seen on frames the meter sends us. Its own reports always carry
 * 03H, but a command reply mirrors back whatever we put in byte 9 -- a reply to
 * a command sent with 01H arrives with 01H. Accepting only 03H sent those
 * replies to the CJ/T 188 decoder, which logged them as unrecognised.
 */
const INBOUND_DEVICE_TYPES = new Set([0x01, 0x03]);

/** True when the frame is CAT-1 rather than CJ/T 188. */
export function isCat1Frame(buf) {
  return buf.length > 16 && INBOUND_DEVICE_TYPES.has(buf[9]) && METER_CONTROLS.has(buf[10]);
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
    meterConfig: decodeTableTypeCode(u16(buf, 19)),
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
 * The six clock digits, as the wall clock of a given zone.
 *
 * The meter has no timezone concept -- it stores exactly the digits it is sent
 * and reports them back unchanged. So the caller decides which wall clock those
 * digits represent; `timeZone` null means UTC. Using an IANA zone rather than a
 * fixed offset means a region that starts observing DST keeps working (Dhaka is
 * UTC+6 today, but did run DST in 2009).
 */
/**
 * The wall-clock digits a meter should be showing: `[yy, mm, dd, hh, mi, ss]`.
 *
 * Exported because the reconciler compares a meter's reported clock against the
 * same digits this produces. Two implementations of "what time is it in Dhaka"
 * would eventually disagree, and the disagreement would look like clock drift.
 */
export function clockParts(when, timeZone) {
  if (!timeZone) {
    return [
      when.getUTCFullYear() % 100,
      when.getUTCMonth() + 1,
      when.getUTCDate(),
      when.getUTCHours(),
      when.getUTCMinutes(),
      when.getUTCSeconds(),
    ];
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23', // 00-23, so midnight is 00 rather than 24
  }).formatToParts(when);
  const at = (type) => Number(parts.find((x) => x.type === type).value);
  return [at('year'), at('month'), at('day'), at('hour'), at('minute'), at('second')];
}

/**
 * Byte 9 is 03H, per section I.3 "Equipment type: Fixed at 0x03" and every
 * command table in the document.
 *
 * A frame captured from the vendor's own server carries 01H instead, so we
 * tried it on 2026-08-04: the meter refused it with the same 0BH and echoed the
 * 01H straight back in its reply, where every earlier reply had carried 03H. It
 * mirrors this byte rather than validating it, so it is not what 0BH is about.
 * The vendor has since confirmed 03H. Left here so nobody re-runs the test.
 */

/**
 * The header every server-originated command shares, with the data field
 * allocated but empty. Callers fill in from offset 18 and call sealCommand.
 *
 * `dataLength` is per-identifier and comes straight from the document's byte
 * tables -- 0AH for A901 (section 1.1), 0CH for AA05 (2.6), 11H for AA00 (2.1).
 * The vendor's AA07 frame uses 18H because section 2.8 gives *that* command a
 * 24-byte data field ending at byte 39, not because commands are padded to a
 * fixed width. Generalising its length to every command was wrong.
 */
function commandFrame({ meterTypeCode = 0x10, address }, control, identifier, instructionNumber, dataLength) {
  const cmd = Buffer.alloc(HEADER_BYTES + dataLength + 2);
  cmd[0] = FRAME_START;
  cmd[1] = meterTypeCode;
  addressBytes(address).copy(cmd, 2);
  cmd[9] = CAT1_DEVICE_TYPE;
  cmd[10] = control;
  cmd.writeUInt16BE(instructionNumber & 0xffff, 11);
  cmd.writeUInt16BE(0x0000, 13); // spare
  cmd[15] = dataLength;
  cmd.writeUInt16BE(identifier, 16);
  return cmd;
}

/** Checksum covers everything from 68H up to but not including CS (section I.9). */
function sealCommand(cmd) {
  cmd[cmd.length - 2] = checksum(cmd);
  cmd[cmd.length - 1] = FRAME_END;
  return cmd;
}

/**
 * Clock calibration write (protocol section 2.1, data identifier AA00H).
 *
 *   68 | T | A6-A0 | 01 | 04 | instruction no. | 0000 | 11H | AA00 |
 *   5A | YY MM DD HH MM SS | backup(8) | CS | 16          -- 35 bytes, m = 11H
 *
 * Byte 18 is the calibration enable: 5AH performs the calibration, anything
 * else leaves the clock alone. The six clock bytes are plain BCD, and the
 * meter has no timezone concept -- it stores exactly what it is given, so the
 * caller decides whether that is UTC or local.
 */
export function encodeSetClock({ meterTypeCode = 0x10, address }, when, instructionNumber, { timeZone = null } = {}) {
  const cmd = commandFrame({ meterTypeCode, address }, WRITE_CONTROL, 0xaa00, instructionNumber, 0x11);
  cmd[18] = 0x5a; // enable
  clockParts(when, timeZone).forEach((v, i) => {
    cmd[19 + i] = toBcd(v);
  });
  return sealCommand(cmd);
}

/**
 * Clock calibration via the generic parameter write (protocol section 2, with
 * data identifier 0xAC12 "Real-Time Clock, BCD, 6 bytes, R/W" from section III).
 *
 *   68 | T | A6-A0 | 01 | 04 | instruction no. | 0000 | 08H | AC12 |
 *   YY MM DD HH MM SS | CS | 16                          -- 26 bytes, m = 8
 *
 * Superseded by encodeSetClock: AA00H works, provided it is sent alone and
 * first in a session, and it applies silently with no 84H reply at all. This
 * form is the one that fails -- a real meter refused 0xAC12 with error 0BH,
 * exactly as it later refused 0xAC0E, so generic parameter writes look
 * unimplemented on this firmware. Kept for meters that do implement them.
 */
export function encodeSetClockParam({ meterTypeCode = 0x10, address }, when, instructionNumber, { timeZone = null } = {}) {
  const cmd = commandFrame({ meterTypeCode, address }, WRITE_CONTROL, 0xac12, instructionNumber, 0x08);
  clockParts(when, timeZone).forEach((v, i) => {
    cmd[18 + i] = toBcd(v);
  });
  return sealCommand(cmd);
}

// Section 23.2, data identifier AA05H.
export const VALVE_OPEN = 0x55;
export const VALVE_CLOSED = 0x99;
export const VALVE_FORCED = 0x5a; // "0x5A: Forced Operation; !0x5A: Non-mandatory"
export const VALVE_NOT_FORCED = 0x00;

/**
 * Section 2.6 gives AA05 a 12-byte data field (16-27, CS at 28), and that is
 * the default. It is overridable because the document is not reliable here:
 * section 2.8 states m = 0DH for AA07 while its own byte table puts CS at 40,
 * implying 18H -- and the vendor's working AA07 frame uses 18H. So the firmware
 * follows the byte positions, not the stated length, and a valve frame sized to
 * 18H is worth a try against the meter's "wrong command" (0BH) refusal.
 */
export const VALVE_DATA_LENGTH = 0x0c;

/**
 * Valve open/close (protocol section 2.6, data identifier AA05H).
 *
 *   68 | T | A6-A0 | 01 | 04 | instruction no. | 0000 | 0CH | AA05 |
 *   operation | permission | spare(8) | CS | 16          -- 30 bytes, m = 0CH
 *
 * Byte 18 is the operation (55H open, 99H close) and byte 19 the permission:
 * 5AH forces the operation, any other value leaves it advisory. This physically
 * actuates the valve, so the caller decides which -- there is no default that
 * is safe in every installation.
 */
export function encodeValveOperation(
  { meterTypeCode = 0x10, address },
  { open, forced = false, dataLength = VALVE_DATA_LENGTH },
  instructionNumber,
) {
  const cmd = commandFrame({ meterTypeCode, address }, WRITE_CONTROL, 0xaa05, instructionNumber, dataLength);
  cmd[18] = open ? VALVE_OPEN : VALVE_CLOSED;
  cmd[19] = forced ? VALVE_FORCED : VALVE_NOT_FORCED;
  return sealCommand(cmd);
}

// --- metering resolution and the other meter-type bytes -------------------

/**
 * Section III, "Mounting parameter". These are the three mode bytes AA07 writes
 * and the same values a read response reports back, so both directions share
 * one definition.
 *
 * The metering mode is the reading precision: a 1000 L meter only increments
 * once a whole cubic metre has passed, which is why this meter's total sat
 * frozen at 1000 L until the vendor moved it to 10 L.
 */
export const METERING_MODE_BYTES = { 1: 0x50, 10: 0x60, 100: 0x70, 1000: 0x80 };
export const PAYMENT_MODE_BYTES = { postpaid: 0x48, prepaid: 0x59, 'pre-ladder': 0x4a, hvac_valve: 0x4e };
export const IN_PLACE_MODE_BYTES = { blocked_turn: 0x44, switch: 0x4b };

/**
 * Section 2.8 states m = 0DH, but its own byte table runs the data field from
 * the identifier at 16 to the spare ending at 39, with CS at 40 -- that is 18H.
 * The vendor's accepted frame uses 18H, so the byte positions are right and the
 * stated length is not. Same contradiction the valve command has, resolved the
 * same way.
 */
export const METER_TYPE_DATA_LENGTH = 0x18;

/**
 * Set the meter type: metering resolution, payment mode, valve type
 * (protocol section 2.8, data identifier AA07H).
 *
 *   68 | T | A6-A0 | 03 | 04 | instruction no. | 0000 | 18H | AA07 |
 *   metering | paid | in-place | addr gate | new address(7) |
 *   mfr gate | new mfr(2) | spare(8) | CS | 16            -- 42 bytes, m = 18H
 *
 * Bytes 21 and 29 are the gates that let the rest of the frame rewrite the
 * meter's address and manufacturer code (0xC1 and 0xC3 respectively). They are
 * held at zero and not exposed: this command exists to change the reading
 * precision, and a mistyped field here would change the meter's identity, after
 * which we could no longer address it at all.
 *
 * There is no "leave unchanged" value for the two modes that ride along with
 * the metering mode, so the caller has to restate them. The defaults are what
 * this meter already is (and what the vendor's own accepted frame carries).
 */
export function encodeSetMeterType(
  { meterTypeCode = 0x10, address },
  {
    meteringMode,
    paymentMode = PAYMENT_MODE_BYTES.postpaid,
    inPlaceMode = IN_PLACE_MODE_BYTES.switch,
    dataLength = METER_TYPE_DATA_LENGTH,
  },
  instructionNumber,
) {
  const cmd = commandFrame({ meterTypeCode, address }, WRITE_CONTROL, 0xaa07, instructionNumber, dataLength);
  cmd[18] = meteringMode;
  cmd[19] = paymentMode;
  cmd[20] = inPlaceMode;
  return sealCommand(cmd);
}

// --- where the meter reports to (protocol section III, 0xAC0E / 0xAC0F) ----

export const SERVER_ADDRESS_PRIMARY = 0xac0e;
export const SERVER_ADDRESS_SECONDARY = 0xac0f;

/** m = 2 identifier bytes + 6 parameter bytes; section 2's generic write. */
export const SERVER_ADDRESS_DATA_LENGTH = 0x08;

/**
 * Re-point the meter at a different server (section 2 "server write table
 * parameters", carrying parameter 0xAC0E or 0xAC0F).
 *
 *   68 | T | A6-A0 | 03 | 04 | instruction no. | 0000 | 08H | AC0E |
 *   IP(4) | port(2) | CS | 16                            -- 26 bytes, m = 8
 *
 * Section III lists both server addresses as R/W, 6 bytes, "4-byte address +
 * 2-byte port number, high byte listed first", and the revision of the protocol
 * PDF in this repo has no AA-series command for it -- its section 2 command
 * list ends at 2.10 -- so this looked like the only route.
 *
 * It is not, and it does not work. Writing 0xAC0E with the address the meter
 * already had -- a no-op probe -- came back with error 0BH on 2026-08-05, the
 * instruction number and identifier echoed back intact, which is a meter that
 * parsed the frame and refused the identifier. 0xAC12 fails the same way:
 * generic parameter writes are not implemented on this firmware.
 *
 * Use `encodeSetServerEndpoint` instead. A newer revision of the vendor's
 * document adds section 2.12 with a dedicated AA17H command, which is the
 * AA-series shape this firmware does accept. This one is kept only for meters
 * that predate it.
 */
export function encodeSetServerAddress(
  { meterTypeCode = 0x10, address },
  { ip, port, identifier = SERVER_ADDRESS_PRIMARY },
  instructionNumber,
) {
  const octets = String(ip).split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    throw new FrameError('bad_ip', `expected dotted-quad IPv4, got ${JSON.stringify(ip)}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new FrameError('bad_port', `expected a port in 1-65535, got ${JSON.stringify(port)}`);
  }

  const cmd = commandFrame(
    { meterTypeCode, address },
    WRITE_CONTROL,
    identifier,
    instructionNumber,
    SERVER_ADDRESS_DATA_LENGTH,
  );
  octets.forEach((o, i) => {
    cmd[18 + i] = o;
  });
  cmd.writeUInt16BE(port, 22); // high byte first, as section 5 spells out
  return sealCommand(cmd);
}

// --- re-pointing the meter, the way that works (section 2.12, AA17H) -------

export const SERVER_ENDPOINT_IDENTIFIER = 0xaa17;

/** Byte 15 is "20" in the table, and 20 decimal is what the byte positions say:
 *  data runs 16-35, CS at 36, end frame at 37, so the frame is 38 bytes and
 *  m = 16 + 20 + 2 = 38. Read as 0x20 the arithmetic gives a 50-byte frame that
 *  contradicts the table's own offsets. Where the two disagree this firmware has
 *  consistently followed the byte positions -- see the AA07 note above. */
export const SERVER_ENDPOINT_DATA_LENGTH = 20;

/** Section 2.12 calls 0xA6B6 the "modification enable". Nothing happens without it. */
export const SERVER_ENDPOINT_ENABLE = 0xa6b6;

/**
 * The confirmation word: the low two bytes of the meter address, XORed with
 * 0xA6B6. A meter only accepts the frame if this matches the address it knows
 * itself by, so a broadcast or a mistyped address cannot re-point a fleet.
 *
 * "表地址低两字节分别与A6B6异或" is the whole of the specification and it leaves the
 * byte order open, so this was a coin flip until a meter settled it. **Value
 * order is correct**: the address's two least significant BCD bytes read high
 * byte first -- for 00102608220004 that is 00 04, giving 0x0004 ^ 0xA6B6 =
 * 0xA6B2 -- accepted with success 00H on 2026-08-05. That matches every other
 * multi-byte data field in this document being high byte first.
 *
 * `wireOrder` produces the losing reading (04 00 -> 0xA2B6). Kept only because
 * the two orderings sum identically, so a checksum cannot tell them apart and a
 * meter with the opposite convention would be indistinguishable from a bad
 * frame. Try it if some other meter refuses AA17H with everything else right.
 */
export function serverEndpointConfirmation(address, { wireOrder = false } = {}) {
  const low = addressBytes(address).subarray(0, 2); // wire order: least significant first
  const pair = wireOrder ? low : Buffer.from([low[1], low[0]]);
  return ((pair[0] ^ 0xa6) << 8) | (pair[1] ^ 0xb6);
}

/**
 * Re-point the meter at a different server (section 2.12, identifier AA17H).
 *
 *   68 | T | A6-A0 | 03 | 04 | instruction no. | 0000 | 14H | AA17 |
 *   A6B6 | confirm(2) | IP(4) | port(2) | spare(8) | CS | 16   -- 38 bytes, m = 20
 *
 * **Confirmed against hardware 2026-08-05**: accepted with success 00H, where
 * the 0xAC0E parameter write of the same endpoint was refused 0BH minutes
 * earlier. This firmware implements section 2.x command identifiers and refuses
 * section III parameter ones, and this is the section 2.x form. Sent as a no-op
 * -- writing the address the meter already had -- so acceptance is proof the
 * frame parses, not that the endpoint moved.
 *
 * It is absent from the protocol PDF in this repo -- that revision's section 2
 * ends at 2.10 -- so the layout here comes from a chart the vendor supplied.
 *
 * **This is the only command that can put a meter permanently out of reach.**
 * Downlink rides on the acknowledgement path, so a meter pointed at a server
 * that does not acknowledge its reports can never be commanded again, including
 * to point it back. Verify the destination actually acknowledges before sending
 * this to anything, and do it to one meter first.
 */
export function encodeSetServerEndpoint(
  { meterTypeCode = 0x10, address },
  { ip, port, wireOrderConfirmation = false },
  instructionNumber,
) {
  const octets = String(ip).split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    throw new FrameError('bad_ip', `expected dotted-quad IPv4, got ${JSON.stringify(ip)}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new FrameError('bad_port', `expected a port in 1-65535, got ${JSON.stringify(port)}`);
  }

  const cmd = commandFrame(
    { meterTypeCode, address },
    WRITE_CONTROL,
    SERVER_ENDPOINT_IDENTIFIER,
    instructionNumber,
    SERVER_ENDPOINT_DATA_LENGTH,
  );
  cmd.writeUInt16BE(SERVER_ENDPOINT_ENABLE, 18);
  cmd.writeUInt16BE(serverEndpointConfirmation(address, { wireOrder: wireOrderConfirmation }), 20);
  octets.forEach((o, i) => {
    cmd[22 + i] = o;
  });
  cmd.writeUInt16BE(port, 26);
  // Bytes 28-35 are spare and left zero.
  return sealCommand(cmd);
}

// --- reading the meter's configuration (protocol section 1.1) -------------

export const READ_CONTROL = 0x01; // server issues a read command
export const READ_RESPONSE_CONTROL = 0x81; // meter's reply to that read
export const READ_ALL_IDENTIFIER = 0xa901; // the one documented read: dump parameters

/**
 * Read the meter's stored parameters (protocol section 1.1, identifier A901H).
 *
 *   68 | T | A6-A0 | 03 | 01 | instruction no. | 0000 | 0AH | A901 |
 *   spare(8) | CS | 16                                  -- 28 bytes, m = 0AH
 *
 * The only read the protocol defines, and it returns the whole configuration
 * block in one response. Worth having for its own sake, but its real value is
 * diagnostic: a write that comes back refused says nothing about *why*, whereas
 * this reports the payment mode, metering mode and valve-control shielding that
 * decide whether a valve command is allowed to act at all.
 */
export function encodeReadParameters({ meterTypeCode = 0x10, address }, instructionNumber) {
  const cmd = commandFrame({ meterTypeCode, address }, READ_CONTROL, READ_ALL_IDENTIFIER, instructionNumber, 0x0a);
  // 18-25 spare, left zero: the identifier is the whole request.
  return sealCommand(cmd);
}

// Section III parameter table. The document's section 1.1 response table has
// its label column drifted one row against its byte-position column; these four
// identifiers appear in the parameter table in exactly this order and with
// exactly these widths (AD00 is 2 bytes, AD01/AD02/AD03 are 1 each), which is
// what pins offsets 73-77 down.
const byByte = (map, value = (name) => name) =>
  Object.fromEntries(Object.entries(map).map(([name, byte]) => [byte, value(name)]));

const PAYMENT_MODES = byByte(PAYMENT_MODE_BYTES);
const IN_PLACE_MODES = byByte(IN_PLACE_MODE_BYTES);
const METERING_MODES = byByte(METERING_MODE_BYTES, Number);

/** Section 5, 0xAC0E: 4-byte IP then 2-byte port, high byte first. */
function decodeServerAddress(bytes) {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}:${bytes.readUInt16BE(4)}`;
}

/**
 * Section 9, 0xAD00 valve control function shielding.
 *
 * Each bit governs whether an alarm condition is allowed to shut the valve:
 * "0: Valve closed, 1: Invalid". Default 0x0000 means valve control enabled.
 */
function decodeValveShielding(word) {
  const shielded = (bit) => Boolean(word & (1 << bit));
  return {
    raw: word.toString(16).toUpperCase().padStart(4, '0'),
    enabled: word === 0x0000,
    shieldedConditions: [
      shielded(4) && 'battery_power_loss',
      shielded(5) && 'undervoltage',
      shielded(6) && 'magnetic_interference',
      shielded(7) && 'cover_open',
    ].filter(Boolean),
  };
}

/**
 * The meter's reply to a read (protocol section 1.1, "Response").
 *
 * Only the fields through offset 77 are decoded. Everything past that is tiered
 * pricing and thresholds for prepaid meters, which this postpaid meter does not
 * use; the raw bytes are kept so nothing is lost.
 */
export function decodeReadResponse(buf) {
  const frame = decodeCat1Frame(buf);
  if (frame.control !== READ_RESPONSE_CONTROL) {
    throw new FrameError('not_read_response', `expected control 81H, got ${frame.control.toString(16)}H`);
  }
  if (buf.length < 80) {
    throw new FrameError('too_short', `read response is ${buf.length} bytes, need at least 80`);
  }

  const meteringModeByte = buf[75];
  return {
    ...frame,
    // Echoed back so the response can be checked against the meter's own report
    // -- if these match, the offsets below are reading the right bytes.
    imei: bcdForward(buf.subarray(18, 26)).slice(0, 15),
    imsi: bcdForward(buf.subarray(26, 34)).slice(0, 15),
    iccid: bcdForward(buf.subarray(34, 44)),
    hardwareVersion: buf.subarray(44, 46).toString('hex').toUpperCase(),
    softwareVersion: buf.subarray(46, 48).toString('hex').toUpperCase(),
    tableTypeCode: buf.subarray(48, 50).toString('hex').toUpperCase(),
    meterConfig: decodeTableTypeCode(u16(buf, 48)),
    vendorCode: buf.subarray(50, 52).toString('hex').toUpperCase(),
    dailyReportLimit: buf[52],
    serverAddress1: decodeServerAddress(buf.subarray(53, 59)),
    serverAddress2: decodeServerAddress(buf.subarray(59, 65)),
    cumulativeReportCount: u16(buf, 65),
    reportingMode: decodeReportingMode(buf.subarray(67, 73)),
    // The three that decide whether a valve write is permitted.
    valveControl: decodeValveShielding(u16(buf, 73)),
    meteringModeLitres: METERING_MODES[meteringModeByte] ?? null,
    meteringModeRaw: meteringModeByte.toString(16).toUpperCase().padStart(2, '0'),
    paymentMode: PAYMENT_MODES[buf[76]] ?? `unknown (${buf[76].toString(16).toUpperCase()}H)`,
    inPlaceMode: IN_PLACE_MODES[buf[77]] ?? `unknown (${buf[77].toString(16).toUpperCase()}H)`,
    rest: buf.subarray(78, buf.length - 2).toString('hex').toUpperCase(),
  };
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
