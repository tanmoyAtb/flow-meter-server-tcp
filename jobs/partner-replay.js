// Replay a pinned set of captured meter reports to the partner ingest server,
// byte for byte, and grade every reply against §6.
//
// Unlike partner-heartbeat.js this invents nothing: each frame goes out exactly
// as the meter sent it, from a pinned file, so the set cannot drift between the
// moment it is reviewed and the moment it is sent. One frame per TCP connection,
// the way a real meter behaves -- dial, send, wait for the ack, hang up.
//
//   node jobs/partner-replay.js --file logs/replay-set-2026-08-09.json
//   node jobs/partner-replay.js --file <path> --wait 30 --gap 2 --dry-run
//
// The input file is a JSON array of {id, meter, rx, hex}.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checksum } from '../src/lib/frame.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const HOST = process.env.PARTNER_HOST ?? '31.220.109.95';
const PORT = Number(process.env.PARTNER_PORT ?? 5001);
const FILE = opt('file', 'logs/replay-set-2026-08-09.json');
const ACK_WAIT_MS = Number(opt('wait', 30)) * 1000;
const GAP_MS = Number(opt('gap', 2)) * 1000;
const DRY = flag('dry-run');

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
const hex = (b) => b.toString('hex').toUpperCase();

const frames = JSON.parse(fs.readFileSync(path.resolve(ROOT, FILE), 'utf8'));

/** The acknowledgement §6 says the server owes us for a given report. */
function expectedAck(report) {
  const ack = Buffer.alloc(20);
  ack[0] = 0x68;
  ack[1] = report[1];              // meter type, echoed
  report.copy(ack, 2, 2, 9);       // address, echoed -- 7 bytes, fixed width
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
 * "They sent bytes" is not "they acknowledged" -- §12 is explicit that only a
 * byte-correct ack counts. Name the specific defects so the partner can act on
 * them rather than guess.
 */
function grade(reply, want) {
  if (reply.length === 0) return { verdict: 'silent', detail: 'no bytes returned' };
  if (reply.equals(want)) return { verdict: 'ack', detail: 'byte-for-byte §6 acknowledgement' };

  const notes = [];
  if (reply.length !== 20) notes.push(`length ${reply.length}, expected 20`);
  if (reply[0] !== 0x68) notes.push('no 68H start');
  // A short address shifts every later field left, so locate the control code
  // by where it actually landed rather than assuming offset 10.
  const ctrlAt = reply.indexOf(0x17, 8);
  if (reply[10] !== 0x17) {
    notes.push(ctrlAt === -1 ? 'no 17H control byte' : `17H control at offset ${ctrlAt}, expected 10`);
  }
  if (!reply.includes(0xaf)) notes.push('no AFH power-off flag');
  if (reply.length >= 2 && reply[reply.length - 1] !== 0x16) notes.push('no 16H end byte');
  if (reply.length >= 2) {
    const own = checksum(reply);
    if (own !== reply[reply.length - 2]) notes.push('checksum invalid over its own bytes');
  }
  return { verdict: 'wrong-reply', detail: notes.join('; ') || 'differs from expected ack' };
}

function send(report) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks = [];
    let settled = false;
    let connectedMs = null;

    const sock = new net.Socket();
    const done = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ ...extra, connectedMs, elapsedMs: Date.now() - t0, reply: Buffer.concat(chunks) });
    };
    const timer = setTimeout(() => done(), ACK_WAIT_MS);

    sock.setNoDelay(true);
    sock.connect(PORT, HOST, () => {
      connectedMs = Date.now() - t0;
      sock.write(report);
    });
    sock.on('data', (b) => {
      chunks.push(b);
      setTimeout(() => done(), 1000); // allow for a split read, then stop
    });
    sock.on('close', () => done());
    sock.on('error', (err) => done({ error: err.code ?? err.message }));
  });
}

const logFile = path.join(LOG_DIR, 'partner-replay.log');
const jsonlFile = path.join(LOG_DIR, 'partner-replay.jsonl');
fs.mkdirSync(LOG_DIR, { recursive: true });

function log(line) {
  process.stdout.write(line + '\n');
  fs.appendFileSync(logFile, line + '\n');
}

log(`${stamp()}  replay starting -- ${frames.length} frame(s) from ${FILE} -> ${HOST}:${PORT}` +
    `${DRY ? '  [DRY RUN, nothing sent]' : ''}`);

const tally = { ack: 0, 'wrong-reply': 0, silent: 0, error: 0 };

for (const [i, f] of frames.entries()) {
  const report = Buffer.from(f.hex, 'hex');
  const want = expectedAck(report);

  // Never send a frame we cannot vouch for.
  if (checksum(report) !== report[report.length - 2]) {
    log(`  [${i + 1}/${frames.length}] #${f.id} ${f.meter}  SKIPPED -- checksum invalid`);
    continue;
  }

  if (DRY) {
    log(`  [${i + 1}/${frames.length}] #${f.id} ${f.meter} rx ${f.rx.slice(11, 19)}  ` +
        `${report.length}B  would send; expect ${hex(want)}`);
    continue;
  }

  const r = await send(report);
  const g = r.error ? { verdict: 'error', detail: r.error } : grade(r.reply, want);
  tally[g.verdict] = (tally[g.verdict] ?? 0) + 1;

  log(`  [${i + 1}/${frames.length}] #${f.id} ${f.meter} rx ${f.rx.slice(11, 19)}  ` +
      `${g.verdict.padEnd(11)} connect ${r.connectedMs ?? '--'}ms  ${(r.elapsedMs / 1000).toFixed(1)}s  ${g.detail}`);
  if (r.reply.length) log(`        <-- ${r.reply.length}B  ${hex(r.reply)}`);

  fs.appendFileSync(jsonlFile, JSON.stringify({
    at: new Date().toISOString(),
    source: { id: f.id, meter: f.meter, receivedAt: f.rx },
    host: HOST, port: PORT,
    verdict: g.verdict, detail: g.detail,
    connectedMs: r.connectedMs, elapsedMs: r.elapsedMs,
    sent: hex(report), expectedAck: hex(want), reply: hex(r.reply),
  }) + '\n');

  if (i < frames.length - 1) await new Promise((res) => setTimeout(res, GAP_MS));
}

log(`${stamp()}  done -- ` +
    Object.entries(tally).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', '));
