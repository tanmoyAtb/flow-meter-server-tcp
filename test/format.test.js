// The TCP handler logs through these formatters, and the flow tests run with a
// silent logger -- so without these tests a typo'd field path would print
// "undefined" forever and nothing would fail.

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCat1Reading, formatUnrecognisedFrame } from '../src/lib/format.js';
import { parseCat1 } from '../src/lib/cat1.js';
import { peekEnvelope } from '../src/lib/framing.js';
import { CAT1_FRAME, CAT1_FRAMES_HEX, REFERENCE_FRAME, DEVICE_METER_ADDRESS } from './fixtures.js';

const HEX = CAT1_FRAMES_HEX[0].toUpperCase();

test('cat1 log carries the values decoded from the frame', () => {
  const out = formatCat1Reading(parseCat1(CAT1_FRAME), HEX, { duplicate: false });

  for (const expected of [
    DEVICE_METER_ADDRESS,
    'CAT-1 · cold water meter',
    'packet postpaid_standard',
    '2023-09-23T06:02:46',
    'report #16',
    'valve open',
    'IMEI 867512079825846',
    'ICCID 89860422152570009782',
    // Captured before the resolution was written down to 1 L, so these frames
    // still report the factory 1000 L step.
    'counts in 1000 L steps',
  ]) {
    assert.ok(out.includes(expected), `missing ${JSON.stringify(expected)} in:\n${out}`);
  }

  assert.ok(!out.includes('undefined'), 'no undefined field paths');
  assert.ok(!out.includes('[object Object]'), 'no unformatted objects');
});

test('duplicate readings are marked in the log', () => {
  const out = formatCat1Reading(parseCat1(CAT1_FRAME), HEX, { duplicate: true });
  assert.ok(out.includes('(duplicate)'));
});

test('unknown units log as a dash rather than null', () => {
  const reading = parseCat1(CAT1_FRAME);
  reading.payload.signalStrengthDbm = null;
  const out = formatCat1Reading(reading, HEX, { duplicate: false });
  assert.ok(out.includes('radio   — RSSI'), `expected a dash for RSSI in:\n${out}`);
  assert.ok(!out.includes('null'));
});

// The old wording claimed an unrecognised frame was "valid CJ/T 188", which was
// printed against the fleet's own CAT-1 frames before CAT-1 was supported.
test('an unrecognised frame is not blamed on a particular protocol', () => {
  const out = formatUnrecognisedFrame(
    REFERENCE_FRAME,
    peekEnvelope(REFERENCE_FRAME),
    'not_cat1: not a CAT-1 frame',
    { peer: '10.0.0.1:1234' },
  );

  assert.ok(out.includes('UNRECOGNISED'));
  assert.ok(out.includes('not_cat1'));
  // The raw hex is dumped in full, so only the prose is checked.
  const prose = out.split('\n').filter((l) => !l.trim().startsWith('raw')).join('\n');
  assert.ok(!prose.includes('CJ/T 188'), 'must not name a protocol it did not verify');
  assert.ok(!prose.includes('9097'));
});
