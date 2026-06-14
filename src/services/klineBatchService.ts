import { logger } from "../lib/logger.js";
import { fetchYahooKlines, type KlineAssetType } from "./yahooKlineService.js";

export type { KlineAssetType };

const BINANCE_BASE = process.env.BINANCE_API_BASE ?? "https://api.binance.com/api/v3";
const KLINE_LIMIT = 70;
const CACHE_TTL_MS = 90_000;
/** Bütün (symbol×interval) sorğuları üçün vahid pool — 16×3=48 əvəzinə 24 */
const MAX_CONCURRENT = 24;

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
}

const cache = new Map<string, CacheEntry>();

const PREWARM_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
];
const PREWARM_INTERVALS = ["15m", "1h", "4h"];

function cacheKey(assetId: string, interval: string): string {
  return `${assetId}:${interval}`;
}

function parseRaw(raw: number[][]): Kline[] {
  return raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(String(k[1])),
    high: parseFloat(String(k[2])),
    low: parseFloat(String(k[3])),
    close: parseFloat(String(k[4])),
    volume: parseFloat(String(k[5])),
    closeTime: k[6],
  }));
}

async function fetchBinanceKline(symbol: string, interval: string): Promise<Kline[]> {
  const base = symbol.replace(/USDT$/, "");
  const key = cacheKey(`crypto:${base}`, interval);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${KLINE_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Klines ${symbol}/${interval}: ${res.status} ${body.slice(0, 80)}`);
  }
  const raw = (await res.json()) as number[][];
  const data = parseRaw(raw);
  cache.set(key, { at: Date.now(), data });
  return data;
}

async function fetchAssetKline(asset: KlineAsset, interval: string): Promise<Kline[]> {
  const key = cacheKey(asset.id, interval);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const data = asset.type === "crypto"
    ? await fetchBinanceKline(asset.symbol, interval)
    : await fetchYahooKlines(asset.type, asset.symbol, interval, KLINE_LIMIT);

  cache.set(key, { at: Date.now(), data });
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

  await runPool(tasks, MAX_CONCURRENT, async ({ asset, interval }) => {
    try {
      result[asset.id][interval] = await fetchAssetKline(asset, interval);
    } catch {
      result[asset.id][interval] = [];
    }
    const count = (completedIntervals.get(asset.id) ?? 0) + 1;
    completedIntervals.set(asset.id, count);
    if (count === intervalCount) {
      done++;
      onAsset?.(asset.id, result[asset.id], done, total);
    }
  });

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
  limit = 200,
): Promise<Kline[]> {
  const id = `${type}:${symbol}`;
  const asset: KlineAsset = { id, symbol, type };
  if (type === "crypto") {
    const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Klines ${symbol}/${interval}: ${res.status}`);
    const raw = (await res.json()) as number[][];
    return parseRaw(raw);
  }
  return fetchYahooKlines(type, symbol, interval, limit);
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
      onSymbol?.(symbol, result[symbol], done, total);
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
  return { entries: cache.size, ttlMs: CACHE_TTL_MS };
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
