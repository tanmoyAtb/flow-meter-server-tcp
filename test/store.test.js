// Dedup used to be the database's job (unique indexes). With the mock store it
// is application logic, so it needs covering directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store/memory.js';
import { parseCat1 } from '../src/lib/cat1.js';
import { CAT1_FRAMES, CAT1_FRAMES_HEX, DEVICE_METER_ADDRESS } from './fixtures.js';

const reading = (i = 0) => parseCat1(CAT1_FRAMES[i]);
const hex = (i = 0) => CAT1_FRAMES_HEX[i].toUpperCase();

test('cat1 dedup is per (address, report count, meter clock)', () => {
  const store = openStore();

  const first = store.saveCat1Reading(reading(0), hex(0));
  assert.equal(first.duplicate, false);
  assert.ok(first.id);

  const second = store.saveCat1Reading(reading(0), hex(0));
  assert.equal(second.duplicate, true);
  assert.equal(second.id, null);

  assert.equal(store.cat1Readings().length, 1);

  // The next captured frame steps the report counter, so it is a new reading
  // even though no water was drawn between the two.
  assert.equal(store.saveCat1Reading(reading(1), hex(1)).duplicate, false);
  assert.equal(store.cat1Readings(DEVICE_METER_ADDRESS).length, 2);
});

test('the clock guards against a report counter that restarted', () => {
  const store = openStore();
  store.saveCat1Reading(reading(0), hex(0));

  // Same counter, different clock: a meter that was power-cycled, not a resend.
  const restarted = reading(0);
  restarted.payload.meterClock = { ...restarted.payload.meterClock, iso: '2023-09-24T06:02:46' };
  assert.equal(store.saveCat1Reading(restarted, hex(0)).duplicate, false);
  assert.equal(store.cat1Readings().length, 2);
});

test('a stored reading is a snapshot, not a live reference', () => {
  const store = openStore();
  const r = reading(0);
  store.saveCat1Reading(r, hex(0));

  r.reportingTriggers.push('mutated after the write');
  assert.equal(store.cat1Readings()[0].reportingTriggers.length, 1, 'triggers were copied on write');
});

test('failures are recorded and truncated', () => {
  const store = openStore();
  store.recordFailure('tcp', 'bad_checksum: nope', 'a'.repeat(9000));
  store.recordFailure('tcp', 'not_cat1: not a CAT-1 frame', null);

  assert.equal(store.ingestFailures().length, 2);
  assert.equal(store.ingestFailures('tcp').length, 2);
  assert.equal(store.ingestFailures('tcp')[0].body.length, 4096);
  assert.equal(store.ingestFailures('tcp')[1].body, null);
});

test('reset clears rows and dedup keys together', () => {
  const store = openStore();
  store.saveCat1Reading(reading(0), hex(0));
  store.recordFailure('tcp', 'x', null);
  store.reset();

  assert.deepEqual(store.snapshot().counts, {
    cat1Readings: 0,
    ingestFailures: 0,
  });
  // The dedup key must be gone too, or the row can never be re-added.
  assert.equal(store.saveCat1Reading(reading(0), hex(0)).duplicate, false);
});
