import net from 'node:net';
import http from 'node:http';
import { createApp } from './app.js';
import { openStore } from './store/memory.js';
import { createCommandQueue } from './commands.js';
import { createMeterConnectionHandler } from './tcp.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

// Set API_TOKEN to require an x-api-token header on the command routes. These
// write to physical hardware, so leaving them open is a deliberate choice.
const API_TOKEN = process.env.API_TOKEN ?? null;

// Mock store: everything lives in memory and is lost on restart.
const store = openStore();
const commands = createCommandQueue();
const app = createApp(store, console, { commands, apiToken: API_TOKEN });
const httpServer = http.createServer(app);
const handleMeterConnection = createMeterConnectionHandler(store, console, { commands });

// Meters cannot be pointed at a second port -- they are provisioned with one
// address and push raw CJ/T 188 down it. Rather than split the protocols across
// two ports (and need another firewall rule), the first byte decides.
//
// The test is "does this look like HTTP", not "does this look like a frame".
// Testing for 68H would misroute this device: it sends a 6-byte preamble
// starting A3H before its first frame, so the connection's opening byte is not
// 68H at all. Every HTTP method token starts with an uppercase ASCII letter,
// which no CJ/T 188 frame (68H) or preamble byte seen so far does.
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
  console.log(`ingest server listening on ${HOST}:${PORT}  (raw TCP + HTTP share this port)`);
  console.log('  raw TCP   meters pushing frames straight down the socket: CAT-1 and CJ/T 188');
  console.log('  POST /api/v1/datalogs/:deviceId   binary datalogger frames');
  console.log('  POST /api/v1/coap_push            CJ/T 188 frames relayed by an IoT platform');
  console.log('  POST /api/v1/meters/:address/time queue a clock calibration');
  console.log('  GET  /api/v1/commands             queued / sent / acknowledged commands');
  console.log('  GET  /debug/store                 everything ingested so far');
  console.log(`command API auth: ${API_TOKEN ? 'x-api-token required' : 'OPEN (set API_TOKEN to require a token)'}`);
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
