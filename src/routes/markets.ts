import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import type { AssetClass } from "../market-data";
import { getMarketDataService } from "../market/bootstrap.js";
import { envInt, rateLimit } from "../middleware/rateLimit.js";
import { logger } from "../lib/logger.js";
import {
  batchFetchKlinesForAssets,
  fetchSingleAssetKlines,
  getKlineCacheStats,
  type KlineAsset,
  type KlineAssetType,
} from "../services/klineBatchService.js";

const router: IRouter = Router();

/**
 * Every market endpoint fans one inbound request out to an upstream we do not
 * pay for (Binance, Yahoo). The cost of a request is therefore not the CPU it
 * burns here but the quota it spends there, and the worst outcome is not a slow
 * response but an upstream ban that takes the service down for everyone.
 *
 * Hence two tiers: a broad one for cheap cached quote lookups, and a tight one
 * for the kline endpoints, where a single call can expand into hundreds of
 * upstream fetches. globalMax caps the total damage even when the per-client
 * key — an IP, and so ultimately a client-controlled header — is being rotated.
 */
const quoteLimiter = rateLimit({
  windowMs: envInt("MARKET_RATE_WINDOW_SECONDS", 60) * 1000,
  max: envInt("MARKET_RATE_MAX", 120),
  keyPrefix: "market:quotes",
});

const klineLimiter = rateLimit({
  windowMs: envInt("KLINE_RATE_WINDOW_SECONDS", 60) * 1000,
  // Headroom for a real session: opening a chart and stepping through all
  // seven timeframes on a handful of assets is a normal thing to do, and most
  // of those calls are served from the kline cache anyway.
  max: envInt("KLINE_RATE_MAX", 60),
  globalMax: envInt("KLINE_RATE_GLOBAL_MAX", 600),
  keyPrefix: "market:klines",
});

/** Upper bound on how many instruments one quote request may ask for. */
const MAX_REQUESTED_SYMBOLS = envInt("MARKET_MAX_SYMBOLS", 50);
/** Concurrent SSE streams a single client may hold open. */
const MAX_STREAMS_PER_CLIENT = envInt("MARKET_MAX_STREAMS", 3);

/** Instrument tickers: letters, digits, dot and dash only (BRK.B, BTCUSDT). */
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,19}$/;

const VALID_TYPES = new Set<KlineAssetType>(["crypto", "stock", "forex", "commodity"]);
const VALID_INTERVALS = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "3d", "1w"]);

/**
 * Symbols reach upstream URLs and cache keys, so they are filtered to a strict
 * character set rather than merely trimmed, and the list is capped: an
 * unbounded ?symbols= lets one request trigger one upstream fetch per entry,
 * which is a request amplifier aimed at our own upstream quota.
 */
function parseSymbols(query: string | undefined): string[] | undefined {
  if (!query) return undefined;
  const seen = new Set<string>();
  for (const raw of query.split(",")) {
    const symbol = raw.trim().toUpperCase();
    if (SYMBOL_RE.test(symbol)) seen.add(symbol);
    if (seen.size >= MAX_REQUESTED_SYMBOLS) break;
  }
  return seen.size > 0 ? [...seen] : undefined;
}

function parseList(param: string | string[] | undefined): string[] {
  if (!param) return [];
  const raw = Array.isArray(param) ? param.join(",") : param;
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

/** Whitelist intervals — arbitrary strings would flow into upstream URLs and cache keys. */
function sanitizeIntervals(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback;
  const valid = raw.filter((i): i is string => typeof i === "string" && VALID_INTERVALS.has(i));
  return valid.length ? [...new Set(valid)].slice(0, 8) : fallback;
}

function toKlineAsset(type: KlineAssetType, symbol: string): KlineAsset {
  const sym = symbol.toUpperCase();
  if (type === "crypto") {
    const trading = sym.endsWith("USDT") ? sym : `${sym}USDT`;
    const base = trading.replace(/USDT$/, "");
    return { id: `crypto:${base}`, symbol: trading, type: "crypto" };
  }
  return { id: `${type}:${sym}`, symbol: sym, type };
}

function parseAssetsParam(raw: string | undefined): KlineAsset[] {
  if (!raw) return [];
  return raw.split(",").map((entry) => {
    const colon = entry.indexOf(":");
    if (colon < 0) return null;
    const type = entry.slice(0, colon).toLowerCase() as KlineAssetType;
    const symbol = entry.slice(colon + 1).trim().toUpperCase();
    if (!VALID_TYPES.has(type) || !SYMBOL_RE.test(symbol)) return null;
    return toKlineAsset(type, symbol);
  }).filter((a): a is KlineAsset => a !== null);
}

/**
 * The client-supplied id is echoed back as a response key and used as a cache
 * key, and the symbol is interpolated into upstream request URLs — neither may
 * be taken on trust just because the shape of the object looks right.
 */
const klineAssetSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9:_.\-]+$/),
  symbol: z.string().min(1).max(20),
  type: z.enum(["crypto", "stock", "forex", "commodity"]),
});

const batchBodySchema = z.object({
  assets: z.array(klineAssetSchema).max(80).optional(),
  symbols: z.array(z.string().min(1).max(20)).max(60).optional(),
  intervals: z.array(z.string().max(8)).max(16).optional(),
  refresh: z.boolean().optional(),
});

function parseAssetsBody(body: unknown): KlineAsset[] {
  const parsed = batchBodySchema.safeParse(body);
  if (!parsed.success || !parsed.data.assets) return [];
  return parsed.data.assets
    .filter(a => SYMBOL_RE.test(a.symbol.toUpperCase()))
    .map(a => ({ id: a.id, symbol: a.symbol.toUpperCase(), type: a.type }));
}

/**
 * Upstream failures are logged in full and reported as a bare status. The raw
 * message names the provider, the ticker and the upstream status code, which
 * together sketch out an integration a caller has no business seeing.
 */
function upstreamFailure(res: Response, err: unknown, event: string): void {
  logger.error({ err, event }, "Market data upstream failure");
  res.status(502).json({ error: "Market data temporarily unavailable" });
}

/** GET /api/markets/klines/chart — tək asset chart datası */
router.get("/klines/chart", klineLimiter, async (req: Request, res: Response) => {
  try {
    const type = String(req.query.type ?? "crypto").toLowerCase() as KlineAssetType;
    let symbol = String(req.query.symbol ?? "").toUpperCase();
    const interval = String(req.query.interval ?? "1h");
    const limit = Math.min(5000, Math.max(20, Number(req.query.limit) || 1000));

    if (!VALID_TYPES.has(type) || !SYMBOL_RE.test(symbol) || !VALID_INTERVALS.has(interval)) {
      res.status(400).json({ error: "type, symbol and interval required" });
      return;
    }
    if (type === "crypto" && !symbol.endsWith("USDT")) {
      symbol = `${symbol}USDT`;
    }

    const data = await fetchSingleAssetKlines(type, symbol, interval, limit);
    res.json({ data, type, symbol, interval, count: data.length });
  } catch (err) {
    upstreamFailure(res, err, "klines_chart_failed");
  }
});

/** POST /api/markets/klines/batch — bir sorğuda bütün klines (server paralel) */
router.post("/klines/batch", klineLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = batchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const assets = parseAssetsBody(req.body);
    const intervals = sanitizeIntervals(parsed.data.intervals, ["15m", "1h", "4h"]);

    if (assets.length > 0) {
      const refresh = parsed.data.refresh === true;
      const data = await batchFetchKlinesForAssets(assets, intervals, undefined, { bypassCache: refresh });
      res.json({ data, count: Object.keys(data).length });
      return;
    }

    const symbols = (parsed.data.symbols ?? [])
      .map(s => s.toUpperCase())
      .filter(s => SYMBOL_RE.test(s));
    if (!symbols.length) {
      res.status(400).json({ error: "symbols or assets required" });
      return;
    }
    const legacyAssets: KlineAsset[] = symbols.slice(0, 60).map(sym => {
      const s = sym.endsWith("USDT") ? sym : `${sym}USDT`;
      const base = s.replace(/USDT$/, "");
      return { id: `crypto:${base}`, symbol: s, type: "crypto" as const };
    });
    const data = await batchFetchKlinesForAssets(legacyAssets, intervals);
    res.json({ data, count: Object.keys(data).length });
  } catch (err) {
    upstreamFailure(res, err, "klines_batch_failed");
  }
});

/**
 * Open SSE streams per client. Each stream pins a socket and drives a fan-out of
 * upstream fetches, so how many one client may hold is a resource question
 * rather than a politeness one.
 */
const openStreams = new Map<string, number>();

function streamKey(req: Request): string {
  return req.user?.userId ?? req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/** GET /api/markets/klines/stream — SSE, hər asset hazır olanda göndər */
router.get("/klines/stream", klineLimiter, async (req: Request, res: Response) => {
  const assetsParam = parseAssetsParam(req.query.assets as string | undefined);
  const intervals = parseList(req.query.intervals as string | undefined);
  const tfs = sanitizeIntervals(intervals, ["15m", "1h", "4h"]);

  let assets = assetsParam;
  if (!assets.length) {
    const symbols = parseList(req.query.symbols as string | undefined)
      .map(s => s.toUpperCase())
      .filter(s => SYMBOL_RE.test(s))
      .map(s => (s.endsWith("USDT") ? s : `${s}USDT`));
    assets = symbols.map(sym => {
      const base = sym.replace(/USDT$/, "");
      return { id: `crypto:${base}`, symbol: sym, type: "crypto" as const };
    });
  }

  if (!assets.length) {
    res.status(400).json({ error: "assets or symbols required" });
    return;
  }

  const key = streamKey(req);
  const open = openStreams.get(key) ?? 0;
  if (open >= MAX_STREAMS_PER_CLIENT) {
    logger.warn({ event: "sse_limit_exceeded", ip: req.ip, open }, "Too many concurrent SSE streams");
    res.status(429).json({ error: "Too many open streams" });
    return;
  }
  openStreams.set(key, open + 1);

  const releaseStream = () => {
    const current = openStreams.get(key) ?? 1;
    if (current <= 1) openStreams.delete(key);
    else openStreams.set(key, current - 1);
  };

  const refresh = req.query.refresh === "1" || req.query.refresh === "true";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(": connected\n\n");

  // Stop writing the moment the client disconnects — otherwise every SSE
  // event after a dropped tab is a write to a destroyed socket.
  let clientGone = false;
  req.on("close", () => { clientGone = true; });
  const send = (payload: unknown) => {
    if (clientGone || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    await batchFetchKlinesForAssets(assets.slice(0, 80), tfs, (id, klines, done, total) => {
      send({ id, klines, done, total });
    }, { bypassCache: refresh });
    send({ complete: true });
  } catch (err) {
    logger.error({ err, event: "klines_stream_failed" }, "SSE stream failed");
    send({ error: "Market data temporarily unavailable" });
  } finally {
    // Must run on the error path too, or a failing upstream permanently burns
    // one of the caller's stream slots.
    releaseStream();
  }
  if (!res.writableEnded) res.end();
});

router.get("/klines/stats", quoteLimiter, (_req: Request, res: Response) => {
  res.json(getKlineCacheStats());
});

router.get("/crypto", quoteLimiter, async (req: Request, res: Response) => {
  try {
    const svc = await getMarketDataService();
    const symbols = parseSymbols(req.query.symbols as string | undefined);
    const data = await svc.getCryptoMarkets(symbols);
    res.json({ data, source: data[0]?.source ?? "cache", count: data.length });
  } catch {
    res.status(200).json({ data: [], source: "none", count: 0 });
  }
});

router.get("/stocks", quoteLimiter, async (req: Request, res: Response) => {
  try {
    const svc = await getMarketDataService();
    const symbols = parseSymbols(req.query.symbols as string | undefined);
    const data = await svc.getStocks(symbols);
    res.json({ data, source: data[0]?.source ?? "cache", count: data.length });
  } catch {
    res.status(200).json({ data: [], source: "none", count: 0 });
  }
});

router.get("/forex", quoteLimiter, async (req: Request, res: Response) => {
  try {
    const svc = await getMarketDataService();
    const pairs = parseSymbols(req.query.pairs as string | undefined);
    const data = await svc.getForex(pairs);
    res.json({ data, source: data[0]?.source ?? "cache", count: data.length });
  } catch {
    res.status(200).json({ data: [], source: "none", count: 0 });
  }
});

router.get("/commodities", quoteLimiter, async (req: Request, res: Response) => {
  try {
    const svc = await getMarketDataService();
    const symbols = parseSymbols(req.query.symbols as string | undefined);
    const data = await svc.getCommodities(symbols);
    res.json({ data, source: data[0]?.source ?? "cache", count: data.length });
  } catch {
    res.status(200).json({ data: [], source: "none", count: 0 });
  }
});

router.get("/health", quoteLimiter, async (_req: Request, res: Response) => {
  try {
    const svc = await getMarketDataService();
    res.json({
      cache: svc.getCacheKind(),
      providers: svc.getProviderHealth(),
    });
  } catch (err) {
    logger.error({ err, event: "market_health_failed" }, "Market data health check failed");
    res.status(503).json({ error: "Market data unavailable" });
  }
});

const ASSET_CLASSES = new Set<AssetClass>(["crypto", "stocks", "forex", "commodities"]);

router.get("/asset/:symbol", quoteLimiter, async (req: Request, res: Response) => {
  try {
    const assetClass = String(req.query.class ?? "crypto") as AssetClass;
    const symbol = String(req.params.symbol).toUpperCase();
    if (!ASSET_CLASSES.has(assetClass) || !SYMBOL_RE.test(symbol)) {
      res.status(400).json({ error: "Invalid symbol or asset class" });
      return;
    }
    const svc = await getMarketDataService();
    const asset = await svc.getAsset(symbol, assetClass);
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    res.json({ data: asset });
  } catch (err) {
    upstreamFailure(res, err, "asset_lookup_failed");
  }
});

export default router;
