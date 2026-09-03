import { BaseProvider } from './BaseProvider.js';
import type { NormalizedAsset } from '../types.js';
import {
  COMMODITY_SPECS,
  COMMODITY_SYMBOLS,
  DEFAULT_FOREX_PAIRS,
  DEFAULT_STOCK_SYMBOLS,
} from '../types.js';
import { fetchJson, mapLimit, nowIso } from '../utils/http.js';
import { ProviderError } from '../types.js';

interface YahooChartMeta {
  regularMarketPrice: number;
  chartPreviousClose?: number;
  regularMarketVolume?: number;
  marketCap?: number;
  longName?: string;
  shortName?: string;
}

interface YahooChartResponse {
  chart: {
    result: Array<{
      meta: YahooChartMeta;
    }> | null;
  };
}

/** Yahoo throttles unidentified clients, and the default lists are no longer small. */
const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; MarketScanner/1.0)' };
const MAX_PARALLEL = 6;

export class YahooFinanceProvider extends BaseProvider {
  readonly name = 'YahooFinance';
  readonly priority = 1;
  readonly supportedClasses = ['stocks', 'forex', 'commodities'] as const;

  private async fetchYahoo(symbol: string): Promise<NormalizedAsset | null> {
    const data = await fetchJson<YahooChartResponse>(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`,
      { headers: YAHOO_HEADERS },
    );
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const prev = meta.chartPreviousClose ?? meta.regularMarketPrice;
    const change = prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0;
    return {
      symbol: symbol.replace('=X', '').replace('=F', ''),
      name: meta.longName ?? meta.shortName ?? symbol,
      price: meta.regularMarketPrice,
      change24h: change,
      marketCap: meta.marketCap ?? null,
      volume24h: meta.regularMarketVolume ?? null,
      source: this.name,
      assetClass: 'stocks',
      lastUpdated: nowIso(),
    };
  }

  /**
   * Fetch one entry per requested item and drop the ones that fail, so a single
   * delisted ticker cannot empty the whole asset class. The overrides stay
   * attached to their own request instead of being zipped by index afterwards —
   * a filtered-then-indexed join silently relabels every asset after a gap.
   *
   * A total wipeout is still reported as a provider failure so the failover
   * chain blacklists Yahoo and moves on rather than serving an empty class.
   */
  private async fetchAll<T extends { ticker: string }>(
    specs: readonly T[],
    decorate: (asset: NormalizedAsset, spec: T) => NormalizedAsset,
    label: string,
  ): Promise<NormalizedAsset[]> {
    if (specs.length === 0) return [];

    const settled = await mapLimit(specs, MAX_PARALLEL, async (spec) => {
      try {
        const asset = await this.fetchYahoo(spec.ticker);
        return asset ? decorate(asset, spec) : null;
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
    });

    const assets = settled.filter((r): r is NormalizedAsset => r !== null && !(r instanceof Error));
    if (assets.length === 0) {
      const firstError = settled.find((r): r is Error => r instanceof Error);
      throw new ProviderError(
        firstError?.message ?? `Yahoo ${label} returned no data`,
        'NETWORK',
        this.name,
      );
    }
    return assets;
  }

  override async getStocks(symbols = DEFAULT_STOCK_SYMBOLS): Promise<NormalizedAsset[]> {
    const specs = symbols.map(s => ({ ticker: s.toUpperCase() }));
    return this.fetchAll(specs, asset => ({ ...asset, assetClass: 'stocks' as const }), 'stocks');
  }

  override async getForex(pairs = DEFAULT_FOREX_PAIRS): Promise<NormalizedAsset[]> {
    const specs = pairs.map((p) => {
      const raw = p.replace('/', '').replace('=X', '').toUpperCase();
      return { ticker: `${raw}=X`, raw };
    });
    return this.fetchAll(
      specs,
      (asset, spec) => ({
        ...asset,
        symbol: spec.raw,
        name: `${spec.raw.slice(0, 3)}/${spec.raw.slice(3)}`,
        assetClass: 'forex' as const,
      }),
      'forex',
    );
  }

  override async getCommodities(symbols = COMMODITY_SYMBOLS): Promise<NormalizedAsset[]> {
    // Unknown symbols are skipped, not failed: ?symbols=GOLD,NOPE must still
    // answer with gold rather than erroring the whole request.
    const specs = symbols
      .map(s => s.toUpperCase())
      .map(symbol => ({ symbol, spec: COMMODITY_SPECS[symbol] }))
      .filter((e): e is { symbol: string; spec: { yahoo: string; name: string } } => Boolean(e.spec))
      .map(e => ({ ticker: e.spec.yahoo, symbol: e.symbol, name: e.spec.name }));

    return this.fetchAll(
      specs,
      (asset, spec) => ({
        ...asset,
        symbol: spec.symbol,
        name: spec.name,
        assetClass: 'commodities' as const,
      }),
      'commodities',
    );
  }
}
