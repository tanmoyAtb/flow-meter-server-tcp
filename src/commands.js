// Pending downlink commands, keyed by meter address.
//
// A meter is a client: it dials in, reports, and powers down. There is no open
// socket to push a command into at an arbitrary moment, so commands cannot be
// delivered on demand -- they are queued here and handed to the meter the next
// time it makes contact. Protocol section 3 is what makes that possible: the
// report acknowledgement carries a power-off flag, and setting it to 00H tells
// the meter to hold its radio open instead of sleeping.
//
// Lifecycle: queued -> sent -> acknowledged | failed | expired.
//
// In memory only, like the store. A queued command does not survive a restart.

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000; // a meter on the daily schedule gets two chances

export function createCommandQueue({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const byId = new Map();
  const byAddress = new Map(); // address -> command id[]
  let nextId = 1;

  // Section I.4 says instruction numbers must not repeat. They are not used to
  // match a reply to its command -- this firmware does not echo them reliably,
  // so tcp.js correlates by session instead -- but they still go on the wire,
  // and a meter that deduplicates by number could silently drop a repeat.
  //
  // Seeded from the clock rather than 1 so a restart lands somewhere else in the
  // 16-bit space instead of reissuing numbers that may still be outstanding.
  // Zero is skipped: it is the value the meter's own refusals carry.
  let nextInstruction = (now() >>> 4) & 0xffff || 1;

  const isLive = (cmd) => cmd.status === 'queued' && cmd.expiresAt > now();

  function prune(address) {
    const ids = byAddress.get(address);
    if (!ids) return [];
    for (const id of ids) {
      const cmd = byId.get(id);
      if (cmd.status === 'queued' && cmd.expiresAt <= now()) {
        cmd.status = 'expired';
        cmd.completedAt = new Date(now()).toISOString();
      }
    }
    return ids;
  }

  return {
    /** Queue a command. `build(instructionNumber)` returns the frame to send. */
    enqueue(address, { type, params = {}, build }) {
      const id = nextId++;
      const instructionNumber = nextInstruction++ & 0xffff || 1;
      const cmd = {
        id,
        address,
        type,
        params,
        instructionNumber,
        build,
        status: 'queued',
        queuedAt: new Date(now()).toISOString(),
        expiresAt: now() + ttlMs,
        sentAt: null,
        completedAt: null,
        result: null,
      };
      byId.set(id, cmd);
      if (!byAddress.has(address)) byAddress.set(address, []);
      byAddress.get(address).push(id);
      return cmd;
    },

    /** The next command waiting for this meter, or null. */
    nextFor(address) {
      for (const id of prune(address)) {
        const cmd = byId.get(id);
        if (isLive(cmd)) return cmd;
      }
      return null;
    },

    /** True when this meter should be held awake rather than told to sleep. */
    hasPending(address) {
      return this.nextFor(address) !== null;
    },

    markSent(cmd) {
      cmd.status = 'sent';
      cmd.sentAt = new Date(now()).toISOString();
    },

    /**
     * Record a verdict, and say whether it was the one that stuck.
     *
     * A command that already finished is left alone. An error draws two reply
     * frames from this firmware -- a generic one carrying instruction number
     * 0000, then the real one -- and the second must not overwrite the first.
     * A command can also fail before it is ever sent, when its frame will not
     * build, so `queued` is a legal starting point here too.
     */
    complete(cmd, { success, detail }) {
      if (cmd.status !== 'queued' && cmd.status !== 'sent') return false;
      cmd.status = success ? 'acknowledged' : 'failed';
      cmd.completedAt = new Date(now()).toISOString();
      cmd.result = detail ?? null;
      return true;
    },

    get(id) {
      const cmd = byId.get(Number(id));
      return cmd ? view(cmd) : null;
    },

    list(address) {
      const all = [...byId.values()];
      return (address ? all.filter((c) => c.address === address) : all).map(view);
    },
  };
}

/** Public shape: everything except the frame builder. */
function view(cmd) {
  const { build, expiresAt, ...rest } = cmd;
  return { ...rest, expiresAt: new Date(expiresAt).toISOString() };
}
