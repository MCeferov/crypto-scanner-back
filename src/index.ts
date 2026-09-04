import "./env";

import app from "./app";
import { logger } from "./lib/logger";
import { prisma } from "./db/prisma";
import { shutdownMarketDataService } from "./market-data";
import { prewarmKlineCache } from "./services/klineBatchService.js";

/**
 * PORT is what every hosting platform injects (Railway, Render, Fly) and what
 * .env.example documents for local dev. Nothing else competes for it now that
 * the frontend lives in its own repo. API_PORT stays as a legacy override.
 */
const rawPort = process.env.PORT ?? process.env.API_PORT ?? "3000";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/* Fail fast on misconfiguration instead of 500-ing on the first login. */
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  logger.error("JWT_SECRET must be set and at least 32 characters");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  logger.error("DATABASE_URL is not set — auth routes will fail");
  process.exit(1);
}

const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");
  prewarmKlineCache();
});

/**
 * Slowloris budget. Node defaults to 60s for headers and 300s for a full
 * request, which is five minutes of a held socket per trickled byte stream.
 * These bound how long an *inbound* request may take to arrive; SSE responses
 * are unaffected, because the limit is on reading the request, not writing the
 * reply.
 */
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

server.on("error", (err) => {
  logger.error({ err }, "Server failed to start");
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  server.close(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      // Closes the Redis connection the market data cache may hold open.
      await shutdownMarketDataService();
    } catch {
      /* never started, or already torn down */
    }
    process.exit(0);
  });
  // Force-exit if connections (e.g. SSE streams) keep the server open.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  process.exit(1);
});
