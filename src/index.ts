import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Load lib/prisma/.env for local development (DATABASE_URL, JWT_SECRET, etc.) */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: path.join(repoRoot, "lib/prisma/.env") });

import app from "./app";
import { logger } from "./lib/logger";
import { prewarmKlineCache } from "./services/klineBatchService.js";

/** API always listens on API_PORT (default 8080). Do not inherit frontend PORT (e.g. 23508). */
const rawPort = process.env.API_PORT ?? "8080";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  prewarmKlineCache();
});
