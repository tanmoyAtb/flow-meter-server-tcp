// What is left of the HTTP surface once the meters talk raw TCP: health, the
// debug store view, and the configure policy view. The command API has its own
// file (command-api.test.js).

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openStore } from '../src/store/memory.js';
import { parseCat1 } from '../src/lib/cat1.js';
import { CAT1_FRAMES, CAT1_FRAMES_HEX, DEVICE_METER_ADDRESS } from './fixtures.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

let server;
let base;
let store;

before(async () => {
  store = openStore();
  server = createApp(store, quiet).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // Nothing arrives over HTTP any more, so seed the store the way the TCP
  // handler would.
  store.saveCat1Reading(parseCat1(CAT1_FRAMES[0]), CAT1_FRAMES_HEX[0].toUpperCase());
  store.recordFailure('tcp', 'not_cat1: not a CAT-1 frame', 'DEADBEEF');
});

after(() => {
  server.close();
  store.close();
});

test('health endpoint responds', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('the ingest endpoints are gone, not silently accepting', async () => {
  // Both were removed with the devices that used them. A 404 is the honest
  // answer; a 200 would tell a misconfigured pusher its data had been stored.
  for (const path of ['/api/v1/coap_push', '/api/v1/datalogs/HS-GWL-0042']) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'anything',
    });
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).reason, 'not_found', path);
  }
});

test('configure view reports the policy as off when none is configured', async () => {
  const res = await fetch(`${base}/api/v1/configure`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, enabled: false });
});

test('debug endpoint exposes everything the mock store holds', async () => {
  const snapshot = await (await fetch(`${base}/debug/store`)).json();

  assert.equal(snapshot.counts.cat1Readings, 1);
  assert.ok(snapshot.counts.ingestFailures > 0);
  assert.equal(snapshot.cat1Readings[0].meterAddress, DEVICE_METER_ADDRESS);
  assert.equal(snapshot.cat1Readings[0].cumulativeReportCount, 16);
});

// Wipes the store, so it runs last.
test('debug reset empties the mock store', async () => {
  const res = await fetch(`${base}/debug/store`, { method: 'DELETE' });
  assert.equal(res.status, 200);

  const snapshot = await (await fetch(`${base}/debug/store`)).json();
  assert.deepEqual(snapshot.counts, { cat1Readings: 0, ingestFailures: 0 });

  // A reading that was previously a duplicate is accepted again after a reset.
  const again = store.saveCat1Reading(parseCat1(CAT1_FRAMES[0]), CAT1_FRAMES_HEX[0].toUpperCase());
  assert.equal(again.duplicate, false);
});
