// The routes log through these formatters, and the HTTP tests run with a silent
// logger -- so without these tests a typo'd field path would print "undefined"
// forever and nothing would fail.

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMeterReading, formatDatalog } from '../src/lib/format.js';
import { parseUplink } from '../src/lib/cjt188.js';
import { REFERENCE_FRAME, REFERENCE_FRAME_HEX } from './fixtures.js';

test('meter log carries the values decoded from the frame', () => {
  const reading = parseUplink(REFERENCE_FRAME);
  const out = formatMeterReading(reading, REFERENCE_FRAME_HEX.toUpperCase(), {
    duplicate: false,
    encoding: 'hex',
  });

  for (const expected of [
    '21081300004575',
    '2021-08-26T04:14:46',
    'cumulative 206.66 m3',
    'settlement 18.03 m3',
    'temp 27.92 C',
    'valve open',
    'alarms: emptyPipe',
    '-76 dBm',
    'transmission #11',
    'IMEI 864823047988050',
    'ICCID 89861119253017474430',
    'uploads at 04:00',
    'cutoff 00:00 at 206.66 m3',
    '26/47 half-hour slots non-zero',
    '13:30 3.95',
  ]) {
    assert.ok(out.includes(expected), `missing ${JSON.stringify(expected)} in:\n${out}`);
  }

  assert.ok(!out.includes('undefined'), 'no undefined field paths');
  assert.ok(!out.includes('[object Object]'), 'no unformatted objects');
});

test('duplicate meter readings are marked in the log', () => {
  const reading = parseUplink(REFERENCE_FRAME);
  const out = formatMeterReading(reading, REFERENCE_FRAME_HEX, { duplicate: true, encoding: 'binary' });
  assert.ok(out.includes('(duplicate)'));
  assert.ok(out.includes('binary'));
});

test('datalog log lists every record', () => {
  const records = [
    { timestamp: 1738000000, battery: 3.7, temperature: 21.5, waterLevel: 1.234, barometric: 1013.2 },
    { timestamp: 1738000600, battery: 3.69, temperature: 21.4, waterLevel: null, barometric: 1013.1 },
  ];
  const out = formatDatalog('HS-GWL-0042', records, { inserted: 2, duplicates: 0 });

  assert.ok(out.includes('HS-GWL-0042'));
  assert.ok(out.includes('2 record(s) · 2 new · 0 duplicate'));
  assert.ok(out.includes('2025-01-27T17:46:40Z'), 'unix seconds rendered as UTC');
  assert.ok(out.includes('batt 3.70 V'));
  assert.ok(out.includes('level 1.234 m'));
  assert.ok(out.includes('(invalid)'), 'null water level is shown as invalid, not blank');
  assert.ok(!out.includes('undefined'));
  assert.equal(out.split('\n').length, 4, 'header + counts + one line per record');
});

test('unknown units log as a dash rather than null', () => {
  const reading = parseUplink(REFERENCE_FRAME);
  reading.payload.cumulativeFlow.value = null;
  const out = formatMeterReading(reading, REFERENCE_FRAME_HEX, { duplicate: false, encoding: 'hex' });
  assert.ok(out.includes('cumulative —'));
  assert.ok(!out.includes('null'));
});
