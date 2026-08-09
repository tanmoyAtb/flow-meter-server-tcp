// Watch server 1 for new meter reports and configure activity.
//
// Meters arrive in bursts -- a cold-start registration is typically 2-4
// contacts a minute or two apart while the configurer walks the clock and
// resolution rungs. So this does not fire on the first new reading; it waits
// for the burst to go quiet, then reports the whole session at once and exits.
// That makes one notification per meter rather than one per frame.
//
//   node jobs/fleet-watch.js
//   node jobs/fleet-watch.js --quiet 60 --max 120
//
// Exits 0 either way: with a report when something arrived, or with
// "no new data" when the time budget runs out.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'fleet-watch.log');

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(argv[i + 1]);
};

const BASE = process.env.SERVER ?? 'http://65.1.99.130:8505';
const POLL_MS = value('poll', 20) * 1000;
const QUIET_MS = value('quiet', 120) * 1000; // burst is over after this much silence
const MAX_MS = value('max', 180) * 60 * 1000; // give up after this long with nothing

// Meter clocks carry no time zone (§10); ours are set to Dhaka, UTC+6.
const DHAKA_OFFSET_MS = 6 * 3600 * 1000;
const RESOLUTION = { 0: 1, 1: 10, 2: 100, 3: 1000 };

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';

function log(line) {
  process.stdout.write(line + '\n');
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // Logging is a convenience here; never let it kill the watch.
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function poll() {
  const [store, commands] = await Promise.all([
    fetchJson(`${BASE}/debug/store`),
    fetchJson(`${BASE}/api/v1/commands`).catch(() => ({ commands: [] })),
  ]);
  return { readings: store.cat1Readings ?? [], failures: store.ingestFailures ?? [], commands: commands.commands ?? [] };
}

/**
 * The two things the configurer actually fixes, read back off the wire rather
 * than trusted from the command's success byte -- §5 and §11 both insist on
 * confirming against the meter's own next report.
 */
function describe(reading) {
  const raw = Buffer.from(reading.rawFrame, 'hex');
  const litres = RESOLUTION[raw[20] & 0x03];
  const skewSeconds = reading.meterClock
    ? Math.round(
        (Date.parse(`${reading.meterClock}Z`) - (Date.parse(reading.receivedAt) + DHAKA_OFFSET_MS)) / 1000,
      )
    : null;
  return { litres, skewSeconds, tableType: raw.subarray(19, 21).toString('hex').toUpperCase() };
}

function render(reading, isNewMeter) {
  const d = describe(reading);
  const clock =
    d.skewSeconds === null
      ? 'clock ?'
      : Math.abs(d.skewSeconds) > 3600
        ? `clock ${reading.meterClock} WRONG`
        : `clock ok (${d.skewSeconds >= 0 ? '+' : ''}${d.skewSeconds}s)`;

  return (
    `  ${isNewMeter ? '** NEW METER ** ' : ''}#${reading.id} ${reading.meterAddress} ` +
    `rx ${reading.receivedAt.slice(11, 19)}Z rpt#${reading.cumulativeReportCount} ` +
    `[${reading.reportingTriggers.join(',')}] ${clock} ` +
    `cum ${reading.cumulativeUsageLitres} L  valve ${reading.valveStatus}  ` +
    `res ${d.litres} L (tbl ${d.tableType})  ${reading.voltageVolts}V ${reading.signalStrengthDbm}dBm`
  );
}

/** Everything still standing between a meter and a correct configuration. */
function outstanding(reading) {
  const d = describe(reading);
  const gaps = [];
  if (d.litres !== 1) gaps.push(`resolution still ${d.litres} L`);
  if (d.skewSeconds !== null && Math.abs(d.skewSeconds) > 60) gaps.push(`clock off ${d.skewSeconds}s`);
  if (reading.valveStatus === 'closed') gaps.push('valve closed');
  return gaps;
}

// --- watch ---------------------------------------------------------------

fs.mkdirSync(LOG_DIR, { recursive: true });

const base = await poll();
const seenReadings = new Set(base.readings.map((r) => r.id));
const seenCommands = new Map(base.commands.map((c) => [c.id, c.status]));
const seenMeters = new Set(base.readings.map((r) => r.meterAddress));
const seenFailures = new Set(base.failures.map((f) => f.id));

log(
  `${stamp()}  fleet watch armed on ${BASE} -- baseline ${base.readings.length} readings, ` +
    `${seenMeters.size} meters, ${base.commands.length} commands; ` +
    `poll ${POLL_MS / 1000}s, settle ${QUIET_MS / 1000}s, budget ${MAX_MS / 60000}min`,
);

const startedAt = Date.now();
const collected = [];
const newCommands = [];
const newFailures = [];
let lastActivity = null;
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

while (true) {
  await sleep(POLL_MS);

  // The budget is wall-clock, not a count of successful polls -- if the
  // network is down the watch must still give up on time rather than spin.
  const expired = !lastActivity && Date.now() - startedAt >= MAX_MS;

  let now = null;
  try {
    now = await poll();
    if (failures) {
      log(`${stamp()}  poll recovered after ${failures} failure(s)`);
      failures = 0;
    }
  } catch (err) {
    failures += 1;
    // One line per outage, not one per attempt.
    if (failures === 1) log(`${stamp()}  poll failing: ${err.message}`);
  }

  if (!now) {
    if (expired) {
      log(`${stamp()}  giving up after ${MAX_MS / 60000} min -- ${failures} consecutive poll failure(s)`);
      process.exit(0);
    }
    continue;
  }

  for (const r of now.readings) {
    if (seenReadings.has(r.id)) continue;
    seenReadings.add(r.id);
    const isNew = !seenMeters.has(r.meterAddress);
    seenMeters.add(r.meterAddress);
    collected.push({ reading: r, isNew });
    lastActivity = Date.now();
  }

  for (const c of now.commands) {
    if (seenCommands.get(c.id) === c.status) continue;
    const known = seenCommands.has(c.id);
    seenCommands.set(c.id, c.status);
    newCommands.push(`  #${c.id} ${c.address} ${c.type} -> ${c.status}${known ? '' : ' (queued)'}`);
    lastActivity = Date.now();
  }

  for (const f of now.failures) {
    if (seenFailures.has(f.id)) continue;
    seenFailures.add(f.id);
    newFailures.push(`  #${f.id} ${f.endpoint} ${f.reason} at ${f.receivedAt.slice(11, 19)}Z`);
    lastActivity = Date.now();
  }

  // Report once the burst has settled, so a registration arrives as one event.
  if (lastActivity && Date.now() - lastActivity >= QUIET_MS) break;

  if (expired) {
    log(`${stamp()}  no new data in ${MAX_MS / 60000} min -- re-arm if still needed`);
    process.exit(0);
  }
}

// --- report --------------------------------------------------------------

const meters = [...new Set(collected.map((c) => c.reading.meterAddress))];
const fresh = collected.filter((c) => c.isNew).map((c) => c.reading.meterAddress);

log(`${stamp()}  ${collected.length} new reading(s) from ${meters.length} meter(s)` +
  (fresh.length ? `  --  NEW: ${fresh.join(', ')}` : ''));

for (const { reading, isNew } of collected) log(render(reading, isNew));

if (newCommands.length) {
  log('  --- commands ---');
  for (const line of newCommands) log(line);
}
if (newFailures.length) {
  log('  --- INGEST FAILURES ---');
  for (const line of newFailures) log(line);
}

log('  --- state after this burst ---');
for (const address of meters) {
  const last = collected.filter((c) => c.reading.meterAddress === address).pop().reading;
  const gaps = outstanding(last);
  log(`  ${address}  ${gaps.length ? 'PENDING: ' + gaps.join(', ') : 'converged'}`);
}
