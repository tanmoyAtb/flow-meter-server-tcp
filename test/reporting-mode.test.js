// AA06, the reporting interval (protocol section 2.7).
//
// Untested against real hardware at the time of writing -- these tests pin the
// frame to the document's byte table, which is the part that has been right
// every time the document contradicted itself. Section 2.7's stated length and
// its byte positions happen to agree here (1CH either way), unlike 2.6 and 2.8.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { openStore } from '../src/store/memory.js';
import { createCommandQueue } from '../src/commands.js';
import {
  encodeSetReportingMode,
  reportingModeBytes,
  dailyReportLimitFor,
  decodeCat1Frame,
  DEFAULT_REPORTING_INTERVAL_MINUTES,
  REPORTING_SCHEME_INTERVAL,
} from '../src/lib/cat1.js';
import { checksum } from '../src/lib/frame.js';
import { DEVICE_METER_ADDRESS } from './fixtures.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

const at = (intervalMinutes) =>
  encodeSetReportingMode({ address: DEVICE_METER_ADDRESS }, { intervalMinutes }, 1);

// --- the six-byte reporting mode field ------------------------------------

test('the factory value decodes to the interval the meters shipped on', () => {
  // Every meter arrived reporting C005A0FFFFFF in bytes 52-57 of packet 03.
  assert.equal(reportingModeBytes(DEFAULT_REPORTING_INTERVAL_MINUTES).toString('hex'), 'c005a0ffffff');
});

test('minutes are big-endian, and the trailing bytes match the hardware', () => {
  assert.equal(reportingModeBytes(30).toString('hex'), 'c0001effffff');
  assert.equal(reportingModeBytes(60).toString('hex'), 'c0003cffffff');
  assert.equal(reportingModeBytes(360).toString('hex'), 'c00168ffffff', 'the fleet policy: 6 hours');
  assert.equal(reportingModeBytes(720).toString('hex'), 'c002d0ffffff');
});

test('an interval that will not fit the field is refused rather than truncated', () => {
  for (const bad of [0, -1, 65536, 1.5, '30']) {
    assert.throws(() => reportingModeBytes(bad), /reporting interval/, String(bad));
  }
});

// --- the daily cap, byte 18 -----------------------------------------------

test('the daily cap is derived to match the interval', () => {
  // The firmware applies this on top of the interval, so a cap below what the
  // interval implies silently wins and the interval looks like it never took.
  assert.equal(dailyReportLimitFor(30), 48);
  assert.equal(dailyReportLimitFor(60), 24);
  assert.equal(dailyReportLimitFor(360), 4, 'the fleet policy: four contacts a day');
  assert.equal(dailyReportLimitFor(1440), 3, 'clamped up to the documented floor');
  assert.equal(dailyReportLimitFor(1), 100, 'clamped down to the documented ceiling');
});

// --- the frame ------------------------------------------------------------

test('the frame matches section 2.7 byte for byte', () => {
  const frame = at(30);
  assert.equal(frame.length, 46);
  assert.equal(frame[0], 0x68);
  assert.equal(frame[9], 0x03, 'device type');
  assert.equal(frame[10], 0x04, 'control: write');
  assert.equal(frame.readUInt16BE(13), 0x0000, 'spare');
  assert.equal(frame[15], 0x1c, 'm, from the byte table: 16..43 is 28 bytes');
  assert.equal(frame.readUInt16BE(16), 0xaa06);
  assert.equal(frame[18], 48, 'daily cap');
  assert.equal(frame.subarray(19, 25).toString('hex'), 'c0001effffff');
  assert.equal(frame.at(-1), 0x16);
});

test('the checksum covers everything up to itself', () => {
  const frame = at(30);
  assert.equal(frame[frame.length - 2], checksum(frame));
});

test('the command carries the addressed meter and its instruction number', () => {
  const frame = encodeSetReportingMode({ address: DEVICE_METER_ADDRESS }, { intervalMinutes: 30 }, 0x1234);
  assert.equal(decodeCat1Frame(frame).address, DEVICE_METER_ADDRESS);
  assert.equal(frame.readUInt16BE(11), 0x1234);
});

test('no passenger field asks for permission to change anything', () => {
  // This is the AA07 lesson made explicit. Byte 34 is 0xAD to allow the valve
  // control function to be rewritten and byte 35 is 0xAE for the manufacturer;
  // byte 27 is 0xAC/0xCA for the history buffer. All must stay zero, or this
  // command stops being only about the reporting schedule.
  const frame = at(30);
  assert.deepEqual(frame.subarray(25, 44), Buffer.alloc(19));
  assert.equal(frame[34], 0x00, 'valve control modification NOT granted');
  assert.equal(frame[35], 0x00, 'manufacturer modification NOT granted');
});

test('the scheme byte is the interval one, not a calendar scheme', () => {
  assert.equal(at(30)[19], REPORTING_SCHEME_INTERVAL);
});

// --- API ------------------------------------------------------------------

async function serve() {
  const commands = createCommandQueue();
  const app = createApp(openStore(), silent, { commands });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, commands, server };
}

const postReporting = (base, body) =>
  fetch(`http://${new URL(base).host}/api/v1/meters/${DEVICE_METER_ADDRESS}/reporting`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('an interval change queues a command', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  const res = await postReporting(base, { intervalMinutes: 30 });
  assert.equal(res.status, 202);
  const cmd = commands.nextFor(DEVICE_METER_ADDRESS);
  assert.equal(cmd.type, 'set_reporting');
  assert.equal(cmd.build(1).subarray(19, 25).toString('hex'), 'c0001effffff');
});

test('the interval is required, and not coerced from a string', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  for (const body of [{}, { intervalMinutes: '30' }, { intervalMinutes: 0 }, { intervalMinutes: 70000 }]) {
    const res = await postReporting(base, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).reason, 'bad_interval');
  }
  assert.equal(commands.list().length, 0);
});

test('a daily cap outside the documented range is refused', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  for (const dailyLimit of [2, 101, 1.5]) {
    const res = await postReporting(base, { intervalMinutes: 30, dailyLimit });
    assert.equal(res.status, 400, String(dailyLimit));
    assert.equal((await res.json()).reason, 'bad_daily_limit');
  }
  assert.equal(commands.list().length, 0);
});

test('the daily cap can be set explicitly when the derived one is wrong', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  await postReporting(base, { intervalMinutes: 30, dailyLimit: 60 });
  assert.equal(commands.nextFor(DEVICE_METER_ADDRESS).build(1)[18], 60);
});
