import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDatalog, DatalogError, isValidDeviceId } from '../src/lib/datalog.js';
import { buildDatalog } from './fixtures.js';

const sample = [
  { timestamp: 1738000000, battery: 3.7, temperature: 21.5, waterLevel: 1.234, barometric: 1013.2 },
  { timestamp: 1738000600, battery: 3.69, temperature: 21.4, waterLevel: 1.238, barometric: 1013.1 },
];

test('two records round-trip through the wire format', () => {
  const { count, records } = parseDatalog(buildDatalog(sample));
  assert.equal(count, 2);
  assert.equal(records.length, 2);
  assert.equal(records[0].timestamp, 1738000000);
  assert.equal(records[0].battery, 3.7);
  assert.equal(records[0].temperature, 21.5);
  assert.equal(records[0].waterLevel, 1.234);
  assert.equal(records[1].waterLevel, 1.238);
});

test('999 water level is the invalid sentinel', () => {
  const { records } = parseDatalog(
    buildDatalog([{ ...sample[0], waterLevel: 999 }]),
  );
  assert.equal(records[0].waterLevel, null);
  assert.equal(records[0].battery, 3.7, 'other fields still decode');
});

test('body length must match the declared count exactly', () => {
  const body = buildDatalog(sample);
  assert.throws(
    () => parseDatalog(body.subarray(0, body.length - 1)),
    (e) => e instanceof DatalogError && e.code === 'bad_length',
  );

  const overstated = Buffer.from(body);
  overstated[0] = 3;
  assert.throws(
    () => parseDatalog(overstated),
    (e) => e instanceof DatalogError && e.code === 'bad_length',
  );
});

test('count must be 1-100', () => {
  for (const count of [0, 101, 255]) {
    const body = Buffer.alloc(1 + Math.min(count, 1) * 20);
    body[0] = count;
    assert.throws(
      () => parseDatalog(body),
      (e) => e instanceof DatalogError && e.code === 'bad_count',
      `count ${count}`,
    );
  }
});

test('a full 100-record batch parses', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ ...sample[0], timestamp: 1738000000 + i * 600 }));
  const { count, records } = parseDatalog(buildDatalog(many));
  assert.equal(count, 100);
  assert.equal(records.at(-1).timestamp, 1738000000 + 99 * 600);
});

test('empty body is rejected', () => {
  assert.throws(
    () => parseDatalog(Buffer.alloc(0)),
    (e) => e instanceof DatalogError && e.code === 'empty_body',
  );
});

test('device id constraint is 1-16 printable ASCII', () => {
  assert.ok(isValidDeviceId('HS-GWL-0042'));
  assert.ok(isValidDeviceId('A'.repeat(16)));
  assert.ok(!isValidDeviceId('A'.repeat(17)));
  assert.ok(!isValidDeviceId(''));
  assert.ok(!isValidDeviceId('has space'));
  assert.ok(!isValidDeviceId('../etc/passwd'.padEnd(20, 'x')));
});
