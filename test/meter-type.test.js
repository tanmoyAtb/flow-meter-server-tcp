// Setting the metering resolution (protocol section 2.8, identifier AA07H).
//
// This is the only command besides the valve that the vendor has shown us a
// working frame for, so the encoder is checked against that frame byte by byte
// rather than only against the document -- section 2.8 contradicts itself about
// the data length, and the frame is what the meter actually accepted.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeSetMeterType,
  decodeCat1Frame,
  decodeTableTypeCode,
  WRITE_CONTROL,
  METERING_MODE_BYTES,
  PAYMENT_MODE_BYTES,
  IN_PLACE_MODE_BYTES,
  METER_TYPE_DATA_LENGTH,
} from '../src/lib/cat1.js';
import { checksum } from '../src/lib/frame.js';
import { createApp } from '../src/app.js';
import { openStore } from '../src/store/memory.js';
import { createCommandQueue } from '../src/commands.js';
import { DEVICE_METER_ADDRESS } from './fixtures.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const target = { meterTypeCode: 0x10, address: DEVICE_METER_ADDRESS };

/**
 * The frame the vendor's own server sent this meter to move it to 10 L
 * resolution, supplied 2026-08-04. Instruction number 3A37H.
 */
const VENDOR_FRAME = Buffer.from(
  '68100400220826100001043A37000018AA0760484B000000000000000000000000000000000000374516',
  'hex',
);

const at10Litres = (instructionNumber = 0x3a37) =>
  encodeSetMeterType(target, { meteringMode: METERING_MODE_BYTES[10] }, instructionNumber);

// --- encoder --------------------------------------------------------------

test('the command matches the section 2.8 layout', () => {
  const cmd = at10Litres();
  assert.equal(cmd.length, 42); // CS at 40, end frame at 41
  assert.equal(cmd[0], 0x68);
  assert.equal(cmd[9], 0x03); // section I.3
  assert.equal(cmd[10], WRITE_CONTROL); // 04H
  assert.equal(cmd.readUInt16BE(11), 0x3a37);
  assert.equal(cmd.readUInt16BE(13), 0x0000); // spare
  assert.equal(cmd[15], METER_TYPE_DATA_LENGTH); // 18H, not the stated 0DH
  assert.equal(cmd.readUInt16BE(16), 0xaa07);
  assert.equal(cmd.at(-2), checksum(cmd));
  assert.equal(cmd.at(-1), 0x16);
  assert.equal(16 + cmd[15] + 2, cmd.length);
});

test('it reproduces the vendor frame, byte 9 and the vendor spare aside', () => {
  // Bytes 39 differs: the vendor's spare block carries a stray 37H where ours
  // is zeroed, which changes the checksum too. Everything that means anything
  // has to match.
  const cmd = at10Litres();
  assert.deepEqual(cmd.subarray(0, 9), VENDOR_FRAME.subarray(0, 9));
  assert.deepEqual(cmd.subarray(10, 39), VENDOR_FRAME.subarray(10, 39));
  assert.equal(cmd[9], 0x03); // vendor sends 01H; the meter mirrors it, does not check it
  assert.equal(VENDOR_FRAME[9], 0x01);
});

test('the vendor frame validates under our own checksum rule', () => {
  // If this fails the frame was mis-transcribed and the comparison above proves
  // nothing.
  assert.equal(VENDOR_FRAME.at(-2), checksum(VENDOR_FRAME));
  assert.equal(VENDOR_FRAME.at(-1), 0x16);
  assert.equal(16 + VENDOR_FRAME[15] + 2, VENDOR_FRAME.length);
});

test('the metering mode byte carries the requested resolution', () => {
  assert.deepEqual(METERING_MODE_BYTES, { 1: 0x50, 10: 0x60, 100: 0x70, 1000: 0x80 });
  for (const [litres, byte] of Object.entries(METERING_MODE_BYTES)) {
    assert.equal(encodeSetMeterType(target, { meteringMode: byte }, 1)[18], byte, `${litres} L`);
  }
});

test('the payment and valve modes default to what this meter already is', () => {
  const cmd = at10Litres();
  assert.equal(cmd[19], PAYMENT_MODE_BYTES.postpaid); // 48H
  assert.equal(cmd[20], IN_PLACE_MODE_BYTES.switch); // 4BH
});

test('both identity gates stay shut', () => {
  // Byte 21 = C1H would rewrite the meter address from bytes 22-28, byte 29 =
  // C3H the manufacturer code from 30-31. Either one applied by accident leaves
  // a meter we can no longer address.
  const cmd = encodeSetMeterType(target, { meteringMode: METERING_MODE_BYTES[1] }, 1);
  assert.equal(cmd[21], 0x00);
  assert.equal(cmd.subarray(22, 29).toString('hex'), '00000000000000');
  assert.equal(cmd[29], 0x00);
  assert.equal(cmd.subarray(30, 32).toString('hex'), '0000');
});

test('the spare block is left zeroed', () => {
  assert.equal(at10Litres().subarray(32, 40).toString('hex'), '0000000000000000');
});

test('the command carries the addressed meter', () => {
  assert.equal(decodeCat1Frame(at10Litres()).address, DEVICE_METER_ADDRESS);
});

test('the resolution written is the one the table type code reports back', () => {
  // The meter echoes its configuration as 0xAB06 in every report, so a write of
  // 10 L should surface as resolutionLitres 10 there. 0027H -> 0025H is exactly
  // the change observed when the vendor sent the frame above.
  assert.equal(decodeTableTypeCode(0x0027).resolutionLitres, 1000);
  assert.equal(decodeTableTypeCode(0x0025).resolutionLitres, 10);
  assert.equal(decodeTableTypeCode(0x0024).resolutionLitres, 1);
});

// --- API ------------------------------------------------------------------

async function serve() {
  const commands = createCommandQueue();
  const app = createApp(openStore(), silent, { commands });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, commands, server };
}

const postMetering = (base, body) =>
  fetch(`http://${new URL(base).host}/api/v1/meters/${DEVICE_METER_ADDRESS}/metering`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a resolution change queues a command', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  const res = await postMetering(base, { resolutionLitres: 1 });
  assert.equal(res.status, 202);
  const cmd = commands.nextFor(DEVICE_METER_ADDRESS);
  assert.equal(cmd.type, 'set_meter_type');
  assert.equal(cmd.build(1)[18], METERING_MODE_BYTES[1]);
});

test('the resolution is required and must be a documented one', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  for (const body of [{}, { resolutionLitres: 5 }, { resolutionLitres: '10' }, { resolutionLitres: null }]) {
    const res = await postMetering(base, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).reason, 'bad_resolution');
  }
  assert.equal(commands.list().length, 0);
});

test('an unrecognised payment or valve mode is rejected rather than guessed at', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  assert.equal((await postMetering(base, { resolutionLitres: 1, paymentMode: 'pay-later' })).status, 400);
  assert.equal((await postMetering(base, { resolutionLitres: 1, inPlaceMode: 'toggle' })).status, 400);
  assert.equal(commands.list().length, 0);
});

test('the other two modes can be set explicitly', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  await postMetering(base, { resolutionLitres: 100, paymentMode: 'prepaid', inPlaceMode: 'blocked_turn' });
  const frame = commands.nextFor(DEVICE_METER_ADDRESS).build(1);
  assert.equal(frame[18], METERING_MODE_BYTES[100]);
  assert.equal(frame[19], PAYMENT_MODE_BYTES.prepaid);
  assert.equal(frame[20], IN_PLACE_MODE_BYTES.blocked_turn);
});
