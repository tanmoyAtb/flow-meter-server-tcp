# water-meter-check

Express ingest server for the two endpoints in [api.txt](api.txt): the Hydrosense
binary datalogger push, and the NB-IoT CJ/T 188 meter frame push forwarded by the
IoT platform (Telecom AEP / China Mobile OneNet).

Runtime dependencies: Express and Mongoose.

**The ingest path still writes to `src/store/memory.js`**, which keeps everything
in plain arrays and starts empty every time. The Mongoose models in
`src/database/` are defined and tested but not yet wired into ingest — see
[Database](#database) for what exists and what is still to come.

```bash
npm install
npm run build   # TypeScript -> dist/
npm test        # 207 tests (14 skip without a mongod)
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

Both endpoints log the full decoded payload as it arrives — the raw frame plus
every field, not a summary. Bad frames log the specific reason (`bad_checksum`,
`too_short`, …).

```
─── coap_push  21081300004575 ───────────────────────────────
  raw     68107545000013082181AC9097002B6066...2CD8E616
  frame   water meter · hex · 185 bytes · DI 9097 · SER 0
  time    2021-08-26T04:14:46   (meter local)
  flow    cumulative 206.66 m3   settlement 18.03 m3   reverse 0 m3   remaining 0 m3
  rate    0 m3/h   temp 27.92 C   pressure 0 MPa   ultrasonic 0
  status  valve open   battery ok   alarms: emptyPipe
  radio   -76 dBm   quality 18   transmission #11
  sim     IMEI 864823047988050   ICCID 89861119253017474430
  config  uploads at 04:00   flag 1
  freeze  cutoff 00:00 at 206.66 m3
  usage   26/47 half-hour slots non-zero: 13:30 3.95 · 13:00 1.94 · … · +18 more

─── datalogs  HS-GWL-0042 ───────────────────────────────────
  2 record(s) · 2 new · 0 duplicate
  2025-01-27T17:46:40Z  batt 3.70 V  temp 21.5 C  level 1.234 m  baro 1013.2 hPa
  2025-01-27T17:56:40Z  batt 3.69 V  temp 21.4 C  level — (invalid)  baro 1013.1 hPa
```

Formatting lives in `src/lib/format.js`. Routes log through an injected logger,
so tests silence it by passing no-op `info`/`warn`/`error`.

## Endpoints

### `POST /api/v1/datalogs/:deviceId`

Body is `[count: 1 byte][count × 20-byte records]`, little-endian, count 1–100.
Each record is `uint32` unix seconds + four `float32`s (battery V, temperature °C,
water level m, barometric — parsed but not used). A water level of `999` is the
device's invalid sentinel and is stored as `NULL`.

- `200` empty body — saved, device clears its queue
- `400` — bad frame, device retries
- `500` — server fault; deliberately *not* `400`, so the device keeps its buffer

Deduplicated on `(device_id, timestamp)`, so retries are safe.

### `POST /api/v1/coap_push`

Accepts the frame as raw hex text, raw binary, JSON containing hex, or JSON
containing base64. For JSON the payload is found by walking the object for the
first string that decodes to a `68…16` frame, so platform-specific wrapper shapes
don't need to be configured.

Always answers `200` — platforms retry on any non-200, and a frame that fails to
parse will never parse on retry. Failures come back as `{"ok": false, "reason": …}`
and are written to the `ingest_failures` table rather than dropped.

Deduplicated on `(meter_address, meter_time)`.

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
$ curl -X POST localhost:3000/api/v1/coap_push -d '68107545...E616'
{"ok":true,"duplicate":false,"encoding":"hex","meter_address":"21081300004575",
 "meter_time":"2021-08-26T04:14:46","cumulative_flow":206.66,"temperature":27.92,
 "valve_status":"open","signal_strength":-76,"imei":"864823047988050",
 "alarms":{"emptyPipe":true,...},"increments":[{"time":"23:30","value":0},...]}
```

## Auto-reconcile

Field meters are brought to a target configuration without anyone queueing
commands for them. Every CAT-1 report is checked against the policy, and the
meter is answered with **at most one command**, chosen from a ladder:

| | condition | command |
|---|---|---|
| 1 | meter clock more than `RECONCILE_CLOCK_TOLERANCE_S` off the target zone | `AA00` clock |
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
RECONCILE=0                       turn it off; server becomes a pure collector
RECONCILE_TIMEZONE=Asia/Dhaka     IANA zone the meter clock should read
RECONCILE_RESOLUTION_LITRES=1     1 | 10 | 100 | 1000
RECONCILE_CLOCK_TOLERANCE_S=120   below this, treat skew as drift, not a wrong zone
RECONCILE_MAX_ATTEMPTS=3          per meter, per setting, before giving up
RECONCILE_ALLOW_CLOSED_VALVE=0    see below — leave at 0
```

`GET /api/v1/reconcile` reports the active policy and the attempt count per
meter. A meter sitting at the cap is one that has been commanded repeatedly and
has not complied; it is logged as `reconcile held` on every subsequent contact
rather than being retried forever, because these are battery devices.

**`AA07` opens the valve**, so a meter whose valve is shut is skipped rather
than corrected. This is not in the protocol: the frame rewrites payment mode and
in-place mode alongside the metering mode with no "leave unchanged" value, and
re-asserting postpaid on a meter with no debt makes this firmware open the valve.
Turning a customer's water back on as a side effect of a resolution change is
the one irreversible thing this loop could do unattended, so it does not.
`RECONCILE_ALLOW_CLOSED_VALVE=1` overrides that if you know the fleet is safe.

A command queued through the API always outranks the policy for that contact.

## Where the decoder disagrees with the protocol PDF

`src/lib/cjt188.js` is written against `IoT_Platform_COAP_Communication_Protocol_English.pdf`,
but three things in that document don't hold. Each is covered by a test in
`test/cjt188.test.js` that asserts against the document's own worked example.

1. **Temperature is 3 bytes, not 2.** The §3.1 field table says 2; the worked
   example carries `92 27 00`. At 2 bytes every field from the timestamp onward
   decodes to garbage. The third byte is undocumented and is exposed as
   `temperature.reserved`.
2. **47 half-hourly slots, not 48.** The document labels the block "48
   freeze-data", but that count includes the 00:00 cutoff pair stored separately.
   The series itself runs 23:30 → 00:30.
3. **§3.3's first time-calibration example has a wrong checksum** — it prints
   `52`, the correct value is `9D`. Don't use it as a test vector. (Not exercised
   here; this server only handles uplink.)

Two further points the document leaves unstated, both handled with the
conservative reading:

- The half-hourly block has no unit byte, so it is scaled by the **cumulative
  flow unit**. With the reference frame's `2BH` that gives ×0.001 m³, which
  reproduces the printed table exactly.
- §4.6 numbers the status bytes BYTE 1 / BYTE 2 but never says which is sent
  first. Wire order is assumed. The raw pair is kept in `status.raw` — if a live
  meter disagrees, flip the two in `readStatus()`. Note the reference frame
  decodes to an active **empty-pipe alarm**, which the document's table leaves
  undecoded.

## Layout

```
src/lib/cjt188.js       frame envelope + 9097 payload decoder
src/lib/cat1.js         CAT-1 frame decoding and command encoders
src/lib/datalog.js      20-byte datalogger record decoder
src/lib/body.js         hex / binary / JSON-hex / JSON-base64 normalisation
src/reconcile.js        auto-reconcile policy: one report in, one command out
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
cat1_readings     CAT-1 packet-03 reports, append-only history
meter_readings    CJ/T 188 readings, including the 47 half-hourly slots
datalogs          Hydrosense datalogger records
commands          the downlink queue
ingest_failures   frames that would not parse, with a TTL
counters          command ids and instruction numbers
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
