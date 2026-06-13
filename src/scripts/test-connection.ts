import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const dir = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(dir, "../.env") });

const prisma = new PrismaClient();

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("FAIL: DATABASE_URL is not set in lib/prisma/.env");
    process.exit(1);
  }

  if (url.includes("YOUR_PASSWORD")) {
    console.error("FAIL: Replace YOUR_PASSWORD in lib/prisma/.env with your real PostgreSQL password");
    process.exit(1);
  }

  console.log("Connecting to:", url.replace(/:([^:@]+)@/, ":****@"));

  await prisma.$connect();
  const result = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
  const count = await prisma.user.count();

  console.log("SUCCESS: Database connection established");
  console.log("Ping result:", result[0]?.ok === 1 ? "OK" : result);
  console.log("Users in database:", count);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("FAIL: Could not connect to database");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
