# water-meter-check

Ingest and command server for CAT-1 NB-IoT water meters. The meters open a raw
TCP connection and push a frame; the server decodes it, answers on the same
socket, and can send the meter a command in that reply.

Runtime dependencies: Express and Mongoose.

**The ingest path still writes to `src/store/memory.js`**, which keeps everything
in plain arrays and starts empty every time. The Mongoose models in
`src/database/` are defined and tested but not yet wired into ingest — see
[Database](#database) for what exists and what is still to come.

```bash
npm install
npm run build   # TypeScript -> dist/
npm test        # 189 tests (13 skip without a mongod)
npm start       # PORT=3000 by default
```

| Env var | Default   |
| ------- | --------- |
| `PORT`  | `3000`    |
| `HOST`  | `0.0.0.0` |

## TypeScript

Sources compile to `dist/` and the server runs from there. `npm start` does not
build — deploy runs `npm run build` explicitly, so a production start is
deterministic rather than quietly recompiling.

There is a faster option that this project deliberately does not use. Node 22
can execute `.ts` directly by stripping types, no build step at all — but the
EC2 box runs Ubuntu's distro `nodejs` package, which is **compiled without
TypeScript support** and answers `ERR_NO_TYPESCRIPT`. Native stripping would
therefore work on a dev machine and fail in production, which is the worst place
for that difference to show up. A build step works on any Node.

```
npm run build       tsc -> dist/
npm run typecheck   tsc --noEmit, no output
npm run dev         watch-compile and watch-run together
npm test            build, then run dist/test/*.test.js
```

**JavaScript and TypeScript coexist on purpose.** `allowJs` is on and `checkJs`
is off, so the existing modules compile untouched and are not type-checked,
while everything under `src/database/` is `.ts` and fully strict. Files convert
one at a time; turn `checkJs` on once the last `.js` is gone.

Two settings worth knowing about, both in `tsconfig.json`: `verbatimModuleSyntax`
requires type-only imports be written `import type`, and `erasableSyntaxOnly`
bans constructs that need real codegen — no `enum`, no parameter properties. The
output is ESM that Node runs directly, so anything surviving erasure that has no
runtime becomes an import of a module that does not exist. Union types from
`as const` arrays replace enums throughout.

Relative imports are written with `.js` extensions even from `.ts` files. That
is what `nodenext` module resolution requires: the extension refers to the
compiled output, which is what actually gets imported at runtime.

## Console output

Every report logs the full decoded payload as it arrives — the raw frame plus
every field, not a summary. Bad frames log the specific reason (`bad_checksum`,
`too_short`, `not_cat1`, …) together with the raw bytes.

```
─── tcp  00102608220004 ─────────────────────────────────────
  raw     6810040022082610000397000000024603C22C00...7416
  frame   CAT-1 · cold water meter · 88 bytes · packet postpaid_standard
  trigger trigger   report #16 (today #2)
  time    2023-09-23T06:02:46   (meter clock)
  usage   cumulative 1.000 m3 (1000 L)   today 0.000 m3   month 0.000 m3
  meter   postpaid · switch valve · counts in 1000 L steps
  status  valve open   battery ok 3.614 V   alarms: none
  radio   -94 dBm RSSI   -9 dB RSRQ   23 dB SNR
  sim     IMEI 867512079825846   ICCID 89860422152570009782
  config  reports every 1440 minutes   mfr C22C   hw 0306   sw 0300
```

Formatting lives in `src/lib/format.js`. The TCP handler logs through an injected
logger, so tests silence it by passing no-op `info`/`warn`/`error`.

## Endpoints

### `POST /api/v1/meters/:address/server-address`

Re-points a meter at a different ingest server. **This is the one command with
no opposite.** Downlink rides on the acknowledgement path, so a meter pointed at
a server that does not acknowledge its reports can never be commanded again —
including to point it back. Only physical access recovers it. Prove the
destination returns a correct `17H` ack before sending this to anything, and do
one meter first.

`confirm: true` is required and `ip`/`port` are never defaulted.

Two frames exist and `method` picks between them:

- `command` (default) — `AA17H`, protocol §2.12. **Confirmed on hardware**:
  success `00H`. An `AA`-series command, which is the shape this firmware
  implements.
- `parameter` — the §III `0xAC0E`/`0xAC0F` write, selected with
  `which: primary|secondary`. **A real meter refused this with `0BH`** minutes
  before accepting the `AA17H` form, along with every other generic parameter
  write tried. Kept only for meters older than §2.12.

§2.12 is not in the protocol PDF in this repo — that revision's §2 ends at 2.10
— so the `AA17H` layout comes from a byte table the vendor supplied separately.
One field in it was ambiguous: the confirmation word at bytes 20–21 is "the low
two bytes of the meter address XORed with `A6B6`", which does not fix a byte
order. The meter settled it — **value order** (`0xA6B2` for `00102608220004`) is
what it accepts. `wireOrderConfirmation: true` sends the other reading
(`0xA2B6`); the two sum identically so no checksum can distinguish them, which is
why it stays available for a meter with the opposite convention.

### `GET /debug/store` · `DELETE /debug/store`

With no database there is nowhere else to look at what was ingested, so `GET`
dumps the whole mock store (counts plus every row) and `DELETE` empties it,
including the dedup keys — handy for replaying the same frame during manual
testing. Both are unauthenticated and exist only for the mock; remove them when
a real store goes in.

```
$ curl -s localhost:3000/debug/store | jq .counts
{"cat1Readings": 41, "ingestFailures": 7}
```

## Auto-configure

Field meters are brought to a target configuration without anyone queueing
commands for them. Every CAT-1 report is checked against the policy, and the
meter is answered with **at most one command**, chosen from a ladder:

| | condition | command |
|---|---|---|
| 1 | meter clock more than `CONFIGURE_CLOCK_TOLERANCE_S` off the target zone | `AA00` clock |
| 2 | table type code resolution ≠ target | `AA07` meter type |
| 3 | nothing wrong | power-off ack only |

One command per contact is not a throttle, it is what the firmware allows.
`AA00` never sends a reply, so nothing queued behind it in a contact is ever
transmitted, and a clock write chained behind another command applied nothing at
all. A meter wrong in both ways therefore converges over two contacts — two days
unattended, or two button presses.

No read command is needed, which matters because this firmware refuses `01H`
reads: packet 03 already carries the meter's clock and its table type code,
whose low two bits are the metering resolution.

Both settings are read back from the *next* report rather than from a reply, so
the loop is self-checking. It is also self-healing — a replaced or reset meter
is corrected the first time it reports.

```
CONFIGURE=0                       turn it off; server becomes a pure collector
CONFIGURE_TIMEZONE=Asia/Dhaka     IANA zone the meter clock should read
CONFIGURE_RESOLUTION_LITRES=1     1 | 10 | 100 | 1000
CONFIGURE_CLOCK_TOLERANCE_S=120   below this, treat skew as drift, not a wrong zone
CONFIGURE_MAX_ATTEMPTS=3          per meter, per setting, before giving up
CONFIGURE_ALLOW_CLOSED_VALVE=0    see below — leave at 0
```

The older `RECONCILE_*` spelling of every one of these is still honoured, and
`CONFIGURE_*` wins where both are set. This is not cosmetic: `Environment=RECONCILE=0`
is what holds the policy **off** in a deployed systemd unit, and ignoring the old
name would turn the policy silently on wherever the unit file had not been
updated alongside the code — which means unattended `AA07` writes, which open
valves.

`GET /api/v1/configure` reports the active policy and the attempt count per
meter. A meter sitting at the cap is one that has been commanded repeatedly and
has not complied; it is logged as `configure held` on every subsequent contact
rather than being retried forever, because these are battery devices.

**`AA07` opens the valve**, so a meter whose valve is shut is skipped rather
than corrected. This is not in the protocol: the frame rewrites payment mode and
in-place mode alongside the metering mode with no "leave unchanged" value, and
re-asserting postpaid on a meter with no debt makes this firmware open the valve.
Turning a customer's water back on as a side effect of a resolution change is
the one irreversible thing this loop could do unattended, so it does not.
`CONFIGURE_ALLOW_CLOSED_VALVE=1` overrides that if you know the fleet is safe.

**The policy outranks a command queued through the API.** A meter whose clock or
resolution is wrong is misreporting, and every contact spent on something else is
another day of readings to correct later — so the meter is brought to a known
state first. A hand-issued command is not starved by this: each rung gives up
after `CONFIGURE_MAX_ATTEMPTS`, and the queue's next command goes out in the same
contact once a policy command succeeds. The exception is `AA00`, which never
replies, so a contact spent on a clock write ends there.

## Layout

```
src/lib/frame.js        checksum + FrameError, shared by framing and cat1
src/lib/framing.js      splits the TCP stream into 68H…16H frames
src/lib/cat1.js         CAT-1 frame decoding and command encoders
src/configure.js        auto-configure policy: one report in, one command out
src/commands.js         the downlink queue (still in memory)
src/database/           connection lifecycle + Mongoose models  [TypeScript]
src/database/models/    one file per collection
src/store/memory.js     mock store: in-memory rows + dedup
src/routes/             one file per endpoint
test/fixtures.js        the PDF's reference frame and its expected values
test/database.test.ts   model tests, skipped without a mongod
```

## Database

MongoDB via Mongoose. `src/database/` holds the connection lifecycle and one
model per collection; `src/database/models/index.ts` re-exports the lot.

```
meters            one document per physical meter: its latest known state
meterreadings     one row per report, append-only history
commands          the downlink queue
ingest_failures   frames that would not parse, with a TTL
```

| Env var | Default | |
| --- | --- | --- |
| `MONGO_URL` | `mongodb://127.0.0.1:27017/watermeter` | `MONGODB_URI` also accepted, for Atlas |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | `5000` | |
| `MONGO_MAX_POOL_SIZE` | `10` | |
| `MONGO_AUTO_INDEX` | on | `0` disables — see the dedup warning below |
| `FAILURE_RETENTION_DAYS` | `90` | |

Four decisions in here are load-bearing.

**Meter clocks are strings, not Dates.** A meter has no concept of a time zone —
it stores exactly the six BCD digits it was given and reads them back, so
`"2026-08-05T15:35:00"` means the digits on its display and nothing more.
Storing that as a `Date` asserts an instant the meter never had, and this fleet
has already lived through why that matters: these meters shipped on UTC+8 and
were moved to Dhaka UTC+6, so identical digits mean different instants either
side of the change. `clockSkewSeconds` is the derived number that *is*
comparable. Anything genuinely on the server clock — `receivedAt`, `lastSeenAt`
— is a real `Date`.

**Deduplication is now the index's job.** Unique indexes on
`(meterAddress, cumulativeReportCount, meterClock)`,
`(meterAddress, meterTime)` and `(deviceId, timestamp)` replace the `Set`s the
mock kept in memory — which is the only version that survives a restart, since a
meter replays a report whose ack it never saw. This is why `autoIndex` stays on:
with the indexes missing nothing errors, duplicates simply accumulate, and the
first sign is a usage chart with doubled steps.

**Commands are rows, not closures.** A queued command used to carry the function
that builds its frame, so a restart dropped every command not yet delivered —
and with meters reporting daily, "not yet delivered" is the normal state. A
command is stored as its type, target and parameters, and the encoder is looked
up by type at delivery. Parameters are resolved late on purpose: a clock command
with no explicit time resolves *now* when the frame is built, or a meter
collecting it a day later would be set exactly as wrong as the delay.

**Connection settings favour the meter over the query.** `bufferCommands` is off
and server selection times out at 5 s rather than 30. The queue lookup sits on
the acknowledgement path, so that timeout is time a battery-powered meter spends
awake with its radio on. Failing fast costs one report; blocking costs battery on
every meter that calls in during an outage.

Storage is still reached through `openStore()` in `src/server.js`, so routes and
decoders never touch the database directly, and `/debug/store` should go when the
Mongo-backed store replaces the mock.

### Running the model tests

They need a real mongod and are **skipped, not failed,** without one — asserting
that a unique index rejects a replay is meaningless against a mock.

```bash
mongod --dbpath /tmp/wm-mongo --port 27018 --bind_ip 127.0.0.1
MONGO_TEST_URL='mongodb://127.0.0.1:27018/watermeter_test' npm test
```

### Note on the EC2 box

`65.1.99.130` has 912 MB of RAM, no swap, and ~3 GB free disk. WiredTiger's
cache floor alone is 256 MB and mongod typically settles at 400–600 MB resident,
so mongod and the ingest server together will not fit comfortably as things
stand. Add a 2 GB swapfile, move to a larger instance, or point `MONGO_URL` at a
hosted cluster before running both there. The failure mode if you don't is the
OOM killer choosing between them, and the ingest server losing means meters get
no acknowledgement at all.

## Not included

Downlink commands (§3.2 valve open/close, §3.3 time calibration) are not
implemented — those are calls *out* to the platform API, not endpoints devices
post to. The frame builders are small if you want them added later.
# flow-meter-server-tcp
