import { createServer } from 'http';
import app from './app.js';
import { initializeWebSocket } from './websocket/index.js';
import { startScheduler } from './scheduler.js';
import prisma from './db.js';

const PORT = process.env.PORT || 3000;

const server = createServer(app);

// HTTP server timeouts
server.headersTimeout = 10_000;   // 10 seconds to receive headers
server.requestTimeout = 30_000;   // 30 seconds for full request
server.timeout = 120_000;         // 2 minutes overall socket timeout
server.keepAliveTimeout = 65_000; // slightly above common LB idle timeout (60s)

// Initialize WebSocket
const io = initializeWebSocket(server);

// Start the scheduled message processor
const schedulerHandle = startScheduler();

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
function shutdown() {
  console.log('Shutting down gracefully...');
  clearInterval(schedulerHandle);
  io.close();
  server.close(() => {
    prisma.$disconnect().then(() => process.exit(0));
  });
  // Force exit after 10 seconds
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
