import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCat1, decodeCat1Frame, isCat1Frame, decodeTableTypeCode } from '../src/lib/cat1.js';
import { FrameError } from '../src/lib/frame.js';
import { CAT1_FRAME, CAT1_FRAMES, DEVICE_METER_ADDRESS, REFERENCE_FRAME } from './fixtures.js';

test('recognises CAT-1 by device type 03H + control code 97H', () => {
  assert.equal(isCat1Frame(CAT1_FRAME), true);
  // The CJ/T 188 reference frame must not be misrouted to this decoder.
  assert.equal(isCat1Frame(REFERENCE_FRAME), false);
});

test('length lives at offset 15, not offset 10', () => {
  const frame = decodeCat1Frame(CAT1_FRAME);
  assert.equal(frame.dataLength, 0x46); // 70
  assert.equal(16 + frame.dataLength + 2, CAT1_FRAME.length);
  // Byte 10 is the control code and must not be read as a length.
  assert.equal(frame.control, 0x97);
  assert.equal(frame.controlName, 'meter_report');
});

test('decodes the envelope of a real frame', () => {
  const frame = decodeCat1Frame(CAT1_FRAME);
  assert.equal(frame.protocol, 'cat1');
  assert.equal(frame.address, DEVICE_METER_ADDRESS);
  assert.equal(frame.meterTypeCode, 0x10);
  assert.equal(frame.meterType, 'cold water');
  assert.equal(frame.deviceType, 0x03);
  assert.equal(frame.instructionNumber, 0);
  assert.equal(frame.packetType, 0x03);
  assert.equal(frame.packetName, 'postpaid_standard');
});

test('reporting type 0002H decodes as a button-press trigger', () => {
  const frame = decodeCat1Frame(CAT1_FRAME);
  assert.equal(frame.reportingType, 0x0002);
  assert.deepEqual(frame.reportingTriggers, ['trigger']);
});

test('decodes packet 03 payload, including the flow reading', () => {
  const { payload: p } = parseCat1(CAT1_FRAME);
  assert.equal(p.cumulativeUsageLitres, 1000); // 1.000 m3
  assert.equal(p.dailyUsageLitres, 0);
  assert.equal(p.monthlyUsageLitres, 0);
  assert.equal(p.meterClock.iso, '2023-09-23T06:02:46');
  assert.equal(p.imei, '867512079825846');
  assert.equal(p.iccid, '89860422152570009782');
  assert.equal(p.voltageVolts, 3.614);
  assert.equal(p.signalStrengthDbm, -94);
  assert.equal(p.signalQualityDb, -9);
  assert.equal(p.snrDb, 23);
  assert.equal(p.manufacturerCode, 'C22C');
});

test('status word 0000H means valve open and no alarms', () => {
  const { payload: p } = parseCat1(CAT1_FRAME);
  assert.equal(p.status.valve, 'open');
  assert.equal(p.status.batteryUndervoltage, false);
  assert.equal(p.status.magneticInterference, false);
  assert.equal(p.status.coverOpen, false);
});

test('reporting mode matches the documented C0 default of 1440 minutes', () => {
  const { payload: p } = parseCat1(CAT1_FRAME);
  assert.equal(p.reportingMode.scheme, 0xc0);
  assert.equal(p.reportingMode.intervalMinutes, 1440);
});

test('report counters step by one across the six captured frames', () => {
  const decoded = CAT1_FRAMES.map((f) => parseCat1(f).payload);
  assert.deepEqual(
    decoded.map((p) => p.cumulativeReportCount),
    [16, 17, 18, 19, 20, 21],
  );
  assert.deepEqual(
    decoded.map((p) => p.dailyReportCount),
    [2, 3, 4, 5, 6, 7],
  );
});

test('cumulative usage is unchanged across all six -- no water was drawn', () => {
  const usages = CAT1_FRAMES.map((f) => parseCat1(f).payload.cumulativeUsageLitres);
  assert.deepEqual(usages, [1000, 1000, 1000, 1000, 1000, 1000]);
});

test('meter clock advances in step with the captured transmissions', () => {
  const clocks = CAT1_FRAMES.map((f) => parseCat1(f).payload.meterClock.iso);
  assert.deepEqual(clocks, [
    '2023-09-23T06:02:46',
    '2023-09-23T06:18:27',
    '2023-09-23T06:22:23',
    '2023-09-23T06:26:55',
    '2023-09-23T06:29:17',
    '2023-09-23T06:29:46',
  ]);
});

test('the eight bytes past the documented table are surfaced as spare', () => {
  // Section 3.3 stops at CS=78/end=79 (m=62); real meters send m=70.
  const { payload: p } = parseCat1(CAT1_FRAME);
  assert.equal(p.spare, '0000000000000000');
});

test('every captured frame has a valid checksum', () => {
  for (const frame of CAT1_FRAMES) {
    assert.doesNotThrow(() => parseCat1(frame));
  }
});

test('a corrupted byte is rejected, not silently mis-decoded', () => {
  const bad = Buffer.from(CAT1_FRAME);
  bad[60] ^= 0xff; // flip a byte inside the cumulative usage field
  assert.throws(() => parseCat1(bad), (err) => err instanceof FrameError && err.code === 'bad_checksum');
});

test('an undecoded packet type reports which type it was', () => {
  const other = Buffer.from(CAT1_FRAME);
  other[16] = 0x06; // daily history packet
  // Re-checksum so the failure is about the packet type, not the checksum.
  let sum = 0;
  for (let i = 0; i < other.length - 2; i++) sum = (sum + other[i]) & 0xff;
  other[other.length - 2] = sum;

  assert.throws(
    () => parseCat1(other),
    (err) => err instanceof FrameError && err.code === 'unsupported_packet_type',
  );
});

test('table type code decodes the meter configuration', () => {
  const { payload: p } = parseCat1(CAT1_FRAME);
  assert.equal(p.tableTypeCode, '0027');
  assert.equal(p.meterConfig.paymentType, 'postpaid'); // agrees with packet type 03
  assert.equal(p.meterConfig.valveType, 'switch');
  // The reason a short run of water never moves the counters.
  assert.equal(p.meterConfig.resolutionLitres, 1000);
});

test('metering resolution decodes across all four scopes', () => {
  const scopes = { 0b00: 1, 0b01: 10, 0b10: 100, 0b11: 1000 };
  for (const [bits, litres] of Object.entries(scopes)) {
    assert.equal(decodeTableTypeCode(0x0024 | Number(bits)).resolutionLitres, litres);
  }
});

test('payment type decodes across all four modes', () => {
  const modes = { 0b00: 'prepaid', 0b01: 'pre-ladder', 0b10: 'postpaid', 0b11: 'hvac_valve' };
  for (const [bits, name] of Object.entries(modes)) {
    assert.equal(decodeTableTypeCode((Number(bits) << 4) | 0b0111).paymentType, name);
  }
});
