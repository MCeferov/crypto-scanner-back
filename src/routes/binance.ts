import { Router, type IRouter } from "express";

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

const MAX_CACHE_ENTRIES = 500;
const UPSTREAM_TIMEOUT_MS = 10_000;

const cache = new Map<string, { at: number; status: number; body: string; contentType: string | null }>();

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

router.get(/.*/, async (req, res) => {
  const subPath = req.path.replace(/^\//, "");
  if (!ALLOWED_PATHS.has(subPath)) {
    res.status(404).json({ error: "Unknown Binance endpoint" });
    return;
  }

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === "string") qs.set(key, value);
  }
  const qsStr = qs.toString();
  const url = `${BINANCE_BASE}/${subPath}${qsStr ? `?${qsStr}` : ""}`;
  const cacheKey = url;
  const ttl = cacheTtl(subPath);

  if (ttl > 0) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttl) {
      res.status(hit.status);
      if (hit.contentType) res.setHeader("Content-Type", hit.contentType);
      res.send(hit.body);
      return;
    }
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    const body = await response.text();
    const contentType = response.headers.get("content-type");
    if (ttl > 0 && response.ok) {
      cache.set(cacheKey, { at: Date.now(), status: response.status, body, contentType });
      pruneCache();
    }
    res.status(response.status);
    if (contentType) res.setHeader("Content-Type", contentType);
    res.send(body);
  } catch {
    res.status(502).json({ error: "Binance proxy unreachable" });
  }
});

export default router;
