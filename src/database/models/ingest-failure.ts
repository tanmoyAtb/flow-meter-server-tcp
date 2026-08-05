// Frames that could not be parsed, parked rather than dropped.
//
// /coap_push always answers 200, because an IoT platform retries on anything
// else and a frame that fails to parse will fail identically on retry. That
// makes silent loss the default failure mode unless the bad frame is written
// down somewhere -- and on this project the bad frames have repeatedly been the
// evidence: the six-byte A345 preamble, the meter's 0BH refusals, the coalesced
// ack-plus-command segment.
//
// This is also the one collection an unauthenticated public port can grow
// without bound, so it expires.

import { Schema } from 'mongoose';
import { defineModel } from '../define-model.js';

/** Days a parked failure is kept before Mongo removes it. */
export const FAILURE_RETENTION_DAYS = Number(process.env.FAILURE_RETENTION_DAYS ?? 90);

export interface IngestFailureDoc {
  /** Which way in: 'coap_push', 'datalogs', or 'tcp'. */
  endpoint: string;
  reason: string;
  /** Truncated to 4 KB -- enough to identify a frame, not enough to be a disk risk. */
  body: string | null;
  peer: string | null;
  receivedAt: Date;
}

const ingestFailureSchema = new Schema<IngestFailureDoc>(
  {
    endpoint: { type: String, required: true },
    reason: { type: String, required: true },
    body: { type: String, default: null },
    peer: { type: String, default: null },
    receivedAt: { type: Date, required: true },
  },
  { versionKey: false },
);

ingestFailureSchema.index({ endpoint: 1, receivedAt: -1 });

// Anything that can reach the port can write here, so these age out. Raise
// FAILURE_RETENTION_DAYS while investigating something long-running.
ingestFailureSchema.index(
  { receivedAt: 1 },
  { expireAfterSeconds: FAILURE_RETENTION_DAYS * 24 * 60 * 60, name: 'failure_ttl' },
);

export const IngestFailure = defineModel<IngestFailureDoc>('IngestFailure', ingestFailureSchema, 'ingest_failures');
