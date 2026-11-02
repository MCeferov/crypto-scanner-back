import type { PrismaClient } from "@prisma/client";
import { prisma } from "../db/prisma";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { hashPassword, verifyPassword } from "../lib/password";
import { signToken } from "../lib/jwt";
import { codeMatches, generateCode, hashCode } from "../lib/otp";
import { sanitizeEmail, sanitizeUsername } from "../lib/sanitize";
import { DEFAULT_LOCALE } from "../i18n/index";
import type { Locale } from "../i18n/types";
import { getMailer, type Mailer } from "../mail/mailer";
import { renderVerificationEmail } from "../mail/templates";
import type {
  LoginInput,
  ResendVerificationInput,
  SignupInput,
  VerifyEmailInput,
} from "../validators/auth";

// Valid bcrypt hash of a random string — used only to equalize login timing.
const DUMMY_HASH = "$2b$12$CActsalRlkSGM5KE.xhVK.kyvF8YK.aGioYj1/haYHsUNi1qGn/3K";

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface VerificationNotice {
  email: string;
  verificationRequired: true;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export type AuthDb = Pick<PrismaClient, "user" | "emailVerification">;

export interface AuthServiceOptions {
  db: AuthDb;
  mailer: () => Mailer;
  now?: () => Date;
  otpTtlMinutes?: number;
  maxAttempts?: number;
  resendCooldownSeconds?: number;
}

function toPublicUser(user: {
  id: string;
  username: string;
  email: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function createAuthService(opts: AuthServiceOptions) {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const ttlMinutes = opts.otpTtlMinutes ?? positiveInt(process.env.OTP_TTL_MINUTES, 10);
  const maxAttempts = opts.maxAttempts ?? positiveInt(process.env.OTP_MAX_ATTEMPTS, 5);
  const cooldownSec = opts.resendCooldownSeconds ?? positiveInt(process.env.OTP_RESEND_COOLDOWN_SECONDS, 60);

  function notice(email: string): VerificationNotice {
    return {
      email,
      verificationRequired: true,
      expiresInSeconds: ttlMinutes * 60,
      resendAfterSeconds: cooldownSec,
    };
  }

  /** Seconds left before another code may be sent to this user, 0 if none. */
  async function cooldownLeft(userId: string): Promise<number> {
    const rec = await db.emailVerification.findUnique({ where: { userId } });
    if (!rec) return 0;
    const elapsed = (now().getTime() - rec.lastSentAt.getTime()) / 1000;
    return Math.max(0, Math.ceil(cooldownSec - elapsed));
  }

  /**
   * Replaces any earlier code, so only the newest one works, and emails it.
   * If delivery fails the record is removed again: otherwise the cooldown
   * would lock the user out of retrying a code that never arrived.
   */
  async function issueCode(user: { id: string; email: string }, locale: Locale): Promise<void> {
    const wait = await cooldownLeft(user.id);
    if (wait > 0) {
      throw new AppError(
        429,
        `Please wait ${wait}s before requesting another code`,
        "VERIFICATION_COOLDOWN",
        wait,
      );
    }

    const code = generateCode();
    const sentAt = now();
    const data = {
      codeHash: hashCode(user.id, code),
      expiresAt: new Date(sentAt.getTime() + ttlMinutes * 60_000),
      attempts: 0,
      lastSentAt: sentAt,
    };
    await db.emailVerification.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...data },
      update: data,
    });

    try {
      await opts.mailer().send({ to: user.email, ...renderVerificationEmail(locale, code, ttlMinutes) });
    } catch (err) {
      await db.emailVerification.deleteMany({ where: { userId: user.id } });
      if (err instanceof AppError) throw err;
      logger.error({ err, event: "verification_mail_failed" }, "Could not send verification email");
      throw new AppError(502, "Could not send the verification email. Try again.", "EMAIL_SEND_FAILED");
    }
  }

  /**
   * Sign Up: creates an UNVERIFIED account and emails a code. No token is
   * issued — the address is not proven to belong to the caller yet.
   *
   * An unverified account holds nothing, so it must not be able to squat an
   * address or a username: signing up again with the same email simply
   * overwrites the pending credentials, and a pending username can be taken.
   */
  async function signup(input: SignupInput): Promise<{ user: PublicUser; verification: VerificationNotice }> {
    const email = sanitizeEmail(input.email);
    const username = sanitizeUsername(input.username);
    const locale = input.locale ?? DEFAULT_LOCALE;

    const byEmail = await db.user.findUnique({ where: { email } });
    if (byEmail?.emailVerifiedAt) {
      throw new AppError(409, "Email is already registered", "EMAIL_EXISTS");
    }

    const byUsername = await db.user.findUnique({ where: { username } });
    if (byUsername && byUsername.id !== byEmail?.id) {
      if (byUsername.emailVerifiedAt) {
        throw new AppError(409, "Username is already taken", "USERNAME_EXISTS");
      }
      await db.user.delete({ where: { id: byUsername.id } });
    }

    const passwordHash = await hashPassword(input.password);

    let user;
    try {
      user = byEmail
        ? await db.user.update({ where: { id: byEmail.id }, data: { username, passwordHash } })
        : await db.user.create({ data: { email, username, passwordHash } });
    } catch (err) {
      // The checks above are not atomic; the unique constraint is the backstop.
      if (isUniqueViolation(err)) {
        throw new AppError(409, "Email or username is already registered", "ALREADY_EXISTS");
      }
      throw err;
    }

    await issueCode(user, locale);
    return { user: toPublicUser(user), verification: notice(user.email) };
  }

  /**
   * Confirms the emailed code and signs the user in.
   *
   * The attempt counter is incremented BEFORE the comparison and the new value
   * is what gets checked, so parallel guesses cannot all slip under the limit
   * by reading the same stale count.
   */
  async function verifyEmail(input: VerifyEmailInput): Promise<{ user: PublicUser; token: string }> {
    const email = sanitizeEmail(input.email);
    const invalid = () => new AppError(400, "Invalid or expired verification code", "INVALID_CODE");

    const user = await db.user.findUnique({ where: { email } });
    if (!user || user.emailVerifiedAt) throw invalid();

    const rec = await db.emailVerification.findUnique({ where: { userId: user.id } });
    if (!rec) throw invalid();

    if (rec.expiresAt.getTime() <= now().getTime()) {
      await db.emailVerification.deleteMany({ where: { userId: user.id } });
      throw new AppError(400, "Verification code expired. Request a new one.", "CODE_EXPIRED");
    }

    const bumped = await db.emailVerification.update({
      where: { userId: user.id },
      data: { attempts: { increment: 1 } },
    });
    if (bumped.attempts > maxAttempts) {
      await db.emailVerification.deleteMany({ where: { userId: user.id } });
      throw new AppError(429, "Too many wrong codes. Request a new one.", "TOO_MANY_ATTEMPTS");
    }

    if (!codeMatches(user.id, input.code, rec.codeHash)) throw invalid();

    const verified = await db.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: now() },
    });
    await db.emailVerification.deleteMany({ where: { userId: user.id } });

    const token = signToken({ userId: verified.id, email: verified.email, username: verified.username });
    return { user: toPublicUser(verified), token };
  }

  /**
   * Same 200 whether or not the address is registered, so this endpoint cannot
   * be used to probe for accounts. A genuinely pending account that asks too
   * soon does get a 429 with the wait time, which the UI needs for its timer.
   */
  async function resendVerification(input: ResendVerificationInput): Promise<VerificationNotice> {
    const email = sanitizeEmail(input.email);
    const user = await db.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt) {
      await issueCode(user, input.locale ?? DEFAULT_LOCALE);
    }
    return notice(email);
  }

  /** Sign In: find by email → bcrypt.compare → require verified email → JWT */
  async function login(input: LoginInput): Promise<{ user: PublicUser; token: string }> {
    const email = sanitizeEmail(input.email);

    const user = await db.user.findUnique({ where: { email } });
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

    if (!user.emailVerifiedAt) {
      // Correct password but unproven address: mail a fresh code (unless one
      // was sent moments ago) and tell the client to show the code screen.
      try {
        await issueCode(user, input.locale ?? DEFAULT_LOCALE);
      } catch (err) {
        if (!(err instanceof AppError && err.code === "VERIFICATION_COOLDOWN")) {
          logger.warn({ err, event: "login_resend_failed" }, "Could not resend verification code on login");
        }
      }
      throw new AppError(403, "Email is not verified. Enter the code we emailed you.", "EMAIL_NOT_VERIFIED");
    }

    const token = signToken({ userId: user.id, email: user.email, username: user.username });
    return { user: toPublicUser(user), token };
  }

  async function getUserById(userId: string): Promise<PublicUser | null> {
    const user = await db.user.findUnique({ where: { id: userId } });
    return user ? toPublicUser(user) : null;
  }

  return { signup, verifyEmail, resendVerification, login, getUserById };
}

const service = createAuthService({ db: prisma, mailer: getMailer });

export const signup = service.signup;
export const verifyEmail = service.verifyEmail;
export const resendVerification = service.resendVerification;
export const login = service.login;
export const getUserById = service.getUserById;
