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
//   1. clock not on the target zone   -> AA00   (must be alone and first anyway)
//   2. resolution not the target      -> AA07
//   3. nothing wrong                  -> no command, just the power-off ack
//
// See the "Auto-configure" section of the README for the operational picture.

import { encodeSetClock, encodeSetMeterType, clockParts, METERING_MODE_BYTES } from './lib/cat1.js';

export const CONFIGURE_DEFAULTS = {
  timeZone: 'Asia/Dhaka',
  resolutionLitres: 1,
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

      // --- 1. clock ------------------------------------------------------
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

      // --- 2. metering resolution ----------------------------------------
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
