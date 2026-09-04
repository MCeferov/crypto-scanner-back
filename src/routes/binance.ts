import { Router, type IRouter } from "express";
import { envInt, rateLimit } from "../middleware/rateLimit.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();
const BINANCE_BASE = process.env.BINANCE_API_BASE ?? "https://api.binance.com/api/v3";

/** Only the endpoints the frontend actually uses — this is not an open relay. */
const ALLOWED_PATHS = new Set([
  "ticker/24hr",
  "ticker/price",
  "klines",
  "exchangeInfo",
  "ping",
  "time",
]);

/**
 * Parameters are allowlisted by name *and* checked by value. Forwarding the
 * query string wholesale turns this route into a way to compose arbitrary calls
 * against Binance from our IP — and it is our IP that gets banned for it.
 */
const PARAM_RULES: Record<string, RegExp> = {
  symbol: /^[A-Z0-9]{1,20}$/,
  // Binance takes this as a JSON array literal, e.g. ["BTCUSDT","ETHUSDT"].
  symbols: /^\[(?:"[A-Z0-9]{1,20}"(?:,"[A-Z0-9]{1,20}")*)?\]$/,
  interval: /^(1s|[13]m|5m|15m|30m|[12468]h|12h|[13]d|1w|1M)$/,
  limit: /^[0-9]{1,4}$/,
  startTime: /^[0-9]{1,13}$/,
  endTime: /^[0-9]{1,13}$/,
  timeZone: /^[-+]?[0-9]{1,2}(:[0-9]{2})?$/,
};

/** Binance's own ceiling; asking for more just wastes an upstream call. */
const MAX_KLINE_LIMIT = 1000;

const MAX_CACHE_ENTRIES = 500;
const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * The proxy spends our upstream quota on behalf of anonymous callers, so it
 * carries its own budget. Without one, a single client can walk the service
 * into a Binance IP ban that takes down the crypto table for everybody.
 */
const proxyLimiter = rateLimit({
  windowMs: envInt("BINANCE_PROXY_WINDOW_SECONDS", 60) * 1000,
  max: envInt("BINANCE_PROXY_MAX", 60),
  globalMax: envInt("BINANCE_PROXY_GLOBAL_MAX", 1200),
  keyPrefix: "market:binance-proxy",
});

const cache = new Map<string, { at: number; status: number; body: string }>();

function cacheTtl(path: string): number {
  if (path === "ticker/24hr") return 30_000;
  if (path === "klines") return 12_000;
  return 0;
}

/** Evict expired entries; if still over cap, drop oldest (Map preserves insertion order). */
function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at > 60_000) cache.delete(key);
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

router.get(/.*/, proxyLimiter, async (req, res) => {
  const subPath = req.path.replace(/^\//, "");
  if (!ALLOWED_PATHS.has(subPath)) {
    res.status(404).json({ error: "Unknown Binance endpoint" });
    return;
  }

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    const rule = PARAM_RULES[key];
    // Unknown or malformed parameters are dropped rather than rejected: the
    // upstream contract is ours to define here, and a stray parameter from a
    // future frontend build should not turn into a 400 for the user.
    if (!rule || typeof value !== "string" || !rule.test(value)) continue;
    if (key === "limit") {
      const limit = Math.min(MAX_KLINE_LIMIT, Math.max(1, Number(value)));
      qs.set(key, String(limit));
      continue;
    }
    qs.set(key, value);
  }

  const qsStr = qs.toString();
  const url = `${BINANCE_BASE}/${subPath}${qsStr ? `?${qsStr}` : ""}`;
  const cacheKey = url;
  const ttl = cacheTtl(subPath);

  if (ttl > 0) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttl) {
      res.status(hit.status).type("application/json").send(hit.body);
      return;
    }
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    const body = await response.text();

    if (!response.ok) {
      // Upstream error bodies carry Binance's own codes and messages, plus a
      // 451/418 tells a prober exactly how our egress is placed and banned.
      logger.warn(
        { event: "binance_proxy_upstream_error", status: response.status, path: subPath },
        "Binance proxy upstream returned an error",
      );
      res.status(502).json({ error: "Upstream market data unavailable" });
      return;
    }

    if (ttl > 0) {
      cache.set(cacheKey, { at: Date.now(), status: response.status, body });
      pruneCache();
    }
    // Content type is asserted, not echoed: whatever the upstream claims, this
    // route only ever serves the JSON payloads on the allowlist.
    res.status(response.status).type("application/json").send(body);
  } catch (err) {
    logger.error({ err, event: "binance_proxy_failed", path: subPath }, "Binance proxy request failed");
    res.status(502).json({ error: "Binance proxy unreachable" });
  }
});

export default router;
