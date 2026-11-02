import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const OTP_LENGTH = 6;

/** Uniformly random numeric code from the OS CSPRNG, zero-padded. */
export function generateCode(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

function pepper(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be set and at least 32 characters");
  }
  return secret;
}

/**
 * Keyed hash, bound to the user. A six-digit code has only a million values, so
 * a plain hash would be reversible from a leaked table in milliseconds; keying
 * it with a server secret removes that, and binding it to the user id means a
 * hash lifted from one row is useless on another.
 */
export function hashCode(userId: string, code: string): string {
  return createHmac("sha256", pepper()).update(`${userId}:${code}`).digest("hex");
}

export function codeMatches(userId: string, code: string, storedHash: string): boolean {
  const a = Buffer.from(hashCode(userId, code), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
