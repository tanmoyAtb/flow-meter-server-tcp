// Timestamps on the way out.
//
// Until the database is wired up, this log is the only place readings live, and
// it is a complete record: every frame is printed with its full `raw` hex, so a
// whole store row can be rebuilt from the bytes alone. Complete except for one
// field -- when it arrived.
//
// The meter's own clock cannot stand in for that. A meter whose clock is wrong
// is precisely the case the configurer exists to fix, and this log has caught
// one going backwards mid-session (report #62 at 17:34:06, then #63 at
// 15:37:29) while the clock was being written underneath it. Nor does the
// journal help: the unit sends stdout straight to a file with
// `StandardOutput=append:`, so journald only ever sees systemd's own start and
// stop lines.
//
// So the stamp goes on here, at the moment of printing. One wrapper rather than
// a change in every formatter, which also picks up the HTTP command routes and
// the startup banner -- they log plain strings and never touch format.js.
//
// Only the first line of a multi-line block carries the stamp. That is
// deliberate: the report blocks stay readable, and a backfill has all it needs
// -- take the time from the block header, take the bytes from the `raw` line
// underneath it.

/**
 * Wrap a console-shaped sink so every message is preceded by an ISO instant.
 *
 * The stamp is passed as its own leading argument rather than spliced into the
 * first one, because callers do not always log a string -- `app.js` hands the
 * error handler an Error object as a second argument, and console's own
 * formatting of that is worth keeping.
 */
export function timestampedLog(sink = console, now = () => new Date()) {
  const at = (method) =>
    (...args) => {
      sink[method]?.(now().toISOString(), ...args);
    };

  return {
    log: at('log'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
}
