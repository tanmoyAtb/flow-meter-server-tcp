// Send a meter report to the partner ingest server on a fixed interval and
// record whether it ever acknowledges.
//
// This impersonates meter 00102608220004 dialling in the way a real one does:
// fresh connection per contact, one 88-byte packet-03 report (§5), then wait
// for the 20-byte 17H acknowledgement (§6) and hang up. It does not retry --
// a meter does not retry either, and the point of this job is to observe the
// partner's behaviour, not to compensate for it.
//
//   node jobs/partner-heartbeat.js
//   node jobs/partner-heartbeat.js --once --wait 20
//   node jobs/partner-heartbeat.js --static --interval 60
//
// Stop it with Ctrl-C.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checksum } from '../src/lib/frame.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'partner-heartbeat.log');
const JSONL_FILE = path.join(LOG_DIR, 'partner-heartbeat.jsonl');
const STATE_FILE = path.join(LOG_DIR, 'partner-heartbeat.state.json');

// --- configuration -------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(argv[i + 1]);
};

const HOST = process.env.PARTNER_HOST ?? '31.220.109.95';
const PORT = Number(process.env.PARTNER_PORT ?? 5001);
const INTERVAL_MS = value('interval', 300) * 1000; // 5 minutes
const ACK_WAIT_MS = value('wait', 60) * 1000;
const ONCE = flag('once');
const STATIC = flag('static');

// The §14 reference report for meter 00102608220004. In --static mode this
// goes out byte for byte; otherwise it is the template the live frame is
// built from.
const REFERENCE = Buffer.from(
  '6810040022082610000397000000024603C22C002403060300' +
    '867512079825846D898604221525700097820E0EA7F915003F' +
    '001CC005A0FFFFFF0000000008B20000000000000000260804' +
    '15372900000000000000008816',
  'hex',
);

// Offsets into the packet-03 report, §5.
const OFF = {
  reportingType: 13,
  cumulativeCount: 48,
  dailyCount: 50,
  status: 58,
  cumulativeUsage: 60,
  clock: 72,
};

const TIMED = 0x0001; // reporting-type bit D0 -- scheduled interval, §1

// --- frame construction --------------------------------------------------

/** Two BCD nibbles, the encoding every date and counter field uses. */
const bcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);

/**
 * Meter clocks carry no time zone (§10) and ours are set to Dhaka local, so
 * that is what a genuine report would contain.
 */
function meterClock(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at).reduce((acc, p) => ({ ...acc, [p.type]: Number(p.value) }), {});

  return Buffer.from([
    bcd(parts.year), bcd(parts.month), bcd(parts.day),
    bcd(parts.hour), bcd(parts.minute), bcd(parts.second),
  ]);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    // Seed from the reference frame so the series continues from where §14 left off.
    return {
      cumulativeCount: REFERENCE.readUInt16BE(OFF.cumulativeCount),
      dailyCount: REFERENCE.readUInt16BE(OFF.dailyCount),
      litres: REFERENCE.readUInt32BE(OFF.cumulativeUsage),
      day: null,
    };
  }
}

/**
 * A report that looks like it came from a live meter: clock set to now,
 * counters advanced, a plausible trickle of consumption since the last
 * contact. Everything else -- identity, firmware, radio, table type -- is the
 * reference frame's, because those genuinely do not change between reports.
 */
function buildReport(state) {
  const frame = Buffer.from(REFERENCE);
  const clock = meterClock();
  const today = clock.subarray(0, 3).toString('hex');

  if (state.day !== today) {
    state.day = today;
    state.dailyCount = 0;
  }
  state.cumulativeCount = (state.cumulativeCount + 1) & 0xffff;
  state.dailyCount = (state.dailyCount + 1) & 0xffff;
  state.litres += 1 + Math.floor(Math.random() * 5); // ~1-5 L per contact

  frame.writeUInt16BE(TIMED, OFF.reportingType);
  frame.writeUInt16BE(state.cumulativeCount, OFF.cumulativeCount);
  frame.writeUInt16BE(state.dailyCount, OFF.dailyCount);
  frame.writeUInt32BE(state.litres, OFF.cumulativeUsage);
  clock.copy(frame, OFF.clock);

  frame[frame.length - 2] = checksum(frame);
  return frame;
}

/** The acknowledgement §6 says the server owes us for this report. */
function expectedAck(report) {
  const ack = Buffer.alloc(20);
  ack[0] = 0x68;
  ack[1] = report[1];              // meter type, echoed
  report.copy(ack, 2, 2, 9);       // address, echoed
  ack[9] = 0x03;                   // device type
  ack[10] = 0x17;                  // control: acknowledge
  ack.writeUInt16BE(0x0000, 11);   // instruction number
  ack[13] = report[13];            // reporting type, echoed
  ack[14] = report[14];
  ack[15] = 0x02;                  // data length
  ack[16] = report[16];            // packet type, echoed
  ack[17] = 0xaf;                  // power-off flag: sleep now
  ack[18] = checksum(ack);
  ack[19] = 0x16;
  return ack;
}

/**
 * Grade whatever came back. "They sent bytes" is not the same as "they
 * acknowledged" -- §12 is explicit that only a byte-correct ack counts.
 */
function gradeReply(reply, want) {
  if (reply.length === 0) return { verdict: 'silent', detail: 'no bytes returned' };
  if (reply.equals(want)) return { verdict: 'ack', detail: 'byte-for-byte §6 acknowledgement' };

  const notes = [];
  if (reply.length !== 20) notes.push(`length ${reply.length}, expected 20`);
  if (reply[0] !== 0x68) notes.push('no 68H start');
  if (reply[10] !== 0x17) notes.push(`control ${hex(reply.subarray(10, 11))}, expected 17`);
  if (reply.length >= 20 && reply[18] !== checksum(reply.subarray(0, 20))) notes.push('bad checksum');
  return { verdict: 'wrong-reply', detail: notes.join('; ') || 'differs from expected ack' };
}

// --- one contact ---------------------------------------------------------

const hex = (b) => b.toString('hex').toUpperCase();
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';

function contact(report) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks = [];
    let settled = false;
    let connectedMs = null;

    const sock = new net.Socket();
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ ...outcome, connectedMs, elapsedMs: Date.now() - t0, reply: Buffer.concat(chunks) });
    };

    const timer = setTimeout(() => done({}), ACK_WAIT_MS);

    sock.setNoDelay(true);
    sock.connect(PORT, HOST, () => {
      connectedMs = Date.now() - t0;
      sock.write(report);
    });
    sock.on('data', (b) => {
      chunks.push(b);
      // An ack is one short frame; give a moment for a split read, then stop.
      setTimeout(() => done({}), 1000);
    });
    sock.on('close', () => done({}));
    sock.on('error', (err) => done({ error: err.code ?? err.message }));
  });
}

// --- run -----------------------------------------------------------------

function log(line) {
  process.stdout.write(line + '\n');
  fs.appendFileSync(LOG_FILE, line + '\n');
}

let sent = 0;
let acked = 0;

async function tick() {
  const state = readState();
  const report = STATIC ? REFERENCE : buildReport(state);
  const want = expectedAck(report);

  const result = await contact(report);
  sent += 1;

  const graded = result.error
    ? { verdict: 'error', detail: result.error }
    : gradeReply(result.reply, want);
  if (graded.verdict === 'ack') acked += 1;

  if (!STATIC) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  const litres = report.readUInt32BE(OFF.cumulativeUsage);
  log(
    `${stamp()}  #${sent}  ${HOST}:${PORT}  ` +
      `${graded.verdict.padEnd(11)} ` +
      `connect ${result.connectedMs ?? '--'}ms  waited ${(result.elapsedMs / 1000).toFixed(1)}s  ` +
      `cum ${litres} L  ${graded.detail}`,
  );
  if (result.reply.length) log(`    <-- ${result.reply.length} bytes  ${hex(result.reply)}`);

  fs.appendFileSync(
    JSONL_FILE,
    JSON.stringify({
      at: new Date().toISOString(),
      attempt: sent,
      host: HOST,
      port: PORT,
      mode: STATIC ? 'static' : 'live',
      verdict: graded.verdict,
      detail: graded.detail,
      connectedMs: result.connectedMs,
      elapsedMs: result.elapsedMs,
      sent: hex(report),
      expectedAck: hex(want),
      reply: hex(result.reply),
    }) + '\n',
  );
}

fs.mkdirSync(LOG_DIR, { recursive: true });

log(
  `${stamp()}  partner heartbeat starting -- meter 00102608220004 -> ${HOST}:${PORT}, ` +
    `${STATIC ? 'static reference frame' : 'live frame'}, ` +
    `every ${INTERVAL_MS / 1000}s, ack wait ${ACK_WAIT_MS / 1000}s`,
);

await tick();

if (!ONCE) {
  const handle = setInterval(() => { tick(); }, INTERVAL_MS);
  const stop = () => {
    clearInterval(handle);
    log(`${stamp()}  stopped -- ${sent} sent, ${acked} acknowledged`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
