import type { Kline } from "./klineBatchService.js";

export type KlineAssetType = "crypto" | "stock" | "forex" | "commodity";

const COMMODITY_YAHOO: Record<string, string> = {
  GOLD: "GC=F",
  SILVER: "SI=F",
  OIL: "CL=F",
  NATGAS: "NG=F",
};

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

export function toYahooTicker(type: KlineAssetType, symbol: string): string | null {
  if (type === "crypto") return null;
  if (type === "stock") return symbol;
  if (type === "forex") {
    const clean = symbol.replace("/", "").replace("=X", "").toUpperCase();
    return `${clean}=X`;
  }
  if (type === "commodity") return COMMODITY_YAHOO[symbol.toUpperCase()] ?? symbol;
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

export async function fetchYahooKlines(
  type: KlineAssetType,
  symbol: string,
  interval: string,
  limit = 70,
): Promise<Kline[]> {
  const ticker = toYahooTicker(type, symbol);
  if (!ticker) return [];

  const spec = YAHOO_TF[interval] ?? YAHOO_TF["1h"];
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?interval=${spec.interval}&range=${spec.range}&includePrePost=false`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MarketScanner/1.0)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Yahoo klines ${ticker}/${interval}: ${res.status}`);
  }

  const data = (await res.json()) as YahooChartResponse;
  const result = data.chart?.result?.[0];
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
