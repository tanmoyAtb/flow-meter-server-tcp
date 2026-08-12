// The auto-configure policy: one report in, at most one command out.
//
// The fixture frame is convenient here because it is wrong in both ways at
// once -- its clock reads 2023-09-23 and its table type code is 0027, which is
// 1000 L. So a single frame exercises the whole ladder by fixing one rung at a
// time and re-asking.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createConfigurer, clockSkewSeconds, CONFIGURE_DEFAULTS, configureOptionsFromEnv } from '../src/configure.js';
import { createMeterConnectionHandler } from '../src/tcp.js';
import { openStore } from '../src/store/memory.js';
import { createCommandQueue } from '../src/commands.js';
import { decodeCat1Frame, decodePayload, ACK_CONTROL, METERING_MODE_BYTES } from '../src/lib/cat1.js';
import { checksum } from '../src/lib/frame.js';
import { CAT1_FRAME, DEVICE_METER_ADDRESS } from './fixtures.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** The fixture frame's own clock, 2023-09-23 06:02:46, as a real instant. */
const FIXTURE_CLOCK = '2023-09-23T06:02:46';

const read = (frame) => {
  const envelope = decodeCat1Frame(frame);
  return { ...envelope, payload: decodePayload(envelope, frame) };
};

/**
 * The fixture frame with fields patched, so each rung can be isolated.
 * Table type code sits at 19-20, reporting mode at 52-57 and the clock at
 * 72-77; all are inside the checksummed region, so it has to be resealed.
 *
 * The reporting interval defaults to the target rather than to the fixture's
 * own 1440, because it is now the top rung: left alone it would pre-empt every
 * test below it and none of them would be testing what its name says. It reads
 * the target off the policy rather than repeating the number, so changing the
 * fleet interval does not break sixteen unrelated tests.
 */
function frameWith({
  tableTypeCode,
  clock,
  statusWord,
  reportingIntervalMinutes = CONFIGURE_DEFAULTS.reportingIntervalMinutes,
} = {}) {
  const buf = Buffer.from(CAT1_FRAME);
  if (tableTypeCode !== undefined) buf.writeUInt16BE(tableTypeCode, 19);
  if (statusWord !== undefined) buf.writeUInt16BE(statusWord, 58);
  if (reportingIntervalMinutes !== null) {
    buf[52] = 0xc0;
    buf.writeUInt16BE(reportingIntervalMinutes, 53);
    buf.fill(0xff, 55, 58);
  }
  if (clock !== undefined) {
    const bcd = (n) => parseInt(String(n).padStart(2, '0'), 16);
    const [y, mo, d, h, mi, s] = clock;
    [y, mo, d, h, mi, s].forEach((v, i) => {
      buf[72 + i] = bcd(v);
    });
  }
  buf[buf.length - 2] = checksum(buf);
  return buf;
}

/**
 * The fixture with only the interval already right, so the clock and the
 * resolution are the rungs in play. This is what CAT1_FRAME used to mean to
 * these tests before the interval rung existed.
 */
const LADDER_FRAME = frameWith({});

/** Table type code with the resolution bits set, keeping the rest of 0027. */
const CODE_FOR = { 1: 0x0024, 10: 0x0025, 100: 0x0026, 1000: 0x0027 };

/**
 * A configurer driving meters to 1 L, which is what these tests were written
 * against. The fleet default is now 1000 L (m3) -- and the fixture frame is
 * already 1000 L, so left on the default the resolution rung would never fire
 * and half of these would pass without asserting anything. Pinning the target
 * here keeps each test about its own rung rather than about the policy of the
 * day. Callers can still override, including the resolution itself.
 */
const toLitres = (opts = {}) => createConfigurer({ resolutionLitres: 1, ...opts });

/** The instant at which the fixture's clock is exactly right for Dhaka. */
const dhakaNowFor = (iso) => new Date(`${iso}Z`).getTime() - 6 * 3600_000;

// --- skew arithmetic ------------------------------------------------------

test('a meter on the vendor clock reads two hours ahead of Dhaka', () => {
  // The real transition: this meter shipped on UTC+8 and was moved to UTC+6.
  const now = new Date('2026-08-04T09:37:29Z');
  assert.equal(clockSkewSeconds('2026-08-04T17:37:29', now, 'Asia/Dhaka'), 7200);
  assert.equal(clockSkewSeconds('2026-08-04T15:37:29', now, 'Asia/Dhaka'), 0);
});

test('unreadable BCD is not mistaken for a clock at the epoch', () => {
  assert.equal(clockSkewSeconds(null, new Date(), 'Asia/Dhaka'), null);
});

// --- the reporting interval, the top rung ---------------------------------

test('the reporting interval outranks the clock and the resolution', () => {
  // The fixture is wrong in all three ways: 1440 min, a 2023 clock and 1000 L.
  // The interval goes first because it is what makes the other two quick.
  const { command } = toLitres().decide(read(CAT1_FRAME));
  assert.equal(command.type, 'set_reporting');
  assert.equal(command.params.fromMinutes, 1440);
  assert.equal(command.params.toMinutes, 360);
});

test('the interval command carries AA06 and the minutes big-endian', () => {
  const { command } = toLitres().decide(read(CAT1_FRAME));
  const frame = command.build(7);
  assert.equal(frame.length, 46);
  assert.equal(frame[15], 0x1c, 'm = 1CH');
  assert.equal(frame.readUInt16BE(16), 0xaa06);
  assert.equal(frame[18], 4, '1440 / 360, clamped up to the documented floor of 3');
  assert.equal(frame.subarray(19, 25).toString('hex'), 'c00168ffffff', '360 minutes');
  assert.equal(frame.readUInt16BE(11), 7, 'instruction number');
});

test('AA06 leaves every passenger field alone, including the valve gates', () => {
  // The lesson of AA07: this firmware re-evaluates whatever the frame touches.
  // Bytes 25-43 carry valve shielding, the history gate, emergency reporting
  // and the two modification gates -- none of which we are asking to change.
  const frame = toLitres().decide(read(CAT1_FRAME)).command.build(1);
  assert.deepEqual(frame.subarray(25, 44), Buffer.alloc(19), 'no modification permission is granted');
});

test('a meter already on the target interval is left alone by this rung', () => {
  const frame = frameWith({
    reportingIntervalMinutes: CONFIGURE_DEFAULTS.reportingIntervalMinutes,
    clock: [26, 8, 5, 12, 0, 0],
    tableTypeCode: CODE_FOR[1],
  });
  const decision = toLitres().decide(read(frame), new Date(dhakaNowFor('2026-08-05T12:00:00')));
  assert.equal(decision.command, null);
});

test('the interval target is configurable, and 0 disables the rung', () => {
  const reading = read(CAT1_FRAME); // 1440 min
  assert.equal(toLitres({ reportingIntervalMinutes: 1440 }).decide(reading).command.type, 'set_clock');
  assert.equal(
    toLitres({ reportingIntervalMinutes: 0 }).decide(reading).command.type,
    'set_clock',
    'rung off, so the ladder starts at the clock',
  );
  assert.equal(toLitres({ reportingIntervalMinutes: 60 }).decide(reading).command.params.toMinutes, 60);
});

test('a meter on a calendar scheme is moved onto an interval', () => {
  // C1/C2/C3 report on given days/hours/minutes, so there is no interval to
  // compare at all -- decodeReportingMode leaves intervalMinutes null. That is
  // a meter needing the rung, not a meter that is already right.
  const buf = Buffer.from(CAT1_FRAME);
  buf[52] = 0xc2; // "at these hours"
  buf[buf.length - 2] = checksum(buf);
  const { command } = toLitres().decide(read(buf));
  assert.equal(command.type, 'set_reporting');
  assert.equal(command.params.fromMinutes, null);
  assert.match(command.reason, /reporting scheme is C2/);
});

test('AA06 is withheld from a meter whose valve is shut', () => {
  // Precautionary rather than proven: the frame grants no valve permission,
  // but it is the same shape as the one that surprised us.
  // Clock and resolution already right, so this rung is the only one in play.
  const frame = frameWith({
    reportingIntervalMinutes: 1440,
    statusWord: 0x0001, // valve closed
    clock: [26, 8, 5, 12, 0, 0],
    tableTypeCode: CODE_FOR[1],
  });
  const now = new Date(dhakaNowFor('2026-08-05T12:00:00'));

  const held = toLitres().decide(read(frame), now);
  assert.equal(held.command, null);
  assert.match(held.notes[0], /AA06 held back as a precaution/);

  const forced = toLitres({ allowClosedValve: true }).decide(read(frame), now);
  assert.equal(forced.command.type, 'set_reporting');
});

test('giving up on the interval still lets the clock be fixed', () => {
  const configurer = toLitres({ maxAttempts: 1 });
  const reading = read(CAT1_FRAME);
  assert.equal(configurer.decide(reading).command.type, 'set_reporting');

  const next = configurer.decide(reading);
  assert.equal(next.command.type, 'set_clock', 'a stuck top rung does not block the ladder');
  assert.match(next.notes[0], /reporting interval still/);
});

// --- the ladder -----------------------------------------------------------

test('a wrong clock outranks a wrong resolution', () => {
  const { command } = toLitres().decide(read(LADDER_FRAME));
  assert.equal(command.type, 'set_clock');
  // The fixture is also at 1000 L, and that is deliberately not what came back:
  // AA00 must be alone and first in a contact, so it goes first.
  assert.match(command.reason, /off Asia\/Dhaka/);
});

test('once the clock is right the resolution is next', () => {
  const frame = frameWith({ clock: [26, 8, 5, 12, 0, 0] });
  const { command } = toLitres().decide(read(frame), new Date(dhakaNowFor('2026-08-05T12:00:00')));
  assert.equal(command.type, 'set_metering');
  assert.equal(command.params.fromLitres, 1000);
  assert.equal(command.params.toLitres, 1);
  assert.equal(command.build(1)[18], METERING_MODE_BYTES[1]);
});

test('a meter that is already correct is left alone', () => {
  const frame = frameWith({ clock: [26, 8, 5, 12, 0, 0], tableTypeCode: CODE_FOR[1] });
  const decision = toLitres().decide(read(frame), new Date(dhakaNowFor('2026-08-05T12:00:00')));
  assert.equal(decision.command, null);
  assert.deepEqual(decision.notes, []);
});

test('small skew is drift, not a wrong time zone', () => {
  const frame = frameWith({ clock: [26, 8, 5, 12, 0, 45], tableTypeCode: CODE_FOR[1] });
  const decision = toLitres().decide(read(frame), new Date(dhakaNowFor('2026-08-05T12:00:00')));
  assert.equal(decision.command, null, '45s is inside the tolerance');
});

test('the target resolution is configurable and 10 L meters are then left alone', () => {
  const frame = frameWith({ clock: [26, 8, 5, 12, 0, 0], tableTypeCode: CODE_FOR[10] });
  const at = (resolutionLitres) =>
    toLitres({ resolutionLitres }).decide(read(frame), new Date(dhakaNowFor('2026-08-05T12:00:00')));
  assert.equal(at(10).command, null);
  assert.equal(at(1).command.type, 'set_metering');
});

test('an impossible target resolution is refused at construction', () => {
  assert.throws(() => toLitres({ resolutionLitres: 500 }), /must be one of/);
});

// --- the valve interlock --------------------------------------------------

test('AA07 is withheld from a meter whose valve is shut', () => {
  // AA07 opens the valve. Doing that unattended to a meter someone deliberately
  // closed is the one irreversible thing this policy could do.
  const frame = frameWith({ clock: [26, 8, 5, 12, 0, 0], statusWord: 0x0001 }); // valve closed
  const now = new Date(dhakaNowFor('2026-08-05T12:00:00'));

  const held = toLitres().decide(read(frame), now);
  assert.equal(held.command, null);
  assert.match(held.notes[0], /valve is closed; AA07 would open it/);

  const forced = toLitres({ allowClosedValve: true }).decide(read(frame), now);
  assert.equal(forced.command.type, 'set_metering');
});

test('holding for a closed valve does not burn an attempt', () => {
  const closed = read(frameWith({ clock: [26, 8, 5, 12, 0, 0], statusWord: 0x0001 }));
  const open = read(frameWith({ clock: [26, 8, 5, 12, 0, 0], statusWord: 0x0000 }));
  const now = new Date(dhakaNowFor('2026-08-05T12:00:00'));
  const configurer = toLitres({ maxAttempts: 1 });

  for (let i = 0; i < 5; i++) assert.equal(configurer.decide(closed, now).command, null);
  assert.equal(configurer.decide(open, now).command.type, 'set_metering', 'eligible as soon as the valve opens');
});

// --- not looping forever --------------------------------------------------

test('a meter that never complies is given up on, and said so', () => {
  const configurer = toLitres({ maxAttempts: 3 });
  // Resolution already correct, so the clock is the only rung in play.
  const reading = read(frameWith({ tableTypeCode: CODE_FOR[1] }));

  for (let i = 0; i < 3; i++) {
    assert.equal(configurer.decide(reading).command.type, 'set_clock', `attempt ${i + 1}`);
  }
  const exhausted = configurer.decide(reading);
  assert.equal(exhausted.command, null);
  assert.match(exhausted.notes[0], /clock still .* after 3 attempts/);
  assert.equal(configurer.state()[DEVICE_METER_ADDRESS].set_clock, 3);
});

test('giving up on the clock still lets the resolution be fixed', () => {
  const configurer = toLitres({ maxAttempts: 1 });
  const reading = read(LADDER_FRAME); // wrong clock AND 1000 L
  assert.equal(configurer.decide(reading).command.type, 'set_clock');

  const next = configurer.decide(reading);
  assert.equal(next.command.type, 'set_metering', 'the rungs are independent');
  assert.match(next.notes[0], /clock still/);
});

test('a meter that complies has its attempts forgiven', () => {
  const configurer = toLitres({ maxAttempts: 2 });
  const now = new Date(dhakaNowFor('2026-08-05T12:00:00'));
  assert.equal(configurer.decide(read(LADDER_FRAME)).command.type, 'set_clock');

  // It obeyed, so the count resets and a later drift gets a full budget again.
  const fixed = read(frameWith({ clock: [26, 8, 5, 12, 0, 0] }));
  configurer.decide(fixed, now);
  assert.equal(configurer.state()[DEVICE_METER_ADDRESS].set_clock, undefined);
});

// --- configuration --------------------------------------------------------

test('the shipped defaults are the fleet policy: m3, every 6 hours, Dhaka', () => {
  // These three are the whole ask. They are asserted here rather than left to
  // the unit file because a box coming up without its overrides should still
  // run the policy -- the dangerous failure is the one nobody notices.
  assert.equal(CONFIGURE_DEFAULTS.resolutionLitres, 1000, 'one cubic metre');
  assert.equal(CONFIGURE_DEFAULTS.reportingIntervalMinutes, 360, 'six hours');
  assert.equal(CONFIGURE_DEFAULTS.timeZone, 'Asia/Dhaka');
  assert.equal(METERING_MODE_BYTES[1000], 0x80, 'the byte AA07 carries for m3');
});

test('the environment is read with safe defaults', () => {
  assert.deepEqual(configureOptionsFromEnv({}), {
    enabled: true,
    timeZone: CONFIGURE_DEFAULTS.timeZone,
    resolutionLitres: 1000,
    reportingIntervalMinutes: 360,
    clockToleranceSeconds: 120,
    maxAttempts: 3,
    allowClosedValve: false,
  });
  assert.equal(configureOptionsFromEnv({ CONFIGURE_REPORT_INTERVAL_MIN: '60' }).reportingIntervalMinutes, 60);
  assert.equal(
    configureOptionsFromEnv({ CONFIGURE_REPORT_INTERVAL_MIN: '0' }).reportingIntervalMinutes,
    0,
    'the kill switch for the AA06 rung',
  );
  assert.equal(configureOptionsFromEnv({ CONFIGURE: '0' }).enabled, false);
  assert.equal(configureOptionsFromEnv({ CONFIGURE_ALLOW_CLOSED_VALVE: '1' }).allowClosedValve, true);
  assert.equal(configureOptionsFromEnv({ CONFIGURE_TIMEZONE: 'UTC' }).timeZone, 'UTC');
});

test('the old RECONCILE_* names still work, because a deployed unit file uses them', () => {
  // `Environment=RECONCILE=0` is what holds the policy OFF on 65.2.232.159. If
  // renaming the code silently ignored that, the policy would come up ON there
  // and start writing AA07 unattended -- which opens valves.
  assert.equal(configureOptionsFromEnv({ RECONCILE: '0' }).enabled, false);
  assert.equal(configureOptionsFromEnv({ RECONCILE_ALLOW_CLOSED_VALVE: '1' }).allowClosedValve, true);
  assert.equal(configureOptionsFromEnv({ RECONCILE_TIMEZONE: 'UTC' }).timeZone, 'UTC');
  assert.equal(configureOptionsFromEnv({ RECONCILE_MAX_ATTEMPTS: '7' }).maxAttempts, 7);

  // The new name wins where both are set.
  assert.equal(configureOptionsFromEnv({ CONFIGURE_TIMEZONE: 'UTC', RECONCILE_TIMEZONE: 'Asia/Tokyo' }).timeZone, 'UTC');
  assert.equal(configureOptionsFromEnv({ CONFIGURE: '0', RECONCILE: '1' }).enabled, false);
});

// --- through the connection handler ---------------------------------------

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

function connect(opts = {}) {
  const socket = new FakeSocket();
  createMeterConnectionHandler(openStore(), silent, { commandDelayMs: 0, ...opts })(socket);
  return socket;
}

test('a report from a wrong meter is answered with a command, not an ack', () => {
  const commands = createCommandQueue();
  const socket = connect({ commands, configurer: toLitres() });
  socket.emit('data', LADDER_FRAME);

  assert.equal(socket.writes.length, 1, 'one command, and no stay-awake ack before it');
  assert.equal(socket.writes[0].readUInt16BE(16), 0xaa00);
  const queued = commands.list();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].type, 'set_clock');
  assert.equal(queued[0].status, 'sent');
});

test('a correct meter just gets its power-off ack', () => {
  const frame = frameWith({ clock: [26, 8, 5, 12, 0, 0], tableTypeCode: CODE_FOR[1] });
  const commands = createCommandQueue();
  // Freeze the comparison by handing the configurer a matching zone offset.
  const socket = connect({ commands, configurer: toLitres({ clockToleranceSeconds: 10 ** 9 }) });
  socket.emit('data', frame);

  assert.equal(socket.writes.length, 1);
  assert.equal(socket.writes[0][10], ACK_CONTROL);
  assert.equal(commands.list().length, 0, 'nothing queued');
});

test('the policy outranks a hand-queued command', () => {
  const commands = createCommandQueue();
  commands.enqueue(DEVICE_METER_ADDRESS, {
    type: 'valve',
    build: () => Buffer.from('68100400220826100003040001000008aa05995a0000000000000000f316', 'hex'),
  });
  const socket = connect({ commands, configurer: toLitres() });
  socket.emit('data', LADDER_FRAME);

  assert.equal(socket.writes[0].readUInt16BE(16), 0xaa00, 'the clock, not the queued valve command');

  const queued = commands.list();
  assert.equal(queued.length, 2, 'the policy queued its own alongside the waiting one');
  assert.equal(queued.find((c) => c.type === 'valve').status, 'queued', 'the valve command still waits its turn');
});

test('the policy contributes at most one command per report', () => {
  // Wrong in both ways at once: clock reads 2023 and resolution is 1000 L. Only
  // the clock goes out -- the resolution waits for the next contact.
  const commands = createCommandQueue();
  const socket = connect({ commands, configurer: toLitres() });
  socket.emit('data', LADDER_FRAME);

  assert.equal(socket.writes.length, 1, 'one command, not one per rung');
  assert.equal(socket.writes[0].readUInt16BE(16), 0xaa00);
  assert.equal(commands.list().length, 1, 'and only one was queued');
});

test('a queued command gets its turn once the policy has nothing left to do', () => {
  // The meter is already right -- resolution 1 L, and a tolerance wide enough
  // that any clock counts as correct -- so the policy stands aside entirely.
  const frame = frameWith({ tableTypeCode: CODE_FOR[1] });
  const commands = createCommandQueue();
  commands.enqueue(DEVICE_METER_ADDRESS, {
    type: 'valve',
    build: () => Buffer.from('68100400220826100003040001000008aa05995a0000000000000000f316', 'hex'),
  });
  const socket = connect({ commands, configurer: toLitres({ clockToleranceSeconds: 10 ** 9 }) });
  socket.emit('data', frame);

  assert.equal(socket.writes[0].readUInt16BE(16), 0xaa05, 'the valve command goes out');
});

test('only one command goes out per contact', () => {
  const commands = createCommandQueue();
  const configurer = toLitres();
  const socket = connect({ commands, configurer });

  // Two reports on one connection: each gets exactly one command back.
  socket.emit('data', LADDER_FRAME);
  socket.emit('data', LADDER_FRAME);
  assert.equal(socket.writes.length, 2);
  for (const write of socket.writes) assert.equal(write.readUInt16BE(16), 0xaa00);
});

test('an undecodable payload is still acknowledged and never configured', () => {
  // Packet type 04 has no decoder. The meter must still be told to sleep.
  const buf = Buffer.from(CAT1_FRAME);
  buf[16] = 0x04;
  buf[buf.length - 2] = checksum(buf);

  const commands = createCommandQueue();
  const socket = connect({ commands, configurer: toLitres() });
  socket.emit('data', buf);

  assert.equal(socket.writes.length, 1);
  assert.equal(socket.writes[0][10], ACK_CONTROL);
  assert.equal(commands.list().length, 0);
});
