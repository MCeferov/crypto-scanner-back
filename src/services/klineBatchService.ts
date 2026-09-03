import { logger } from "../lib/logger.js";
import { fetchYahooKlines, type KlineAssetType } from "./yahooKlineService.js";

export type { KlineAssetType };

const BINANCE_BASE = process.env.BINANCE_API_BASE ?? "https://api.binance.com/api/v3";
/** Cədvəl/indikator — MACD EMA sabitliyi üçün kifayət qədər tarixçə (detail ilə uyğun) */
export const KLINE_LIMIT = 1000;
const CACHE_TTL_MS = 90_000;
/** Bütün (symbol×interval) sorğuları üçün vahid pool — 16×3=48 əvəzinə 24 */
const MAX_CONCURRENT = 24;
/**
 * Yahoo tasks get their own, much smaller pool. They queue behind a shared
 * upstream gate, and in a single pool enough blocked Yahoo tasks would occupy
 * every slot a Binance task could have used.
 */
const YAHOO_TASK_CONCURRENT = 8;

/**
 * Yahoo rate-limits far harder than Binance and its candles only move once per
 * bar, so each timeframe keeps its series roughly as long as the bar it
 * describes: a 1m series is stale in a minute, a daily one holds for an hour.
 * Without this the frontend's 60s non-crypto refresh would re-fetch every
 * (symbol × timeframe) from Yahoo every single minute.
 */
const YAHOO_TTL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 10 * 60_000,
  "30m": 15 * 60_000,
  "1h": 30 * 60_000,
  "4h": 45 * 60_000,
  "1d": 60 * 60_000,
  "1w": 3 * 60 * 60_000,
};
const YAHOO_TTL_FALLBACK_MS = 15 * 60_000;

function ttlFor(type: KlineAssetType, interval: string): number {
  return type === "crypto" ? CACHE_TTL_MS : YAHOO_TTL_MS[interval] ?? YAHOO_TTL_FALLBACK_MS;
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume?: number;
  closeTime: number;
}

export interface KlineAsset {
  id: string;
  symbol: string;
  type: KlineAssetType;
}

interface CacheEntry {
  at: number;
  data: Kline[];
  /** Per-entry lifetime — crypto and each Yahoo timeframe expire differently. */
  ttl: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 1500;
const FETCH_TIMEOUT_MS = 15_000;

/** Drop expired entries; if still over cap, drop oldest. Called on every write. */
function pruneKlineCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at > entry.ttl) cache.delete(key);
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

const PREWARM_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
];
const PREWARM_INTERVALS = ["15m", "1h", "4h"];

function cacheKey(assetId: string, interval: string): string {
  return `${assetId}:${interval}`;
}

export function normalizeKlineAsset(type: KlineAssetType, symbol: string): KlineAsset {
  const sym = symbol.toUpperCase();
  if (type === "crypto") {
    const trading = sym.endsWith("USDT") ? sym : `${sym}USDT`;
    const base = trading.replace(/USDT$/, "");
    return { id: `crypto:${base}`, symbol: trading, type: "crypto" };
  }
  return { id: `${type}:${sym}`, symbol: sym, type };
}

interface FetchKlineOpts {
  bypassCache?: boolean;
  limit?: number;
}

function parseRaw(raw: number[][]): Kline[] {
  return raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(String(k[1])),
    high: parseFloat(String(k[2])),
    low: parseFloat(String(k[3])),
    close: parseFloat(String(k[4])),
    volume: parseFloat(String(k[5])),
    takerBuyVolume: k[9] != null ? parseFloat(String(k[9])) : undefined,
    closeTime: k[6],
  }));
}

async function fetchBinanceKline(
  symbol: string,
  interval: string,
  opts: FetchKlineOpts = {},
): Promise<Kline[]> {
  const limit = opts.limit ?? KLINE_LIMIT;
  const base = symbol.replace(/USDT$/, "");
  const key = cacheKey(`crypto:${base}`, interval);
  // The cache only ever holds full KLINE_LIMIT series — serve smaller requests
  // by slicing, never cache partial results (they would poison the batch path).
  if (!opts.bypassCache && limit <= KLINE_LIMIT) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl && hit.data.length >= Math.min(limit, hit.data.length)) {
      return limit < hit.data.length ? hit.data.slice(-limit) : hit.data;
    }
  }

  const maxPerReq = 1000;
  let all: Kline[] = [];
  let endTime: number | undefined;

  while (all.length < limit) {
    const batchSize = Math.min(maxPerReq, limit - all.length);
    let url =
      `${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${batchSize}`;
    if (endTime != null) url += `&endTime=${endTime}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Klines ${symbol}/${interval}: ${res.status} ${body.slice(0, 80)}`);
    }
    const raw = (await res.json()) as number[][];
    const batch = parseRaw(raw);
    if (batch.length === 0) break;

    all = batch.concat(all);
    endTime = batch[0].openTime - 1;
    if (batch.length < batchSize) break;
  }

  // Deduplicate by openTime (overlap between pages)
  const seen = new Set<number>();
  const data: Kline[] = [];
  for (const k of all) {
    if (seen.has(k.openTime)) continue;
    seen.add(k.openTime);
    data.push(k);
  }
  data.sort((a, b) => a.openTime - b.openTime);
  const trimmed = data.length > limit ? data.slice(-limit) : data;

  // Only cache full-size series — a short fetch stored under the shared key
  // would later be served to the heatmap as if it were the full history.
  if (limit === KLINE_LIMIT) {
    cache.set(key, { at: Date.now(), data: trimmed, ttl: CACHE_TTL_MS });
    pruneKlineCache();
  }
  return trimmed;
}

async function fetchAssetKline(
  asset: KlineAsset,
  interval: string,
  opts: FetchKlineOpts = {},
): Promise<Kline[]> {
  const limit = opts.limit ?? KLINE_LIMIT;
  const key = cacheKey(asset.id, interval);
  if (!opts.bypassCache && limit <= KLINE_LIMIT) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) {
      return limit < hit.data.length ? hit.data.slice(-limit) : hit.data;
    }
  }

  const data = asset.type === "crypto"
    ? await fetchBinanceKline(asset.symbol, interval, { bypassCache: true, limit })
    : await fetchYahooKlines(asset.type, asset.symbol, interval, limit);

  if (limit === KLINE_LIMIT) {
    cache.set(key, { at: Date.now(), data, ttl: ttlFor(asset.type, interval) });
    pruneKlineCache();
  }
  return data;
}

/** Legacy Binance-only fetch */
async function fetchKline(symbol: string, interval: string): Promise<Kline[]> {
  return fetchBinanceKline(symbol, interval);
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  async function next(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
}

export async function batchFetchKlinesForAssets(
  assets: KlineAsset[],
  intervals: string[],
  onAsset?: (
    id: string,
    klines: Record<string, Kline[]>,
    done: number,
    total: number,
  ) => void,
  opts: FetchKlineOpts = {},
): Promise<Record<string, Record<string, Kline[]>>> {
  const result: Record<string, Record<string, Kline[]>> = {};
  const intervalCount = intervals.length;
  const total = assets.length;
  let done = 0;
  const started = Date.now();

  for (const asset of assets) {
    result[asset.id] = {};
  }

  type Task = { asset: KlineAsset; interval: string };
  const tasks: Task[] = [];
  for (const asset of assets) {
    for (const interval of intervals) {
      tasks.push({ asset, interval });
    }
  }

  const completedIntervals = new Map<string, number>();

  // A failed symbol yields an empty series for that interval and nothing more —
  // one delisted ticker or Yahoo hiccup must never sink the whole batch/stream.
  const runTask = async ({ asset, interval }: Task): Promise<void> => {
    try {
      result[asset.id][interval] = await fetchAssetKline(asset, interval, opts);
    } catch {
      result[asset.id][interval] = [];
    }
    const count = (completedIntervals.get(asset.id) ?? 0) + 1;
    completedIntervals.set(asset.id, count);
    if (count === intervalCount) {
      done++;
      try {
        onAsset?.(asset.id, result[asset.id], done, total);
      } catch {
        // A throwing callback (e.g. res.write on a disconnected SSE client)
        // must not abort the remaining pool tasks.
      }
    }
  };

  // Separate pools per upstream: Yahoo tasks wait on their own concurrency gate,
  // and sharing one pool would let them hold every slot while Binance tasks —
  // the bulk of a heatmap refresh — sit idle behind them.
  const cryptoTasks = tasks.filter(t => t.asset.type === "crypto");
  const yahooTasks = tasks.filter(t => t.asset.type !== "crypto");
  await Promise.all([
    runPool(cryptoTasks, MAX_CONCURRENT, runTask),
    runPool(yahooTasks, YAHOO_TASK_CONCURRENT, runTask),
  ]);

  logger.info({
    event: "klines_assets_batch_done",
    assets: total,
    intervals: intervalCount,
    requests: tasks.length,
    ms: Date.now() - started,
  });

  return result;
}

export async function fetchSingleAssetKlines(
  type: KlineAssetType,
  symbol: string,
  interval: string,
  limit = KLINE_LIMIT,
): Promise<Kline[]> {
  const asset = normalizeKlineAsset(type, symbol);
  // Binance is cheap enough to always answer a chart from source. Yahoo is not,
  // and this endpoint is hit again on every timeframe switch in the chart UI,
  // so non-crypto charts are served from the same TTL cache as the heatmap.
  return fetchAssetKline(asset, interval, { bypassCache: asset.type === "crypto", limit });
}

export async function batchFetchKlines(
  symbols: string[],
  intervals: string[],
  onSymbol?: (
    symbol: string,
    klines: Record<string, Kline[]>,
    done: number,
    total: number,
  ) => void,
): Promise<Record<string, Record<string, Kline[]>>> {
  const result: Record<string, Record<string, Kline[]>> = {};
  const intervalCount = intervals.length;
  const total = symbols.length;
  let done = 0;
  const started = Date.now();

  for (const symbol of symbols) {
    result[symbol] = {};
  }

  type Task = { symbol: string; interval: string };
  const tasks: Task[] = [];
  for (const symbol of symbols) {
    for (const interval of intervals) {
      tasks.push({ symbol, interval });
    }
  }

  const completedIntervals = new Map<string, number>();

  await runPool(tasks, MAX_CONCURRENT, async ({ symbol, interval }) => {
    try {
      result[symbol][interval] = await fetchKline(symbol, interval);
    } catch {
      result[symbol][interval] = [];
    }
    const count = (completedIntervals.get(symbol) ?? 0) + 1;
    completedIntervals.set(symbol, count);
    if (count === intervalCount) {
      done++;
      try {
        onSymbol?.(symbol, result[symbol], done, total);
      } catch {
        // Callback failures must not abort the remaining pool tasks.
      }
    }
  });

  logger.info({
    event: "klines_batch_done",
    symbols: total,
    intervals: intervalCount,
    requests: tasks.length,
    ms: Date.now() - started,
  });

  return result;
}

export function getKlineCacheStats() {
  return { entries: cache.size, ttlMs: CACHE_TTL_MS, yahooTtlMs: YAHOO_TTL_MS };
}

/** Server start-da top coinləri cache-ə yüklə — ilk istifadəçi gözləmir */
export function prewarmKlineCache(): void {
  const tasks = PREWARM_SYMBOLS.flatMap((symbol) =>
    PREWARM_INTERVALS.map((interval) => ({ symbol, interval })),
  );
  void runPool(tasks, MAX_CONCURRENT, async ({ symbol, interval }) => {
    try {
      await fetchKline(symbol, interval);
    } catch {
      /* ignore prewarm failures */
    }
  }).then(() => {
    logger.info({ event: "klines_prewarm_done", entries: cache.size });
  });
}
