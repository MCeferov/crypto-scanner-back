import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads lib/prisma/.env before any other module reads process.env.
 * This file must be the FIRST import of the entrypoint — ESM hoists static
 * imports, so a plain config() call in index.ts runs after imported modules
 * (Prisma client, CORS config, logger) have already read their env vars.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: path.join(repoRoot, "lib/prisma/.env") });
