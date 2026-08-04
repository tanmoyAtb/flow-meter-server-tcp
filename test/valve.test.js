import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeValveOperation,
  decodeCat1Frame,
  WRITE_CONTROL,
  VALVE_OPEN,
  VALVE_CLOSED,
  VALVE_FORCED,
  VALVE_NOT_FORCED,
} from '../src/lib/cat1.js';
import { checksum } from '../src/lib/cjt188.js';
import { createApp } from '../src/app.js';
import { openStore } from '../src/store/memory.js';
import { createCommandQueue } from '../src/commands.js';
import { DEVICE_METER_ADDRESS } from './fixtures.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const target = { meterTypeCode: 0x10, address: DEVICE_METER_ADDRESS };

/**
 * A command the vendor's own server sends and this meter accepts, supplied by
 * the vendor on 2026-08-04. It is an AA07 configuration write, not a valve
 * operation, so it is not a fixture for the payload -- but bytes 0-14 are the
 * shape every command has to have, and ours had byte 9 wrong. Pinned here so it
 * cannot regress.
 */
const VENDOR_ACCEPTED_FRAME = Buffer.from(
  '68100400220826100001043A37000018AA0760484B000000000000000000000000000000000000374516',
  'hex',
);

// --- encoder (protocol section 2.6, identifier AA05H) ---------------------

test('the vendor frame validates under our own checksum rule', () => {
  // If this fails, the frame was mis-transcribed and proves nothing.
  assert.equal(VENDOR_ACCEPTED_FRAME.at(-2), checksum(VENDOR_ACCEPTED_FRAME));
  assert.equal(VENDOR_ACCEPTED_FRAME.at(-1), 0x16);
  assert.equal(16 + VENDOR_ACCEPTED_FRAME[15] + 2, VENDOR_ACCEPTED_FRAME.length);
});

test('our command header matches the accepted frame up to the length byte', () => {
  // Bytes 0-14 are identifier-independent, so with the same address and
  // instruction number they must match exactly. Byte 15 must NOT: the data
  // length is per-command, 0CH for AA05 (section 2.6) against 18H for the
  // vendor's AA07 (section 2.8, data field 16-39).
  const cmd = encodeValveOperation(target, { open: true }, 0x3a37);
  assert.deepEqual(cmd.subarray(0, 15), VENDOR_ACCEPTED_FRAME.subarray(0, 15));
  assert.equal(cmd[9], 0x01); // the byte we had as 03H on every refused command
  assert.equal(cmd[15], 0x0c);
  assert.equal(VENDOR_ACCEPTED_FRAME[15], 0x18);
});

test('the vendor AA07 payload decodes as section 2.8 says it should', () => {
  // Confirms the frame is a meter-type write, not a valve command: the three
  // mode bytes match section III, and both "allow modification" gates are shut.
  const f = VENDOR_ACCEPTED_FRAME;
  assert.equal(f.readUInt16BE(16), 0xaa07);
  assert.equal(f[18], 0x60); // metering mode: 10 L per count
  assert.equal(f[19], 0x48); // paid mode: postpaid
  assert.equal(f[20], 0x4b); // in-place mode: switch
  assert.equal(f[21], 0x00); // address modification NOT enabled (0xC1 would)
  assert.equal(f[29], 0x00); // manufacturer modification NOT enabled (0xC3 would)
});

test('valve command matches the documented layout', () => {
  const cmd = encodeValveOperation(target, { open: false }, 0x0042);
  assert.equal(cmd.length, 30); // section 2.6: CS at 28, end frame at 29
  assert.equal(cmd[0], 0x68);
  assert.equal(cmd[9], 0x01); // server-originated, not the document's 03H
  assert.equal(cmd[10], WRITE_CONTROL); // 04H
  assert.equal(cmd.readUInt16BE(11), 0x0042);
  assert.equal(cmd.readUInt16BE(13), 0x0000); // spare
  assert.equal(cmd[15], 0x0c); // section 2.6 data length 12
  assert.equal(cmd.readUInt16BE(16), 0xaa05); // data identifier
  assert.equal(cmd.at(-1), 0x16);
  assert.equal(cmd.at(-2), checksum(cmd));
  assert.equal(16 + cmd[15] + 2, cmd.length);
});

test('open sends 55H and close sends 99H', () => {
  assert.equal(encodeValveOperation(target, { open: true }, 1)[18], VALVE_OPEN);
  assert.equal(encodeValveOperation(target, { open: false }, 1)[18], VALVE_CLOSED);
  assert.equal(VALVE_OPEN, 0x55);
  assert.equal(VALVE_CLOSED, 0x99);
});

test('the permission byte is 5AH only when forced is requested', () => {
  assert.equal(encodeValveOperation(target, { open: false, forced: true }, 1)[19], VALVE_FORCED);
  assert.equal(encodeValveOperation(target, { open: false, forced: false }, 1)[19], VALVE_NOT_FORCED);
  // Not forced by default: forcing a valve should never be implicit.
  assert.equal(encodeValveOperation(target, { open: false }, 1)[19], VALVE_NOT_FORCED);
});

test('the spare block is left zeroed', () => {
  const cmd = encodeValveOperation(target, { open: true }, 1);
  assert.equal(cmd.subarray(20, 28).toString('hex'), '0000000000000000');
});

test('the command carries the addressed meter', () => {
  const cmd = encodeValveOperation(target, { open: false }, 1);
  assert.equal(decodeCat1Frame(cmd).address, DEVICE_METER_ADDRESS);
});

// --- API ------------------------------------------------------------------

async function serve() {
  const commands = createCommandQueue();
  const app = createApp(openStore(), silent, { commands });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, commands, server };
}

const postValve = (base, body) =>
  fetch(`${base}/api/v1/meters/${DEVICE_METER_ADDRESS}/valve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('closing the valve queues a command', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  const res = await postValve(base, { state: 'closed' });
  assert.equal(res.status, 202);
  const cmd = commands.nextFor(DEVICE_METER_ADDRESS);
  assert.equal(cmd.type, 'valve');
  assert.equal(cmd.build(1)[18], VALVE_CLOSED);
});

test('state is required -- a missing state must not fall through to a default', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  const res = await postValve(base, {});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, 'bad_state');
  assert.equal(commands.list().length, 0);
});

test('an unrecognised state is rejected rather than guessed at', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  for (const state of ['shut', 'OPEN', true, null]) {
    assert.equal((await postValve(base, { state })).status, 400);
  }
  assert.equal(commands.list().length, 0);
});

test('forced must be requested explicitly', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  await postValve(base, { state: 'closed' });
  assert.equal(commands.nextFor(DEVICE_METER_ADDRESS).build(1)[19], VALVE_NOT_FORCED);

  const { base: b2, commands: c2, server: s2 } = await serve();
  t.after(() => s2.close());
  await postValve(b2, { state: 'closed', forced: true });
  assert.equal(c2.nextFor(DEVICE_METER_ADDRESS).build(1)[19], VALVE_FORCED);
});

test('valve and clock commands queue independently for the same meter', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  await postValve(base, { state: 'closed' });
  await fetch(`${base}/api/v1/meters/${DEVICE_METER_ADDRESS}/time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

  const all = commands.list(DEVICE_METER_ADDRESS);
  assert.deepEqual(all.map((c) => c.type), ['valve', 'set_clock']);
  // FIFO: the valve command was queued first, so it goes out first.
  assert.equal(commands.nextFor(DEVICE_METER_ADDRESS).type, 'valve');
});
