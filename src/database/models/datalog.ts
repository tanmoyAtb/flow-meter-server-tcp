// Hydrosense datalogger records, pushed as packed binary to
// /api/v1/datalogs/:deviceId.
//
// Unrelated to the water meters -- a different device, a different protocol,
// sharing this server only because it shares the port.

import { Schema } from 'mongoose';
import { defineModel } from '../define-model.js';

export interface DatalogDoc {
  deviceId: string;
  /** Unix seconds, as sent by the device. Its own clock, not ours. */
  timestamp: number;
  receivedAt: Date;

  battery: number | null;
  temperature: number | null;
  /**
   * Metres. Null where the device sent its invalid sentinel of 999 -- stored as
   * absent rather than as a number that would quietly pollute any average.
   */
  waterLevel: number | null;
  barometric: number | null;
}

const datalogSchema = new Schema<DatalogDoc>(
  {
    deviceId: { type: String, required: true },
    timestamp: { type: Number, required: true },
    receivedAt: { type: Date, required: true },

    battery: { type: Number, default: null },
    temperature: { type: Number, default: null },
    waterLevel: { type: Number, default: null },
    barometric: { type: Number, default: null },
  },
  { versionKey: false },
);

// The device keeps its buffer until we answer 200, then replays anything it is
// unsure about. Without this index those replays would each land as a new row.
datalogSchema.index({ deviceId: 1, timestamp: 1 }, { unique: true, name: 'datalog_dedup' });

export const Datalog = defineModel<DatalogDoc>('Datalog', datalogSchema, 'datalogs');
