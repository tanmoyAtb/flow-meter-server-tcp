// Monotonic sequences.
//
// Two things in this system need numbers that keep counting across a restart,
// and Mongo has no autoincrement:
//
//   command_id          so the audit trail never reuses an identifier
//   instruction_number  because protocol section I.4 requires that the number
//                       correlating a command with its reply does not repeat
//
// The second is the one that actually bites. Instruction numbers used to come
// from a counter that reset to 1 every time the process started, so a restart
// could send a meter a fresh command carrying the same number as one still
// outstanding -- and the reply-matching logic would credit the wrong command.
//
// findOneAndUpdate with $inc is atomic on the server, so concurrent contacts
// cannot draw the same value even though nothing here holds a lock.

import { Schema } from 'mongoose';
import { defineModel } from '../define-model.js';

export interface CounterDoc {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<CounterDoc>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const Counter = defineModel<CounterDoc>('Counter', counterSchema, 'counters');

/** The next value in a named sequence. Creates the sequence on first use. */
export async function nextSequence(name: string): Promise<number> {
  const doc = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return doc!.seq;
}
