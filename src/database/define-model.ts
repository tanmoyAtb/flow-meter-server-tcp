// Model registration that tolerates being run twice.
//
// mongoose.model() throws OverwriteModelError if the same name is registered
// again, which is exactly what happens under `node --watch` and in a test file
// that imports a model module more than once through different paths. Reusing
// the already-compiled model is always what was meant.

import mongoose, { Schema } from 'mongoose';
import type { Model } from 'mongoose';

export function defineModel<T>(name: string, schema: Schema<T>, collection: string): Model<T> {
  const existing = mongoose.models[name] as Model<T> | undefined;
  return existing ?? mongoose.model<T>(name, schema, collection);
}
