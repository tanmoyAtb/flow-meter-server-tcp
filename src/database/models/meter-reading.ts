// The history: one document per report a meter pushed down the TCP socket.
//
// Append-only. The current state of a device lives on its Meter document; this
// is the trail behind it, and the only thing that can answer "how much water
// between these two dates".
//
// Usage over a period is a *difference of cumulative totals*, not a sum of the
// daily figures:
//
//   usage(from, to) = totalUsageLiters(at to) - totalUsageLiters(at from)
//
// The meter resets `dailyUsageLiters` itself, so summing it silently loses every
// day whose report never arrived. The cumulative total carries that water
// forward, so differencing stays correct across gaps -- and gaps happen, which
// is what `meterReportNumber` is here to make visible.

import { Schema } from 'mongoose';
import { defineModel } from '../define-model.js';
import { VALVE_STATES } from './meter.js';
import type { ValveState } from './meter.js';

export interface MeterReadingDoc {
  /** → Meter._id, the 14-digit meter ID. */
  meterId: string;
  /** Server clock, and therefore a real instant. Date ranges query this. */
  receivedAt: Date;
  /** Zoneless wall clock, as reported. See MeterDoc.meterClock for why. */
  meterClock: string | null;

  /**
   * The meter's own transmission counter, straight off the wire.
   *
   * Not derived: the firmware increments it on every call home and sends it as
   * two bytes in the report. It earns its place twice over. A gap in the
   * sequence is the only evidence that a report existed and never reached us --
   * a silent meter and a lossy link look identical without it. And a meter
   * re-sends a report when its acknowledgement goes missing on a cellular link,
   * with the counter and clock unchanged, so the pair is what lets the unique
   * index below reject the retry instead of double-counting the water.
   */
  meterReportNumber: number | null;

  totalUsageLiters: number | null;
  dailyUsageLiters: number | null;
  monthlyUsageLiters: number | null;

  /**
   * Metering resolution in force for THIS reading.
   *
   * Stored per reading, not just on the meter, because it is the unit the three
   * figures above are counted in. A fleet mid-rollout has meters on 1000 L and
   * meters on 1 L, and a reading whose resolution is recorded only on the meter
   * document becomes uninterpretable the moment that meter is reconfigured.
   */
  resolutionLiters: number | null;

  valve: ValveState | null;
  batteryVolts: number | null;
  signalStrengthDbm: number | null;
  /** Per reading as well as on the meter, so a SIM swap is visible in history. */
  imei: string | null;

  /** Kept verbatim. Every protocol finding in this project came from re-reading these. */
  rawFrame: string;
}

const meterReadingSchema = new Schema<MeterReadingDoc>(
  {
    meterId: { type: String, required: true },
    receivedAt: { type: Date, required: true },
    meterClock: { type: String, default: null },
    meterReportNumber: { type: Number, default: null },

    totalUsageLiters: { type: Number, default: null },
    dailyUsageLiters: { type: Number, default: null },
    monthlyUsageLiters: { type: Number, default: null },
    resolutionLiters: { type: Number, default: null },

    valve: { type: String, enum: [...VALVE_STATES, null], default: null },
    batteryVolts: { type: Number, default: null },
    signalStrengthDbm: { type: Number, default: null },
    imei: { type: String, default: null },

    rawFrame: { type: String, required: true },
  },
  { versionKey: false },
);

/**
 * Dedup, handed to the database instead of a Set in application memory.
 *
 * Both parts are needed. The report number is the meter's own sequence, and the
 * clock guards against a counter that has been reset -- or that could not be
 * decoded, in which case the number alone still separates the readings.
 */
meterReadingSchema.index(
  { meterId: 1, meterReportNumber: 1, meterClock: 1 },
  { unique: true, name: 'meter_reading_dedup' },
);

// The history view, and the index both ends of a period query ride on.
meterReadingSchema.index({ meterId: 1, receivedAt: -1 });

export const MeterReading = defineModel<MeterReadingDoc>('MeterReading', meterReadingSchema, 'meterreadings');

/**
 * Water used between two instants, by differencing the cumulative total.
 *
 * Returns null when either end has no reading to anchor on -- a period that
 * starts before the meter's first report has no honest answer, and returning 0
 * would be indistinguishable from a meter that genuinely used nothing.
 */
export async function usageBetween(meterId: string, from: Date, to: Date): Promise<number | null> {
  const at = (when: Date) =>
    MeterReading.findOne({ meterId, receivedAt: { $lte: when }, totalUsageLiters: { $ne: null } })
      .sort({ receivedAt: -1 })
      .select('totalUsageLiters')
      .lean();

  const [start, end] = await Promise.all([at(from), at(to)]);
  if (!start || !end) return null;
  return (end.totalUsageLiters ?? 0) - (start.totalUsageLiters ?? 0);
}
