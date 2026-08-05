// Every model in one place, so callers import from `database/models` rather
// than reaching for individual files and getting the registration order wrong.

export { Meter, VALVE_STATES, REPORT_OWNED_FIELDS } from './meter.js';
export type { MeterDoc, ValveState } from './meter.js';

export { MeterReading, usageBetween } from './meter-reading.js';
export type { MeterReadingDoc } from './meter-reading.js';

export { Command, COMMAND_STATUSES, COMMAND_TYPES, COMMAND_SOURCES } from './command.js';
export type { CommandDoc, CommandStatus, CommandType, CommandSource } from './command.js';

export { IngestFailure, FAILURE_RETENTION_DAYS } from './ingest-failure.js';
export type { IngestFailureDoc } from './ingest-failure.js';
