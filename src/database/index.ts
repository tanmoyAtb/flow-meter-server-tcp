// Database connection lifecycle.
//
// The settings below are chosen for what this server actually is: a process
// whose most important job is to answer a battery-powered meter that is holding
// its radio open, waiting. Every default that trades latency for resilience is
// the wrong trade here -- a meter does not benefit from a query that eventually
// succeeds after thirty seconds, it benefits from the ack it is waiting for.

import mongoose from 'mongoose';
import type { ConnectOptions } from 'mongoose';

export * from './models/index.js';

export const DEFAULT_MONGO_URL = 'mongodb://127.0.0.1:27017/watermeter';

interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface DatabaseOptions {
  url?: string;
  log?: Logger;
  /** Build the schema indexes on connect. Leave on -- see below. */
  autoIndex?: boolean;
}

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.MONGO_URL ?? env.MONGODB_URI ?? DEFAULT_MONGO_URL;
}

/** Hide any password before a URL goes anywhere near a log line. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@');
}

export async function connectDatabase({
  url = databaseUrl(),
  log = console,
  autoIndex = process.env.MONGO_AUTO_INDEX !== '0',
}: DatabaseOptions = {}): Promise<typeof mongoose> {
  const options: ConnectOptions = {
    /**
     * Five seconds, not the default thirty.
     *
     * This is how long a query waits for a reachable server before giving up.
     * The command-queue lookup sits on the acknowledgement path, so this
     * timeout is time a meter spends awake with its radio on. Failing fast and
     * logging it costs one report; blocking for thirty seconds costs battery on
     * every meter that contacts us while Mongo is down.
     */
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS ?? 5000),

    /**
     * Do not queue operations while disconnected.
     *
     * With buffering on -- the Mongoose default -- a query issued during an
     * outage sits in memory until it times out, and whatever awaited it stalls
     * with it. Here that would be a meter's socket. Rejecting immediately lets
     * the collector fall back to what it can always do: acknowledge the report
     * and log the raw frame, so the contact is not wasted.
     */
    bufferCommands: false,

    /**
     * Ten connections, not the default hundred. The box this runs on has under
     * a gigabyte of RAM, and the workload is a handful of meters reporting once
     * a day -- concurrency here is measured in single digits.
     */
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE ?? 10),
    minPoolSize: 0,

    /**
     * Index building stays on.
     *
     * Deduplication is now entirely index-enforced: the unique indexes on the
     * readings collections are what stop a meter's retry becoming a second
     * reading. Without them nothing errors -- duplicates simply accumulate, and
     * the first sign of it is a usage chart with doubled steps.
     */
    autoIndex,
  };

  mongoose.connection.on('disconnected', () => {
    log.warn?.(`mongo: disconnected from ${redactUrl(url)}`);
  });
  mongoose.connection.on('reconnected', () => {
    log.info?.(`mongo: reconnected to ${redactUrl(url)}`);
  });
  mongoose.connection.on('error', (err: Error) => {
    log.error?.(`mongo: ${err.message}`);
  });

  await mongoose.connect(url, options);
  log.info?.(`mongo: connected to ${redactUrl(url)} (db "${mongoose.connection.name}")`);
  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export interface DatabaseState {
  connected: boolean;
  readyState: number;
  name: string | null;
  host: string | null;
}

/** For /health and the dashboard: is the database actually there right now. */
export function databaseState(): DatabaseState {
  const c = mongoose.connection;
  return {
    connected: c.readyState === 1,
    readyState: c.readyState,
    name: c.name ?? null,
    host: c.host ?? null,
  };
}

export { mongoose };
