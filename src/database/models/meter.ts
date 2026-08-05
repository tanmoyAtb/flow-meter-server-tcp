// The fleet: one document per meter, holding its latest known state.
// `meterreadings` is the history; this is the present, and `lastSeenAt` says
// how much of the snapshot below is still worth believing.

import { Schema } from "mongoose";
import { defineModel } from "../define-model.js";

export const VALVE_STATES = ["open", "closed", "abnormal", "reserved"] as const;
export type ValveState = (typeof VALVE_STATES)[number];

export interface MeterDoc {
  /** The 14-digit meter ID. Every frame carries it, so ingest is one upsert. */
  _id: string;

  // --- operator-owned: never written from a report ---
  label: string | null;
  location: string | null;
  notes: string | null;
  /** The SIM's number. Operator-entered -- the meter transmits IMEI, never this. */
  simPhoneNumber: string | null;

  imei: string | null;

  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Does this meter match the configuration policy as of `lastSeenAt`. */
  isConfigured: boolean;

  // --- latest snapshot, overwritten by every report ---
  totalUsageLiters: number | null;
  dailyUsageLiters: number | null;
  monthlyUsageLiters: number | null;
  /** The unit the three above are counted in. Not a constant: 1000 L -> 1 L rollout. */
  resolutionLiters: number | null;

  valve: ValveState | null;
  batteryVolts: number | null;
  signalStrengthDbm: number | null;

  /**
   * Zoneless wall clock, deliberately not a Date: the meter stores six BCD
   * digits and has no zone. These shipped on UTC+8 and moved to Dhaka UTC+6, so
   * the same digits mean different instants either side of that change.
   */
  meterClock: string | null;

  /** The meter's own transmission counter at last contact. */
  meterReportNumber: number | null;
}

const meterSchema = new Schema<MeterDoc>(
  {
    _id: { type: String, required: true },

    label: { type: String, default: null },
    location: { type: String, default: null },
    notes: { type: String, default: null },
    simPhoneNumber: { type: String, default: null },

    imei: { type: String, default: null },

    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    isConfigured: { type: Boolean, default: false },

    totalUsageLiters: { type: Number, default: null },
    dailyUsageLiters: { type: Number, default: null },
    monthlyUsageLiters: { type: Number, default: null },
    resolutionLiters: { type: Number, default: null },

    valve: { type: String, enum: [...VALVE_STATES, null], default: null },
    batteryVolts: { type: Number, default: null },
    signalStrengthDbm: { type: Number, default: null },

    meterClock: { type: String, default: null },
    meterReportNumber: { type: Number, default: null },
  },
  { versionKey: false, timestamps: true, _id: false },
);

meterSchema.index({ lastSeenAt: -1 });
meterSchema.index({ isConfigured: 1, lastSeenAt: -1 });

export const Meter = defineModel<MeterDoc>("Meter", meterSchema, "meters");

/**
 * The only fields a report may write. Everything omitted here belongs to the
 * operator, and a `$set` of the whole document would wipe it silently.
 */
export const REPORT_OWNED_FIELDS = [
  "imei",
  "lastSeenAt",
  "totalUsageLiters",
  "dailyUsageLiters",
  "monthlyUsageLiters",
  "resolutionLiters",
  "valve",
  "batteryVolts",
  "signalStrengthDbm",
  "meterClock",
  "meterReportNumber",
] as const satisfies readonly (keyof MeterDoc)[];
