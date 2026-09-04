import { logger } from "../lib/logger.js";
import { envInt } from "./rateLimit.js";

/**
 * Per-account login throttling.
 *
 * IP-based limits are only as trustworthy as the proxy headers they are keyed
 * on, and X-Forwarded-For is written by the client. The account identifier in
 * the request body is not: it is the very thing the attacker is trying to break
 * into, so it cannot be rotated away. This is what actually stops a targeted
 * brute-force or credential-stuffing run.
 *
 * Failures are recorded for accounts that do not exist as well. A lockout that
 * only ever triggered for real accounts would answer "does this email exist?"
 * just as loudly as a distinct error message would.
 */

interface Attempts {
  failures: number;
  lockedUntil: number;
  /** Last touch, used to expire idle records. */
  seenAt: number;
}

const FREE_ATTEMPTS = envInt("AUTH_FREE_ATTEMPTS", 5);
const BASE_LOCK_MS = envInt("AUTH_LOCK_BASE_SECONDS", 30) * 1000;
const MAX_LOCK_MS = envInt("AUTH_LOCK_MAX_SECONDS", 900) * 1000;
/** Forget an account's history once it has been quiet for this long. */
const IDLE_MS = Math.max(MAX_LOCK_MS * 2, 3_600_000);
const MAX_TRACKED = 20_000;

const attempts = new Map<string, Attempts>();

function evict(now: number): void {
  for (const [key, entry] of attempts) {
    if (now - entry.seenAt > IDLE_MS && now >= entry.lockedUntil) attempts.delete(key);
  }
  while (attempts.size > MAX_TRACKED) {
    const oldest = attempts.keys().next().value;
    if (oldest === undefined) break;
    attempts.delete(oldest);
  }
}

export interface LockState {
  locked: boolean;
  retryAfterSec: number;
}

export function checkAccountLock(accountId: string): LockState {
  const entry = attempts.get(accountId);
  if (!entry) return { locked: false, retryAfterSec: 0 };
  const now = Date.now();
  if (now >= entry.lockedUntil) return { locked: false, retryAfterSec: 0 };
  return { locked: true, retryAfterSec: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000)) };
}

export function recordAuthFailure(accountId: string): void {
  const now = Date.now();
  const entry = attempts.get(accountId) ?? { failures: 0, lockedUntil: 0, seenAt: now };
  entry.failures += 1;
  entry.seenAt = now;

  if (entry.failures > FREE_ATTEMPTS) {
    const overage = entry.failures - FREE_ATTEMPTS - 1;
    const lockMs = Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** overage);
    entry.lockedUntil = now + lockMs;
    logger.warn(
      { event: "auth_account_locked", failures: entry.failures, lockSeconds: Math.round(lockMs / 1000) },
      "Account temporarily locked after repeated failed logins",
    );
  }

  attempts.set(accountId, entry);
  evict(now);
}

export function recordAuthSuccess(accountId: string): void {
  attempts.delete(accountId);
}

export function getBruteForceStats(): { tracked: number; locked: number } {
  const now = Date.now();
  let locked = 0;
  for (const entry of attempts.values()) if (now < entry.lockedUntil) locked++;
  return { tracked: attempts.size, locked };
}
