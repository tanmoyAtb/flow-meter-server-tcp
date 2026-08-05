// The connection handler itself: what gets written back to the meter, in what
// order, and when.
//
// This is the part the meter actually reacts to, and it was the least-covered
// code in the project. The default order is deliberately NOT the documented one
// -- see the ACK_BEFORE_COMMAND note in tcp.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createMeterConnectionHandler } from '../src/tcp.js';
import { openStore } from '../src/store/memory.js';
import { createCommandQueue } from '../src/commands.js';
import { encodeValveOperation, ACK_CONTROL, POWER_OFF_NOW, POWER_STAY_AWAKE } from '../src/lib/cat1.js';
import { CAT1_FRAME, DEVICE_METER_ADDRESS } from './fixtures.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** The meter's real acceptance of valve command instruction 1, from the logs. */
const WRITE_RESPONSE = Buffer.from(
  '68100400220826100003840001000011AA05002608041626380000000000000000CA16',
  'hex',
);

/** And its refusal of the same, success byte 0BH. */
const REFUSED_RESPONSE = Buffer.from(
  '68100400220826100003840001000011AA050B2608041602330000000000000000AC16',
  'hex',
);

/**
 * The other frame a refusal produces, sent just before the one above: same
 * error, but instruction number 0000 and data identifier 0000 rather than the
 * ones we sent. Verbatim from 65.1.99.130 on 2026-08-04. This frame is why
 * replies are matched by session and not by instruction number -- it has also
 * been seen arriving before any command was sent on the connection.
 */
const GENERIC_REFUSAL = Buffer.from(
  '6810040022082610000384000000001100000B2608041602330000000000000000FC16',
  'hex',
);

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.writes = [];
    this.noDelay = false;
    this.remoteAddress = '198.51.100.7';
    this.remotePort = 5000;
  }
  setTimeout() {}
  setNoDelay(v) {
    this.noDelay = v;
  }
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

function connect(opts = {}) {
  const socket = new FakeSocket();
  createMeterConnectionHandler(openStore(), silent, { commandDelayMs: 0, ...opts })(socket);
  return socket;
}

const isAck = (b) => b[10] === ACK_CONTROL;
const identifierOf = (b) => b.readUInt16BE(16);

const queueValve = (queue, open = false) =>
  queue.enqueue(DEVICE_METER_ADDRESS, {
    type: 'valve',
    params: {},
    build: (n) => encodeValveOperation({ address: DEVICE_METER_ADDRESS }, { open }, n),
  });

// --- nothing queued -------------------------------------------------------

test('a report with nothing queued gets one acknowledgement, power-off AFH', () => {
  const socket = connect();
  socket.emit('data', CAT1_FRAME);
  assert.equal(socket.writes.length, 1);
  assert.ok(isAck(socket.writes[0]));
  assert.equal(socket.writes[0][17], POWER_OFF_NOW);
});

test('the report is stored even while a command is being dispatched', () => {
  const commands = createCommandQueue();
  queueValve(commands);
  const store = openStore();
  const socket = new FakeSocket();
  createMeterConnectionHandler(store, silent, { commands, commandDelayMs: 0 })(socket);
  socket.emit('data', CAT1_FRAME);
  assert.equal(store.snapshot().counts.cat1Readings, 1);
});

// --- default order: command first, no stay-awake ack ----------------------

test('a queued command is sent without a stay-awake acknowledgement first', () => {
  // The meter answers the 00H ack with 84H/0BH before it has even seen a
  // command, so that frame is not sent at all when something is queued.
  const commands = createCommandQueue();
  queueValve(commands);
  const socket = connect({ commands });
  socket.emit('data', CAT1_FRAME);

  assert.equal(socket.writes.length, 1);
  assert.ok(!isAck(socket.writes[0]));
  assert.equal(identifierOf(socket.writes[0]), 0xaa05);
});

test('the exchange is closed off with a power-off ack once the meter replies', () => {
  const commands = createCommandQueue();
  queueValve(commands);
  const socket = connect({ commands });
  socket.emit('data', CAT1_FRAME);
  socket.emit('data', WRITE_RESPONSE);

  assert.equal(socket.writes.length, 2);
  const ack = socket.writes[1];
  assert.ok(isAck(ack));
  assert.equal(ack[17], POWER_OFF_NOW); // sleep, we are done with you
});

test('a second queued command goes out instead of the power-off ack', () => {
  // The meter is awake and has just answered; no reason to make it reconnect.
  const commands = createCommandQueue();
  queueValve(commands, false);
  queueValve(commands, true);
  const socket = connect({ commands });
  socket.emit('data', CAT1_FRAME);
  socket.emit('data', WRITE_RESPONSE);

  assert.equal(socket.writes.length, 2);
  assert.ok(!isAck(socket.writes[1]));
  assert.equal(identifierOf(socket.writes[1]), 0xaa05);
  assert.equal(socket.writes[1][18], 0x55); // the second command: open
});

test('a refusal stops the queue rather than chaining into it', () => {
  // The meter abandons the session after an error, so a following command would
  // be refused too and marked failed for a fault that is not its own.
  const commands = createCommandQueue();
  queueValve(commands, false);
  queueValve(commands, true);
  const socket = connect({ commands });
  socket.emit('data', CAT1_FRAME);
  socket.emit('data', REFUSED_RESPONSE);

  assert.equal(socket.writes.length, 2);
  assert.ok(isAck(socket.writes[1])); // power-off, not the second command
  assert.equal(commands.list()[1].status, 'queued'); // still pending, untouched
});

test('no acknowledgement is sent if the meter never replies', () => {
  const commands = createCommandQueue();
  queueValve(commands);
  const socket = connect({ commands });
  socket.emit('data', CAT1_FRAME);
  assert.equal(socket.writes.filter(isAck).length, 0);
});

// --- matching a reply to its command --------------------------------------

test('both frames of a refusal resolve to the one command that was sent', () => {
  const commands = createCommandQueue();
  const cmd = queueValve(commands);
  const socket = connect({ commands });
  socket.emit('data', CAT1_FRAME);
  socket.emit('data', GENERIC_REFUSAL); // instruction number 0000
  socket.emit('data', REFUSED_RESPONSE); // the real one, same error

  assert.equal(commands.get(cmd.id).status, 'failed');
  assert.equal(commands.get(cmd.id).result, 'meter returned 11');
  // Matching on the instruction number used to credit the first frame to the
  // command and then find nothing for the second. Neither frame is orphaned now.
  assert.equal(socket.writes.length, 2, 'command out, then one power-off ack');
});

test('a reply on a connection that sent nothing is not credited to a stale command', () => {
  // A command the meter never answered stays at "sent" forever -- AA00 clock
  // writes never reply at all, so this is the normal case, not an edge one.
  const commands = createCommandQueue();
  const stale = queueValve(commands);
  const first = connect({ commands });
  first.emit('data', CAT1_FRAME);
  first.destroy();
  assert.equal(commands.get(stale.id).status, 'sent');

  // A later contact opens with the generic refusal before anything is sent.
  const second = connect({ commands });
  second.emit('data', GENERIC_REFUSAL);

  assert.equal(commands.get(stale.id).status, 'sent', 'not failed by a frame from another session');
  assert.equal(second.writes.length, 0);
});

test('a reply carrying another meter address is not credited either', () => {
  const commands = createCommandQueue();
  const cmd = queueValve(commands);
  const socket = connect({ commands });
  socket.emit('data', CAT1_FRAME);

  const other = Buffer.from(REFUSED_RESPONSE);
  other[2] ^= 0xff; // a different address in the same envelope
  other[other.length - 2] = other.subarray(0, other.length - 2).reduce((s, b) => (s + b) & 0xff, 0);
  socket.emit('data', other);

  assert.equal(commands.get(cmd.id).status, 'sent');
});

// --- the documented order, kept available ---------------------------------

test('ackBeforeCommand restores the section 3 order with the 00H flag', () => {
  const commands = createCommandQueue();
  queueValve(commands);
  const socket = connect({ commands, ackBeforeCommand: true });
  socket.emit('data', CAT1_FRAME);

  assert.equal(socket.writes.length, 2);
  assert.ok(isAck(socket.writes[0]));
  assert.equal(socket.writes[0][17], POWER_STAY_AWAKE);
  assert.equal(identifierOf(socket.writes[1]), 0xaa05);
});

test('in that mode the command is delayed so it cannot share a TCP segment', async () => {
  const commands = createCommandQueue();
  queueValve(commands);
  const socket = connect({ commands, ackBeforeCommand: true, commandDelayMs: 30 });
  socket.emit('data', CAT1_FRAME);

  assert.equal(socket.writes.length, 1); // ack out, command not yet
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(socket.writes.length, 2);
});

test('a delayed command is dropped if the meter hangs up first', async () => {
  const commands = createCommandQueue();
  queueValve(commands);
  const socket = connect({ commands, ackBeforeCommand: true, commandDelayMs: 30 });
  socket.emit('data', CAT1_FRAME);
  socket.destroy();

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(socket.writes.length, 1);
});

test('Nagle is disabled so a frame is not held back waiting for company', () => {
  assert.equal(connect().noDelay, true);
});
