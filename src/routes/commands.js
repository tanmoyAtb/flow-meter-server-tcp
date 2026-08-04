// Downlink command API.
//
// Commands are queued, never delivered synchronously: a CAT-1 meter is a client
// that reports and powers down, so the earliest a command can reach it is its
// next contact. Responses are therefore 202 Accepted, not 200 -- the request
// has been recorded, the device has not yet acted on it.

import express, { Router } from 'express';
import {
  encodeReadParameters,
  encodeSetClock,
  encodeSetClockParam,
  encodeSetMeterType,
  encodeValveOperation,
  METERING_MODE_BYTES,
  PAYMENT_MODE_BYTES,
  IN_PLACE_MODE_BYTES,
} from '../lib/cat1.js';

const ADDRESS_RE = /^\d{14}$/; // 14-digit BCD meter address

// Two documented ways to set the clock. A real meter rejected aa00 with error
// 0BH, so the identifier is selectable until we know which one it accepts.
const CLOCK_METHODS = { aa00: encodeSetClock, ac12: encodeSetClockParam };

export function commandRouter(queue, log = console, { token = null } = {}) {
  const router = Router();
  router.use(express.json({ limit: '8kb' }));

  // Writing to a physical meter is not the same risk as reading from it. When
  // API_TOKEN is set, every route here requires it; unset, the API is open.
  router.use((req, res, next) => {
    if (!token) return next();
    const supplied = req.get('x-api-token');
    if (supplied !== token) return res.status(401).json({ ok: false, reason: 'unauthorised' });
    next();
  });

  router.post('/meters/:address/time', (req, res) => {
    const { address } = req.params;
    if (!ADDRESS_RE.test(address)) {
      return res.status(400).json({ ok: false, reason: 'bad_address', detail: 'expected 14 decimal digits' });
    }

    // A meter stores exactly the digits it is given and has no timezone, so an
    // explicit value is taken at face value.
    //
    // Omitting `time` means "now", and that must be resolved when the frame is
    // built, not when it is queued. A meter on the daily schedule can collect
    // its command 24 hours later; freezing the timestamp at request time would
    // set the clock exactly as wrong as the delay.
    const raw = req.body?.time;
    const explicit = raw === undefined ? null : new Date(raw);
    if (explicit !== null && Number.isNaN(explicit.getTime())) {
      return res.status(400).json({ ok: false, reason: 'bad_time', detail: `cannot parse ${JSON.stringify(raw)}` });
    }

    const method = req.body?.method ?? 'ac12';
    const encode = CLOCK_METHODS[method];
    if (!encode) {
      return res.status(400).json({
        ok: false,
        reason: 'bad_method',
        detail: `expected one of ${Object.keys(CLOCK_METHODS).join(', ')}`,
      });
    }

    // The meter stores digits, not an instant, so the caller says which wall
    // clock they should be. Resolved at delivery like `now`, so a command that
    // waits a day still lands on the right local time.
    const timeZone = req.body?.timeZone ?? null;
    if (timeZone !== null) {
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone });
      } catch {
        return res.status(400).json({
          ok: false,
          reason: 'bad_timezone',
          detail: `unknown time zone ${JSON.stringify(timeZone)}`,
        });
      }
    }

    const meterTypeCode = req.body?.meterTypeCode ?? 0x10;
    // Held by reference so the resolved value shows up in the command's status.
    const params = {
      mode: explicit ? 'explicit' : 'now_at_delivery',
      method,
      timeZone: timeZone ?? 'UTC',
      time: explicit ? explicit.toISOString() : null,
      sentTime: null,
      meterTypeCode,
    };

    const cmd = queue.enqueue(address, {
      type: 'set_clock',
      params,
      build: (instructionNumber) => {
        const at = explicit ?? new Date();
        params.sentTime = at.toISOString();
        return encode({ meterTypeCode, address }, at, instructionNumber, { timeZone });
      },
    });

    log.info?.(
      `command queued: set_clock #${cmd.id} for ${address} -> ${explicit ? explicit.toISOString() : 'now, resolved at delivery'} (${timeZone ?? 'UTC'})`,
    );

    return res.status(202).json({
      ok: true,
      status: 'queued',
      command: queue.get(cmd.id),
      note: "delivered at the meter's next contact; press the meter button to force one",
    });
  });

  // Physically actuates the valve. `state` is required rather than defaulted:
  // shutting off a supply is not something to arrive at by omission.
  router.post('/meters/:address/valve', (req, res) => {
    const { address } = req.params;
    if (!ADDRESS_RE.test(address)) {
      return res.status(400).json({ ok: false, reason: 'bad_address', detail: 'expected 14 decimal digits' });
    }

    const state = req.body?.state;
    if (state !== 'open' && state !== 'closed') {
      return res.status(400).json({
        ok: false,
        reason: 'bad_state',
        detail: 'state must be "open" or "closed"',
      });
    }

    const open = state === 'open';
    const forced = req.body?.forced === true;
    const meterTypeCode = req.body?.meterTypeCode ?? 0x10;

    // Overridable only because the meter rejects the documented 0CH with error
    // 0BH ("wrong command"). Bounded so a typo cannot emit a malformed frame.
    const dataLength = req.body?.dataLength ?? 0x0c;
    if (!Number.isInteger(dataLength) || dataLength < 0x0c || dataLength > 0xff) {
      return res.status(400).json({
        ok: false,
        reason: 'bad_data_length',
        detail: 'dataLength must be an integer between 12 and 255',
      });
    }

    const params = { state, forced, dataLength, sentTime: null, meterTypeCode };

    const cmd = queue.enqueue(address, {
      type: 'valve',
      params,
      build: (instructionNumber) => {
        params.sentTime = new Date().toISOString();
        return encodeValveOperation({ meterTypeCode, address }, { open, forced, dataLength }, instructionNumber);
      },
    });

    log.info?.(`command queued: valve #${cmd.id} for ${address} -> ${state}${forced ? ' (forced)' : ''}`);

    return res.status(202).json({
      ok: true,
      status: 'queued',
      command: queue.get(cmd.id),
      note: "delivered at the meter's next contact; confirm via the valve status in the following report",
    });
  });

  // Reading precision. The meter counts in whole units of its metering mode, so
  // at 1000 L a tap running for an hour can leave every usage field unchanged.
  router.post('/meters/:address/metering', (req, res) => {
    const { address } = req.params;
    if (!ADDRESS_RE.test(address)) {
      return res.status(400).json({ ok: false, reason: 'bad_address', detail: 'expected 14 decimal digits' });
    }

    // Required, like the valve state: there is no resolution that is right by
    // default, and getting it wrong makes the readings quietly useless.
    // Not coerced: object keys are strings, so "10" would otherwise be accepted
    // silently, and the rest of this API rejects the wrong type rather than
    // guessing what the caller meant.
    const resolutionLitres = req.body?.resolutionLitres;
    const meteringMode = typeof resolutionLitres === 'number' ? METERING_MODE_BYTES[resolutionLitres] : undefined;
    if (meteringMode === undefined) {
      return res.status(400).json({
        ok: false,
        reason: 'bad_resolution',
        detail: `resolutionLitres must be one of ${Object.keys(METERING_MODE_BYTES).join(', ')}`,
      });
    }

    // AA07 writes all three modes at once, so the two that are not being
    // changed have to be restated. Defaults match this meter as configured.
    const paymentModeName = req.body?.paymentMode ?? 'postpaid';
    const paymentMode = PAYMENT_MODE_BYTES[paymentModeName];
    if (paymentMode === undefined) {
      return res.status(400).json({
        ok: false,
        reason: 'bad_payment_mode',
        detail: `paymentMode must be one of ${Object.keys(PAYMENT_MODE_BYTES).join(', ')}`,
      });
    }

    const inPlaceModeName = req.body?.inPlaceMode ?? 'switch';
    const inPlaceMode = IN_PLACE_MODE_BYTES[inPlaceModeName];
    if (inPlaceMode === undefined) {
      return res.status(400).json({
        ok: false,
        reason: 'bad_in_place_mode',
        detail: `inPlaceMode must be one of ${Object.keys(IN_PLACE_MODE_BYTES).join(', ')}`,
      });
    }

    const meterTypeCode = req.body?.meterTypeCode ?? 0x10;
    const params = {
      resolutionLitres,
      paymentMode: paymentModeName,
      inPlaceMode: inPlaceModeName,
      sentTime: null,
      meterTypeCode,
    };

    const cmd = queue.enqueue(address, {
      type: 'set_meter_type',
      params,
      build: (instructionNumber) => {
        params.sentTime = new Date().toISOString();
        return encodeSetMeterType(
          { meterTypeCode, address },
          { meteringMode, paymentMode, inPlaceMode },
          instructionNumber,
        );
      },
    });

    log.info?.(
      `command queued: set_meter_type #${cmd.id} for ${address} -> ${resolutionLitres} L resolution` +
        ` (${paymentModeName}, ${inPlaceModeName})`,
    );

    return res.status(202).json({
      ok: true,
      status: 'queued',
      command: queue.get(cmd.id),
      note: "delivered at the meter's next contact; confirm via the table type code in the following report",
    });
  });

  // Read-only, and the only command in the protocol that is. Queued the same
  // way as the writes because the meter is asleep either way.
  router.post('/meters/:address/read', (req, res) => {
    const { address } = req.params;
    if (!ADDRESS_RE.test(address)) {
      return res.status(400).json({ ok: false, reason: 'bad_address', detail: 'expected 14 decimal digits' });
    }

    const meterTypeCode = req.body?.meterTypeCode ?? 0x10;
    const params = { identifier: 'A901', sentTime: null, meterTypeCode };

    const cmd = queue.enqueue(address, {
      type: 'read_parameters',
      params,
      build: (instructionNumber) => {
        params.sentTime = new Date().toISOString();
        return encodeReadParameters({ meterTypeCode, address }, instructionNumber);
      },
    });

    log.info?.(`command queued: read_parameters #${cmd.id} for ${address}`);

    return res.status(202).json({
      ok: true,
      status: 'queued',
      command: queue.get(cmd.id),
      note: "delivered at the meter's next contact; the parameter dump appears in the log",
    });
  });

  router.get('/commands/:id', (req, res) => {
    const cmd = queue.get(req.params.id);
    if (!cmd) return res.status(404).json({ ok: false, reason: 'not_found' });
    return res.json({ ok: true, command: cmd });
  });

  router.get('/commands', (req, res) => {
    res.json({ ok: true, commands: queue.list(req.query.address) });
  });

  return router;
}
