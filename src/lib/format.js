// Console formatting for incoming data. The point of this server right now is
// to see what the meters are sending, so reports are logged in full rather than
// as a summary line.

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
    `  meter   ${p.meterConfig.paymentType} · ${p.meterConfig.valveType} valve · counts in ${p.meterConfig.resolutionLitres} L steps`,
    `  status  valve ${p.status.valve}   battery ${p.status.batteryUndervoltage ? 'LOW' : 'ok'} ${p.voltageVolts.toFixed(3)} V   alarms: ${alarms.join(', ') || 'none'}`,
    `  radio   ${num(p.signalStrengthDbm, 'dBm')} RSSI   ${num(p.signalQualityDb, 'dB')} RSRQ   ${num(p.snrDb, 'dB')} SNR`,
    `  sim     IMEI ${p.imei}   ICCID ${p.iccid}`,
    `  config  reports ${p.reportingMode.description ?? p.reportingMode.raw}   mfr ${p.manufacturerCode}   hw ${p.hardwareVersion}   sw ${p.softwareVersion}`,
  ].join('\n');
}

/**
 * CAT-1 section 1.1 read response: the meter's stored configuration.
 *
 * IMEI/ICCID/versions are printed first on purpose. They are already known from
 * the meter's own reports, so if they read back correctly here then every later
 * offset in this frame is being read from the right place -- which is the only
 * reason to trust the valve and payment fields underneath them.
 */
export function formatReadResponse(r, hex, { peer }) {
  return [
    rule(`tcp read  ${r.address}  PARAMETERS`),
    `  peer    ${peer}`,
    `  raw     ${hex}`,
    `  ident   IMEI ${r.imei}   IMSI ${r.imsi}`,
    `          ICCID ${r.iccid}`,
    `          hw ${r.hardwareVersion}   sw ${r.softwareVersion}   vendor ${r.vendorCode}   table type ${r.tableTypeCode}`,
    `  valve   control ${r.valveControl.enabled ? 'ENABLED (0000, default)' : `SHIELDED (${r.valveControl.raw})`}` +
      `${r.valveControl.shieldedConditions.length ? `   shielded on: ${r.valveControl.shieldedConditions.join(', ')}` : ''}`,
    `  modes   payment ${r.paymentMode}   in-place ${r.inPlaceMode}   metering ${r.meteringModeLitres ?? DASH} L/count (${r.meteringModeRaw}H)`,
    `  server  primary ${r.serverAddress1}   secondary ${r.serverAddress2}`,
    `  reports ${r.reportingMode.description ?? r.reportingMode.raw}   daily limit ${r.dailyReportLimit}   cumulative #${r.cumulativeReportCount}`,
    `  rest    ${r.rest}`,
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
    '  note    the 68H…16H envelope is shared by several meter protocols, so a',
    '          valid envelope here does not make the payload CAT-1',
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
