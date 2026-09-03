import type { NormalizedAsset } from '../types.js';
import { fetchJson } from '../utils/http.js';

interface CoinGeckoMarket {
  symbol: string;
  market_cap: number | null;
}

/**
 * Binance ranks by volume and reports no market cap, so the crypto table came
 * back with marketCap: null for every row and could not be sorted by size.
 *
 * One CoinGecko page covers the top 250 coins by market cap, which comfortably
 * spans the 100 symbols Binance returns, so the whole table is filled from a
 * single upstream request. It is cached for ten minutes — market caps move far
 * more slowly than prices, and CoinGecko's free tier does not tolerate a call
 * per refresh.
 */
const URL =
  'https://api.coingecko.com/api/v3/coins/markets' +
  '?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false';

const TTL_MS = 10 * 60_000;
/** Back off briefly after a failure instead of retrying on every request. */
const FAILURE_TTL_MS = 60_000;

let caps = new Map<string, number>();
let expiresAt = 0;
let inflight: Promise<Map<string, number>> | null = null;

async function load(): Promise<Map<string, number>> {
  try {
    const data = await fetchJson<CoinGeckoMarket[]>(URL, { timeoutMs: 6_000 });
    const next = new Map<string, number>();
    for (const coin of data) {
      const symbol = coin.symbol?.toUpperCase();
      // The response is market-cap ordered, so the first entry for a ticker is
      // the real one — later namesakes are impostors with the same symbol.
      if (symbol && coin.market_cap != null && !next.has(symbol)) {
        next.set(symbol, coin.market_cap);
      }
    }
    caps = next;
    expiresAt = Date.now() + TTL_MS;
  } catch {
    // Market caps are decoration: an outage leaves them null rather than
    // failing the crypto table, which the frontend already handles.
    expiresAt = Date.now() + FAILURE_TTL_MS;
  }
  return caps;
}

async function getCaps(): Promise<Map<string, number>> {
  if (Date.now() < expiresAt) return caps;
  // Collapse concurrent refreshes into one upstream call.
  inflight ??= load().finally(() => { inflight = null; });
  return inflight;
}

/** Fill in missing market caps; providers that already supply one are left alone. */
export async function withMarketCaps(assets: NormalizedAsset[]): Promise<NormalizedAsset[]> {
  if (!assets.some(a => a.marketCap == null)) return assets;

  const table = await getCaps();
  if (table.size === 0) return assets;

  return assets.map(a =>
    a.marketCap == null
      ? { ...a, marketCap: table.get(a.symbol.toUpperCase()) ?? null }
      : a,
  );
}
