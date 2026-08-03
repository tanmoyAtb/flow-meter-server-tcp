// Hydrosense water level datalogger frame:
//   [count: 1 byte][count x 20-byte records], count 1-100
// Records are little-endian: uint32 unix seconds, then four float32s.

export const RECORD_BYTES = 20;
export const MAX_RECORDS = 100;
export const MAX_DEVICE_ID = 16;
const INVALID_WATER_LEVEL = 999;

export class DatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatalogError';
    this.code = code;
  }
}

/** deviceId doubles as the device's identity, so keep the constraint tight. */
export function isValidDeviceId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_DEVICE_ID && /^[\x21-\x7e]+$/.test(id);
}

export function parseDatalog(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 1) {
    throw new DatalogError('empty_body', 'body is empty');
  }

  const count = buf[0];
  if (count < 1 || count > MAX_RECORDS) {
    throw new DatalogError('bad_count', `count is ${count}, must be 1-${MAX_RECORDS}`);
  }

  const expected = 1 + count * RECORD_BYTES;
  if (buf.length !== expected) {
    throw new DatalogError(
      'bad_length',
      `count=${count} implies a ${expected}-byte body, got ${buf.length}`,
    );
  }

  const records = [];
  for (let i = 0; i < count; i++) {
    const at = 1 + i * RECORD_BYTES;
    const waterLevel = buf.readFloatLE(at + 12);
    const timestamp = buf.readUInt32LE(at);
    if (timestamp === 0) {
      throw new DatalogError('bad_timestamp', `record ${i} has a zero timestamp`);
    }
    records.push({
      timestamp,
      battery: clean(buf.readFloatLE(at + 4)),
      temperature: clean(buf.readFloatLE(at + 8)),
      // 999 is the device's sentinel for "no valid reading".
      waterLevel: Math.round(waterLevel) === INVALID_WATER_LEVEL ? null : clean(waterLevel),
      barometric: clean(buf.readFloatLE(at + 16)), // parsed but ignored downstream
    });
  }
  return { count, records };
}

// float32 -> float64 widening leaves artefacts like 3.7000000476837158.
function clean(n) {
  return Number.isFinite(n) ? Number(n.toFixed(4)) : null;
}
