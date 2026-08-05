// CJ/T 188 readings, pushed by an IoT platform to /api/v1/coap_push or sent
// straight down the TCP socket.
//
// This is the collection that most justifies a document store. A reading
// carries 47 half-hourly usage slots and a set of named alarm flags; in SQL
// that is a child table with 47 rows per reading plus either a wide sparse row
// or a JSON column. Here it is one document, written once, read whole.

import { Schema } from 'mongoose';
import { defineModel } from '../define-model.js';

/** One half-hourly slot from the freeze block. `time` is "HH:MM" local to the meter. */
export interface UsageIncrement {
  time: string;
  value: number;
}

export interface MeterReadingDoc {
  meterAddress: string;
  /** Zoneless wall clock, as reported. See MeterDoc.meterClock. */
  meterTime: string | null;
  receivedAt: Date;
  peer: string | null;
  /** How the frame reached us: hex, base64, binary, or straight off the socket. */
  encoding: string | null;

  cumulativeFlow: number | null;
  settlementFlow: number | null;
  reverseFlow: number | null;
  remainingFlow: number | null;
  flowRate: number | null;
  temperature: number | null;
  pressure: number | null;

  valveStatus: string | null;
  batteryVoltageLow: boolean | null;
  alarms: Record<string, boolean>;

  signalStrength: number | null;
  signalQuality: number | null;
  transmissionCount: number | null;

  imei: string | null;
  iccid: string | null;

  /**
   * 47 slots running 23:30 -> 00:30, not 48. The protocol document labels the
   * block "48 freeze-data", but that count includes the 00:00 cutoff pair which
   * is carried separately.
   */
  increments: UsageIncrement[];

  rawFrame: string;
}

const incrementSchema = new Schema<UsageIncrement>(
  {
    time: { type: String, required: true },
    value: { type: Number, required: true },
  },
  { _id: false, versionKey: false },
);

const meterReadingSchema = new Schema<MeterReadingDoc>(
  {
    meterAddress: { type: String, required: true },
    meterTime: { type: String, default: null },
    receivedAt: { type: Date, required: true },
    peer: { type: String, default: null },
    encoding: { type: String, default: null },

    cumulativeFlow: { type: Number, default: null },
    settlementFlow: { type: Number, default: null },
    reverseFlow: { type: Number, default: null },
    remainingFlow: { type: Number, default: null },
    flowRate: { type: Number, default: null },
    temperature: { type: Number, default: null },
    pressure: { type: Number, default: null },

    valveStatus: { type: String, default: null },
    batteryVoltageLow: { type: Boolean, default: null },
    alarms: { type: Schema.Types.Mixed, default: () => ({}) },

    signalStrength: { type: Number, default: null },
    signalQuality: { type: Number, default: null },
    transmissionCount: { type: Number, default: null },

    imei: { type: String, default: null },
    iccid: { type: String, default: null },

    increments: { type: [incrementSchema], default: [] },

    rawFrame: { type: String, required: true },
  },
  { versionKey: false },
);

// Platforms retry, and a retry must not become a second reading.
meterReadingSchema.index({ meterAddress: 1, meterTime: 1 }, { unique: true, name: 'meter_reading_dedup' });
meterReadingSchema.index({ meterAddress: 1, receivedAt: -1 });

export const MeterReading = defineModel<MeterReadingDoc>('MeterReading', meterReadingSchema, 'meter_readings');
