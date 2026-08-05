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
  MeterReading,
  usageBetween,
  Command,
  IngestFailure,
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
    await Promise.all([Meter.init(), MeterReading.init(), Command.init()]);
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

test('a meter is keyed by its 14-digit ID, not an ObjectId', async (t) => {
  if (!needsMongo(t)) return;

  const now = new Date();
  await Meter.create({ _id: ADDRESS, firstSeenAt: now, lastSeenAt: now });

  const found = await Meter.findById(ADDRESS).lean();
  assert.equal(found?._id, ADDRESS);
  assert.equal(found?.isConfigured, false, 'a meter is presumed off-policy until checked');
});

test('a meter can be registered by hand before it ever reports', async (t) => {
  if (!needsMongo(t)) return;

  // The reason the meter ID is the primary key. Someone types in the ID, label,
  // location and SIM number at commissioning; the first report upserts onto
  // that document instead of creating a second one to be merged later.
  const ID = '00102608229999';
  await Meter.create({
    _id: ID,
    label: 'Banani site B',
    location: 'Dhaka North',
    simPhoneNumber: '+8801700000000',
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  });

  await Meter.findByIdAndUpdate(ID, { $set: { lastSeenAt: new Date(), imei: '864823047988050' } });

  const found = await Meter.findById(ID).lean();
  assert.equal(found?.label, 'Banani site B', 'the hand-entered registration survived first contact');
  assert.equal(found?.simPhoneNumber, '+8801700000000');
  assert.equal(found?.imei, '864823047988050', 'and the report filled in what only the meter knows');
  assert.equal(await Meter.countDocuments({ _id: ID }), 1, 'one document, not two');
});

test('a report does not clobber the fields an operator owns', async (t) => {
  if (!needsMongo(t)) return;

  await Meter.findByIdAndUpdate(
    ADDRESS,
    {
      $set: {
        label: 'Gulshan pump house',
        location: 'Dhaka North',
        notes: 'valve sticks',
        simPhoneNumber: '+8801711111111',
      },
    },
    { upsert: true },
  );

  // A report writes only report-owned fields. This is the shape the ingest path
  // must use -- $set of a whole document would wipe the four fields above, and
  // nothing would ever report the loss.
  const reportPatch = { lastSeenAt: new Date(), valve: 'closed', resolutionLiters: 1, meterReportNumber: 73 };
  for (const field of Object.keys(reportPatch)) {
    assert.ok(
      (REPORT_OWNED_FIELDS as readonly string[]).includes(field),
      `${field} must be listed in REPORT_OWNED_FIELDS`,
    );
  }
  await Meter.findByIdAndUpdate(ADDRESS, { $set: reportPatch });

  const after = await Meter.findById(ADDRESS).lean();
  assert.equal(after?.label, 'Gulshan pump house', 'operator label survived the report');
  assert.equal(after?.location, 'Dhaka North');
  assert.equal(after?.notes, 'valve sticks');
  assert.equal(after?.simPhoneNumber, '+8801711111111', 'the SIM number is never on the wire, so nothing may overwrite it');
  assert.equal(after?.valve, 'closed');
  assert.equal(after?.resolutionLiters, 1);

  for (const field of ['label', 'location', 'notes', 'simPhoneNumber']) {
    assert.ok(
      !(REPORT_OWNED_FIELDS as readonly string[]).includes(field),
      `${field} must never be report-owned, or the guarantee above is empty`,
    );
  }
});

test('the meter clock is stored as written digits, not an instant', async (t) => {
  if (!needsMongo(t)) return;

  await Meter.findByIdAndUpdate(ADDRESS, { $set: { meterClock: '2026-08-05T15:35:00' } });
  const found = await Meter.findById(ADDRESS).lean();

  // The distinction that matters: these meters shipped on UTC+8 and were moved
  // to UTC+6, so the same digits mean different instants either side of the
  // change. A Date here would assert an instant the meter never had.
  assert.equal(typeof found?.meterClock, 'string');
  assert.equal(found?.meterClock, '2026-08-05T15:35:00');
});

test('an unknown valve state is refused by the schema', async (t) => {
  if (!needsMongo(t)) return;

  await assert.rejects(
    () => Meter.findByIdAndUpdate(ADDRESS, { $set: { valve: 'half' } }, { runValidators: true }),
    /not a valid enum value/,
  );
});

// --- deduplication, now the index's job ---------------------------------

const reading = (overrides: Record<string, unknown> = {}) => ({
  meterId: ADDRESS,
  receivedAt: new Date(),
  meterClock: '2026-08-05T15:35:00',
  meterReportNumber: 68,
  totalUsageLiters: 2229,
  rawFrame: '6810040022082610000397...16',
  ...overrides,
});

test('a re-sent report lands as one reading, not two', async (t) => {
  if (!needsMongo(t)) return;

  // Observed on the live server: report #16 arrived twice, same counter and
  // same clock, because the acknowledgement went missing on the cellular link.
  // A second row here would corrupt every period query spanning it.
  await MeterReading.create(reading());
  await assert.rejects(
    () => MeterReading.create(reading()),
    (err: { code?: number }) => err.code === 11000,
    'the unique index rejects the replay',
  );

  // The counter moving on is a genuinely new report.
  await MeterReading.create(reading({ meterReportNumber: 69, meterClock: '2026-08-06T15:35:00' }));
  assert.equal(await MeterReading.countDocuments({ meterId: ADDRESS }), 2);
});

test('usage over a period is a difference of cumulative totals', async (t) => {
  if (!needsMongo(t)) return;
  await MeterReading.deleteMany({});

  const day = (n: number) => new Date(Date.UTC(2026, 6, n));
  for (const [n, total] of [[1, 1000], [2, 1150], [3, 1300], [4, 1500]] as const) {
    await MeterReading.create(
      reading({ receivedAt: day(n), meterReportNumber: n, meterClock: `2026-07-0${n}T06:00:00`, totalUsageLiters: total }),
    );
  }

  assert.equal(await usageBetween(ADDRESS, day(1), day(4)), 500);
  assert.equal(await usageBetween(ADDRESS, day(2), day(3)), 150);
});

test('a missed report does not lose the water it carried', async (t) => {
  if (!needsMongo(t)) return;
  await MeterReading.deleteMany({});

  // The meter reported on the 1st and the 4th; the two in between never
  // arrived, and their absence is visible as a gap in meterReportNumber. The
  // cumulative total still carries their water, which is exactly why period
  // usage differences the total instead of summing dailyUsageLiters.
  const day = (n: number) => new Date(Date.UTC(2026, 6, n));
  await MeterReading.create(reading({ receivedAt: day(1), meterReportNumber: 70, totalUsageLiters: 1000, dailyUsageLiters: 100, meterClock: '2026-07-01T06:00:00' }));
  await MeterReading.create(reading({ receivedAt: day(4), meterReportNumber: 73, totalUsageLiters: 1500, dailyUsageLiters: 120, meterClock: '2026-07-04T06:00:00' }));

  assert.equal(await usageBetween(ADDRESS, day(1), day(4)), 500, 'all four days of water');

  const rows = await MeterReading.find({ meterId: ADDRESS }).sort({ meterReportNumber: 1 }).lean();
  const summed = rows.reduce((n, r) => n + (r.dailyUsageLiters ?? 0), 0);
  assert.equal(summed, 220, 'summing the daily figure would have lost 280 L');
  assert.equal(rows[1]!.meterReportNumber! - rows[0]!.meterReportNumber!, 3, 'and the gap is visible');
});

test('a period with nothing to anchor on returns null, not zero', async (t) => {
  if (!needsMongo(t)) return;
  await MeterReading.deleteMany({});

  await MeterReading.create(reading({ receivedAt: new Date(Date.UTC(2026, 6, 10)), totalUsageLiters: 1000 }));

  // Before the meter's first report there is no honest answer. Zero would be
  // indistinguishable from a meter that genuinely used no water.
  assert.equal(await usageBetween(ADDRESS, new Date(Date.UTC(2026, 5, 1)), new Date(Date.UTC(2026, 5, 30))), null);
});

// --- the command queue --------------------------------------------------

test('a queued command survives as a row, with no closure in it', async (t) => {
  if (!needsMongo(t)) return;

  const { _id: id } = await Command.create({
    address: ADDRESS,
    type: 'set_clock',
    source: 'configurer',
    params: { method: 'aa00', timeZone: 'Asia/Dhaka', time: null, meterTypeCode: 0x10 },
    status: 'queued',
    queuedAt: new Date(),
    expiresAt: new Date(Date.now() + 48 * 3600 * 1000),
  });

  const found = await Command.findById(id).lean();
  assert.equal(found?.type, 'set_clock');
  assert.equal(found?.source, 'configurer');
  // The whole point: everything needed to build the frame later is data.
  assert.equal(found?.params.method, 'aa00');
  assert.equal(found?.params.timeZone, 'Asia/Dhaka');
  assert.equal(found?.params.time, null, 'left unresolved on purpose -- "now" means now at delivery');
  assert.equal(found?.frame, null, 'nothing on the wire yet');
});

test('the queue lookup returns the oldest live command for one meter', async (t) => {
  if (!needsMongo(t)) return;

  await Command.deleteMany({});
  const base = { address: ADDRESS, type: 'valve' as const, source: 'api' as const, queuedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) };

  // Created in order, so _id order is queue order: an ObjectId opens with a
  // timestamp, and within one process a counter keeps ties in insertion order.
  await Command.create({ ...base, status: 'acknowledged', params: {} });
  const oldest = await Command.create({ ...base, status: 'queued', params: { state: 'open' } });
  await Command.create({ ...base, status: 'queued', params: { state: 'closed' } });
  await Command.create({ ...base, address: '99999999999999', status: 'queued', params: {} });

  const next = await Command.findOne({ address: ADDRESS, status: 'queued' }).sort({ _id: 1 }).lean();
  assert.equal(String(next?._id), String(oldest._id), 'oldest queued command, and only for this meter');
  assert.deepEqual(next?.params, { state: 'open' });
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

  const before = await Command.countDocuments({});
  await assert.rejects(
    () =>
      Command.create({
        address: ADDRESS,
        ...typo,
        source: 'api',
        status: 'queued',
        queuedAt: new Date(),
        expiresAt: new Date(),
        params: {},
      }),
    /not a valid enum value/,
  );

  assert.equal(await Command.countDocuments({}), before, 'nothing was written');
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
