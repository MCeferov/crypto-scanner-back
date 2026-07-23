import type { Request, Response, NextFunction } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Sadə in-memory rate limit — auth brute-force üçün */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  keyPrefix?: string;
}) {
  const { windowMs, max, keyPrefix = "rl" } = opts;

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - bucket.count)));

    if (bucket.count > max) {
      const retrySec = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retrySec));
      res.status(429).json({ message: "Too many requests. Try again later." });
      return;
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
