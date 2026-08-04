import test from 'node:test';
import assert from 'node:assert/strict';

import { createCommandQueue } from '../src/commands.js';
import {
  encodeSetClock,
  encodeSetClockParam,
  decodeCat1Frame,
  decodeWriteResponse,
  WRITE_CONTROL,
} from '../src/lib/cat1.js';
import { checksum, FrameError } from '../src/lib/cjt188.js';
import { DEVICE_METER_ADDRESS } from './fixtures.js';

const target = { meterTypeCode: 0x10, address: DEVICE_METER_ADDRESS };
const when = new Date(Date.UTC(2026, 7, 3, 10, 40, 5)); // 2026-08-03 10:40:05

// --- clock calibration encoder (protocol section 2.1) ---------------------

test('clock command matches the documented layout', () => {
  const cmd = encodeSetClock(target, when, 0x1234);
  assert.equal(cmd.length, 35); // section 2.1: CS at 33, end frame at 34
  assert.equal(cmd[0], 0x68);
  assert.equal(cmd[9], 0x01); // server-originated, not the document's 03H
  assert.equal(cmd[10], WRITE_CONTROL); // 04H, server write
  assert.equal(cmd.readUInt16BE(11), 0x1234); // instruction number
  assert.equal(cmd.readUInt16BE(13), 0x0000); // spare
  assert.equal(cmd[15], 0x11); // section 2.1 data length 17
  assert.equal(cmd.readUInt16BE(16), 0xaa00); // data identifier
  assert.equal(cmd[18], 0x5a); // calibration enable
  assert.equal(cmd.at(-1), 0x16);
  assert.equal(cmd.at(-2), checksum(cmd));
});

test('length field reconciles with the frame size', () => {
  const cmd = encodeSetClock(target, when, 1);
  assert.equal(16 + cmd[15] + 2, cmd.length);
});

test('clock is written as plain BCD, year through second', () => {
  const cmd = encodeSetClock(target, when, 1);
  assert.equal(cmd.subarray(19, 25).toString('hex'), '260803104005');
});

test('command carries the meter address the reply can be matched on', () => {
  const cmd = encodeSetClock(target, when, 1);
  assert.equal(decodeCat1Frame(cmd).address, DEVICE_METER_ADDRESS);
});

// --- write response (protocol section 2, Table -> Server) -----------------

/** Build the reply a meter would send to the command above. */
function buildWriteResponse(address, instructionNumber, errorCode) {
  const buf = Buffer.alloc(35);
  buf[0] = 0x68;
  buf[1] = 0x10;
  Buffer.from(address.match(/../g).reverse().join(''), 'hex').copy(buf, 2);
  buf[9] = 0x03;
  buf[10] = 0x84;
  buf.writeUInt16BE(instructionNumber, 11);
  buf[15] = 0x11;
  buf.writeUInt16BE(0xaa00, 16);
  buf[18] = errorCode;
  Buffer.from('260803104006', 'hex').copy(buf, 19);
  buf[33] = checksum(buf);
  buf[34] = 0x16;
  return buf;
}

test('a success reply decodes as success', () => {
  const res = decodeWriteResponse(buildWriteResponse(DEVICE_METER_ADDRESS, 7, 0));
  assert.equal(res.success, true);
  assert.equal(res.instructionNumber, 7);
  assert.equal(res.address, DEVICE_METER_ADDRESS);
  assert.equal(res.meterClock.iso, '2026-08-03T10:40:06');
});

test('a non-zero flag is an error, and the code is surfaced', () => {
  const res = decodeWriteResponse(buildWriteResponse(DEVICE_METER_ADDRESS, 7, 3));
  assert.equal(res.success, false);
  assert.equal(res.errorCode, 3);
});

test('a report frame is not mistaken for a write response', () => {
  const cmd = encodeSetClock(target, when, 1); // control 04H, not 84H
  assert.throws(
    () => decodeWriteResponse(cmd),
    (err) => err instanceof FrameError && err.code === 'not_write_response',
  );
});

// --- queue ----------------------------------------------------------------

const enqueueClock = (queue, address = DEVICE_METER_ADDRESS) =>
  queue.enqueue(address, {
    type: 'set_clock',
    params: { time: when.toISOString() },
    build: (instr) => encodeSetClock({ address }, when, instr),
  });

test('a queued command is pending for its meter and no other', () => {
  const queue = createCommandQueue();
  enqueueClock(queue);
  assert.equal(queue.hasPending(DEVICE_METER_ADDRESS), true);
  assert.equal(queue.hasPending('99999999999999'), false);
});

test('instruction numbers do not repeat', () => {
  const queue = createCommandQueue();
  const a = enqueueClock(queue);
  const b = enqueueClock(queue);
  assert.notEqual(a.instructionNumber, b.instructionNumber);
});

test('sending then acknowledging walks the command through its lifecycle', () => {
  const queue = createCommandQueue();
  const cmd = enqueueClock(queue);
  assert.equal(queue.get(cmd.id).status, 'queued');

  queue.markSent(cmd);
  assert.equal(queue.get(cmd.id).status, 'sent');
  // Once sent it is no longer offered up for delivery again.
  assert.equal(queue.nextFor(DEVICE_METER_ADDRESS), null);

  const match = queue.findSentByInstruction(DEVICE_METER_ADDRESS, cmd.instructionNumber);
  assert.equal(match.id, cmd.id);
  queue.complete(match, { success: true });
  assert.equal(queue.get(cmd.id).status, 'acknowledged');
});

test('a meter error marks the command failed, not acknowledged', () => {
  const queue = createCommandQueue();
  const cmd = enqueueClock(queue);
  queue.markSent(cmd);
  queue.complete(cmd, { success: false, detail: 'meter returned 3' });
  assert.equal(queue.get(cmd.id).status, 'failed');
  assert.equal(queue.get(cmd.id).result, 'meter returned 3');
});

test('commands expire rather than waiting for a meter that never returns', () => {
  let clock = 1_000_000;
  const queue = createCommandQueue({ ttlMs: 1000, now: () => clock });
  const cmd = enqueueClock(queue);
  assert.equal(queue.hasPending(DEVICE_METER_ADDRESS), true);

  clock += 1001;
  assert.equal(queue.hasPending(DEVICE_METER_ADDRESS), false);
  assert.equal(queue.get(cmd.id).status, 'expired');
});

test('the queue never leaks the frame builder to callers', () => {
  const queue = createCommandQueue();
  const cmd = enqueueClock(queue);
  assert.equal(queue.get(cmd.id).build, undefined);
});

// --- AC12 variant, after a meter rejected AA00 with error 0BH --------------

test('AC12 clock write matches the generic section 2 parameter layout', () => {
  const cmd = encodeSetClockParam(target, when, 0x2211);
  assert.equal(cmd.length, 26); // section 2 generic write: identifier(2) + clock(6)
  assert.equal(cmd[9], 0x01);
  assert.equal(cmd[10], WRITE_CONTROL);
  assert.equal(cmd.readUInt16BE(11), 0x2211);
  assert.equal(cmd[15], 0x08); // identifier(2) + clock(6)
  assert.equal(cmd.readUInt16BE(16), 0xac12);
  assert.equal(cmd.subarray(18, 24).toString('hex'), '260803104005');
  assert.equal(cmd.at(-2), checksum(cmd));
  assert.equal(cmd.at(-1), 0x16);
  assert.equal(16 + cmd[15] + 2, cmd.length);
});

test('a reply with a zeroed instruction number still resolves the command', () => {
  // Observed from real hardware: the rejection echoed instruction 0000 rather
  // than the number we sent, which used to leave the command stuck at "sent".
  const queue = createCommandQueue();
  const cmd = enqueueClock(queue);
  queue.markSent(cmd);

  const match = queue.findSentByInstruction(DEVICE_METER_ADDRESS, 0);
  assert.equal(match.id, cmd.id);
  queue.complete(match, { success: false, detail: 'meter returned 11' });
  assert.equal(queue.get(cmd.id).status, 'failed');
});

test('the fallback does not guess when several commands are outstanding', () => {
  const queue = createCommandQueue();
  const a = enqueueClock(queue);
  const b = enqueueClock(queue);
  queue.markSent(a);
  queue.markSent(b);
  // Ambiguous: mis-attributing a failure is worse than leaving it unresolved.
  assert.equal(queue.findSentByInstruction(DEVICE_METER_ADDRESS, 0), null);
  // An exact instruction number still matches precisely.
  assert.equal(queue.findSentByInstruction(DEVICE_METER_ADDRESS, b.instructionNumber).id, b.id);
});
