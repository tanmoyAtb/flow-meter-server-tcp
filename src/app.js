import express from 'express';
import { commandRouter } from './routes/commands.js';

export function createApp(store, log = console, { commands = null, apiToken = null, configurer = null } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

  if (commands) app.use('/api/v1', commandRouter(commands, log, { token: apiToken }));

  // Inspection for the mock store: without a database there is nowhere else to
  // look at what was ingested. Unauthenticated -- remove this before the server
  // is fronted by a real store or exposed to anything but a test network.
  // What the policy is set to and which meters it has given up on. The attempt
  // counts are the interesting half: a meter listed at the attempt cap is one
  // that has been commanded repeatedly and has not complied.
  app.get('/api/v1/configure', (req, res) => {
    if (!configurer) return res.json({ ok: true, enabled: false });
    res.json({ ok: true, enabled: true, config: configurer.config, attempts: configurer.state() });
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
    // A server fault is never a 400: a 4xx tells a client its request was bad
    // and not to repeat it, which would lose data over a bug on our side.
    res.status(500).end();
  });

  return app;
}
