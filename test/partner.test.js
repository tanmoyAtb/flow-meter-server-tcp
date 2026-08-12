// Forwarding readings to the partner's ingest server.
//
// The property that matters most here is a negative one: nothing this module
// does may slow down or break the meter exchange. Most of these tests are
// therefore about what happens when the partner misbehaves -- refuses the
// connection, says nothing, answers with rubbish -- and assert that the meter
// still got its ack and the reading still reached the store.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';

import { createPartnerForwarder, PARTNER_FORWARDING, PARTNER_ENDPOINT } from '../src/partner.js';
import { createMeterConnectionHandler } from '../src/tcp.js';
import { openStore } from '../src/store/memory.js';
import { decodeCat1Frame, encodeReportAck, ACK_CONTROL } from '../src/lib/cat1.js';
import { CAT1_FRAME, DEVICE_METER_ADDRESS } from './fixtures.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const envelope = decodeCat1Frame(CAT1_FRAME);
const hex = CAT1_FRAME.toString('hex');

/** A stand-in partner. `reply` decides what it sends back, if anything. */
async function fakePartner({ reply = 'ack', onFrame = () => {} } = {}) {
  const received = [];
  const server = net.createServer((socket) => {
    socket.on('data', (buf) => {
      received.push(Buffer.from(buf));
      onFrame(buf);
      if (reply === 'ack') socket.end(encodeReportAck(decodeCat1Frame(buf)));
      else if (reply === 'garbage') socket.end(Buffer.from('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'hex'));
      else if (reply === 'close') socket.end();
      // 'silent': hold the socket open and say nothing
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, received, close: () => server.close() };
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

// --- the switch -----------------------------------------------------------

test('the switch is a code constant, not an environment variable', () => {
  // If this ever becomes env-driven, what we send to a third party stops being
  // visible in the diff. That is the whole point of it living here.
  assert.equal(typeof PARTNER_FORWARDING, 'boolean');
  assert.equal(PARTNER_ENDPOINT.host, '31.220.109.95');
  assert.equal(PARTNER_ENDPOINT.port, 5001);
});

test('disabled, it accepts nothing and opens no sockets', async () => {
  const p = await fakePartner();
  const fwd = createPartnerForwarder(silent, { enabled: false, port: p.port, host: '127.0.0.1' });

  assert.equal(fwd.forward(hex, envelope), false);
  await settle();
  assert.equal(p.received.length, 0);
  assert.equal(fwd.stats().counters.accepted, 0, 'not even counted');
  p.close();
});

// --- the happy path -------------------------------------------------------

test('a reading is forwarded byte for byte and the ack is recognised', async () => {
  const p = await fakePartner({ reply: 'ack' });
  const fwd = createPartnerForwarder(silent, { enabled: true, port: p.port, host: '127.0.0.1' });

  fwd.forward(hex, envelope);
  await settle();

  assert.equal(p.received.length, 1);
  assert.equal(p.received[0].toString('hex'), hex, 'exactly what the meter sent, unmodified');
  assert.equal(fwd.stats().counters.acked, 1);
  assert.equal(fwd.stats().counters.wrongReply, 0);
  p.close();
});

test('a duplicate reading is not sent twice', async () => {
  const p = await fakePartner();
  const fwd = createPartnerForwarder(silent, { enabled: true, port: p.port, host: '127.0.0.1' });

  fwd.forward(hex, envelope, { duplicate: false });
  fwd.forward(hex, envelope, { duplicate: true });
  await settle();

  assert.equal(p.received.length, 1, 'the duplicate would double-count on their side');
  assert.equal(fwd.stats().counters.duplicate, 1);
  p.close();
});

// --- the partner misbehaving ----------------------------------------------

test('a wrong reply is counted, not mistaken for success', async () => {
  const p = await fakePartner({ reply: 'garbage' });
  const fwd = createPartnerForwarder(silent, { enabled: true, port: p.port, host: '127.0.0.1' });

  fwd.forward(hex, envelope);
  await settle();

  assert.equal(fwd.stats().counters.acked, 0);
  assert.equal(fwd.stats().counters.wrongReply, 1);
  p.close();
});

test('silence is counted, and the socket does not hang forever', async () => {
  const p = await fakePartner({ reply: 'silent' });
  const fwd = createPartnerForwarder(silent, {
    enabled: true,
    port: p.port,
    host: '127.0.0.1',
    ackTimeoutMs: 120,
  });

  fwd.forward(hex, envelope);
  await settle(400);

  assert.equal(fwd.stats().counters.silent, 1);
  assert.equal(fwd.stats().inFlight, 0, 'released after the timeout');
  p.close();
});

test('a refused connection is counted and never thrown', async () => {
  // Port 1 on loopback: nothing listens there.
  const fwd = createPartnerForwarder(silent, { enabled: true, host: '127.0.0.1', port: 1 });
  assert.doesNotThrow(() => fwd.forward(hex, envelope));
  await settle(300);
  assert.equal(fwd.stats().counters.failed, 1);
});

test('an unparseable frame is counted, not thrown into the ingest path', () => {
  const fwd = createPartnerForwarder(silent, { enabled: true, host: '127.0.0.1', port: 1 });
  assert.doesNotThrow(() => fwd.forward('not-hex-at-all', {}));
  assert.equal(fwd.stats().counters.failed, 1);
});

// --- the backlog ----------------------------------------------------------

test('the backlog is bounded, and it is the oldest frame that is dropped', async () => {
  const p = await fakePartner({ reply: 'silent' });
  const fwd = createPartnerForwarder(silent, {
    enabled: true,
    port: p.port,
    host: '127.0.0.1',
    ackTimeoutMs: 5000,
    maxInFlight: 1,
    maxQueued: 2,
  });

  for (let i = 0; i < 10; i++) fwd.forward(hex, envelope);
  const s = fwd.stats();
  assert.ok(s.queued <= 2, `queued ${s.queued}, ceiling is 2`);
  assert.ok(s.counters.dropped > 0, 'the excess was dropped rather than buffered forever');
  p.close();
});

// --- the guarantee that matters -------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.writes = [];
    this.remoteAddress = '198.51.100.7';
    this.remotePort = 5000;
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

test('a dead partner does not cost the meter its acknowledgement', async () => {
  // The whole reason forwarding is fire-and-forget. Nothing listens on port 1.
  const store = openStore();
  const partner = createPartnerForwarder(silent, { enabled: true, host: '127.0.0.1', port: 1 });
  const socket = new FakeSocket();
  createMeterConnectionHandler(store, silent, { partner, commandDelayMs: 0 })(socket);

  socket.emit('data', CAT1_FRAME);

  // Synchronously, before the partner connection has even failed:
  assert.equal(socket.writes.length, 1, 'the meter was answered immediately');
  assert.equal(socket.writes[0][10], ACK_CONTROL);
  assert.equal(store.snapshot().cat1Readings.length, 1, 'and the reading was stored');

  await settle(300);
  assert.equal(partner.stats().counters.failed, 1, 'the partner failure happened after, harmlessly');
});

test('the reading reaches our store whether or not the partner is reachable', async () => {
  const p = await fakePartner({ reply: 'ack' });
  const store = openStore();
  const partner = createPartnerForwarder(silent, { enabled: true, host: '127.0.0.1', port: p.port });
  const socket = new FakeSocket();
  createMeterConnectionHandler(store, silent, { partner, commandDelayMs: 0 })(socket);

  socket.emit('data', CAT1_FRAME);
  await settle();

  const readings = store.snapshot().cat1Readings;
  assert.equal(readings.length, 1);
  assert.equal(readings[0].meterAddress, DEVICE_METER_ADDRESS);
  assert.equal(partner.stats().counters.acked, 1, 'and it was forwarded too');
  p.close();
});

test('with no forwarder wired in at all, ingest is unchanged', () => {
  const store = openStore();
  const socket = new FakeSocket();
  createMeterConnectionHandler(store, silent, { commandDelayMs: 0 })(socket);
  socket.emit('data', CAT1_FRAME);

  assert.equal(socket.writes[0][10], ACK_CONTROL);
  assert.equal(store.snapshot().cat1Readings.length, 1);
});
