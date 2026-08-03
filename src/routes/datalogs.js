// POST /api/v1/datalogs/:deviceId
//
// Contract from api.txt: 200 with an empty body means "saved, clear your
// queue"; 400 means "bad frame, retry". A server-side fault must therefore NOT
// answer 400 -- it answers 500 so the device keeps its buffer and retries.

import express, { Router } from 'express';
import {
  parseDatalog,
  DatalogError,
  isValidDeviceId,
  RECORD_BYTES,
  MAX_RECORDS,
} from '../lib/datalog.js';
import { formatDatalog } from '../lib/format.js';

const MAX_BODY = 1 + MAX_RECORDS * RECORD_BYTES; // 2001 bytes

export function datalogRouter(store, log = console) {
  const router = Router();

  // Every byte is payload: no JSON or urlencoded parser may touch this route.
  const readBody = express.raw({ type: () => true, limit: MAX_BODY });

  router.post(
    '/datalogs/:deviceId',
    (req, res, next) =>
      readBody(req, res, (err) => {
        // An oversized or unreadable body is a bad frame, not a server fault.
        if (err) return res.status(400).end();
        next();
      }),
    (req, res) => {
      const { deviceId } = req.params;

      if (!isValidDeviceId(deviceId)) {
        log.warn?.(`datalogs: rejected device id ${JSON.stringify(deviceId)}`);
        return res.status(400).end();
      }

      let parsed;
      try {
        parsed = parseDatalog(req.body);
      } catch (err) {
        if (!(err instanceof DatalogError)) throw err;
        log.warn?.(`datalogs: ${deviceId} bad frame (${err.code}): ${err.message}`);
        store.recordFailure('datalogs', `${err.code}: ${err.message}`, req.body?.toString('hex'));
        return res.status(400).end();
      }

      const { inserted, duplicates } = store.saveDatalog(deviceId, parsed.records);
      log.info?.(formatDatalog(deviceId, parsed.records, { inserted, duplicates }));
      return res.status(200).end();
    },
  );

  return router;
}
