// POST /api/v1/coap_push
//
// Contract from api.txt: always 200, with ok:true/false in the body. IoT
// platforms retry on any non-200, and a frame we cannot parse will never parse
// on retry -- so failures are acknowledged and parked in ingest_failures
// instead of being bounced back at the platform forever.

import express, { Router } from 'express';
import { parseUplink, FrameError } from '../lib/cjt188.js';
import { extractFrame } from '../lib/body.js';
import { formatMeterReading } from '../lib/format.js';

const MAX_BODY = '64kb'; // a 9097 frame is 185 bytes; the slack is for JSON wrappers

export function coapRouter(store, log = console) {
  const router = Router();

  // Content-Type is whatever the platform feels like sending, so take the body
  // raw and work out the encoding ourselves.
  const readBody = express.raw({ type: () => true, limit: MAX_BODY });

  const fail = (res, reason, detail) => res.status(200).json({ ok: false, reason, detail });

  router.post(
    '/coap_push',
    (req, res, next) =>
      readBody(req, res, (err) => {
        if (err) {
          log.warn?.(`coap_push: unreadable body: ${err.message}`);
          store.recordFailure('coap_push', `body_error: ${err.message}`, null);
          return fail(res, 'body_error', err.message);
        }
        next();
      }),
    (req, res) => {
      const bodyText = req.body?.length ? req.body.toString('utf8').slice(0, 4096) : null;

      const extracted = extractFrame(req.body);
      if (!extracted) {
        log.warn?.('coap_push: no frame found in body');
        store.recordFailure('coap_push', 'no_frame', bodyText);
        return fail(res, 'no_frame', 'body contained no hex, base64 or binary CJ/T 188 frame');
      }

      const hex = extracted.frame.toString('hex').toUpperCase();

      let reading;
      try {
        reading = parseUplink(extracted.frame);
      } catch (err) {
        if (!(err instanceof FrameError)) throw err;
        log.warn?.(`coap_push: ${err.code}: ${err.message}`);
        store.recordFailure('coap_push', `${err.code}: ${err.message}`, hex);
        return fail(res, err.code, err.message);
      }

      if (reading.direction !== 'uplink') {
        store.recordFailure('coap_push', 'not_uplink', hex);
        return fail(res, 'not_uplink', 'control code D7 marks this as a platform-issued frame');
      }

      const { duplicate } = store.saveMeterReading(reading, hex);
      const p = reading.payload;

      log.info?.(formatMeterReading(reading, hex, { duplicate, encoding: extracted.encoding }));

      return res.status(200).json({
        ok: true,
        duplicate,
        encoding: extracted.encoding,
        meter_address: reading.address,
        meter_time: p.meterTime.iso,
        cumulative_flow: p.cumulativeFlow.value,
        settlement_flow: p.settlementFlow.value,
        reverse_flow: p.reverseFlow.value,
        remaining_flow: p.remainingFlow.value,
        flow_rate: p.flowRate.value,
        temperature: p.temperature.value,
        pressure: p.pressure.value,
        valve_status: p.status.valve,
        battery_voltage_low: p.status.batteryVoltageLow,
        alarms: p.status.alarms,
        signal_strength: p.signalStrength,
        signal_quality: p.signalQuality,
        transmission_count: p.transmissionCount,
        imei: p.imei,
        iccid: p.iccid,
        timing_scheme: p.timingScheme,
        freeze: p.freeze,
        increments: p.increments.map((s) => ({ time: s.time, value: s.value })),
      });
    },
  );

  return router;
}
