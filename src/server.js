import net from 'node:net';
import http from 'node:http';
import { createApp } from './app.js';
import { openStore } from './store/memory.js';
import { createCommandQueue } from './commands.js';
import { createMeterConnectionHandler } from './tcp.js';
import { createConfigurer, configureOptionsFromEnv } from './configure.js';
import { createPartnerForwarder } from './partner.js';
import { timestampedLog } from './lib/log.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

// Set API_TOKEN to require an x-api-token header on the command routes. These
// write to physical hardware, so leaving them open is a deliberate choice.
const API_TOKEN = process.env.API_TOKEN ?? null;

// Bring every meter that reports in to the configured clock and resolution,
// one command per contact. CONFIGURE=0 turns it off and leaves the server a
// pure collector that only sends what the API queued.
const { enabled: configureEnabled, ...configureOptions } = configureOptionsFromEnv();
const configurer = configureEnabled ? createConfigurer(configureOptions) : null;

// Everything printed is stamped with the instant it was printed. The store is
// in memory and the database is not wired up yet, so this log is the record of
// what the fleet has done -- and a record of readings with no arrival time in
// it can only be half-loaded into a database later. See src/lib/log.js.
const log = timestampedLog(console);

// Mock store: everything lives in memory and is lost on restart.
const store = openStore();
const commands = createCommandQueue();
// Copies every reading on to the partner's ingest server, fire and forget.
// The switch is PARTNER_FORWARDING in src/partner.js -- deliberately code, not
// environment, so what we send to a third party is visible in the diff.
const partner = createPartnerForwarder(log);

const app = createApp(store, log, { commands, apiToken: API_TOKEN, configurer, partner });
const httpServer = http.createServer(app);
const handleMeterConnection = createMeterConnectionHandler(store, log, { commands, configurer, partner });

// Meters cannot be pointed at a second port -- they are provisioned with one
// address and push raw frames down it. Rather than split raw TCP and HTTP across
// two ports (and need another firewall rule), the first byte decides.
//
// The test is "does this look like HTTP", not "does this look like a frame".
// Testing for 68H would misroute this device: it sends a 6-byte preamble
// starting A3H before its first frame, so the connection's opening byte is not
// 68H at all. Every HTTP method token starts with an uppercase ASCII letter,
// which no meter frame (68H) or preamble byte seen so far does.
const isHttpStart = (byte) => byte >= 0x41 && byte <= 0x5a;

// A peer that connects and then says nothing would hold a socket open forever.
const SNIFF_TIMEOUT_MS = 30_000;

const server = net.createServer((socket) => {
  socket.setTimeout(SNIFF_TIMEOUT_MS);
  socket.once('timeout', () => socket.destroy());

  const onReadable = () => {
    // Read the whole first chunk, not one byte: unshifting a single byte splits
    // it away from its neighbours and the collector then logs one message as two.
    const first = socket.read();
    if (first === null) {
      // 'readable' also fires at EOF, where read() yields nothing.
      if (socket.readableEnded) socket.destroy();
      return;
    }
    socket.removeListener('readable', onReadable);
    socket.setTimeout(0);
    socket.unshift(first); // hand the byte back before delegating

    if (isHttpStart(first[0])) httpServer.emit('connection', socket);
    else handleMeterConnection(socket);
  };

  socket.on('readable', onReadable);
});

server.listen(PORT, HOST, () => {
  // Stamped, unlike the static lines under it: this is the marker that says
  // when the process came up, which brackets every restart in the log.
  log.info(`ingest server listening on ${HOST}:${PORT}  (raw TCP + HTTP share this port)`);
  console.log('  raw TCP   CAT-1 meters pushing frames straight down the socket');
  console.log('  POST /api/v1/meters/:address/time queue a clock calibration');
  console.log('  GET  /api/v1/commands             queued / sent / acknowledged commands');
  console.log('  GET  /debug/store                 everything ingested so far');
  console.log(`command API auth: ${API_TOKEN ? 'x-api-token required' : 'OPEN (set API_TOKEN to require a token)'}`);
  console.log(
    configurer
      ? `auto-configure: ON -- ` +
          `${configurer.config.reportingIntervalMinutes > 0 ? `report every ${configurer.config.reportingIntervalMinutes} min, ` : 'interval rung OFF, '}` +
          `clock to ${configurer.config.timeZone}, resolution to ` +
          `${configurer.config.resolutionLitres} L, one command per contact, ` +
          `${configurer.config.maxAttempts} attempts each` +
          `${configurer.config.allowClosedValve ? '  (WILL write AA07/AA06 to closed valves; AA07 opens them)' : ''}`
      : 'auto-configure: OFF (CONFIGURE=0)',
  );
  console.log(
    partner.enabled
      ? `partner forwarding: ON -- every reading copied to ${partner.stats().endpoint} (fire and forget)`
      : 'partner forwarding: OFF (PARTNER_FORWARDING in src/partner.js)',
  );
  console.log('storage is in-memory only -- nothing is persisted');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
