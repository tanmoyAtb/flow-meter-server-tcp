import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { openStore } from '../src/store/memory.js';
import { createCommandQueue } from '../src/commands.js';
import { decodeCat1Frame } from '../src/lib/cat1.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const ADDRESS = '00102608220004';

/** Start the app on an ephemeral port and return its base URL plus the queue. */
async function serve({ apiToken = null } = {}) {
  const commands = createCommandQueue();
  const app = createApp(openStore(), silent, { commands, apiToken });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, commands, server };
}

const queueTime = (base, body) =>
  fetch(`${base}/api/v1/meters/${ADDRESS}/time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * The six BCD clock bytes, wherever the chosen method puts them: AA00 carries a
 * calibration-enable byte first (clock at 19), AC12 does not (clock at 18).
 */
function clockOf(frame) {
  // AA00 spends byte 18 on the calibration-enable flag (section 2.1), AC12
  // does not (section 2 generic write). The identifier is the reliable
  // discriminator.
  const at = frame.readUInt16BE(16) === 0xaa00 ? 19 : 18;
  return frame.subarray(at, at + 6).toString('hex');
}

test('queuing a clock set answers 202, not 200', async (t) => {
  const { base, server } = await serve();
  t.after(() => server.close());

  const res = await queueTime(base, {});
  // 202: recorded, but the meter has not acted on it yet.
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.command.status, 'queued');
  assert.equal(body.command.address, ADDRESS);
});

test('"now" is resolved when the frame is built, not when it is queued', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  await queueTime(base, {});
  const cmd = commands.nextFor(ADDRESS);

  // Simulate the meter collecting the command well after it was queued.
  await new Promise((r) => setTimeout(r, 1100));
  const frame = cmd.build(cmd.instructionNumber);

  const seconds = Number(clockOf(frame).slice(10, 12));
  const queuedAtSeconds = new Date(commands.get(cmd.id).queuedAt).getUTCSeconds();
  // The clock in the frame reflects build time, so it has moved on.
  assert.notEqual(seconds, queuedAtSeconds);

  const sent = new Date(commands.get(cmd.id).params.sentTime);
  assert.equal(sent.getUTCSeconds(), seconds);
});

test('an explicit time is sent verbatim, however long it waits', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  await queueTime(base, { time: '2026-08-03T12:00:00Z' });
  const cmd = commands.nextFor(ADDRESS);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(clockOf(cmd.build(cmd.instructionNumber)), '260803120000');
});

test('the default method is ac12, with aa00 available explicitly', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  await queueTime(base, { time: '2026-08-03T12:00:00Z' });
  const byDefault = commands.nextFor(ADDRESS);
  assert.equal(commands.get(byDefault.id).params.method, 'ac12');
  assert.equal(byDefault.build(1).length, 26);
  commands.markSent(byDefault);

  await queueTime(base, { time: '2026-08-03T12:00:00Z', method: 'aa00' });
  const explicit = commands.nextFor(ADDRESS);
  assert.equal(explicit.build(1).length, 35);
  // Both carry the same clock, just at different offsets.
  assert.equal(clockOf(explicit.build(1)), '260803120000');
});

test('an unknown method is rejected', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  const res = await queueTime(base, { method: 'telepathy' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, 'bad_method');
  assert.equal(commands.list().length, 0);
});

test('the queued frame carries the address from the URL', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  await queueTime(base, {});
  const cmd = commands.nextFor(ADDRESS);
  assert.equal(decodeCat1Frame(cmd.build(1)).address, ADDRESS);
});

test('a malformed address is rejected before anything is queued', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  const res = await fetch(`${base}/api/v1/meters/nope/time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, 'bad_address');
  assert.equal(commands.list().length, 0);
});

test('an unparseable time is rejected', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  const res = await queueTime(base, { time: 'tuesday-ish' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, 'bad_time');
  assert.equal(commands.list().length, 0);
});

test('command status is retrievable by id', async (t) => {
  const { base, server } = await serve();
  t.after(() => server.close());

  const id = (await (await queueTime(base, {})).json()).command.id;
  const res = await fetch(`${base}/api/v1/commands/${id}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).command.id, id);

  assert.equal((await fetch(`${base}/api/v1/commands/9999`)).status, 404);
});

test('API_TOKEN gates the command routes when set', async (t) => {
  const { base, commands, server } = await serve({ apiToken: 'sekret' });
  t.after(() => server.close());

  assert.equal((await queueTime(base, {})).status, 401);
  assert.equal(commands.list().length, 0);

  const ok = await fetch(`${base}/api/v1/meters/${ADDRESS}/time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-token': 'sekret' },
    body: '{}',
  });
  assert.equal(ok.status, 202);
});

test('ingest routes keep working alongside the command API', async (t) => {
  const { base, server } = await serve({ apiToken: 'sekret' });
  t.after(() => server.close());
  // The token guard must not leak onto the meter-facing endpoints.
  assert.equal((await fetch(`${base}/health`)).status, 200);
});
