import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeReadParameters,
  decodeReadResponse,
  decodeCat1Frame,
  READ_CONTROL,
  READ_RESPONSE_CONTROL,
  READ_ALL_IDENTIFIER,
} from '../src/lib/cat1.js';
import { FrameError, checksum } from '../src/lib/cjt188.js';
import { createApp } from '../src/app.js';
import { openStore } from '../src/store/memory.js';
import { createCommandQueue } from '../src/commands.js';
import { DEVICE_METER_ADDRESS } from './fixtures.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const target = { meterTypeCode: 0x10, address: DEVICE_METER_ADDRESS };

// --- encoder (protocol section 1.1) --------------------------------------

test('read command matches the documented layout', () => {
  const cmd = encodeReadParameters(target, 0x0007);
  assert.equal(cmd.length, 28); // section 1.1: CS at 26, end frame at 27
  assert.equal(cmd[0], 0x68);
  assert.equal(cmd[9], 0x01); // server-originated, not the document's 03H
  assert.equal(cmd[10], READ_CONTROL); // 01H, not the 04H used by writes
  assert.equal(cmd.readUInt16BE(11), 0x0007);
  assert.equal(cmd.readUInt16BE(13), 0x0000); // spare
  assert.equal(cmd[15], 0x0a); // section 1.1 data length 10 = identifier(2) + spare(8)
  assert.equal(cmd.readUInt16BE(16), READ_ALL_IDENTIFIER); // A901H
  assert.equal(cmd.subarray(18, 26).toString('hex'), '0000000000000000');
  assert.equal(cmd.at(-2), checksum(cmd));
  assert.equal(cmd.at(-1), 0x16);
  assert.equal(16 + cmd[15] + 2, cmd.length);
});

test('the read command addresses the right meter', () => {
  const cmd = encodeReadParameters(target, 1);
  assert.equal(decodeCat1Frame(cmd).address, DEVICE_METER_ADDRESS);
});

// --- response decoder -----------------------------------------------------

/**
 * A section 1.1 response built to the document's layout, carrying this meter's
 * real identifiers so the offsets can be checked against known-good values.
 */
function buildReadResponse(overrides = {}) {
  const buf = Buffer.alloc(115);
  buf[0] = 0x68;
  buf[1] = 0x10;
  Buffer.from('04002208261000', 'hex').copy(buf, 2); // address, wire order
  buf[9] = 0x03;
  buf[10] = READ_RESPONSE_CONTROL;
  buf.writeUInt16BE(overrides.instructionNumber ?? 3, 11);
  buf.writeUInt16BE(0x0000, 13);
  buf[15] = 0x61; // 97 data bytes: 16..112
  buf.writeUInt16BE(READ_ALL_IDENTIFIER, 16);

  Buffer.from('8675120798258460', 'hex').copy(buf, 18); // IMEI, 15 digits + pad
  Buffer.from('4040451234567890', 'hex').copy(buf, 26); // IMSI
  Buffer.from('89860422152570009782', 'hex').copy(buf, 34); // ICCID
  Buffer.from('0306', 'hex').copy(buf, 44); // hardware version
  Buffer.from('0300', 'hex').copy(buf, 46); // software version
  Buffer.from('0027', 'hex').copy(buf, 48); // table type code
  Buffer.from('C22C', 'hex').copy(buf, 50); // vendor code
  buf[52] = 10; // daily report limit
  Buffer.from('41016360', 'hex').copy(buf, 53); // 65.1.99.96
  buf.writeUInt16BE(8505, 57);
  Buffer.from('00000000', 'hex').copy(buf, 59);
  buf.writeUInt16BE(0, 63);
  buf.writeUInt16BE(31, 65); // cumulative report count
  Buffer.from('C005A0FFFFFF', 'hex').copy(buf, 67); // reporting mode: every 1440 min
  buf.writeUInt16BE(overrides.valveShielding ?? 0x0000, 73);
  buf[75] = overrides.meteringMode ?? 0x80; // 1000 L per count
  buf[76] = overrides.paymentMode ?? 0x48; // postpaid
  buf[77] = overrides.inPlaceMode ?? 0x4b; // switch

  buf[113] = checksum(buf);
  buf[114] = 0x16;
  return buf;
}

test('the response decodes back the identifiers the meter already reported', () => {
  // The point of this test: these values are known independently from the
  // meter's 97H reports, so agreement here proves the offsets are right.
  const r = decodeReadResponse(buildReadResponse());
  assert.equal(r.address, DEVICE_METER_ADDRESS);
  assert.equal(r.imei, '867512079825846');
  assert.equal(r.iccid, '89860422152570009782');
  assert.equal(r.hardwareVersion, '0306');
  assert.equal(r.softwareVersion, '0300');
  assert.equal(r.tableTypeCode, '0027');
  assert.equal(r.vendorCode, 'C22C');
});

test('valve control shielding decodes the documented default as enabled', () => {
  const r = decodeReadResponse(buildReadResponse());
  assert.equal(r.valveControl.enabled, true);
  assert.deepEqual(r.valveControl.shieldedConditions, []);
});

test('a shielded valve is reported as such, with the conditions named', () => {
  const r = decodeReadResponse(buildReadResponse({ valveShielding: 0x00f0 }));
  assert.equal(r.valveControl.enabled, false);
  assert.deepEqual(r.valveControl.shieldedConditions, [
    'battery_power_loss',
    'undervoltage',
    'magnetic_interference',
    'cover_open',
  ]);
});

test('payment, in-place and metering modes decode from section III', () => {
  const r = decodeReadResponse(buildReadResponse());
  assert.equal(r.paymentMode, 'postpaid');
  assert.equal(r.inPlaceMode, 'switch');
  // Cross-checks the 1000 L granularity independently of the table type code.
  assert.equal(r.meteringModeLitres, 1000);
  assert.equal(r.meterConfig.resolutionLitres, 1000);
});

test('an unknown mode byte is surfaced rather than silently dropped', () => {
  const r = decodeReadResponse(buildReadResponse({ paymentMode: 0x77, meteringMode: 0x11 }));
  assert.match(r.paymentMode, /unknown \(77H\)/);
  assert.equal(r.meteringModeLitres, null);
  assert.equal(r.meteringModeRaw, '11');
});

test('the configured server address is decoded as IP:port', () => {
  const r = decodeReadResponse(buildReadResponse());
  assert.equal(r.serverAddress1, '65.1.99.96:8505');
});

test('a write response is not accepted by the read decoder', () => {
  const buf = buildReadResponse();
  buf[10] = 0x84;
  buf[113] = checksum(buf);
  assert.throws(
    () => decodeReadResponse(buf),
    (err) => err instanceof FrameError && err.code === 'not_read_response',
  );
});

// --- API ------------------------------------------------------------------

test('POST /read queues a read command carrying identifier A901', async (t) => {
  const commands = createCommandQueue();
  const app = createApp(openStore(), silent, { commands });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());

  const res = await fetch(
    `http://127.0.0.1:${server.address().port}/api/v1/meters/${DEVICE_METER_ADDRESS}/read`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  assert.equal(res.status, 202);

  const cmd = commands.nextFor(DEVICE_METER_ADDRESS);
  assert.equal(cmd.type, 'read_parameters');
  const frame = cmd.build(4);
  assert.equal(frame[10], READ_CONTROL);
  assert.equal(frame.readUInt16BE(16), READ_ALL_IDENTIFIER);
});
