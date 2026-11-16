// CJ/T 188, the protocol the Shenzhen Jiaronghua 515A ultrasonic meter speaks.
//
// The frames here are not invented. They are the exact bytes meter
// 00000020260812 sent to server 1 on 2026-11-16, captured from the ingest log:
// a registration frame, the six-byte packet that follows it, and the metering
// report. Everything asserted below is either checkable against the wire (the
// checksum, the length rule) or against reality (the timestamp decodes to the
// Dhaka time at which the frame actually arrived).
//
// The vendor has supplied no definition for data identifier 921F, so these
// tests also pin the boundary of what we claim to understand: the undecoded
// bytes are asserted to still be present, because losing them would mean
// needing the meter again to re-decode a reading.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  decodeCjt188Frame,
  decodeCjt188Report,
  isCjt188Frame,
  isPreamble,
  trailingPreamble,
  METERING_DATA_IDENTIFIER,
} from '../src/lib/cjt188.js';
import { isCat1Frame } from '../src/lib/cat1.js';
import { checksum } from '../src/lib/frame.js';
import { createMeterConnectionHandler } from '../src/tcp.js';
import { openStore } from '../src/store/memory.js';
import { CAT1_FRAME } from './fixtures.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** The 158-byte metering report, exactly as received at 09:17:37Z. */
export const CJT188_REPORT_HEX =
  '6810120826200000008191921F003617151611262803EA0303F81F802B000000002B00000000350000' +
  '00001018009718006F014001800001032B000000002B00000000400180001611262B000000002B0000' +
  '0000400180001511262B000000002B0000000040018000141126A00500003CA00553002B0053005300' +
  '011C010F903268050531018889813873736093660800002803EA030100FFFF2E65B416';
const REPORT = Buffer.from(CJT188_REPORT_HEX, 'hex');

/** The 28-byte frame the meter sends first. Valid envelope, undocumented body. */
const REGISTRATION = Buffer.from('68801208262000000080000E000B01300F9032680505310188899816', 'hex');

/** What arrives between the two: three undocumented bytes, then the preamble. */
const BETWEEN = Buffer.from('0000A1FEFEFE', 'hex');

const METER = '00000020260812';

// --- telling the two protocols apart ---------------------------------------

test('the report is CJ/T 188 and is not mistaken for CAT-1', () => {
  assert.equal(isCjt188Frame(REPORT), true);
  assert.equal(isCat1Frame(REPORT), false);
});

test('a CAT-1 report is not mistaken for CJ/T 188', () => {
  // This is the property that lets both fleets share one port. A CAT-1 report
  // carries its control code at byte 10, where CJ/T 188 carries its length, so
  // the length rule lands nowhere near the real end of the frame.
  assert.equal(isCat1Frame(CAT1_FRAME), true);
  assert.equal(isCjt188Frame(CAT1_FRAME), false);
  assert.notEqual(11 + CAT1_FRAME[10] + 2, CAT1_FRAME.length, 'byte 10 is not a length here');
});

test('the registration frame is rejected: valid envelope, wrong length rule', () => {
  // 28 bytes carrying L=00H. The checksum is good, so the splitter is right to
  // call it a frame -- but it is not a CJ/T 188 message and is not decoded as one.
  assert.equal(checksum(REGISTRATION), REGISTRATION[REGISTRATION.length - 2], 'checksum is valid');
  assert.equal(isCjt188Frame(REGISTRATION), false);
  assert.equal(isCat1Frame(REGISTRATION), false);
});

test('the frame is located by the rule the vendor document describes', () => {
  assert.equal(REPORT[0], 0x68);
  assert.equal(REPORT.at(-1), 0x16);
  assert.equal(11 + REPORT[10] + 2, REPORT.length, 'header + L + trailer accounts for every byte');
  assert.equal(checksum(REPORT), REPORT.at(-2), 'sum from 68H, truncated to a byte');
});

// --- the preamble ----------------------------------------------------------

test('FE FE FE is preamble, and the bytes before it are not', () => {
  assert.equal(isPreamble(Buffer.from('FEFEFE', 'hex')), true);
  assert.equal(isPreamble(BETWEEN), false, 'the leading 00 00 A1 is not preamble');
  assert.equal(trailingPreamble(BETWEEN), 3, 'three FEH at the end');
  assert.equal(trailingPreamble(Buffer.from('0000A1', 'hex')), 0);
});

// --- the envelope ----------------------------------------------------------

test('the envelope reads the address low byte first, as the vendor document says', () => {
  const e = decodeCjt188Frame(REPORT);
  assert.equal(e.protocol, 'cjt188');
  assert.equal(e.address, METER, '12 08 26 20 00 00 00 reversed');
  assert.equal(e.meterTypeCode, 0x10);
  assert.equal(e.meterType, 'cold water');
  assert.equal(e.control, 0x81);
  assert.equal(e.controlName, 'read_response');
  assert.equal(e.dataLength, 145);
  assert.equal(e.identifier, METERING_DATA_IDENTIFIER);
  assert.equal(e.sequence, 0);
});

// --- the report ------------------------------------------------------------

test('the meter clock decodes to the time the frame actually arrived', () => {
  // This is the check that validated the whole layout. The frame reached the
  // server at 09:17:36Z, which is 15:17 in Dhaka, and the meter had applied no
  // correction of its own -- so a decoder that lands on any other value is
  // reading the wrong offset.
  const r = decodeCjt188Report(decodeCjt188Frame(REPORT));
  assert.equal(r.meterClock.iso, '2026-11-16T15:17:00');
  assert.equal(r.meterClock.raw, '1715161126');
});

test('both registers decode, and carry their direction sign', () => {
  const r = decodeCjt188Report(decodeCjt188Frame(REPORT));
  assert.equal(r.forward.sign, '+', "2BH is ASCII '+'");
  assert.equal(r.reverse.sign, '+');
  assert.equal(r.forward.cubicMetres, 0, 'the meter has not passed water yet');
  assert.equal(r.reverse.cubicMetres, 0);
  assert.equal(r.forward.raw, '2B00000000', 'the raw bytes survive the decode');
});

test('the daily records are walked, not assumed', () => {
  // The manual promises 30 days of daily data and this frame carries three.
  // Nothing says where the count lives, so the decoder walks while the dates
  // and signs parse -- these three are consecutive, which is what makes the
  // 17-byte stride credible.
  const r = decodeCjt188Report(decodeCjt188Frame(REPORT));
  assert.equal(r.daily.length, 3);
  assert.deepEqual(
    r.daily.map((d) => d.date),
    ['2026-11-16', '2026-11-15', '2026-11-14'],
  );
  for (const d of r.daily) {
    assert.equal(d.forward.sign, '+');
    assert.equal(d.forward.cubicMetres, 0);
    assert.equal(d.raw.length, 17 * 2, 'each record keeps its own raw bytes');
  }
});

test('bytes we cannot explain are kept rather than dropped', () => {
  // The point of this test is the gap, not the values. Until the vendor sends
  // the DI 921F definition these bytes are the only record of what the meter
  // said, and a decoder that quietly discarded them would make the reading
  // impossible to correct later.
  const r = decodeCjt188Report(decodeCjt188Frame(REPORT));
  assert.equal(r.unknown.beforeClock, '36');
  assert.equal(r.unknown.afterClock, '2803EA0303F81F80');
  assert.ok(r.unknown.afterRegisters.length > 0);
  assert.ok(r.unknown.afterRecords.startsWith('A00500003C'), 'the tail after the records is kept');
});

test('a frame carrying another identifier is refused rather than guessed at', () => {
  const other = Buffer.from(REPORT);
  other[11] = 0xa0; // the documented valve-control identifier, not the report
  other[12] = 0x17;
  other[other.length - 2] = checksum(other);
  assert.throws(
    () => decodeCjt188Report(decodeCjt188Frame(other)),
    (err) => err.code === 'unexpected_identifier' && /0xA017/.test(err.message),
  );
});

// --- end to end, through the socket handler --------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.writes = [];
    this.remoteAddress = '37.111.212.178';
    this.remotePort = 36797;
  }
  setTimeout() {}
  setNoDelay() {}
  destroy() {
    this.writable = false;
    this.emit('close');
  }
  write(buf, cb) {
    this.writes.push(Buffer.from(buf));
    cb?.();
    return true;
  }
}

function connect(store, opts = {}) {
  const socket = new FakeSocket();
  createMeterConnectionHandler(store, silent, { commandDelayMs: 0, ...opts })(socket);
  return socket;
}

test('the exact 192 bytes the meter sent produce one recorded reading', () => {
  // Byte for byte what arrived on the wire, in one chunk, in arrival order.
  const store = openStore();
  const socket = connect(store);
  socket.emit('data', Buffer.concat([REGISTRATION, BETWEEN, REPORT]));

  const rows = store.cjt188Readings();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meterAddress, METER);
  assert.equal(rows[0].protocol, 'cjt188');
  assert.equal(rows[0].meterClock, '2026-11-16T15:17:00');
  assert.equal(rows[0].forwardCubicMetres, 0);
  assert.equal(rows[0].dailyRecords.length, 3);
  assert.equal(rows[0].rawFrame, CJT188_REPORT_HEX.toUpperCase());
  assert.equal(store.cat1Readings().length, 0, 'nothing leaked into the CAT-1 collection');
});

test('nothing is written back to a CJ/T 188 meter', () => {
  // Deliberate, and the most important assertion in this file. The vendor has
  // not told us what acknowledgement this meter expects, and AA07 on the CAT-1
  // fleet is what a write to a half-understood meter costs: it opened valves.
  // The meter retrying is the price of not guessing. Change this test only when
  // the ack is documented or observed, never to stop the retries.
  const store = openStore();
  const socket = connect(store);
  socket.emit('data', Buffer.concat([REGISTRATION, BETWEEN, REPORT]));
  assert.equal(socket.writes.length, 0);
});

test('a retry of the same report is recorded once', () => {
  // The meter re-sends the identical frame every minute or so while it waits
  // for an ack it is not getting, so without dedup one silent night would fill
  // the store with copies of one reading.
  const store = openStore();
  const socket = connect(store);
  socket.emit('data', REPORT);
  socket.emit('data', REPORT);
  assert.equal(store.cjt188Readings().length, 1);
});

test('the preamble is recorded as a preamble, not as a fault', () => {
  const store = openStore();
  const socket = connect(store);
  socket.emit('data', Buffer.concat([BETWEEN, REPORT]));
  const reasons = store.ingestFailures().map((f) => f.reason);
  assert.equal(reasons.length, 1, 'the six non-frame bytes are still recorded');
  assert.match(reasons[0], /CJ\/T 188 preamble \(3 x FEH\) preceded by 3 byte\(s\)/);
});

test('both fleets are served by one handler without interfering', () => {
  // The whole point of the exercise: one port, one store, two protocols.
  const store = openStore();
  const socket = connect(store);
  socket.emit('data', CAT1_FRAME);
  socket.emit('data', REPORT);

  assert.equal(store.cat1Readings().length, 1, 'the CAT-1 fleet still decodes');
  assert.equal(store.cjt188Readings().length, 1, 'and so does the new meter');
  assert.equal(store.cat1Readings()[0].meterAddress, '00102608220004');
  assert.equal(store.cjt188Readings()[0].meterAddress, METER);
  assert.ok(socket.writes.length >= 1, 'the CAT-1 meter is still answered on the wire');
});

test('the snapshot counts both fleets separately', () => {
  const store = openStore();
  const socket = connect(store);
  socket.emit('data', CAT1_FRAME);
  socket.emit('data', REPORT);
  const { counts } = store.snapshot();
  assert.equal(counts.cat1Readings, 1);
  assert.equal(counts.cjt188Readings, 1);
});
