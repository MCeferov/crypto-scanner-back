import { BaseProvider } from './BaseProvider.js';
import type { NormalizedAsset } from '../types.js';
import { DEFAULT_STOCK_SYMBOLS } from '../types.js';
import { fetchJson, nowIso } from '../utils/http.js';
import { ProviderError } from '../types.js';

interface FmpQuote {
  symbol: string;
  name: string;
  price: number;
  changesPercentage: number;
  marketCap: number;
  volume: number;
}

export class FmpProvider extends BaseProvider {
  readonly name = 'FMP';
  readonly priority = 3;
  readonly supportedClasses = ['stocks', 'forex', 'commodities'] as const;

  constructor(private readonly apiKey?: string) {
    super();
  }

  private enabled(): boolean {
    return Boolean(this.apiKey);
  }

  override async getStocks(symbols = DEFAULT_STOCK_SYMBOLS): Promise<NormalizedAsset[]> {
    if (!this.enabled()) return [];
    try {
      const sym = symbols.join(',');
      const data = await fetchJson<FmpQuote[]>(
        `https://financialmodelingprep.com/api/v3/quote/${sym}?apikey=${this.apiKey}`,
      );
      return data.map(q => ({
        symbol: q.symbol,
        name: q.name,
        price: q.price,
        change24h: q.changesPercentage,
        marketCap: q.marketCap ?? null,
        volume24h: q.volume ?? null,
        source: this.name,
        assetClass: 'stocks' as const,
        lastUpdated: nowIso(),
      }));
    } catch (err) {
      throw new ProviderError(err instanceof Error ? err.message : 'FMP failed', 'NETWORK', this.name);
    }
  }

  override async getForex(): Promise<NormalizedAsset[]> {
    if (!this.enabled()) return [];
    try {
      const data = await fetchJson<FmpQuote[]>(
        `https://financialmodelingprep.com/api/v3/fx/EURUSD,GBPUSD,USDTRY,USDAZN?apikey=${this.apiKey}`,
      );
      return data.map(q => ({
        symbol: q.symbol.replace('/', ''),
        name: q.name ?? q.symbol,
        price: q.price,
        change24h: q.changesPercentage,
        marketCap: null,
        volume24h: q.volume ?? null,
        source: this.name,
        assetClass: 'forex' as const,
        lastUpdated: nowIso(),
      }));
    } catch {
      return [];
    }
  }

  override async getCommodities(): Promise<NormalizedAsset[]> {
    if (!this.enabled()) return [];
    try {
      const data = await fetchJson<FmpQuote[]>(
        `https://financialmodelingprep.com/api/v3/quotes/commodity?apikey=${this.apiKey}`,
      );
      return data
        .filter(q => /gold|silver/i.test(q.name) || /gold|silver/i.test(q.symbol))
        .slice(0, 2)
        .map(q => ({
          symbol: /gold/i.test(q.name) ? 'GOLD' : 'SILVER',
          name: q.name,
          price: q.price,
          change24h: q.changesPercentage,
          marketCap: null,
          volume24h: q.volume ?? null,
          source: this.name,
          assetClass: 'commodities' as const,
          lastUpdated: nowIso(),
        }));
    } catch {
      return [];
    }
  }
}
