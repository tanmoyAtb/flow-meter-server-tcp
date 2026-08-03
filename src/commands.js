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

  // Instruction numbers correlate a command with the meter's response: section
  // I.4 requires they not repeat, and the reply carries the same number back.
  let nextInstruction = 1;

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
     * Match a meter reply back to the command that provoked it.
     *
     * Section I.4 says the reply carries the same instruction number, and that
     * is the correct match. Real meters do not always honour it -- one observed
     * rejection came back with instruction number 0000 and data identifier 0000
     * -- so when the number matches nothing and exactly one command is
     * outstanding for that meter, fall back to it. Without this a rejected
     * command sticks at `sent` forever and the caller never learns it failed.
     */
    findSentByInstruction(address, instructionNumber) {
      const outstanding = (byAddress.get(address) ?? [])
        .map((id) => byId.get(id))
        .filter((cmd) => cmd.status === 'sent');

      const exact = outstanding.find((cmd) => cmd.instructionNumber === instructionNumber);
      if (exact) return exact;
      return outstanding.length === 1 ? outstanding[0] : null;
    },

    complete(cmd, { success, detail }) {
      cmd.status = success ? 'acknowledged' : 'failed';
      cmd.completedAt = new Date(now()).toISOString();
      cmd.result = detail ?? null;
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
