import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeCat1Frame,
  encodeReportAck,
  ACK_CONTROL,
  POWER_OFF_NOW,
  POWER_STAY_AWAKE,
  CAT1_DEVICE_TYPE,
} from '../src/lib/cat1.js';
import { checksum } from '../src/lib/cjt188.js';
import { CAT1_FRAME, DEVICE_METER_ADDRESS } from './fixtures.js';

const envelope = decodeCat1Frame(CAT1_FRAME);

test('acknowledgement matches the section 3 layout', () => {
  const ack = encodeReportAck(envelope);
  assert.equal(ack.length, 20);
  assert.equal(ack[0], 0x68);
  assert.equal(ack[1], envelope.meterTypeCode);
  assert.equal(ack[9], CAT1_DEVICE_TYPE);
  assert.equal(ack[10], ACK_CONTROL); // 17H
  assert.equal(ack.readUInt16BE(11), 0x0000); // instruction number
  assert.equal(ack[15], 2); // data length: packet type + power flag
  assert.equal(ack[16], envelope.packetType);
  assert.equal(ack.at(-1), 0x16);
});

test('the length field reconciles with the frame size, as for uplinks', () => {
  const ack = encodeReportAck(envelope);
  assert.equal(16 + ack[15] + 2, ack.length);
});

test('checksum is valid over the acknowledgement', () => {
  const ack = encodeReportAck(envelope);
  assert.equal(ack.at(-2), checksum(ack));
});

test('address is echoed in wire order, not display order', () => {
  const ack = encodeReportAck(envelope);
  // Same seven bytes the meter sent, byte-for-byte.
  assert.deepEqual(ack.subarray(2, 9), CAT1_FRAME.subarray(2, 9));
  // And it still reads back as the operator-confirmed meter id.
  assert.equal(decodeCat1Frame(ack).address, DEVICE_METER_ADDRESS);
});

test('reporting type is echoed back to the meter', () => {
  const ack = encodeReportAck(envelope);
  assert.equal(ack.readUInt16BE(13), envelope.reportingType);
});

test('power-off flag defaults to AFH so the meter sleeps immediately', () => {
  assert.equal(encodeReportAck(envelope)[17], POWER_OFF_NOW);
  assert.equal(encodeReportAck(envelope, { powerOff: true })[17], POWER_OFF_NOW);
});

test('power-off flag can be cleared to hold the meter awake for a command', () => {
  const ack = encodeReportAck(envelope, { powerOff: false });
  assert.equal(ack[17], POWER_STAY_AWAKE);
  assert.equal(ack.at(-2), checksum(ack)); // checksum still correct for the variant
});
