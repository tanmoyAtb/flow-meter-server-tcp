import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFrame, parseUplink, checksum, FrameError, DATA_9097_BYTES } from '../src/lib/cjt188.js';
import { REFERENCE_FRAME, REFERENCE_INCREMENTS } from './fixtures.js';

test('envelope of the reference frame', () => {
  const f = decodeFrame(REFERENCE_FRAME);
  assert.equal(f.meterType, 'water');
  assert.equal(f.address, '21081300004575');
  assert.equal(f.control, 0x81);
  assert.equal(f.direction, 'uplink');
  assert.equal(f.dataLength, 0xac);
  assert.equal(f.dataIdentifier, '9097');
  assert.equal(f.ser, 0);
  assert.equal(f.data.length, DATA_9097_BYTES);
});

test('checksum matches the value printed in the document', () => {
  assert.equal(checksum(REFERENCE_FRAME), 0xe6);
});

test('every field decodes to the value in the document table', () => {
  const { payload: p } = parseUplink(REFERENCE_FRAME);

  assert.equal(p.cumulativeFlow.unit, 'L');
  assert.equal(p.cumulativeFlow.value, 206.66);
  assert.equal(p.settlementFlow.value, 18.03);
  assert.equal(p.reverseFlow.value, 0);
  assert.equal(p.remainingFlow.value, 0);
  assert.equal(p.flowRate.unit, '1e-4 m^3/h');
  assert.equal(p.flowRate.value, 0);

  assert.equal(p.temperature.value, 27.92);
  assert.equal(p.pressure.value, 0);
  assert.equal(p.ultrasonicSignal, 0);

  assert.equal(p.meterTime.iso, '2021-08-26T04:14:46');

  assert.equal(p.status.valve, 'open');
  assert.equal(p.status.batteryVoltageLow, false);
  // Status byte 2 is 02H -- D1 set. The document leaves this undecoded.
  assert.equal(p.status.alarms.emptyPipe, true);
  assert.equal(p.status.alarms.backflow, false);

  assert.equal(p.signalStrength, -76);
  assert.equal(p.signalQuality, 18);
  assert.equal(p.transmissionCount, 11);
  assert.equal(p.iccid, '89861119253017474430');
  assert.equal(p.imei, '864823047988050');
  assert.equal(p.uploadFlag, 0x01);
  assert.deepEqual(p.timingScheme, [4]);
  assert.equal(p.freeze.cutoffHour, 0);
  assert.equal(p.freeze.cutoffFlow, 206.66);
});

test('47 half-hourly slots, newest first, matching the document table', () => {
  const { payload: p } = parseUplink(REFERENCE_FRAME);

  assert.equal(p.increments.length, 47);
  assert.equal(p.slotCountMismatch, null);
  assert.equal(p.increments[0].time, '23:30');
  assert.equal(p.increments.at(-1).time, '00:30');

  const nonZero = Object.fromEntries(
    p.increments.filter((s) => s.value !== 0).map((s) => [s.time, s.value]),
  );
  assert.deepEqual(nonZero, REFERENCE_INCREMENTS);
});

test('a corrupted byte is caught by the checksum', () => {
  const bad = Buffer.from(REFERENCE_FRAME);
  bad[20] ^= 0xff;
  assert.throws(() => parseUplink(bad), (e) => e instanceof FrameError && e.code === 'bad_checksum');
});

test('envelope violations are reported distinctly', () => {
  const cases = [
    [Buffer.alloc(4), 'too_short'],
    [(() => { const b = Buffer.from(REFERENCE_FRAME); b[0] = 0x69; return b; })(), 'bad_start'],
    [(() => { const b = Buffer.from(REFERENCE_FRAME); b[b.length - 1] = 0x17; return b; })(), 'bad_end'],
    [(() => { const b = Buffer.from(REFERENCE_FRAME); b[10] = 0x20; return b; })(), 'bad_length'],
  ];
  for (const [buf, code] of cases) {
    assert.throws(() => parseUplink(buf), (e) => e instanceof FrameError && e.code === code, code);
  }
});

test('non-9097 identifiers are rejected rather than mis-parsed', () => {
  // The section 3.2 valve command: a well-formed frame with identifier A017.
  const valve = Buffer.from('6820754500001308210404A017005592', 'hex');
  const frame = Buffer.concat([valve, Buffer.from([0x16])]);
  assert.throws(
    () => parseUplink(frame),
    (e) => e instanceof FrameError && e.code === 'unsupported_identifier',
  );
});

test('valve and battery status bits decode across all states', () => {
  const build = (b1, b2) => {
    const f = Buffer.from(REFERENCE_FRAME);
    f[14 + 39] = b1;
    f[14 + 40] = b2;
    f[f.length - 2] = checksum(f);
    return parseUplink(f).payload.status;
  };

  assert.equal(build(0x00, 0x00).valve, 'open');
  assert.equal(build(0x01, 0x00).valve, 'closed');
  assert.equal(build(0x03, 0x00).valve, 'abnormal');
  assert.equal(build(0x04, 0x00).batteryVoltageLow, true);

  const all = build(0x00, 0x3f).alarms;
  assert.deepEqual(all, {
    batteryLevel: true,
    emptyPipe: true,
    backflow: true,
    overRange: true,
    waterTemperature: true,
    ee: true,
  });
});

test('flow scales with the unit byte', () => {
  const withUnit = (unit) => {
    const f = Buffer.from(REFERENCE_FRAME);
    f[14] = unit;
    f[f.length - 2] = checksum(f);
    return parseUplink(f).payload.cumulativeFlow;
  };

  assert.equal(withUnit(0x2b).value, 206.66); // L        -> 206660 x 0.001
  assert.equal(withUnit(0x2e).value, 206660); // 1 m^3    -> 206660 x 1
  assert.equal(withUnit(0x29).value, 2.0666); // 0.01 L   -> 206660 x 1e-5
  assert.equal(withUnit(0x00).value, null); // unknown unit, non-zero reading
  assert.equal(withUnit(0x00).raw, 206660); // ...but the raw count survives
});
