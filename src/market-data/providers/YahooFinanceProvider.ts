import { BaseProvider } from './BaseProvider.js';
import type { NormalizedAsset } from '../types.js';
import { DEFAULT_STOCK_SYMBOLS } from '../types.js';
import { fetchJson, nowIso } from '../utils/http.js';
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

export class YahooFinanceProvider extends BaseProvider {
  readonly name = 'YahooFinance';
  readonly priority = 1;
  readonly supportedClasses = ['stocks', 'forex', 'commodities'] as const;

  private async fetchYahoo(symbol: string): Promise<NormalizedAsset | null> {
    const data = await fetchJson<YahooChartResponse>(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`,
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

  override async getStocks(symbols = DEFAULT_STOCK_SYMBOLS): Promise<NormalizedAsset[]> {
    try {
      const results = await Promise.all(symbols.map(s => this.fetchYahoo(s)));
      return results
        .filter((r): r is NormalizedAsset => r !== null)
        .map(r => ({ ...r, assetClass: 'stocks' as const }));
    } catch (err) {
      throw new ProviderError(
        err instanceof Error ? err.message : 'Yahoo Finance failed',
        'NETWORK',
        this.name,
      );
    }
  }

  override async getForex(pairs = ['EURUSD', 'GBPUSD', 'USDTRY', 'USDAZN', 'USDJPY']): Promise<NormalizedAsset[]> {
    try {
      const yahooPairs = pairs.map(p => {
        const clean = p.replace('/', '');
        return `${clean}=X`;
      });
      const results = await Promise.all(yahooPairs.map(s => this.fetchYahoo(s)));
      return results
        .filter((r): r is NormalizedAsset => r !== null)
        .map((r, i) => {
          const raw = pairs[i].replace('/', '');
          const base = raw.slice(0, 3);
          const quote = raw.slice(3);
          return {
            ...r,
            symbol: raw,
            name: `${base}/${quote}`,
            assetClass: 'forex' as const,
          };
        });
    } catch (err) {
      throw new ProviderError(err instanceof Error ? err.message : 'Yahoo forex failed', 'NETWORK', this.name);
    }
  }

  override async getCommodities(): Promise<NormalizedAsset[]> {
    try {
      const specs: { yahoo: string; symbol: string; name: string }[] = [
        { yahoo: 'GC=F', symbol: 'GOLD', name: 'Gold' },
        { yahoo: 'SI=F', symbol: 'SILVER', name: 'Silver' },
        { yahoo: 'CL=F', symbol: 'OIL', name: 'Crude Oil' },
        { yahoo: 'NG=F', symbol: 'NATGAS', name: 'Natural Gas' },
      ];
      const results = await Promise.all(specs.map(s => this.fetchYahoo(s.yahoo)));
      return results
        .filter((r): r is NormalizedAsset => r !== null)
        .map((r, i) => ({
          ...r,
          symbol: specs[i].symbol,
          name: specs[i].name,
          assetClass: 'commodities' as const,
        }));
    } catch (err) {
      throw new ProviderError(err instanceof Error ? err.message : 'Yahoo commodities failed', 'NETWORK', this.name);
    }
  }
}
