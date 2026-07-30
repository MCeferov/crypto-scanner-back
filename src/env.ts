import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads the repo root .env before any other module reads process.env.
 * This file must be the FIRST import of the entrypoint — ESM hoists static
 * imports, so a plain config() call in index.ts runs after imported modules
 * (Prisma client, CORS config, logger) have already read their env vars.
 *
 * The root .env is the only env file in the repo; lib/prisma/prisma.config.ts
 * loads the same one so the CLI and the server can never disagree about
 * DATABASE_URL. dotenv does not overwrite variables the platform already set,
 * so Render/Vercel environments keep winning in production.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: path.join(repoRoot, ".env") });
