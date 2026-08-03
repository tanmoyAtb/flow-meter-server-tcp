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

// --- encoder (protocol section 2.6, identifier AA05H) ---------------------

test('valve command matches the documented layout', () => {
  const cmd = encodeValveOperation(target, { open: false }, 0x0042);
  assert.equal(cmd.length, 30);
  assert.equal(cmd[0], 0x68);
  assert.equal(cmd[9], 0x03);
  assert.equal(cmd[10], WRITE_CONTROL); // 04H
  assert.equal(cmd.readUInt16BE(11), 0x0042);
  assert.equal(cmd.readUInt16BE(13), 0x0000); // spare
  assert.equal(cmd[15], 0x0c); // data length 12
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
