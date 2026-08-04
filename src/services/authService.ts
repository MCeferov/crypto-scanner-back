import { prisma } from "../db/prisma";
import { AppError } from "../lib/errors";
import { hashPassword, verifyPassword } from "../lib/password";
import { signToken } from "../lib/jwt";
import { sanitizeEmail, sanitizeUsername } from "../lib/sanitize";
import type { LoginInput, SignupInput } from "../validators/auth";

// Valid bcrypt hash of a random string — used only to equalize login timing.
const DUMMY_HASH = "$2b$12$CActsalRlkSGM5KE.xhVK.kyvF8YK.aGioYj1/haYHsUNi1qGn/3K";

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

function toPublicUser(user: {
  id: string;
  username: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/** Sign Up: email unique check → bcrypt hash → save to users.password_hash */
export async function signup(input: SignupInput): Promise<{ user: PublicUser; token: string }> {
  const email = sanitizeEmail(input.email);
  const username = sanitizeUsername(input.username);

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
  });

  if (existing) {
    if (existing.email === email) {
      throw new AppError(409, "Email is already registered", "EMAIL_EXISTS");
    }
    throw new AppError(409, "Username is already taken", "USERNAME_EXISTS");
  }

  const passwordHash = await hashPassword(input.password);

  let user;
  try {
    user = await prisma.user.create({
      data: { email, username, passwordHash },
    });
  } catch (err) {
    // Concurrent duplicate signup: the findFirst check above is not atomic,
    // so the unique constraint can still fire (Prisma P2002).
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
      throw new AppError(409, "Email or username is already registered", "ALREADY_EXISTS");
    }
    throw err;
  }

  const token = signToken({ userId: user.id, email: user.email, username: user.username });

  return { user: toPublicUser(user), token };
}

/** Sign In: find by email → bcrypt.compare → return user + JWT */
export async function login(input: LoginInput): Promise<{ user: PublicUser; token: string }> {
  const email = sanitizeEmail(input.email);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Burn the same bcrypt cost as a real check so response timing
    // doesn't reveal whether the email is registered.
    await verifyPassword(input.password, DUMMY_HASH);
    throw new AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
    throw new AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
  }

  const token = signToken({ userId: user.id, email: user.email, username: user.username });

  return { user: toPublicUser(user), token };
}

export async function getUserById(userId: string): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user ? toPublicUser(user) : null;
}
