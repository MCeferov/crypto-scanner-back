import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger.js";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix?: string;
  /**
   * Ceiling shared by every caller of this limiter, checked in addition to the
   * per-client budget. req.ip comes from X-Forwarded-For, which the client can
   * rewrite on every request, so the per-client limit alone can be sidestepped
   * by rotating the header. This is the backstop that cannot be — set it well
   * above real traffic so it only ever trips during abuse.
   */
  globalMax?: number;
  message?: string;
  /** Exempt a request entirely — used to keep platform health checks free. */
  skip?: (req: Request) => boolean;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Bucket store is bounded. Keys derive from a spoofable header, so an
 * unbounded map is itself a memory-exhaustion vector: one request per forged
 * IP mints one permanent entry for the length of the window.
 */
const MAX_BUCKETS = 20_000;
const buckets = new Map<string, Bucket>();

function evict(now: number): void {
  if (buckets.size <= MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
    if (buckets.size <= MAX_BUCKETS) return;
  }
  // Everything is still live — drop the oldest insertions (Map keeps order).
  while (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

function consume(key: string, windowMs: number, now: number): Bucket {
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket;
}

/** Authenticated callers are tracked by user id, which no header can forge. */
function clientKey(req: Request): string {
  const userId = req.user?.userId;
  if (userId) return `u:${userId}`;
  return `ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
}

/** Read a positive integer from the environment, falling back to the default. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, keyPrefix = "rl", globalMax, message, skip } = opts;
  const body = { message: message ?? "Too many requests. Try again later." };

  return (req: Request, res: Response, next: NextFunction): void => {
    if (skip?.(req)) {
      next();
      return;
    }
    const now = Date.now();
    // Keyed on the limiter's prefix, not req.path: /auth/login and its
    // /auth/sign-in alias are the same operation and must share one budget,
    // otherwise the alias simply hands out a second allowance.
    const bucket = consume(`${keyPrefix}:${clientKey(req)}`, windowMs, now);
    evict(now);

    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - bucket.count)));

    const reject = (resetAt: number, scope: "client" | "global") => {
      const retrySec = Math.max(1, Math.ceil((resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retrySec));
      logger.warn(
        {
          event: "rate_limit_exceeded",
          scope,
          keyPrefix,
          path: req.path,
          ip: req.ip,
          // Hop count, not the addresses. Tells you whether TRUST_PROXY matches
          // reality: if this is consistently larger than TRUST_PROXY, callers
          // are supplying their own X-Forwarded-For entries and the per-client
          // key above is forgeable. See README "Verifying trust proxy".
          hops: req.ips.length,
        },
        "Rate limit exceeded",
      );
      res.status(429).json(body);
    };

    if (bucket.count > max) {
      reject(bucket.resetAt, "client");
      return;
    }

    if (globalMax !== undefined) {
      const shared = consume(`${keyPrefix}:*all*`, windowMs, now);
      if (shared.count > globalMax) {
        reject(shared.resetAt, "global");
        return;
      }
    }

    next();
  };
}

/** Periodik təmizlik — memory leak olmasın */
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}, 60_000).unref?.();

export function getRateLimitStats(): { buckets: number; maxBuckets: number } {
  return { buckets: buckets.size, maxBuckets: MAX_BUCKETS };
}
