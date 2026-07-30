/**
 * Creates (or resets) a test user directly in the database.
 *
 * Deliberately reuses the server's own auth building blocks — signupSchema,
 * sanitizeEmail/sanitizeUsername and hashPassword — so a seeded account is
 * byte-for-byte what POST /api/auth/signup would have produced and is
 * guaranteed to pass POST /api/auth/login. Hand-rolling the bcrypt call here
 * would let the cost factor drift away from lib/password.ts.
 *
 * Reads DATABASE_URL from the repo root .env, the same file the server uses.
 */
import "../env";

import { prisma } from "@workspace/prisma";
import { hashPassword } from "../lib/password";
import { sanitizeEmail, sanitizeUsername } from "../lib/sanitize";
import { formatZodError, signupSchema } from "../validators/auth";

// `pnpm run db:create-user -- a b c` forwards the literal "--" through the
// nested run, so it has to be dropped before positional args line up.
const [emailArg, passwordArg, usernameArg] = process.argv.slice(2).filter((arg) => arg !== "--");

const input = {
  email: emailArg ?? process.env.SEED_EMAIL ?? "admin@test.com",
  password: passwordArg ?? process.env.SEED_PASSWORD ?? "admin12345",
  username: usernameArg ?? process.env.SEED_USERNAME ?? "admin",
};

/** Hides the credentials in the connection string before logging it. */
function maskUrl(url: string): string {
  return url.replace(/:([^:@/]+)@/, ":****@");
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("FAIL: DATABASE_URL is not set in the repo root .env");
    process.exit(1);
  }

  // Same rules the signup endpoint enforces, so this can never produce an
  // account the app itself would have rejected.
  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) {
    console.error(`FAIL: ${formatZodError(parsed.error)}`);
    process.exit(1);
  }

  const email = sanitizeEmail(parsed.data.email);
  const username = sanitizeUsername(parsed.data.username);
  const passwordHash = await hashPassword(parsed.data.password);

  console.log("Target database:", maskUrl(dbUrl));

  const existing = await prisma.user.findUnique({ where: { email } });

  let user;
  try {
    user = await prisma.user.upsert({
      where: { email },
      update: { username, passwordHash },
      create: { email, username, passwordHash },
    });
  } catch (err) {
    // P2002 = unique constraint. The email is handled by the upsert, so this
    // can only be the username already belonging to a different account.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
      console.error(`FAIL: username "${username}" is already taken by another account`);
      process.exit(1);
    }
    throw err;
  }

  console.log(existing ? "UPDATED existing user (password reset)" : "CREATED new user");
  console.log({ id: user.id, username: user.username, email: user.email, createdAt: user.createdAt });
  console.log(`\nLog in with:  email="${user.email}"  password="${parsed.data.password}"`);
}

main()
  .catch((err) => {
    console.error("FAIL: could not create the user");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
