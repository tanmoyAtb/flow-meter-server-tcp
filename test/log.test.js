// The log is the only place readings live until the database is wired up, and
// a reading with no arrival time in it can only be half-loaded later. So the
// stamp is not cosmetic, and these tests hold it in place.

import test from 'node:test';
import assert from 'node:assert/strict';
import { timestampedLog } from '../src/lib/log.js';

/** A console-shaped sink that keeps what it was handed, already joined. */
function recorder() {
  const lines = { log: [], info: [], warn: [], error: [] };
  const sink = {};
  for (const method of Object.keys(lines)) {
    sink[method] = (...args) => lines[method].push(args.join(' '));
  }
  return { sink, lines };
}

const FIXED = new Date('2026-08-06T09:15:00.250Z');

test('every level is stamped with the instant it printed', () => {
  const { sink, lines } = recorder();
  const log = timestampedLog(sink, () => FIXED);

  log.info('report in');
  log.warn('bad frame');
  log.error('boom');
  log.log('plain');

  assert.equal(lines.info[0], '2026-08-06T09:15:00.250Z report in');
  assert.equal(lines.warn[0], '2026-08-06T09:15:00.250Z bad frame');
  assert.equal(lines.error[0], '2026-08-06T09:15:00.250Z boom');
  assert.equal(lines.log[0], '2026-08-06T09:15:00.250Z plain');
});

// A report is logged as one multi-line block. The stamp belongs on the header
// so the block stays readable -- a backfill takes the time from the header and
// the bytes from the `raw` line underneath it.
test('a multi-line block is stamped once, on its first line', () => {
  const { sink, lines } = recorder();
  const log = timestampedLog(sink, () => FIXED);

  log.info('─── tcp  00102608220004 ───\n  raw     6810…16\n  valve   open');

  const [first, ...rest] = lines.info[0].split('\n');
  assert.ok(first.startsWith('2026-08-06T09:15:00.250Z ─── tcp'), first);
  assert.deepEqual(rest, ['  raw     6810…16', '  valve   open']);
});

// app.js hands its error handler an Error as a second argument, and console's
// own rendering of that is worth keeping -- so the stamp is prepended as its
// own argument rather than spliced into the first one.
test('arguments after the first are passed through untouched', () => {
  const seen = [];
  const log = timestampedLog({ error: (...args) => seen.push(args) }, () => FIXED);
  const err = new Error('nope');

  log.error('unhandled error on GET /x:', err);

  assert.deepEqual(seen[0], ['2026-08-06T09:15:00.250Z', 'unhandled error on GET /x:', err]);
});

test('the clock is read at print time, not at construction', () => {
  const { sink, lines } = recorder();
  let now = new Date('2026-08-06T09:00:00.000Z');
  const log = timestampedLog(sink, () => now);

  log.info('first');
  now = new Date('2026-08-06T10:00:00.000Z');
  log.info('second');

  assert.ok(lines.info[0].startsWith('2026-08-06T09:00:00.000Z'));
  assert.ok(lines.info[1].startsWith('2026-08-06T10:00:00.000Z'));
});

// A sink missing a level must not take the server down mid-report.
test('a sink without a level is tolerated', () => {
  const log = timestampedLog({ info: () => {} }, () => FIXED);
  assert.doesNotThrow(() => log.warn('nobody is listening'));
});
