import { PrismaClient } from "@prisma/client";
import { logger } from "../lib/logger";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Serverless Postgres (Neon, Supabase poolers) drops idle or recycled
 * connections, and Prisma surfaces that as P1017 "Server has closed the
 * connection" on whichever query happened to pick the dead one. The server
 * never ran the statement, so repeating it on a fresh connection is safe.
 */
const TRANSIENT_CODES = new Set(["P1017", "P1001", "P1002"]);
const MAX_RETRIES = 3;

function createClient(): PrismaClient {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

  const extended = base.$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        for (let attempt = 0; ; attempt++) {
          try {
            return await query(args);
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (attempt >= MAX_RETRIES || !code || !TRANSIENT_CODES.has(code)) throw err;
            logger.warn(
              { event: "db_transient_retry", code, attempt: attempt + 1, model, operation },
              "Transient database connection error, retrying",
            );
            await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
          }
        }
      },
    },
  });

  // The extension only wraps behaviour; the surface is identical, and the rest
  // of the code (and AuthDb) is typed against plain PrismaClient.
  return extended as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type { User } from "@prisma/client";
