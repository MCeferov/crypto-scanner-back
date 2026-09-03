import { COMMODITY_SPECS } from "../market-data/types.js";
import type { Kline } from "./klineBatchService.js";

export type KlineAssetType = "crypto" | "stock" | "forex" | "commodity";

const YAHOO_TF: Record<string, { interval: string; range: string }> = {
  "1m": { interval: "1m", range: "7d" },
  "5m": { interval: "5m", range: "60d" },
  "15m": { interval: "15m", range: "60d" },
  "30m": { interval: "30m", range: "60d" },
  "1h": { interval: "60m", range: "730d" },
  "4h": { interval: "60m", range: "730d" },
  "1d": { interval: "1d", range: "max" },
  "1w": { interval: "1wk", range: "max" },
};

interface YahooChartResult {
  timestamp?: number[];
  indicators?: {
    quote?: Array<{
      open?: (number | null)[];
      high?: (number | null)[];
      low?: (number | null)[];
      close?: (number | null)[];
      volume?: (number | null)[];
    }>;
  };
}

interface YahooChartResponse {
  chart?: { result?: YahooChartResult[] | null };
}

/**
 * Commodity tickers come from the shared COMMODITY_SPECS map, so a symbol the
 * quote endpoint serves always has a chart too. An unknown commodity resolves
 * to null rather than being passed through verbatim — sending "COPPER" to
 * Yahoo just earns a 404 that would surface as a failed asset.
 */
export function toYahooTicker(type: KlineAssetType, symbol: string): string | null {
  if (type === "crypto") return null;
  if (type === "stock") return symbol;
  if (type === "forex") {
    const clean = symbol.replace("/", "").replace("=X", "").toUpperCase();
    return `${clean}=X`;
  }
  if (type === "commodity") return COMMODITY_SPECS[symbol.toUpperCase()]?.yahoo ?? null;
  return symbol;
}

/** Candle duration per app interval — Yahoo does not return closeTime. */
const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 3_600_000,
  "4h": 4 * 3_600_000,
  "1d": 86_400_000,
  "1w": 7 * 86_400_000,
};

const FOUR_H_MS = 4 * 3_600_000;

/**
 * Bucket hourly candles onto real 4h wall-clock boundaries. Fixed groups-of-4
 * would drift with the series start and merge overnight/weekend market gaps
 * into one bogus candle.
 */
function resampleTo4h(hourly: Kline[]): Kline[] {
  const out: Kline[] = [];
  let bucket: Kline[] = [];
  let bucketStart = -1;

  const flush = () => {
    if (!bucket.length) return;
    out.push({
      openTime: bucket[0].openTime,
      open: bucket[0].open,
      high: Math.max(...bucket.map((k) => k.high)),
      low: Math.min(...bucket.map((k) => k.low)),
      close: bucket[bucket.length - 1].close,
      volume: bucket.reduce((s, k) => s + k.volume, 0),
      closeTime: bucketStart + FOUR_H_MS - 1,
    });
    bucket = [];
  };

  for (const k of hourly) {
    const start = Math.floor(k.openTime / FOUR_H_MS) * FOUR_H_MS;
    if (start !== bucketStart) {
      flush();
      bucketStart = start;
    }
    bucket.push(k);
  }
  flush();
  return out;
}

function parseYahooCandles(result: YahooChartResult, intervalMs: number): Kline[] {
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  if (!q?.close?.length) return [];

  const klines: Kline[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close[i];
    if (close == null || Number.isNaN(close)) continue;
    const open = q.open?.[i] ?? close;
    const high = q.high?.[i] ?? close;
    const low = q.low?.[i] ?? close;
    const vol = q.volume?.[i] ?? 0;
    const openTime = ts[i] * 1000;
    klines.push({
      openTime,
      open,
      high,
      low,
      close,
      volume: vol ?? 0,
      closeTime: openTime + intervalMs - 1,
    });
  }
  return klines;
}

/**
 * Yahoo is the shared upstream for stocks, forex and commodities across the
 * batch, SSE and chart endpoints, and it rate-limits aggressively. Every chart
 * request in the process passes through this gate, so a heatmap refresh cannot
 * open one connection per (symbol × timeframe).
 */
const YAHOO_MAX_CONCURRENT = 6;
let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  while (active >= YAHOO_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
}

function release(): void {
  active--;
  waiting.shift()?.();
}

/**
 * In-flight deduplication by upstream URL. 1h and 4h resolve to the same Yahoo
 * request (4h is resampled from hourly candles), so without this every refresh
 * would fetch each symbol's hourly series twice.
 */
const inflight = new Map<string, Promise<YahooChartResult | null>>();

async function fetchYahooChart(
  ticker: string,
  spec: { interval: string; range: string },
): Promise<YahooChartResult | null> {
  const key = `${ticker}|${spec.interval}|${spec.range}`;
  const running = inflight.get(key);
  if (running) return running;

  const pending = (async () => {
    await acquire();
    try {
      const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
        `?interval=${spec.interval}&range=${spec.range}&includePrePost=false`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MarketScanner/1.0)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`Yahoo klines ${ticker}/${spec.interval}: ${res.status}`);
      }
      const data = (await res.json()) as YahooChartResponse;
      return data.chart?.result?.[0] ?? null;
    } finally {
      release();
    }
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, pending);
  return pending;
}

export async function fetchYahooKlines(
  type: KlineAssetType,
  symbol: string,
  interval: string,
  limit = 70,
): Promise<Kline[]> {
  const ticker = toYahooTicker(type, symbol);
  if (!ticker) return [];

  const spec = YAHOO_TF[interval] ?? YAHOO_TF["1h"];
  const result = await fetchYahooChart(ticker, spec);
  if (!result) return [];

  // The 4h series is resampled from 1h source candles.
  const sourceMs = interval === "4h" ? INTERVAL_MS["1h"] : INTERVAL_MS[interval] ?? INTERVAL_MS["1h"];
  let klines = parseYahooCandles(result, sourceMs);
  if (interval === "4h") {
    klines = resampleTo4h(klines);
  }
  if (klines.length > limit) {
    klines = klines.slice(-limit);
  }
  return klines;
}
