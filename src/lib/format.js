// Console formatting for incoming data. The point of this server right now is
// to see what devices are sending, so both endpoints log the decoded payload in
// full rather than a summary line.

const DASH = '—';

const num = (v, unit = '', places = null) => {
  if (v === null || v === undefined) return DASH;
  const n = places === null ? v : Number(v).toFixed(places);
  return unit ? `${n} ${unit}` : String(n);
};

const rule = (label) => `${'─'.repeat(3)} ${label} ${'─'.repeat(Math.max(0, 56 - label.length))}`;

/** Alarm names that are currently raised, or "none". */
function activeAlarms(alarms) {
  const on = Object.entries(alarms)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return on.length ? on.join(', ') : 'none';
}

export function formatMeterReading(reading, hex, { duplicate, encoding, source = 'coap_push' }) {
  const p = reading.payload;
  const nonZero = p.increments.filter((s) => s.value !== 0 && s.value !== null);
  const shown = nonZero
    .slice(0, 8)
    .map((s) => `${s.time} ${s.value}`)
    .join(' · ');

  const lines = [
    rule(`${source}  ${reading.address}${duplicate ? '  (duplicate)' : ''}`),
    `  raw     ${hex}`,
    `  frame   ${reading.meterType} meter · ${encoding} · ${hex.length / 2} bytes · DI ${reading.dataIdentifier} · SER ${reading.ser}`,
    `  time    ${p.meterTime.iso ?? p.meterTime.raw}   (meter local)`,
    `  flow    cumulative ${num(p.cumulativeFlow.value, 'm3')}   settlement ${num(p.settlementFlow.value, 'm3')}   reverse ${num(p.reverseFlow.value, 'm3')}   remaining ${num(p.remainingFlow.value, 'm3')}`,
    `  rate    ${num(p.flowRate.value, 'm3/h')}   temp ${num(p.temperature.value, 'C')}   pressure ${num(p.pressure.value, 'MPa')}   ultrasonic ${p.ultrasonicSignal}`,
    `  status  valve ${p.status.valve}   battery ${p.status.batteryVoltageLow ? 'LOW' : 'ok'}   alarms: ${activeAlarms(p.status.alarms)}`,
    `  radio   ${num(p.signalStrength, 'dBm')}   quality ${p.signalQuality}   transmission #${p.transmissionCount}`,
    `  sim     IMEI ${p.imei}   ICCID ${p.iccid}`,
    `  config  uploads at ${p.timingScheme.map((h) => `${String(h).padStart(2, '0')}:00`).join(', ') || DASH}   flag ${p.uploadFlag}`,
    `  freeze  cutoff ${String(p.freeze.cutoffHour ?? 0).padStart(2, '0')}:00 at ${num(p.freeze.cutoffFlow, 'm3')}`,
    `  usage   ${nonZero.length}/${p.increments.length} half-hour slots non-zero${shown ? `: ${shown}${nonZero.length > 8 ? ` · +${nonZero.length - 8} more` : ''}` : ''}`,
  ];

  if (p.slotCountMismatch) {
    lines.push(
      `  WARNING expected ${p.slotCountMismatch.expected} half-hour slots, got ${p.slotCountMismatch.got}`,
    );
  }
  return lines.join('\n');
}

/** CAT-1 packet type 03: a postpaid meter's periodic report. */
export function formatCat1Reading(reading, hex, { duplicate, source = 'tcp' }) {
  const p = reading.payload;
  const m3 = (litres) => `${(litres / 1000).toFixed(3)} m3`;
  const alarms = [
    p.status.batteryUndervoltage && 'undervoltage',
    p.status.magneticInterference && 'magnetic',
    p.status.coverOpen && 'cover open',
  ].filter(Boolean);

  return [
    rule(`${source}  ${reading.address}${duplicate ? '  (duplicate)' : ''}`),
    `  raw     ${hex}`,
    `  frame   CAT-1 · ${reading.meterType} meter · ${hex.length / 2} bytes · packet ${reading.packetName}`,
    `  trigger ${reading.reportingTriggers.join(', ') || DASH}   report #${p.cumulativeReportCount} (today #${p.dailyReportCount})`,
    `  time    ${p.meterClock.iso ?? p.meterClock.raw}   (meter clock)`,
    `  usage   cumulative ${m3(p.cumulativeUsageLitres)} (${p.cumulativeUsageLitres} L)   today ${m3(p.dailyUsageLitres)}   month ${m3(p.monthlyUsageLitres)}`,
    `  status  valve ${p.status.valve}   battery ${p.status.batteryUndervoltage ? 'LOW' : 'ok'} ${p.voltageVolts.toFixed(3)} V   alarms: ${alarms.join(', ') || 'none'}`,
    `  radio   ${num(p.signalStrengthDbm, 'dBm')} RSSI   ${num(p.signalQualityDb, 'dB')} RSRQ   ${num(p.snrDb, 'dB')} SNR`,
    `  sim     IMEI ${p.imei}   ICCID ${p.iccid}`,
    `  config  reports ${p.reportingMode.description ?? p.reportingMode.raw}   mfr ${p.manufacturerCode}   hw ${p.hardwareVersion}   sw ${p.softwareVersion}`,
  ].join('\n');
}

const METER_TYPE_LABELS = { 0x10: 'water', 0x20: 'heat' };

const hexOf = (bytes) => bytes.toString('hex').toUpperCase();

/** Connection lifecycle, one line each, so a silent device is still visible. */
export function formatTcpEvent(kind, { peer, detail }) {
  return `··· tcp ${kind}  ${peer}${detail ? `  ${detail}` : ''}`;
}

/**
 * A frame with a valid envelope that we cannot decode into a reading.
 *
 * The address is printed even though the payload is unknown: it says which
 * meter is talking, which is most of the diagnostic value.
 */
export function formatUnrecognisedFrame(bytes, envelope, reason, { peer }) {
  const type = METER_TYPE_LABELS[envelope.meterTypeCode] ?? 'unknown';
  const hx = (v) => (v === null ? DASH : v.toString(16).toUpperCase().padStart(2, '0') + 'H');
  return [
    rule(`tcp frame  ${envelope.address ?? 'unknown address'}  UNRECOGNISED`),
    `  peer    ${peer}`,
    `  raw     ${hexOf(bytes)}`,
    `  frame   ${type} meter · ${bytes.length} bytes · C ${hx(envelope.control)} · L ${hx(envelope.dataLength)}`,
    `  reason  ${reason}`,
    '  note    envelope is valid CJ/T 188; the payload layout is not the 9097 upload',
  ].join('\n');
}

/** Bytes that were not part of any frame -- heartbeats, keepalives, junk. */
export function formatUnframedBytes(bytes, { peer }) {
  const printable = [...bytes].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
  return [
    rule('tcp data  NOT A FRAME'),
    `  peer    ${peer}`,
    `  raw     ${hexOf(bytes)}`,
    `  ascii   ${printable}`,
    `  bytes   ${bytes.length}   (no 68H…16H frame; logged so nothing is lost)`,
  ].join('\n');
}

export function formatDatalog(deviceId, records, { inserted, duplicates }) {
  const lines = [
    rule(`datalogs  ${deviceId}`),
    `  ${records.length} record(s) · ${inserted} new · ${duplicates} duplicate`,
  ];

  for (const r of records) {
    const when = new Date(r.timestamp * 1000).toISOString().replace('.000Z', 'Z');
    lines.push(
      `  ${when}  batt ${num(r.battery, 'V', 2)}  temp ${num(r.temperature, 'C', 1)}` +
        `  level ${r.waterLevel === null ? `${DASH} (invalid)` : num(r.waterLevel, 'm', 3)}` +
        `  baro ${num(r.barometric, 'hPa', 1)}`,
    );
  }
  return lines.join('\n');
}
