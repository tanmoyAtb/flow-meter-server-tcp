// CJ/T 188-2004 frame decoder for NB-IoT water meters.
//
// Frame layout:
//   68H | T(1) | A0-A6(7) | C(1) | L(1) | DI0 DI1(2) | SER(1) | DATA(L-3) | CS(1) | 16H
//
// Every offset in decode9097() was verified byte-for-byte against the worked
// example in section 3.1.1 of the protocol PDF. Two of them contradict the
// field table in that same document -- see TEMPERATURE_BYTES and SLOT_COUNT.

import { bcdForward, bcdReverse, bcdByte, isBcd } from './bcd.js';

const FRAME_START = 0x68;
const FRAME_END = 0x16;
const HEADER_BYTES = 14; // 68 | T | A0-A6 | C | L | DI0 DI1 | SER
const TRAILER_BYTES = 2; // CS | 16

// The section 3.1 field table calls temperature 2 bytes. The worked example
// carries 3 (92 27 00), and at 2 bytes every field from the timestamp onward
// decodes to garbage. The trailing byte is undocumented; we surface it raw.
const TEMPERATURE_BYTES = 3;

// The document labels the trailing block "48 freeze-data" points, but that
// count includes the 00:00 cutoff pair stored separately at offsets 70-74.
// The half-hourly series itself runs 23:30 down to 00:30 = 47 slots.
const SLOT_COUNT = 47;

const FIXED_FIELD_BYTES = 75; // everything before the half-hourly block
export const DATA_9097_BYTES = FIXED_FIELD_BYTES + SLOT_COUNT * 2; // 169

export const METER_TYPES = { 0x10: 'water', 0x20: 'heat' };

// Data Format 1 -- cumulative flow unit, expressed as a multiplier to m^3.
const FLOW_UNITS = {
  0x29: { label: '0.01 L', m3: 1e-5 },
  0x2a: { label: '0.1 L', m3: 1e-4 },
  0x2b: { label: 'L', m3: 1e-3 },
  0x2c: { label: '0.01 m^3', m3: 1e-2 },
  0x2d: { label: '0.1 m^3', m3: 1e-1 },
  0x2e: { label: '1 m^3', m3: 1 },
};

// Data Format 2 -- instantaneous flow rate unit, as a multiplier to m^3/h.
const RATE_UNITS = {
  0x32: { label: '1e-7 m^3/h', m3h: 1e-7 },
  0x33: { label: '1e-6 m^3/h', m3h: 1e-6 },
  0x34: { label: '1e-5 m^3/h', m3h: 1e-5 },
  0x35: { label: '1e-4 m^3/h', m3h: 1e-4 },
  0x36: { label: '1e-3 m^3/h', m3h: 1e-3 },
  0x37: { label: '1e-2 m^3/h', m3h: 1e-2 },
};

const VALVE_STATES = { 0: 'open', 1: 'closed', 3: 'abnormal' };

export class FrameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FrameError';
    this.code = code;
  }
}

/** Sum of bytes [0, end), truncated to one byte. */
export function checksum(buf, end = buf.length - TRAILER_BYTES) {
  let sum = 0;
  for (let i = 0; i < end; i++) sum = (sum + buf[i]) & 0xff;
  return sum;
}

/**
 * Validate the envelope and split off the DATA field.
 * Throws FrameError on anything malformed.
 */
export function decodeFrame(buf) {
  if (!Buffer.isBuffer(buf)) throw new FrameError('not_buffer', 'frame must be a Buffer');
  if (buf.length < HEADER_BYTES + TRAILER_BYTES) {
    throw new FrameError('too_short', `frame is ${buf.length} bytes, minimum is 16`);
  }
  if (buf[0] !== FRAME_START) {
    throw new FrameError('bad_start', `expected 68H start byte, got ${buf[0].toString(16)}H`);
  }
  if (buf[buf.length - 1] !== FRAME_END) {
    throw new FrameError('bad_end', `expected 16H end byte, got ${buf.at(-1).toString(16)}H`);
  }

  // L counts DI(2) + SER(1) + DATA, so DATA is L-3 and the whole frame is L+13.
  const dataLength = buf[10];
  const expectedTotal = dataLength - 3 + HEADER_BYTES + TRAILER_BYTES;
  if (buf.length !== expectedTotal) {
    throw new FrameError(
      'bad_length',
      `L=${dataLength} implies a ${expectedTotal}-byte frame, got ${buf.length}`,
    );
  }

  const expectedCs = checksum(buf);
  const actualCs = buf[buf.length - 2];
  if (expectedCs !== actualCs) {
    throw new FrameError(
      'bad_checksum',
      `checksum is ${actualCs.toString(16).padStart(2, '0')}H, computed ${expectedCs.toString(16).padStart(2, '0')}H`,
    );
  }

  const addressBytes = buf.subarray(2, 9);
  if (!isBcd(addressBytes)) {
    throw new FrameError('bad_address', 'address field is not valid BCD');
  }

  const control = buf[9];
  return {
    meterTypeCode: buf[1],
    meterType: METER_TYPES[buf[1]] ?? 'unknown',
    // A0-A6 are transmitted low digit first; reverse for the printed address.
    address: bcdReverse(addressBytes),
    control,
    direction: control & 0x80 ? 'uplink' : 'downlink',
    dataLength,
    dataIdentifier: bcdForward(buf.subarray(11, 13)),
    ser: buf[13],
    data: buf.subarray(HEADER_BYTES, buf.length - TRAILER_BYTES),
  };
}

/** 4-byte BCD flow value, low byte first, scaled by its unit byte. */
function readFlow(data, offset, units, places = 6) {
  const unitCode = data[offset];
  const valueBytes = data.subarray(offset + 1, offset + 5);
  const digits = bcdReverse(valueBytes);
  const raw = isBcd(valueBytes) ? Number(digits) : null;
  const unit = units[unitCode];
  // A zero reading is unambiguous even when the unit byte is one we don't know
  // (meters send 00H for fields they don't populate, e.g. remaining flow).
  const scale = unit ? unit.m3 ?? unit.m3h : raw === 0 ? 1 : null;
  return {
    unitCode,
    unit: unit?.label ?? null,
    raw,
    value: raw !== null && scale !== null ? round(raw * scale, places) : null,
  };
}

// BCD scaling produces values like 206.66000000000001; trim the float noise.
function round(n, places) {
  return Number(n.toFixed(places));
}

/** Data Format 3: BYTE1 = tenths/hundredths, BYTE2 = tens/ones. */
function readTemperature(bytes) {
  const whole = bcdByte(bytes[1]);
  const frac = bcdByte(bytes[0]);
  if (whole === null || frac === null) return { value: null, raw: bytes.toString('hex') };
  return {
    value: round(whole + frac / 100, 2),
    // Third byte is present on the wire but undocumented; 00 in the reference frame.
    reserved: bytes.length > 2 ? bytes[2] : null,
    raw: bytes.toString('hex'),
  };
}

/** Data Format 4: BYTE1 = hundredths/thousandths, BYTE2 = ones/tenths. */
function readPressure(bytes) {
  const high = bcdByte(bytes[1]);
  const low = bcdByte(bytes[0]);
  if (high === null || low === null) return { value: null, raw: bytes.toString('hex') };
  const ones = Math.floor(high / 10);
  const tenths = high % 10;
  return {
    value: round(ones + tenths / 10 + low / 1000, 3),
    raw: bytes.toString('hex'),
  };
}

/** Data Format 5: sec, min, hour, day, month, year-low, year-high (all BCD). */
function readMeterTime(bytes) {
  const parts = Array.from(bytes, bcdByte);
  if (parts.some((p) => p === null)) return { iso: null, raw: bytes.toString('hex') };
  const [second, minute, hour, day, month, yearLow, yearHigh] = parts;
  const year = yearHigh * 100 + yearLow;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  // Meter-local wall clock. There is no timezone in the protocol, so this is
  // deliberately not a UTC instant -- it is stored and compared as a string.
  return {
    iso: `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`,
    year,
    month,
    day,
    hour,
    minute,
    second,
    raw: bytes.toString('hex'),
  };
}

/**
 * Data Format 6. The document numbers the two status bytes BYTE 1 and BYTE 2
 * but never says which is transmitted first; we take them in wire order and
 * expose `raw` so the mapping can be flipped if a live meter disagrees.
 */
function readStatus(bytes) {
  const [b1, b2] = bytes;
  return {
    raw: bytes.toString('hex'),
    valve: VALVE_STATES[b1 & 0x03] ?? 'reserved',
    batteryVoltageLow: Boolean(b1 & 0x04),
    alarms: {
      batteryLevel: Boolean(b2 & 0x01),
      emptyPipe: Boolean(b2 & 0x02),
      backflow: Boolean(b2 & 0x04),
      overRange: Boolean(b2 & 0x08),
      waterTemperature: Boolean(b2 & 0x10),
      ee: Boolean(b2 & 0x20),
    },
  };
}

/** 16-digit BCD IMEI carries a leading pad digit; the real IMEI is 15 digits. */
function normaliseImei(digits) {
  return digits.length === 16 && digits.startsWith('0') ? digits.slice(1) : digits;
}

/**
 * Decode the DATA field of an 819097 upload.
 * `data` is the DATA field only, as returned by decodeFrame().
 */
export function decode9097(data) {
  if (data.length < FIXED_FIELD_BYTES) {
    throw new FrameError(
      'data_too_short',
      `9097 payload needs at least ${FIXED_FIELD_BYTES} bytes, got ${data.length}`,
    );
  }

  const cumulative = readFlow(data, 0, FLOW_UNITS);
  const settlement = readFlow(data, 5, FLOW_UNITS);
  const reverse = readFlow(data, 10, FLOW_UNITS);
  const remaining = readFlow(data, 15, FLOW_UNITS);
  const flowRate = readFlow(data, 20, RATE_UNITS, 8); // rate units go down to 1e-7

  const tempEnd = 25 + TEMPERATURE_BYTES;
  const temperature = readTemperature(data.subarray(25, tempEnd));
  const pressure = readPressure(data.subarray(tempEnd, tempEnd + 2));
  const ultrasonic = data.readUInt16BE(tempEnd + 2);
  const meterTime = readMeterTime(data.subarray(32, 39));
  const status = readStatus(data.subarray(39, 41));

  const iccid = bcdForward(data.subarray(47, 57));
  const imeiDigits = bcdForward(data.subarray(57, 65));

  // Timing scheme: up to four BCD upload hours, FFH marking an unused slot.
  // (The downlink form in section 3.3 is five bytes -- it prefixes a mode byte.)
  const timingScheme = Array.from(data.subarray(66, 70))
    .filter((b) => b !== 0xff)
    .map(bcdByte)
    .filter((h) => h !== null);

  const freezeCutoffHour = bcdByte(data[70]);
  const cutoffDigits = bcdReverse(data.subarray(71, 75));
  const cutoffRaw = isBcd(data.subarray(71, 75)) ? Number(cutoffDigits) : null;

  // The half-hourly block has no unit byte of its own; it is scaled by the
  // cumulative flow unit. With unit 2BH that gives x0.001 m^3, which reproduces
  // the reference frame exactly.
  const scale = FLOW_UNITS[cumulative.unitCode]?.m3 ?? null;
  const slotBytes = data.subarray(FIXED_FIELD_BYTES);
  const slotCount = Math.floor(slotBytes.length / 2);
  const increments = [];
  for (let i = 0; i < slotCount; i++) {
    const minutesFromMidnight = 23 * 60 + 30 - i * 30;
    if (minutesFromMidnight < 0) break;
    const raw = slotBytes.readUInt16BE(i * 2);
    increments.push({
      time: `${String(Math.floor(minutesFromMidnight / 60)).padStart(2, '0')}:${String(minutesFromMidnight % 60).padStart(2, '0')}`,
      raw,
      value: scale !== null ? round(raw * scale, 6) : null,
    });
  }

  return {
    cumulativeFlow: cumulative,
    settlementFlow: settlement,
    reverseFlow: reverse,
    remainingFlow: remaining,
    flowRate,
    temperature,
    pressure,
    ultrasonicSignal: ultrasonic,
    meterTime,
    status,
    signalStrength: data.readInt16BE(41), // signed: FFB4 = -76 dBm
    signalQuality: data.readUInt16BE(43),
    transmissionCount: data.readUInt16BE(45),
    iccid,
    imei: normaliseImei(imeiDigits),
    uploadFlag: data[65],
    timingScheme,
    freeze: {
      cutoffHour: freezeCutoffHour,
      cutoffFlow: cutoffRaw !== null && scale !== null ? round(cutoffRaw * scale, 6) : null,
    },
    increments,
    // Flagged rather than rejected: a meter with a different slot count still
    // yields usable totals, and the caller decides whether to care.
    slotCountMismatch: slotCount === SLOT_COUNT ? null : { expected: SLOT_COUNT, got: slotCount },
  };
}

/** Full decode of an uplink frame. Throws FrameError if it is not 819097. */
export function parseUplink(buf) {
  const frame = decodeFrame(buf);
  if (frame.dataIdentifier !== '9097') {
    throw new FrameError(
      'unsupported_identifier',
      `only data identifier 9097 is supported, got ${frame.dataIdentifier}`,
    );
  }
  return { ...frame, data: undefined, payload: decode9097(frame.data) };
}
