// CAT-1 packet-03 reports: the history, append-only.
//
// One document per report a meter pushed down the raw TCP socket. The current
// state of the device lives on its Meter document; this is the trail behind it.

import { Schema } from 'mongoose';
import { defineModel } from '../define-model.js';

export interface Cat1ReadingDoc {
  meterAddress: string;
  packetType: string | null;
  /** What made the meter call home: its schedule, an alarm, the button. */
  reportingTriggers: string[];

  /** Zoneless wall clock, as reported. See MeterDoc.meterClock for why. */
  meterClock: string | null;
  /** Server clock, and therefore a real instant. */
  receivedAt: Date;
  peer: string | null;

  cumulativeUsageLitres: number | null;
  dailyUsageLitres: number | null;
  monthlyUsageLitres: number | null;

  /**
   * Metering resolution in force for this reading.
   *
   * Stored per reading, not just on the meter, because it is the unit the usage
   * figures above are counted in. A fleet mid-rollout has meters on 1000 L and
   * meters on 1 L, and a reading whose resolution is only recorded on the meter
   * document becomes uninterpretable the moment that meter is reconciled.
   */
  resolutionLitres: number | null;
  tableTypeCode: string | null;

  valveStatus: string | null;
  batteryUndervoltage: boolean | null;
  voltageVolts: number | null;

  signalStrengthDbm: number | null;
  signalQualityDb: number | null;
  snrDb: number | null;

  /** The meter's own transmission counter -- its sequence number. */
  cumulativeReportCount: number | null;
  dailyReportCount: number | null;

  imei: string | null;
  iccid: string | null;

  /** Kept verbatim. Every protocol finding in this project came from re-reading these. */
  rawFrame: string;
}

const cat1ReadingSchema = new Schema<Cat1ReadingDoc>(
  {
    meterAddress: { type: String, required: true },
    packetType: { type: String, default: null },
    reportingTriggers: { type: [String], default: [] },

    meterClock: { type: String, default: null },
    receivedAt: { type: Date, required: true },
    peer: { type: String, default: null },

    cumulativeUsageLitres: { type: Number, default: null },
    dailyUsageLitres: { type: Number, default: null },
    monthlyUsageLitres: { type: Number, default: null },

    resolutionLitres: { type: Number, default: null },
    tableTypeCode: { type: String, default: null },

    valveStatus: { type: String, default: null },
    batteryUndervoltage: { type: Boolean, default: null },
    voltageVolts: { type: Number, default: null },

    signalStrengthDbm: { type: Number, default: null },
    signalQualityDb: { type: Number, default: null },
    snrDb: { type: Number, default: null },

    cumulativeReportCount: { type: Number, default: null },
    dailyReportCount: { type: Number, default: null },

    imei: { type: String, default: null },
    iccid: { type: String, default: null },

    rawFrame: { type: String, required: true },
  },
  { versionKey: false },
);

/**
 * Dedup, handed to the database instead of a Set in application memory.
 *
 * The cumulative report counter increments once per transmission, so it is the
 * meter's own sequence number; the clock guards against a counter that has been
 * reset. A meter that retries a report -- and these do, when an ack is lost --
 * lands on the same key and is rejected by the index rather than stored twice.
 */
cat1ReadingSchema.index(
  { meterAddress: 1, cumulativeReportCount: 1, meterClock: 1 },
  { unique: true, name: 'cat1_dedup' },
);

// The history view: one meter, newest first.
cat1ReadingSchema.index({ meterAddress: 1, receivedAt: -1 });

export const Cat1Reading = defineModel<Cat1ReadingDoc>('Cat1Reading', cat1ReadingSchema, 'cat1_readings');
