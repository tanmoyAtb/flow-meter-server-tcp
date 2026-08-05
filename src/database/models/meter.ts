// The fleet: one document per physical meter, holding its latest known state.
//
// Until now a meter existed only as a recurring value in a column of readings.
// That is enough to chart one device and useless for operating a hundred:
// "which meters have not called home this week", "which are still on the wrong
// resolution", "which are running their battery down" are questions about the
// *current state* of a device, and answering them by scanning the whole reading
// history is the wrong shape.
//
// So the readings collections stay append-only and are the history; this is the
// present. Nothing here is authoritative -- every field is the last thing a
// meter said about itself, and a meter that has not reported in a month still
// shows the state it was in a month ago. `lastSeenAt` is what tells you how
// much of the rest to believe.

import { Schema } from 'mongoose';
import { defineModel } from '../define-model.js';

export const METER_PROTOCOLS = ['cat1', 'cjt188'] as const;
export type MeterProtocol = (typeof METER_PROTOCOLS)[number];

/** Per-setting counters for the auto-reconcile ladder. */
export interface ReconcileAttempts {
  set_clock?: number;
  set_metering?: number;
}

export interface MeterDoc {
  /** The 14-digit BCD meter address, used directly as the primary key. */
  _id: string;
  protocol: MeterProtocol;

  // --- operator-owned: never written from a report ---
  label: string | null;
  site: string | null;
  notes: string | null;

  // --- contact ---
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Source IP:port of the last contact. Cellular NAT moves this constantly. */
  lastPeer: string | null;
  lastPacket: string | null;
  lastReportingTriggers: string[];
  reportCount: number;

  // --- identity ---
  meterType: string | null;
  meterTypeCode: number | null;
  imei: string | null;
  iccid: string | null;
  hardwareVersion: string | null;
  softwareVersion: string | null;

  /**
   * The meter's own clock, as a zoneless wall-clock string.
   *
   * Deliberately NOT a Date. The meter has no concept of a time zone -- it
   * stores exactly the six BCD digits it was given and reports them back, so
   * "2026-08-05T15:35:00" means the digits on its display and nothing more.
   * Storing that as a Date would silently assert an instant it does not have,
   * and this fleet has already lived through the consequences: these meters
   * shipped on UTC+8 and were moved to Dhaka UTC+6, so the same digits mean
   * different instants either side of that change.
   *
   * `clockSkewSeconds` is the derived, genuinely comparable number: how far the
   * meter's digits are from what `clockTimeZone` says they should read.
   */
  meterClock: string | null;
  clockSkewSeconds: number | null;
  clockTimeZone: string | null;

  // --- configuration the reconciler acts on ---
  resolutionLitres: number | null;
  paymentType: string | null;
  valveType: string | null;
  tableTypeCode: string | null;
  reportingIntervalMinutes: number | null;
  reportingDescription: string | null;

  // --- state ---
  valve: string | null;
  batteryUndervoltage: boolean | null;
  voltageVolts: number | null;
  alarms: Record<string, boolean>;

  cumulativeUsageLitres: number | null;
  dailyUsageLitres: number | null;
  monthlyUsageLitres: number | null;

  signalStrengthDbm: number | null;
  signalQualityDb: number | null;
  snrDb: number | null;

  cumulativeReportCount: number | null;
  dailyReportCount: number | null;

  /**
   * How many times the reconciler has tried to fix each setting.
   *
   * Kept on the meter rather than in process memory so a restart does not hand
   * a non-complying meter three fresh attempts. These are battery devices, and
   * the whole point of the cap is to stop commanding one forever.
   */
  reconcileAttempts: ReconcileAttempts;
}

const meterSchema = new Schema<MeterDoc>(
  {
    _id: { type: String, required: true },
    protocol: { type: String, enum: METER_PROTOCOLS, required: true },

    label: { type: String, default: null },
    site: { type: String, default: null },
    notes: { type: String, default: null },

    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    lastPeer: { type: String, default: null },
    lastPacket: { type: String, default: null },
    lastReportingTriggers: { type: [String], default: [] },
    reportCount: { type: Number, default: 0 },

    meterType: { type: String, default: null },
    meterTypeCode: { type: Number, default: null },
    imei: { type: String, default: null },
    iccid: { type: String, default: null },
    hardwareVersion: { type: String, default: null },
    softwareVersion: { type: String, default: null },

    meterClock: { type: String, default: null },
    clockSkewSeconds: { type: Number, default: null },
    clockTimeZone: { type: String, default: null },

    resolutionLitres: { type: Number, default: null },
    paymentType: { type: String, default: null },
    valveType: { type: String, default: null },
    tableTypeCode: { type: String, default: null },
    reportingIntervalMinutes: { type: Number, default: null },
    reportingDescription: { type: String, default: null },

    valve: { type: String, default: null },
    batteryUndervoltage: { type: Boolean, default: null },
    voltageVolts: { type: Number, default: null },
    alarms: { type: Schema.Types.Mixed, default: () => ({}) },

    cumulativeUsageLitres: { type: Number, default: null },
    dailyUsageLitres: { type: Number, default: null },
    monthlyUsageLitres: { type: Number, default: null },

    signalStrengthDbm: { type: Number, default: null },
    signalQualityDb: { type: Number, default: null },
    snrDb: { type: Number, default: null },

    cumulativeReportCount: { type: Number, default: null },
    dailyReportCount: { type: Number, default: null },

    reconcileAttempts: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { versionKey: false, timestamps: true, _id: false },
);

// "Who has gone quiet" is the most-asked question about a fleet, and it sorts
// on this. The rest support the reconciler's own view: which meters are still
// off-policy, and which it has given up on.
meterSchema.index({ lastSeenAt: -1 });
meterSchema.index({ resolutionLitres: 1, lastSeenAt: -1 });
meterSchema.index({ valve: 1 });

export const Meter = defineModel<MeterDoc>('Meter', meterSchema, 'meters');

/**
 * The fields a report is allowed to overwrite.
 *
 * `label`, `site` and `notes` belong to whoever is operating the fleet, and a
 * report must never clobber them -- which is easy to do by accident when the
 * upsert is written as "$set the whole document". Listing the report-owned
 * fields explicitly is what keeps that from happening.
 */
export const REPORT_OWNED_FIELDS = [
  'protocol',
  'lastSeenAt',
  'lastPeer',
  'lastPacket',
  'lastReportingTriggers',
  'meterType',
  'meterTypeCode',
  'imei',
  'iccid',
  'hardwareVersion',
  'softwareVersion',
  'meterClock',
  'clockSkewSeconds',
  'clockTimeZone',
  'resolutionLitres',
  'paymentType',
  'valveType',
  'tableTypeCode',
  'reportingIntervalMinutes',
  'reportingDescription',
  'valve',
  'batteryUndervoltage',
  'voltageVolts',
  'alarms',
  'cumulativeUsageLitres',
  'dailyUsageLitres',
  'monthlyUsageLitres',
  'signalStrengthDbm',
  'signalQualityDb',
  'snrDb',
  'cumulativeReportCount',
  'dailyReportCount',
] as const satisfies readonly (keyof MeterDoc)[];
