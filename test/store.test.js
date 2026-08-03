// Dedup used to be the database's job (unique indexes). With the mock store it
// is application logic, so it needs covering directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store/memory.js';
import { parseUplink } from '../src/lib/cjt188.js';
import { REFERENCE_FRAME, REFERENCE_FRAME_HEX } from './fixtures.js';

const record = (timestamp) => ({
  timestamp,
  battery: 3.7,
  temperature: 21.5,
  waterLevel: 1.2,
  barometric: 1013,
});

test('datalog dedup is per (device, timestamp)', () => {
  const store = openStore();

  assert.deepEqual(store.saveDatalog('A', [record(1), record(2)]), { inserted: 2, duplicates: 0 });
  assert.deepEqual(store.saveDatalog('A', [record(1), record(2)]), { inserted: 0, duplicates: 2 });

  // Overlapping batch: only the unseen timestamp lands.
  assert.deepEqual(store.saveDatalog('A', [record(2), record(3)]), { inserted: 1, duplicates: 1 });

  // Same timestamps, different device -- not a duplicate.
  assert.deepEqual(store.saveDatalog('B', [record(1)]), { inserted: 1, duplicates: 0 });

  assert.equal(store.datalogReadings('A').length, 3);
  assert.equal(store.datalogReadings('B').length, 1);
  assert.equal(store.datalogReadings().length, 4);
});

test('meter dedup is per (address, meter time)', () => {
  const store = openStore();
  const reading = parseUplink(REFERENCE_FRAME);

  const first = store.saveMeterReading(reading, REFERENCE_FRAME_HEX);
  assert.equal(first.duplicate, false);
  assert.ok(first.id);

  const second = store.saveMeterReading(reading, REFERENCE_FRAME_HEX);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, null);

  assert.equal(store.meterReadings().length, 1);

  // Same meter, a later reading -- stored alongside, not deduped.
  const later = structuredClone({ ...reading, payload: reading.payload });
  later.payload.meterTime = { ...reading.payload.meterTime, iso: '2021-08-26T08:14:46' };
  assert.equal(store.saveMeterReading(later, REFERENCE_FRAME_HEX).duplicate, false);
  assert.equal(store.meterReadings('21081300004575').length, 2);
});

test('a stored reading is a snapshot, not a live reference', () => {
  const store = openStore();
  const reading = parseUplink(REFERENCE_FRAME);
  store.saveMeterReading(reading, REFERENCE_FRAME_HEX);

  reading.payload.status.alarms.emptyPipe = false;
  assert.equal(store.meterReadings()[0].alarms.emptyPipe, true, 'alarms were copied on write');
});

test('failures are recorded and truncated', () => {
  const store = openStore();
  store.recordFailure('coap_push', 'bad_checksum: nope', 'a'.repeat(9000));
  store.recordFailure('datalogs', 'bad_length: nope', null);

  assert.equal(store.ingestFailures().length, 2);
  assert.equal(store.ingestFailures('coap_push').length, 1);
  assert.equal(store.ingestFailures('coap_push')[0].body.length, 4096);
  assert.equal(store.ingestFailures('datalogs')[0].body, null);
});

test('reset clears rows and dedup keys together', () => {
  const store = openStore();
  store.saveDatalog('A', [record(1)]);
  store.recordFailure('datalogs', 'x', null);
  store.reset();

  assert.deepEqual(store.snapshot().counts, {
    datalogReadings: 0,
    meterReadings: 0,
    cat1Readings: 0,
    ingestFailures: 0,
  });
  // The dedup key must be gone too, or the row can never be re-added.
  assert.deepEqual(store.saveDatalog('A', [record(1)]), { inserted: 1, duplicates: 0 });
});
