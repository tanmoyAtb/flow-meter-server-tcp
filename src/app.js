import express from 'express';
import { datalogRouter } from './routes/datalogs.js';
import { coapRouter } from './routes/coap.js';
import { commandRouter } from './routes/commands.js';

export function createApp(store, log = console, { commands = null, apiToken = null, reconciler = null } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.use('/api/v1', datalogRouter(store, log));
  app.use('/api/v1', coapRouter(store, log));
  if (commands) app.use('/api/v1', commandRouter(commands, log, { token: apiToken }));

  // Inspection for the mock store: without a database there is nowhere else to
  // look at what was ingested. Unauthenticated -- remove this before the server
  // is fronted by a real store or exposed to anything but a test network.
  // What the policy is set to and which meters it has given up on. The attempt
  // counts are the interesting half: a meter listed at the attempt cap is one
  // that has been commanded repeatedly and has not complied.
  app.get('/api/v1/reconcile', (req, res) => {
    if (!reconciler) return res.json({ ok: true, enabled: false });
    res.json({ ok: true, enabled: true, config: reconciler.config, attempts: reconciler.state() });
  });

  app.get('/debug/store', (req, res) => res.json(store.snapshot()));
  app.delete('/debug/store', (req, res) => {
    store.reset();
    res.json({ ok: true, reset: true });
  });

  app.use((req, res) => res.status(404).json({ ok: false, reason: 'not_found' }));

  // Express 5 forwards async errors here automatically.
  app.use((err, req, res, next) => {
    log.error?.(`unhandled error on ${req.method} ${req.originalUrl}:`, err);
    if (res.headersSent) return next(err);
    // /coap_push must never hand a platform a non-200, even on a server fault.
    if (req.path === '/api/v1/coap_push') {
      return res.status(200).json({ ok: false, reason: 'server_error' });
    }
    // Datalogger: 500 (not 400) so the device keeps its buffer and retries.
    res.status(500).end();
  });

  return app;
}
