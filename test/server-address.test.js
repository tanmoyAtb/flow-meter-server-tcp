// Re-pointing the meter at a different server (parameter 0xAC0E / 0xAC0F,
// written through section 2's generic parameter write).
//
// This is the one command with no opposite: a meter sent to a server that does
// not acknowledge its reports cannot be commanded back. The tests below are
// mostly about the ways it must refuse to build a frame.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeSetServerAddress,
  encodeSetServerEndpoint,
  serverEndpointConfirmation,
  decodeCat1Frame,
  WRITE_CONTROL,
  SERVER_ADDRESS_PRIMARY,
  SERVER_ADDRESS_SECONDARY,
  SERVER_ADDRESS_DATA_LENGTH,
  SERVER_ENDPOINT_IDENTIFIER,
  SERVER_ENDPOINT_DATA_LENGTH,
  SERVER_ENDPOINT_ENABLE,
} from '../src/lib/cat1.js';
import { checksum } from '../src/lib/cjt188.js';
import { createApp } from '../src/app.js';
import { openStore } from '../src/store/memory.js';
import { createCommandQueue } from '../src/commands.js';
import { DEVICE_METER_ADDRESS } from './fixtures.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const target = { meterTypeCode: 0x10, address: DEVICE_METER_ADDRESS };

/** The address this meter already reports to -- the safe probe. */
const CURRENT = { ip: '65.1.99.130', port: 8505 };

// --- encoder --------------------------------------------------------------

test('the command matches the section 2 generic write layout', () => {
  const cmd = encodeSetServerAddress(target, CURRENT, 0x0001);
  assert.equal(cmd.length, 26); // CS at 24, end frame at 25
  assert.equal(cmd[0], 0x68);
  assert.equal(cmd[9], 0x03);
  assert.equal(cmd[10], WRITE_CONTROL);
  assert.equal(cmd.readUInt16BE(11), 0x0001);
  assert.equal(cmd.readUInt16BE(13), 0x0000); // spare
  assert.equal(cmd[15], SERVER_ADDRESS_DATA_LENGTH); // 08H
  assert.equal(cmd.readUInt16BE(16), SERVER_ADDRESS_PRIMARY);
  assert.equal(cmd.at(-2), checksum(cmd));
  assert.equal(cmd.at(-1), 0x16);
  assert.equal(16 + cmd[15] + 2, cmd.length);
});

test('the IP goes in high byte first, then the port', () => {
  // Section 5's own example: 192.168.1.100:10086 -> C0 A8 01 64 27 66.
  const cmd = encodeSetServerAddress(target, { ip: '192.168.1.100', port: 10086 }, 1);
  assert.equal(cmd.subarray(18, 24).toString('hex'), 'c0a801642766');
});

test('it encodes the address this meter currently uses', () => {
  const cmd = encodeSetServerAddress(target, CURRENT, 0x0001);
  assert.equal(cmd.subarray(18, 24).toString('hex'), '410163822139'); // 65.1.99.130:8505
  assert.equal(cmd.toString('hex'), '68100400220826100003040001000008ac0e4101638221392716');
});

test('the secondary address is the same frame with one identifier changed', () => {
  const primary = encodeSetServerAddress(target, CURRENT, 1);
  const secondary = encodeSetServerAddress(target, { ...CURRENT, identifier: SERVER_ADDRESS_SECONDARY }, 1);
  assert.equal(secondary.readUInt16BE(16), 0xac0f);
  assert.equal(secondary.subarray(18, 24).toString('hex'), primary.subarray(18, 24).toString('hex'));
  assert.notEqual(secondary.at(-2), primary.at(-2)); // checksum moves with it
});

test('the command carries the addressed meter', () => {
  assert.equal(decodeCat1Frame(encodeSetServerAddress(target, CURRENT, 1)).address, DEVICE_METER_ADDRESS);
});

test('a malformed address never becomes a frame', () => {
  // Every one of these, sent to a meter, would be an unrecoverable mistake.
  for (const bad of ['65.1.99', '65.1.99.256', '65.1.99.130.5', 'localhost', '', null, undefined]) {
    assert.throws(() => encodeSetServerAddress(target, { ip: bad, port: 8505 }, 1), { code: 'bad_ip' }, String(bad));
  }
  for (const bad of [0, -1, 65536, 8505.5, '8505', null, undefined]) {
    assert.throws(
      () => encodeSetServerAddress(target, { ip: '65.1.99.130', port: bad }, 1),
      { code: 'bad_port' },
      String(bad),
    );
  }
});

// --- AA17H, the command the vendor confirmed ------------------------------

test('the AA17 frame matches the section 2.12 byte table exactly', () => {
  const cmd = encodeSetServerEndpoint(target, CURRENT, 0x0001);

  assert.equal(cmd.length, 38); // CS at 36, end frame at 37
  assert.equal(cmd[0], 0x68);
  assert.equal(cmd[9], 0x03);
  assert.equal(cmd[10], WRITE_CONTROL); // 04H
  assert.equal(cmd.readUInt16BE(11), 0x0001); // instruction number
  assert.equal(cmd.readUInt16BE(13), 0x0000); // spare
  assert.equal(cmd[15], SERVER_ENDPOINT_DATA_LENGTH); // "20" in the table, decimal
  assert.equal(cmd.readUInt16BE(16), SERVER_ENDPOINT_IDENTIFIER); // AA17H
  assert.equal(cmd.readUInt16BE(18), SERVER_ENDPOINT_ENABLE); // A6B6H
  assert.equal(cmd.subarray(28, 36).toString('hex'), '0'.repeat(16)); // 8 spare bytes
  assert.equal(cmd.at(-2), checksum(cmd));
  assert.equal(cmd.at(-1), 0x16);
  assert.equal(16 + cmd[15] + 2, cmd.length, 'the stated length agrees with the byte positions');
});

test('the confirmation word is the low address bytes XOR A6B6', () => {
  // 00102608220004 -> low two bytes 00 04 -> 0x0004 ^ 0xA6B6.
  assert.equal(serverEndpointConfirmation(DEVICE_METER_ADDRESS), 0xa6b2);
  assert.equal(encodeSetServerEndpoint(target, CURRENT, 1).readUInt16BE(20), 0xa6b2);

  // A different meter must produce a different word, or the field guards nothing.
  assert.notEqual(serverEndpointConfirmation('00102608229971'), 0xa6b2);
  assert.equal(serverEndpointConfirmation('00102608229971'), (0x99 ^ 0xa6) << 8 | (0x71 ^ 0xb6));
});

test('the other reading of the confirmation byte order is one flag away', () => {
  // The spec sentence does not fix the order; this is the fallback if a meter
  // refuses AA17H with the rest of the frame correct.
  const wire = encodeSetServerEndpoint(target, { ...CURRENT, wireOrderConfirmation: true }, 1);
  const valueOrder = encodeSetServerEndpoint(target, CURRENT, 1);
  assert.equal(wire.readUInt16BE(20), 0xa2b6);
  assert.notEqual(wire.readUInt16BE(20), valueOrder.readUInt16BE(20));
  // The two orderings are a byte swap, so they sum the same and the checksum
  // cannot tell them apart -- only the meter can.
  assert.equal(wire.at(-2), valueOrder.at(-2));
});

test('AA17 carries the endpoint high byte first, after the guard words', () => {
  const cmd = encodeSetServerEndpoint(target, { ip: '192.168.1.100', port: 10086 }, 1);
  assert.equal(cmd.subarray(22, 28).toString('hex'), 'c0a801642766');
});

test('the AA17 no-op frame for this meter', () => {
  // Writing the address the meter already has -- the safe probe, as was used to
  // establish that the AC0E route is refused.
  assert.equal(
    encodeSetServerEndpoint(target, CURRENT, 0x0001).toString('hex'),
    '681004002208261000030400010000' + '14' + 'aa17' + 'a6b6' + 'a6b2' + '410163822139' + '0'.repeat(16) + 'ee16',
  );
});

test('AA17 refuses a malformed address just as firmly', () => {
  for (const bad of ['65.1.99', '65.1.99.256', 'localhost', '', null, undefined]) {
    assert.throws(() => encodeSetServerEndpoint(target, { ip: bad, port: 8505 }, 1), { code: 'bad_ip' }, String(bad));
  }
  for (const bad of [0, -1, 65536, '8505', null, undefined]) {
    assert.throws(
      () => encodeSetServerEndpoint(target, { ip: '65.1.99.130', port: bad }, 1),
      { code: 'bad_port' },
      String(bad),
    );
  }
});

test('the command carries the addressed meter', () => {
  assert.equal(decodeCat1Frame(encodeSetServerEndpoint(target, CURRENT, 1)).address, DEVICE_METER_ADDRESS);
});

// --- API ------------------------------------------------------------------

async function serve() {
  const commands = createCommandQueue();
  const app = createApp(openStore(), silent, { commands });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, commands, server };
}

const post = (base, body) =>
  fetch(`http://${new URL(base).host}/api/v1/meters/${DEVICE_METER_ADDRESS}/server-address`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a confirmed request queues the AA17 command by default', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  const res = await post(base, { ...CURRENT, confirm: true });
  assert.equal(res.status, 202);
  const cmd = commands.nextFor(DEVICE_METER_ADDRESS);
  assert.equal(cmd.type, 'set_server_address');
  assert.equal(cmd.params.method, 'command');
  const frame = cmd.build(1);
  assert.equal(frame.readUInt16BE(16), SERVER_ENDPOINT_IDENTIFIER);
  assert.equal(frame.subarray(22, 28).toString('hex'), '410163822139');
});

test('the refused parameter write is still reachable, but only on request', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  assert.equal((await post(base, { ...CURRENT, method: 'parameter', confirm: true })).status, 202);
  const frame = commands.nextFor(DEVICE_METER_ADDRESS).build(1);
  assert.equal(frame.readUInt16BE(16), SERVER_ADDRESS_PRIMARY);
  assert.equal(frame.subarray(18, 24).toString('hex'), '410163822139');

  const res = await post(base, { ...CURRENT, method: 'sideways', confirm: true });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, 'bad_method');
});

test('without confirm: true nothing is queued', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  for (const body of [{ ...CURRENT }, { ...CURRENT, confirm: false }, { ...CURRENT, confirm: 'yes' }]) {
    const res = await post(base, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).reason, 'confirmation_required');
  }
  assert.equal(commands.list().length, 0);
});

test('a bad address is rejected before it is queued', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  assert.equal((await post(base, { ip: '65.1.99', port: 8505, confirm: true })).status, 400);
  assert.equal((await post(base, { ip: '65.1.99.130', port: 0, confirm: true })).status, 400);
  assert.equal((await post(base, { ip: '65.1.99.130', confirm: true })).status, 400);
  assert.equal(commands.list().length, 0);
});

test('the secondary slot belongs to the parameter write only', async (t) => {
  const { base, commands, server } = await serve();
  t.after(() => server.close());

  const ok = await post(base, { ...CURRENT, method: 'parameter', which: 'secondary', confirm: true });
  assert.equal(ok.status, 202);
  assert.equal(commands.nextFor(DEVICE_METER_ADDRESS).build(1).readUInt16BE(16), SERVER_ADDRESS_SECONDARY);

  // AA17H has one endpoint and no slot selector, so asking for the second one
  // has to be an error rather than quietly writing the first.
  const viaCommand = await post(base, { ...CURRENT, which: 'secondary', confirm: true });
  assert.equal(viaCommand.status, 400);
  assert.equal((await viaCommand.json()).reason, 'bad_which');

  const res = await post(base, { ...CURRENT, method: 'parameter', which: 'backup', confirm: true });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, 'bad_which');
});
