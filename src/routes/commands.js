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
  encodeValveOperation,
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

    const meterTypeCode = req.body?.meterTypeCode ?? 0x10;
    // Held by reference so the resolved value shows up in the command's status.
    const params = {
      mode: explicit ? 'explicit' : 'now_at_delivery',
      method,
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
        return encode({ meterTypeCode, address }, at, instructionNumber);
      },
    });

    log.info?.(
      `command queued: set_clock #${cmd.id} for ${address} -> ${explicit ? explicit.toISOString() : 'now, resolved at delivery'}`,
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
    const params = { state, forced, sentTime: null, meterTypeCode };

    const cmd = queue.enqueue(address, {
      type: 'valve',
      params,
      build: (instructionNumber) => {
        params.sentTime = new Date().toISOString();
        return encodeValveOperation({ meterTypeCode, address }, { open, forced }, instructionNumber);
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
