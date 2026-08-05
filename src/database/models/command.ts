// The downlink queue.
//
// A CAT-1 meter is a client, not a server: it dials in, reports, and powers
// down. There is no open socket to push a command into at an arbitrary moment,
// so a command is not "sent" -- it is parked here and handed over the next time
// the meter makes contact. On the daily schedule that is up to 24 hours later,
// which is exactly why this belongs in a database. A queue held in process
// memory loses every undelivered command on restart, and "undelivered" is the
// normal state of this queue, not an edge case.
//
// Lifecycle: queued -> sent -> acknowledged | failed | expired.
//
// Note what is NOT stored: the function that builds the frame. A command is
// described by its type, its target and a bag of parameters, and the encoder is
// looked up by type at delivery time. That is what makes a command a row rather
// than a closure -- see src/command-registry for the other half.

import { Schema } from 'mongoose';
import { defineModel } from '../define-model.js';

export const COMMAND_STATUSES = ['queued', 'sent', 'acknowledged', 'failed', 'expired'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/**
 * Every type the command registry knows how to encode. Adding one here without
 * adding an encoder produces a command that can be queued and never built,
 * which fails at delivery -- so the two lists must move together.
 */
export const COMMAND_TYPES = [
  'set_clock',
  'valve',
  'set_meter_type',
  'set_metering',
  'set_server_address',
  'read_parameters',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const COMMAND_SOURCES = ['api', 'configurer'] as const;
export type CommandSource = (typeof COMMAND_SOURCES)[number];

export interface CommandDoc {
  /** Small integer from the `command_id` counter, not an ObjectId: it appears in the API and in logs. */
  _id: number;
  address: string;
  type: CommandType;
  source: CommandSource;

  /**
   * Free-form because it differs per command type, and validated by the
   * registry's encoder rather than here. Deliberately re-read at delivery: a
   * clock command queued with no explicit time resolves "now" when the frame is
   * built, not when the request arrived, or a meter collecting it a day later
   * would be set exactly as wrong as the delay.
   */
  params: Record<string, unknown>;

  /**
   * Correlates a command with the meter's reply. Protocol section I.4 requires
   * these not repeat, which is why they come from a persistent counter.
   */
  instructionNumber: number;

  status: CommandStatus;
  queuedAt: Date;
  /** After this, the command is abandoned rather than delivered late. */
  expiresAt: Date;
  sentAt: Date | null;
  completedAt: Date | null;

  /** The frame actually put on the wire, hex. Null until sent. */
  frame: string | null;
  /** Why it failed, or what the meter returned. */
  result: string | null;
}

const commandSchema = new Schema<CommandDoc>(
  {
    _id: { type: Number, required: true },
    address: { type: String, required: true },
    type: { type: String, enum: COMMAND_TYPES, required: true },
    source: { type: String, enum: COMMAND_SOURCES, required: true, default: 'api' },

    params: { type: Schema.Types.Mixed, default: () => ({}) },
    instructionNumber: { type: Number, required: true },

    status: { type: String, enum: COMMAND_STATUSES, required: true, default: 'queued' },
    queuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    sentAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    frame: { type: String, default: null },
    result: { type: String, default: null },
  },
  { versionKey: false, _id: false },
);

// The hot path: "is anything waiting for the meter that just called in".
// Sorting by _id within it gives oldest-first delivery for free.
commandSchema.index({ address: 1, status: 1, _id: 1 });

// Matching a reply back to its command, and sweeping expiries.
commandSchema.index({ address: 1, instructionNumber: 1 });
commandSchema.index({ status: 1, expiresAt: 1 });

export const Command = defineModel<CommandDoc>('Command', commandSchema, 'commands');
