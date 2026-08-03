import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openStore } from '../src/store/memory.js';
import { REFERENCE_FRAME, REFERENCE_FRAME_HEX, buildDatalog } from './fixtures.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

let server;
let base;
let store;

before(async () => {
  store = openStore();
  server = createApp(store, quiet).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  store.close();
});

const postRaw = (path, body, contentType = 'application/octet-stream') =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': contentType }, body });

const record = (timestamp) => ({
  timestamp,
  battery: 3.7,
  temperature: 21.5,
  waterLevel: 1.234,
  barometric: 1013.2,
});

test('datalogs: valid batch returns 200 with an empty body', async () => {
  const res = await postRaw('/api/v1/datalogs/HS-GWL-0042', buildDatalog([record(1738000000), record(1738000600)]));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');

  const rows = store.datalogReadings('HS-GWL-0042');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].waterLevel, 1.234);
});

test('datalogs: replaying the same batch is a no-op', async () => {
  const body = buildDatalog([record(1738100000)]);
  assert.equal((await postRaw('/api/v1/datalogs/HS-DUP-01', body)).status, 200);
  assert.equal((await postRaw('/api/v1/datalogs/HS-DUP-01', body)).status, 200);

  assert.equal(store.datalogReadings('HS-DUP-01').length, 1, 'dedup on (device_id, timestamp)');
});

test('datalogs: a truncated frame returns 400 so the device retries', async () => {
  const body = buildDatalog([record(1738200000)]);
  const res = await postRaw('/api/v1/datalogs/HS-BAD-01', body.subarray(0, 10));
  assert.equal(res.status, 400);
});

test('datalogs: an over-long device id is rejected', async () => {
  const res = await postRaw(`/api/v1/datalogs/${'X'.repeat(17)}`, buildDatalog([record(1738300000)]));
  assert.equal(res.status, 400);
});

test('coap_push: hex text body parses and stores', async () => {
  const res = await postRaw('/api/v1/coap_push', REFERENCE_FRAME_HEX, 'text/plain');
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.duplicate, false);
  assert.equal(body.encoding, 'hex');
  assert.equal(body.meter_address, '21081300004575');
  assert.equal(body.cumulative_flow, 206.66);
  assert.equal(body.temperature, 27.92);
  assert.equal(body.valve_status, 'open');
  assert.equal(body.signal_strength, -76);
  assert.equal(body.imei, '864823047988050');
  assert.equal(body.increments.length, 47);

  const rows = store.meterReadings();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meterTime, '2021-08-26T04:14:46');
  assert.equal(rows[0].alarms.emptyPipe, true);
  assert.equal(rows[0].increments.length, 47);
  assert.equal(rows[0].rawFrame, REFERENCE_FRAME_HEX.toUpperCase());
});

test('coap_push: re-push of the same reading is flagged as a duplicate', async () => {
  const res = await postRaw('/api/v1/coap_push', REFERENCE_FRAME_HEX, 'text/plain');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.duplicate, true);

  assert.equal(store.meterReadings().length, 1, 'dedup on (meter_address, meter_time)');
});

test('coap_push: accepts raw binary, JSON hex and JSON base64', async () => {
  const shapes = [
    ['binary', REFERENCE_FRAME, 'application/octet-stream'],
    ['json-hex', JSON.stringify({ deviceId: 'x', payload: { data: REFERENCE_FRAME_HEX } }), 'application/json'],
    ['json-base64', JSON.stringify({ body: { content: REFERENCE_FRAME.toString('base64') } }), 'application/json'],
  ];

  for (const [encoding, body, type] of shapes) {
    const res = await postRaw('/api/v1/coap_push', body, type);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true, encoding);
    assert.equal(json.encoding, encoding);
    assert.equal(json.cumulative_flow, 206.66, encoding);
  }
});

test('coap_push: a bad frame still answers 200 and is parked for review', async () => {
  const corrupted = Buffer.from(REFERENCE_FRAME);
  corrupted[30] ^= 0xff;

  const res = await postRaw('/api/v1/coap_push', corrupted.toString('hex'), 'text/plain');
  assert.equal(res.status, 200, 'never hand the platform a non-200');

  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'bad_checksum');

  const rows = store.ingestFailures('coap_push');
  assert.ok(rows.some((r) => r.reason.startsWith('bad_checksum')), 'failure was recorded');
});

test('coap_push: unrecognisable body is reported, not crashed on', async () => {
  const res = await postRaw('/api/v1/coap_push', 'this is not a frame', 'text/plain');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).reason, 'no_frame');
});

test('health endpoint responds', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('debug endpoint exposes everything the mock store holds', async () => {
  const snapshot = await (await fetch(`${base}/debug/store`)).json();

  assert.equal(snapshot.counts.meterReadings, 1);
  assert.ok(snapshot.counts.datalogReadings > 0);
  assert.ok(snapshot.counts.ingestFailures > 0);
  assert.equal(snapshot.meterReadings[0].meterAddress, '21081300004575');
  assert.equal(snapshot.meterReadings[0].increments.length, 47);
});

// Wipes the store, so it runs last.
test('debug reset empties the mock store', async () => {
  const res = await fetch(`${base}/debug/store`, { method: 'DELETE' });
  assert.equal(res.status, 200);

  const snapshot = await (await fetch(`${base}/debug/store`)).json();
  assert.deepEqual(snapshot.counts, {
    datalogReadings: 0,
    meterReadings: 0,
    cat1Readings: 0,
    ingestFailures: 0,
  });

  // A reading that was previously a duplicate is accepted again after a reset.
  const replay = await postRaw('/api/v1/coap_push', REFERENCE_FRAME_HEX, 'text/plain');
  assert.equal((await replay.json()).duplicate, false);
});
