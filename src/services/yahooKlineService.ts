import type { Kline } from "./klineBatchService.js";

export type KlineAssetType = "crypto" | "stock" | "forex" | "commodity";

const COMMODITY_YAHOO: Record<string, string> = {
  GOLD: "GC=F",
  SILVER: "SI=F",
  OIL: "CL=F",
  NATGAS: "NG=F",
};

const YAHOO_TF: Record<string, { interval: string; range: string }> = {
  "1m": { interval: "1m", range: "1d" },
  "5m": { interval: "5m", range: "5d" },
  "15m": { interval: "15m", range: "5d" },
  "30m": { interval: "30m", range: "1mo" },
  "1h": { interval: "60m", range: "2mo" },
  "4h": { interval: "60m", range: "3mo" },
  "1d": { interval: "1d", range: "6mo" },
  "1w": { interval: "1wk", range: "1y" },
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

function resampleTo4h(hourly: Kline[]): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i + 3 < hourly.length; i += 4) {
    const chunk = hourly.slice(i, i + 4);
    out.push({
      openTime: chunk[0].openTime,
      open: chunk[0].open,
      high: Math.max(...chunk.map((k) => k.high)),
      low: Math.min(...chunk.map((k) => k.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, k) => s + k.volume, 0),
      closeTime: chunk[chunk.length - 1].closeTime,
    });
  }
  return out;
}

function parseYahooCandles(result: YahooChartResult): Kline[] {
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
      closeTime: openTime + 60_000,
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
  });
  if (!res.ok) {
    throw new Error(`Yahoo klines ${ticker}/${interval}: ${res.status}`);
  }

  const data = (await res.json()) as YahooChartResponse;
  const result = data.chart?.result?.[0];
  if (!result) return [];

  let klines = parseYahooCandles(result);
  if (interval === "4h") {
    klines = resampleTo4h(klines);
  }
  if (klines.length > limit) {
    klines = klines.slice(-limit);
  }
  return klines;
}
