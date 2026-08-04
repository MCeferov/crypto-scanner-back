import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

/**
 * Declaring a config file turns Prisma's automatic .env discovery off entirely,
 * which keeps the repo root .env as the single source of truth for
 * DATABASE_URL — the same file src/env.ts loads for the server.
 *
 * On Railway no .env exists and the platform's own environment wins; dotenv
 * never overwrites an already-set variable.
 */
const repoRoot = path.dirname(fileURLToPath(import.meta.url));

loadEnv({ path: path.join(repoRoot, ".env") });

export default defineConfig({
  schema: path.join(repoRoot, "prisma", "schema.prisma"),
  migrations: {
    path: path.join(repoRoot, "prisma", "migrations"),
  },
});
