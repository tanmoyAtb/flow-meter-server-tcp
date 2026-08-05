// Model tests, run against a real mongod.
//
// These assert the things that are the database's job now rather than the
// application's -- chiefly the unique indexes that took over deduplication from
// a Set held in process memory. A test that mocked Mongo would assert that
// mongoose was called correctly and prove nothing about whether a meter's retry
// actually lands as one reading or two.
//
// Skipped, not failed, when no server is reachable: `npm test` has to stay
// runnable on a machine with no database.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import {
  connectDatabase,
  disconnectDatabase,
  mongoose,
  redactUrl,
  databaseUrl,
  databaseState,
  Meter,
  Cat1Reading,
  MeterReading,
  Datalog,
  Command,
  IngestFailure,
  nextSequence,
  REPORT_OWNED_FIELDS,
} from '../src/database/index.js';

const URL = process.env.MONGO_TEST_URL ?? 'mongodb://127.0.0.1:27017/watermeter_test';
const ADDRESS = '00102608220004';

let available = false;

/** Every test guards on this, so a machine with no mongod still runs the suite. */
const needsMongo = (t: TestContext): boolean => {
  if (!available) t.skip(`no mongod at ${redactUrl(URL)}`);
  return available;
};

const silent = { info: () => {}, warn: () => {}, error: () => {} };

before(async () => {
  try {
    await connectDatabase({ url: URL, log: silent });
    await mongoose.connection.dropDatabase();
    // Unique indexes are built asynchronously; the dedup tests below are
    // meaningless until they exist.
    await Promise.all([Meter.init(), Cat1Reading.init(), MeterReading.init(), Datalog.init(), Command.init()]);
    available = true;
  } catch {
    available = false;
  }
});

after(async () => {
  if (available) await mongoose.connection.dropDatabase();
  await disconnectDatabase().catch(() => {});
});

// --- connection helpers, which need no server ---------------------------

test('a password in the URL is never logged', () => {
  assert.equal(redactUrl('mongodb://user:hunter2@host:27017/db'), 'mongodb://***@host:27017/db');
  assert.equal(redactUrl('mongodb://127.0.0.1:27017/watermeter'), 'mongodb://127.0.0.1:27017/watermeter');
});

test('the URL comes from the environment, with a local default', () => {
  assert.equal(databaseUrl({} as NodeJS.ProcessEnv), 'mongodb://127.0.0.1:27017/watermeter');
  assert.equal(databaseUrl({ MONGO_URL: 'mongodb://x/y' } as NodeJS.ProcessEnv), 'mongodb://x/y');
  // Atlas hands out MONGODB_URI, so accept that spelling too.
  assert.equal(databaseUrl({ MONGODB_URI: 'mongodb+srv://a/b' } as NodeJS.ProcessEnv), 'mongodb+srv://a/b');
});

// --- the fleet document -------------------------------------------------

test('a meter is keyed by its address, not an ObjectId', async (t) => {
  if (!needsMongo(t)) return;

  const now = new Date();
  await Meter.create({
    _id: ADDRESS,
    protocol: 'cat1',
    firstSeenAt: now,
    lastSeenAt: now,
    label: null,
    site: null,
    notes: null,
  });

  const found = await Meter.findById(ADDRESS).lean();
  assert.equal(found?._id, ADDRESS);
  assert.equal(found?.protocol, 'cat1');
  assert.equal(found?.reportCount, 0);
});

test('a report does not clobber the fields an operator owns', async (t) => {
  if (!needsMongo(t)) return;

  await Meter.findByIdAndUpdate(
    ADDRESS,
    { $set: { label: 'Gulshan pump house', site: 'Dhaka North', notes: 'valve sticks' } },
    { upsert: true },
  );

  // A report writes only report-owned fields. This is the shape the ingest path
  // must use -- $set of a whole document would wipe the three fields above, and
  // nothing would ever report the loss.
  const reportPatch = { lastSeenAt: new Date(), valve: 'closed', resolutionLitres: 1, protocol: 'cat1' as const };
  for (const field of Object.keys(reportPatch)) {
    assert.ok(
      (REPORT_OWNED_FIELDS as readonly string[]).includes(field),
      `${field} must be listed in REPORT_OWNED_FIELDS`,
    );
  }
  await Meter.findByIdAndUpdate(ADDRESS, { $set: reportPatch, $inc: { reportCount: 1 } });

  const after = await Meter.findById(ADDRESS).lean();
  assert.equal(after?.label, 'Gulshan pump house', 'operator label survived the report');
  assert.equal(after?.site, 'Dhaka North');
  assert.equal(after?.notes, 'valve sticks');
  assert.equal(after?.valve, 'closed');
  assert.equal(after?.resolutionLitres, 1);

  assert.ok(
    !(REPORT_OWNED_FIELDS as readonly string[]).includes('label'),
    'label must never be report-owned, or the guarantee above is empty',
  );
});

test('the meter clock is stored as written digits, not an instant', async (t) => {
  if (!needsMongo(t)) return;

  await Meter.findByIdAndUpdate(ADDRESS, { $set: { meterClock: '2026-08-05T15:35:00', clockSkewSeconds: 2 } });
  const found = await Meter.findById(ADDRESS).lean();

  // The distinction that matters: these meters shipped on UTC+8 and were moved
  // to UTC+6, so the same digits mean different instants either side of the
  // change. A Date here would assert an instant the meter never had.
  assert.equal(typeof found?.meterClock, 'string');
  assert.equal(found?.meterClock, '2026-08-05T15:35:00');
  assert.equal(found?.clockSkewSeconds, 2);
});

// --- deduplication, now the index's job ---------------------------------

const cat1Reading = (overrides: Record<string, unknown> = {}) => ({
  meterAddress: ADDRESS,
  receivedAt: new Date(),
  meterClock: '2026-08-05T15:35:00',
  cumulativeReportCount: 68,
  rawFrame: '6810040022082610000397...16',
  ...overrides,
});

test('a CAT-1 retry lands as one reading, not two', async (t) => {
  if (!needsMongo(t)) return;

  await Cat1Reading.create(cat1Reading());
  await assert.rejects(
    () => Cat1Reading.create(cat1Reading()),
    (err: { code?: number }) => err.code === 11000,
    'the unique index rejects the replay',
  );

  // The counter moving on is a genuinely new report.
  await Cat1Reading.create(cat1Reading({ cumulativeReportCount: 69, meterClock: '2026-08-06T15:35:00' }));
  assert.equal(await Cat1Reading.countDocuments({ meterAddress: ADDRESS }), 2);
});

test('a CJ/T 188 platform retry is deduped on (address, meter time)', async (t) => {
  if (!needsMongo(t)) return;

  const reading = { meterAddress: '21081300004575', meterTime: '2021-08-26T04:14:46', receivedAt: new Date(), rawFrame: '68...16' };
  await MeterReading.create(reading);
  await assert.rejects(() => MeterReading.create(reading), (err: { code?: number }) => err.code === 11000);

  assert.equal(await MeterReading.countDocuments({}), 1);
});

test('the 47 half-hourly slots round-trip as one document', async (t) => {
  if (!needsMongo(t)) return;

  const increments = Array.from({ length: 47 }, (_, i) => ({ time: `slot${i}`, value: i * 0.5 }));
  await MeterReading.create({
    meterAddress: '21081300004575',
    meterTime: '2021-08-26T08:14:46',
    receivedAt: new Date(),
    rawFrame: '68...16',
    increments,
  });

  const found = await MeterReading.findOne({ meterTime: '2021-08-26T08:14:46' }).lean();
  assert.equal(found?.increments.length, 47);
  assert.equal(found?.increments[46]?.value, 23);
  // Subdocuments carry no _id of their own -- they are values, not entities.
  assert.ok(!('_id' in (found?.increments[0] ?? {})), 'increments are plain values');
});

test('datalog dedup is per (device, timestamp)', async (t) => {
  if (!needsMongo(t)) return;

  await Datalog.create({ deviceId: 'HS-GWL-0042', timestamp: 1738000000, receivedAt: new Date(), battery: 3.7 });
  await assert.rejects(
    () => Datalog.create({ deviceId: 'HS-GWL-0042', timestamp: 1738000000, receivedAt: new Date() }),
    (err: { code?: number }) => err.code === 11000,
  );

  // Same timestamp, different device is not a duplicate.
  await Datalog.create({ deviceId: 'HS-GWL-0043', timestamp: 1738000000, receivedAt: new Date() });
  assert.equal(await Datalog.countDocuments({}), 2);
});

// --- sequences ----------------------------------------------------------

test('sequences are monotonic and independent', async (t) => {
  if (!needsMongo(t)) return;

  assert.equal(await nextSequence('command_id'), 1);
  assert.equal(await nextSequence('command_id'), 2);
  assert.equal(await nextSequence('instruction_number'), 1, 'a separate sequence starts over');
  assert.equal(await nextSequence('command_id'), 3);
});

test('concurrent draws never collide', async (t) => {
  if (!needsMongo(t)) return;

  // Protocol section I.4: instruction numbers must not repeat. Two meters can
  // be mid-contact at the same moment, so this is not hypothetical.
  const drawn = await Promise.all(Array.from({ length: 25 }, () => nextSequence('concurrent_test')));
  assert.equal(new Set(drawn).size, 25, 'every draw was unique');
  assert.deepEqual([...drawn].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));
});

// --- the command queue --------------------------------------------------

test('a queued command survives as a row, with no closure in it', async (t) => {
  if (!needsMongo(t)) return;

  const id = await nextSequence('command_id');
  const instructionNumber = await nextSequence('instruction_number');

  await Command.create({
    _id: id,
    address: ADDRESS,
    type: 'set_clock',
    source: 'reconciler',
    params: { method: 'aa00', timeZone: 'Asia/Dhaka', time: null, meterTypeCode: 0x10 },
    instructionNumber,
    status: 'queued',
    queuedAt: new Date(),
    expiresAt: new Date(Date.now() + 48 * 3600 * 1000),
  });

  const found = await Command.findById(id).lean();
  assert.equal(found?.type, 'set_clock');
  assert.equal(found?.source, 'reconciler');
  // The whole point: everything needed to build the frame later is data.
  assert.equal(found?.params.method, 'aa00');
  assert.equal(found?.params.timeZone, 'Asia/Dhaka');
  assert.equal(found?.params.time, null, 'left unresolved on purpose -- "now" means now at delivery');
  assert.equal(found?.frame, null, 'nothing on the wire yet');
});

test('the queue lookup returns the oldest live command for one meter', async (t) => {
  if (!needsMongo(t)) return;

  await Command.deleteMany({});
  const base = { address: ADDRESS, type: 'valve' as const, source: 'api' as const, instructionNumber: 1, queuedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) };

  await Command.create({ ...base, _id: 10, status: 'acknowledged', params: {} });
  await Command.create({ ...base, _id: 11, status: 'queued', params: { state: 'open' } });
  await Command.create({ ...base, _id: 12, status: 'queued', params: { state: 'closed' } });
  await Command.create({ ...base, _id: 13, address: '99999999999999', status: 'queued', params: {} });

  const next = await Command.findOne({ address: ADDRESS, status: 'queued' }).sort({ _id: 1 }).lean();
  assert.equal(next?._id, 11, 'oldest queued command, and only for this meter');
});

test('an invalid command type is refused by the schema', async (t) => {
  if (!needsMongo(t)) return;

  // Two guards, and this exercises the second. TypeScript rejects `set_clok`
  // at compile time -- the cast below is what it takes to get past it -- and
  // the schema enum rejects it at write time, which is the one that still
  // applies to a document arriving from an older build or written by hand.
  // Either way a typo cannot become a row that can be queued but never built,
  // failing silently at delivery a day later.
  const typo = { type: 'set_clok' } as unknown as { type: 'set_clock' };

  await assert.rejects(
    () =>
      Command.create({
        _id: 999,
        address: ADDRESS,
        ...typo,
        source: 'api',
        instructionNumber: 1,
        status: 'queued',
        queuedAt: new Date(),
        expiresAt: new Date(),
        params: {},
      }),
    /not a valid enum value/,
  );

  assert.equal(await Command.findById(999), null, 'nothing was written');
});

// --- failures -----------------------------------------------------------

test('parked failures expire rather than growing without bound', async (t) => {
  if (!needsMongo(t)) return;

  await IngestFailure.create({
    endpoint: 'tcp',
    reason: 'unframed_bytes',
    body: 'A345A3C50000',
    peer: '37.111.194.249:37297',
    receivedAt: new Date(),
  });

  const indexes = await IngestFailure.collection.indexes();
  const ttl = indexes.find((i) => i.name === 'failure_ttl');
  assert.ok(ttl, 'the TTL index exists');
  assert.ok(typeof ttl?.expireAfterSeconds === 'number' && ttl.expireAfterSeconds > 0);
});

test('databaseState reports what is actually connected', async (t) => {
  if (!needsMongo(t)) return;

  const state = databaseState();
  assert.equal(state.connected, true);
  assert.equal(state.readyState, 1);
  assert.ok(state.name);
});
