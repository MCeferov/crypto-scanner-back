import "./env";

import app from "./app";
import { logger } from "./lib/logger";
import { prisma } from "@workspace/prisma";
import { prewarmKlineCache } from "./services/klineBatchService.js";

/** API always listens on API_PORT (default 8080). Do not inherit frontend PORT (e.g. 23508). */
const rawPort = process.env.API_PORT ?? "8080";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid API_PORT value: "${rawPort}"`);
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
