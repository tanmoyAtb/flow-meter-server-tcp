// Bringing field meters to the configuration we want, one command per contact.
//
// There is no batch to send. This firmware will not take two commands in one
// contact: AA00 never replies at all, so nothing queued behind it is ever sent,
// and the one time a clock write was chained behind a successful command it
// applied nothing. So the model is not "queue the work for a meter" -- it is
// "the meter is talking to us right now, what is the single most useful thing
// to say back". Convergence takes as many contacts as there are things wrong.
//
// Everything the decision needs is already in the report. Packet 03 carries the
// meter's own clock and its table type code, whose low two bits are the
// metering resolution -- so no read command is needed, which is just as well,
// since this firmware refuses 01H reads.
//
// The ladder, highest priority first:
//
//   1. reporting interval not the target -> AA06
//   2. clock not on the target zone      -> AA00   (must be alone anyway)
//   3. resolution not the target         -> AA07
//   4. nothing wrong                     -> no command, just the power-off ack
//
// The interval goes first because it is the rung that pays for the others. At
// the factory 1440 minutes a meter needing all three settings takes three days
// to converge, one command per contact; at the 360 we now ask for, the same
// meter finishes in 18 hours. It is also safe to move ahead of the clock,
// because scheme C0 counts elapsed minutes rather than firing at a wall-clock
// time -- so a meter whose clock is still wrong keeps the interval we gave it.
//
// Going first cuts both ways once the interval is widening rather than
// narrowing. A meter that is on 30 minutes and also has a wrong resolution
// spends its next contact on AA06, and only then starts waiting six hours
// between chances to fix anything else. That is the right order anyway -- the
// alternative is holding the fleet at 48 attaches a day while the tail
// converges -- but it does mean the last rung of a rollout is the slow one.
//
// The risk it carries is a rung that keeps failing, which consumes every
// contact up to maxAttempts before the rungs below it get a turn -- expensive
// at 6-hourly contacts. CONFIGURE_REPORT_INTERVAL_MIN=0 disables this rung
// without a redeploy, which is the kill switch.
//
// See the "Auto-configure" section of the README for the operational picture.

import {
  encodeSetClock,
  encodeSetMeterType,
  encodeSetReportingMode,
  clockParts,
  METERING_MODE_BYTES,
  REPORTING_SCHEME_INTERVAL,
} from './lib/cat1.js';

export const CONFIGURE_DEFAULTS = {
  timeZone: 'Asia/Dhaka',
  /**
   * Metering resolution, in litres. 1000 is one cubic metre.
   *
   * This is coarser than the 1 L it replaced, not finer: at 1000 the register
   * does not move until a whole cubic metre has passed, so everything below
   * that is lost at the meter and cannot be recovered here. That is the asked-for
   * behaviour -- billing is in m3 -- but it is worth saying plainly, because a
   * meter on this setting under a light load looks broken for days at a time.
   *
   * It lives here rather than only in the environment so a box that comes up
   * without its unit file overrides still runs the fleet policy instead of
   * quietly reverting to litres. Same reasoning as the RECONCILE_* fallback
   * below: the dangerous failure is the one nobody notices.
   */
  resolutionLitres: 1000,
  /**
   * How often the meter should report, in minutes. 0 disables the rung.
   *
   * Every report is a cellular attach on a battery device, so this number is a
   * battery-life decision as much as a data one: 360 is 4 attaches a day,
   * against the 48 that 30 minutes cost us and the factory's 1. Set it
   * deliberately.
   *
   * The other thing it buys is granularity, and at m3 resolution that matters
   * less than it looks: a meter only moves its register once a cubic metre has
   * passed, so on light usage six-hourly reports and half-hourly ones carry the
   * same information -- the same unchanged number, four times a day instead of
   * forty-eight.
   *
   * What it costs is the feedback loop. Every rung below takes one contact, so
   * a meter needing all three now converges in 18 hours rather than 90 minutes,
   * and any future policy change lands at the same pace. Nothing here is
   * time-critical, but do not expect to watch a rollout finish.
   */
  reportingIntervalMinutes: 360,
  /**
   * How far off the meter's clock may be before it is worth a command.
   *
   * A meter on the wrong zone is out by whole hours, and this one keeps time
   * well enough that the offset measured at exactly +8:00:00 across ten reports
   * before it was moved, then exactly +6:00:00 after. Two minutes is therefore
   * far above the noise, while still catching a meter whose clock has genuinely
   * run away. Do not tighten it towards zero: the meter stamps the report before
   * transmitting, so a slow cellular attach shows up here as apparent skew.
   */
  clockToleranceSeconds: 120,
  /**
   * Give up on an action after this many contacts.
   *
   * Without a cap a meter that cannot comply is commanded on every contact for
   * the rest of its life. These are battery devices, and AA00 in particular
   * never acknowledges, so "it didn't work" and "it worked but said nothing"
   * look identical until the next report -- exactly the shape of a loop that
   * runs forever unnoticed.
   */
  maxAttempts: 3,
  /**
   * Whether to write AA07 to a meter whose valve is shut.
   *
   * Off, because AA07 opens the valve. That is not in the protocol: the frame
   * rewrites payment mode and in-place mode alongside the metering mode with no
   * "leave unchanged" value, and re-asserting postpaid on a meter with no debt
   * makes this firmware re-evaluate and open. A resolution change is cosmetic;
   * turning someone's water back on is not, and doing it unattended across a
   * fleet is not something to discover from a billing complaint.
   *
   * This gates AA06 as well. There the risk is theoretical rather than observed
   * -- the frame holds the valve-shielding bytes and their modification gate at
   * zero -- but it is the same frame shape that surprised us with AA07, and the
   * only meter it currently costs us is one whose valve was closed on purpose.
   * Once AA06 is proven on an open-valve meter this can be relaxed.
   */
  allowClosedValve: false,
};

/**
 * Read the policy out of the environment, for the server entry point.
 *
 * The RECONCILE_* names are the ones this was born with and are still honoured,
 * because `Environment=RECONCILE=0` is what holds the policy OFF in a deployed
 * systemd unit. Dropping the old spelling would turn the policy silently ON on
 * any box whose unit file was not updated in the same breath as the code -- and
 * "silently ON" here means unattended AA07 writes, which open valves. CONFIGURE_*
 * wins where both are set.
 */
export function configureOptionsFromEnv(env = process.env) {
  const str = (name) => env[`CONFIGURE_${name}`] ?? env[`RECONCILE_${name}`];
  const num = (name, fallback) => (str(name) === undefined ? fallback : Number(str(name)));
  return {
    enabled: (env.CONFIGURE ?? env.RECONCILE) !== '0',
    timeZone: str('TIMEZONE') ?? CONFIGURE_DEFAULTS.timeZone,
    resolutionLitres: num('RESOLUTION_LITRES', CONFIGURE_DEFAULTS.resolutionLitres),
    reportingIntervalMinutes: num('REPORT_INTERVAL_MIN', CONFIGURE_DEFAULTS.reportingIntervalMinutes),
    clockToleranceSeconds: num('CLOCK_TOLERANCE_S', CONFIGURE_DEFAULTS.clockToleranceSeconds),
    maxAttempts: num('MAX_ATTEMPTS', CONFIGURE_DEFAULTS.maxAttempts),
    allowClosedValve: str('ALLOW_CLOSED_VALVE') === '1',
  };
}

/** Wall-clock digits as a comparable instant. Not a real time -- both sides of
 * the comparison are zoneless wall clocks, so treating them as UTC lets one
 * subtraction answer "how far apart do these two clocks read". */
const wallClockMs = ([yy, mm, dd, hh, mi, ss]) => Date.UTC(2000 + yy, mm - 1, dd, hh, mi, ss);

/** How many seconds the meter's clock reads ahead of (or behind) the target. */
export function clockSkewSeconds(meterClockIso, now, timeZone) {
  if (!meterClockIso) return null; // unparseable BCD; decodeClock leaves iso null
  const meter = Date.parse(`${meterClockIso}Z`);
  if (Number.isNaN(meter)) return null;
  return Math.round((meter - wallClockMs(clockParts(now, timeZone))) / 1000);
}

/**
 * The policy. `decide` looks at one report and returns the command to send, or
 * null to just acknowledge.
 *
 * Attempt counts live here rather than in the store because they are about our
 * conversation with the meter, not about the meter -- and because losing them
 * on restart is the right failure mode. A restart re-tries, which is what you
 * want after deploying a fix.
 */
export function createConfigurer(options = {}) {
  const config = { ...CONFIGURE_DEFAULTS, ...options };
  const meteringMode = METERING_MODE_BYTES[config.resolutionLitres];
  if (meteringMode === undefined) {
    throw new Error(
      `resolutionLitres must be one of ${Object.keys(METERING_MODE_BYTES).join(', ')}, got ${config.resolutionLitres}`,
    );
  }

  // address -> { set_clock: n, set_metering: n }
  const attempts = new Map();
  const countFor = (address) => {
    if (!attempts.has(address)) attempts.set(address, {});
    return attempts.get(address);
  };

  /** Record that we are about to act, and say whether we still may. */
  const claim = (address, type) => {
    const counts = countFor(address);
    const used = counts[type] ?? 0;
    if (used >= config.maxAttempts) return false;
    counts[type] = used + 1;
    return true;
  };

  /** The meter is already right, so any earlier failures no longer matter. */
  const clear = (address, type) => {
    const counts = attempts.get(address);
    if (counts) delete counts[type];
  };

  return {
    config,

    /**
     * One report in, at most one command out.
     *
     * Returns `{ command, notes }`. `notes` explains anything found wrong that
     * is deliberately not being acted on, which is the part an operator needs
     * to see -- a meter silently excluded from the rollout is worse than one
     * that visibly refuses. A rung that cannot be acted on does not block the
     * rungs below it: the clock and the resolution are independent settings,
     * and a meter that will not take a clock write should still get its
     * resolution fixed.
     */
    decide(reading, now = new Date()) {
      const payload = reading?.payload;
      if (!payload) return { command: null, notes: [] };

      const { address, meterTypeCode } = reading;
      const target = { meterTypeCode, address };
      const notes = [];

      // --- 1. reporting interval -----------------------------------------
      // Two ways a meter needs this rung: it is on scheme C0 at the wrong
      // number of minutes, or it is on one of the calendar schemes (C1 days,
      // C2 hours, C3 minutes) where there is no interval to compare at all.
      // Both are answered by writing C0 at the target.
      if (config.reportingIntervalMinutes > 0) {
        const mode = payload.reportingMode;
        const onInterval = mode?.scheme === REPORTING_SCHEME_INTERVAL;
        const actualMinutes = onInterval ? mode.intervalMinutes : null;

        if (mode && actualMinutes !== config.reportingIntervalMinutes) {
          const valve = payload.status?.valve;
          if (valve !== 'open' && !config.allowClosedValve) {
            notes.push(
              `reporting interval is ${mode.description ?? mode.raw} but valve is ${valve}; ` +
                `AA06 held back as a precaution (CONFIGURE_ALLOW_CLOSED_VALVE=1 to override)`,
            );
          } else if (claim(address, 'set_reporting')) {
            return {
              notes,
              command: {
                type: 'set_reporting',
                reason: onInterval
                  ? `reports every ${actualMinutes} min, want ${config.reportingIntervalMinutes} min`
                  : `reporting scheme is ${mode.raw}, want every ${config.reportingIntervalMinutes} min`,
                params: {
                  fromMinutes: actualMinutes,
                  toMinutes: config.reportingIntervalMinutes,
                  fromRaw: mode.raw,
                  source: 'configurer',
                },
                build: (instructionNumber) =>
                  encodeSetReportingMode(
                    target,
                    { intervalMinutes: config.reportingIntervalMinutes },
                    instructionNumber,
                  ),
              },
            };
          } else {
            notes.push(
              `reporting interval still ${mode.description ?? mode.raw} after ` +
                `${config.maxAttempts} attempts -- needs a look`,
            );
          }
        } else if (mode) {
          clear(address, 'set_reporting');
        }
      }

      // --- 2. clock ------------------------------------------------------
      const skew = clockSkewSeconds(payload.meterClock?.iso, now, config.timeZone);
      if (skew === null) {
        notes.push(`clock unreadable (${payload.meterClock?.raw ?? 'no clock field'})`);
      } else if (Math.abs(skew) > config.clockToleranceSeconds) {
        if (claim(address, 'set_clock')) {
          return {
            notes,
            command: {
              type: 'set_clock',
              reason: `meter clock ${payload.meterClock.iso} is ${skew}s off ${config.timeZone}`,
              params: { timeZone: config.timeZone, skewSeconds: skew, source: 'configurer' },
              build: (instructionNumber) =>
                encodeSetClock(target, new Date(), instructionNumber, { timeZone: config.timeZone }),
            },
          };
        }
        notes.push(`clock still ${skew}s out after ${config.maxAttempts} attempts -- needs a look`);
      } else {
        clear(address, 'set_clock');
      }

      // --- 3. metering resolution ----------------------------------------
      const actual = payload.meterConfig?.resolutionLitres;
      if (actual !== undefined && actual !== config.resolutionLitres) {
        const valve = payload.status?.valve;
        if (valve !== 'open' && !config.allowClosedValve) {
          // Deliberately not counted as an attempt: nothing was sent, and the
          // meter becomes eligible again the moment its valve is opened.
          notes.push(
            `resolution is ${actual} L but valve is ${valve}; AA07 would open it ` +
              `(CONFIGURE_ALLOW_CLOSED_VALVE=1 to override)`,
          );
        } else if (claim(address, 'set_metering')) {
          return {
            notes,
            command: {
              type: 'set_metering',
              reason: `resolution is ${actual} L, want ${config.resolutionLitres} L`,
              params: { fromLitres: actual, toLitres: config.resolutionLitres, meteringMode, source: 'configurer' },
              build: (instructionNumber) => encodeSetMeterType(target, { meteringMode }, instructionNumber),
            },
          };
        } else {
          notes.push(`resolution still ${actual} L after ${config.maxAttempts} attempts -- needs a look`);
        }
      } else if (actual !== undefined) {
        clear(address, 'set_metering');
      }

      return { command: null, notes };
    },

    /** For the debug route: what has been tried, and how often. */
    state() {
      return Object.fromEntries([...attempts].map(([address, counts]) => [address, { ...counts }]));
    },

    /** Start a meter over -- after a battery change, or a manual fix. */
    forget(address) {
      attempts.delete(address);
    },
  };
}
