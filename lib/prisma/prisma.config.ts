import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

/**
 * The db:* scripts run with this package as the CWD, so the Prisma CLI used to
 * pick up lib/prisma/.env and silently target a local Postgres instead of Neon.
 * Declaring a config file turns Prisma's automatic .env discovery off entirely,
 * which lets the repo root .env stay the single source of truth for
 * DATABASE_URL — the same file artifacts/api-server/src/env.ts loads.
 *
 * On Render/Vercel no .env exists and the platform's own environment wins;
 * dotenv never overwrites an already-set variable.
 */
const packageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageDir, "..", "..");

loadEnv({ path: path.join(repoRoot, ".env") });

export default defineConfig({
  schema: path.join(packageDir, "prisma", "schema.prisma"),
  migrations: {
    path: path.join(packageDir, "prisma", "migrations"),
  },
});
