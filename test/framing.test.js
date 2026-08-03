import test from 'node:test';
import assert from 'node:assert/strict';

import { FrameSplitter, peekEnvelope } from '../src/lib/framing.js';
import {
  REFERENCE_FRAME,
  CAT1_FRAME,
  DEVICE_METER_ADDRESS,
  DEVICE_PREAMBLE,
} from './fixtures.js';

const framesOf = (events) => events.filter((e) => e.type === 'frame').map((e) => e.bytes);
const unframedOf = (events) => events.filter((e) => e.type === 'unframed').map((e) => e.bytes);

test('extracts a single 9097 frame', () => {
  const events = new FrameSplitter().push(REFERENCE_FRAME);
  const frames = framesOf(events);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], REFERENCE_FRAME);
  assert.equal(unframedOf(events).length, 0);
});

test('frames a CAT-1 packet, where byte 10 is not a length at all', () => {
  // Byte 10 is CAT-1's fixed 97H control code. Read as a CJ/T 188 length it
  // claims a 164-byte frame; the frame is 88. The splitter is protocol-agnostic
  // and locates the boundary by checksum, so it gets this right either way.
  assert.equal(CAT1_FRAME[10] + 13, 164);
  assert.equal(CAT1_FRAME.length, 88);

  const frames = framesOf(new FrameSplitter().push(CAT1_FRAME));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], CAT1_FRAME);
});

test('reassembles a frame split across several reads', () => {
  const splitter = new FrameSplitter();
  const cuts = [1, 10, 11, 60, 140];
  let offset = 0;
  const collected = [];
  for (const cut of [...cuts, REFERENCE_FRAME.length]) {
    collected.push(...framesOf(splitter.push(REFERENCE_FRAME.subarray(offset, cut))));
    offset = cut;
  }
  assert.equal(collected.length, 1);
  assert.deepEqual(collected[0], REFERENCE_FRAME);
});

test('splits two frames arriving in one read', () => {
  const both = Buffer.concat([REFERENCE_FRAME, CAT1_FRAME]);
  const frames = framesOf(new FrameSplitter().push(both));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], REFERENCE_FRAME);
  assert.deepEqual(frames[1], CAT1_FRAME);
});

test('surfaces the non-frame preamble instead of dropping it', () => {
  const splitter = new FrameSplitter();
  const events = splitter.push(Buffer.concat([DEVICE_PREAMBLE, CAT1_FRAME]));
  assert.deepEqual(unframedOf(events), [DEVICE_PREAMBLE]);
  assert.deepEqual(framesOf(events), [CAT1_FRAME]);
});

test('a lone preamble is reported, not silently buffered forever', () => {
  const splitter = new FrameSplitter();
  const events = splitter.push(DEVICE_PREAMBLE);
  assert.deepEqual(unframedOf(events), [DEVICE_PREAMBLE]);
});

test('flush reports a partial frame left over when the peer disconnects', () => {
  const splitter = new FrameSplitter();
  const partial = REFERENCE_FRAME.subarray(0, 40);
  assert.equal(splitter.push(partial).length, 0); // still waiting for the rest
  assert.deepEqual(unframedOf(splitter.flush()), [partial]);
});

test('peekEnvelope recovers the meter address whatever the protocol', () => {
  const envelope = peekEnvelope(CAT1_FRAME);
  assert.equal(envelope.address, DEVICE_METER_ADDRESS);
  assert.equal(envelope.meterTypeCode, 0x10);
  assert.equal(envelope.dataLength, 0x97);
});

test('peekEnvelope never throws on a truncated frame', () => {
  assert.doesNotThrow(() => peekEnvelope(Buffer.from('6810', 'hex')));
  assert.equal(peekEnvelope(Buffer.from('6810', 'hex')).address, null);
});
