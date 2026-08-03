# water-meter-check

Express ingest server for the two endpoints in [api.txt](api.txt): the Hydrosense
binary datalogger push, and the NB-IoT CJ/T 188 meter frame push forwarded by the
IoT platform (Telecom AEP / China Mobile OneNet).

Runtime dependency: Express, and nothing else.

**Storage is a mock.** `src/store/memory.js` keeps everything in plain arrays;
nothing is persisted and the process starts empty every time. This is a test
build — see [Adding a real database](#adding-a-real-database) below.

```bash
npm install
npm test     # 37 tests
npm start    # PORT=3000 by default
```

| Env var | Default   |
| ------- | --------- |
| `PORT`  | `3000`    |
| `HOST`  | `0.0.0.0` |

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
src/lib/cjt188.js     frame envelope + 9097 payload decoder
src/lib/datalog.js    20-byte datalogger record decoder
src/lib/body.js       hex / binary / JSON-hex / JSON-base64 normalisation
src/store/memory.js   mock store: in-memory rows + dedup
src/routes/           one file per endpoint
test/fixtures.js      the PDF's reference frame and its expected values
```

## Adding a real database

The mock deliberately has the shape a real adapter would: write a module
exposing `saveDatalog`, `saveMeterReading`, `recordFailure` and `close`, then
change the one `openStore` import in `src/server.js`. Routes and decoders never
touch storage directly.

Two things the mock does in application code that a real schema should hand to
the database instead:

- **Dedup.** Unique indexes on `(device_id, timestamp)` and
  `(meter_address, meter_time)`, with `INSERT IGNORE` / `ON CONFLICT DO NOTHING`.
  `saveDatalog` returns how many rows were new; `saveMeterReading` returns
  `{ duplicate }`. Keep those return shapes and the routes keep working.
- **The `increments` array**, which the mock nests inside each meter reading.
  In SQL that is a child table keyed by `(reading_id, slot_time)` — 47 rows per
  reading.

Also drop the `/debug/store` routes from `src/app.js` at that point.

## Not included

Downlink commands (§3.2 valve open/close, §3.3 time calibration) are not
implemented — those are calls *out* to the platform API, not endpoints devices
post to. The frame builders are small if you want them added later.
# flow-meter-server-tcp
