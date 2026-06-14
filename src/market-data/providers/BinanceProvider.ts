import { BaseProvider } from './BaseProvider.js';
import type { NormalizedAsset } from '../types.js';
import { fetchJson, nowIso } from '../utils/http.js';
import { ProviderError } from '../types.js';

interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}

export class BinanceProvider extends BaseProvider {
  readonly name = 'Binance';
  readonly priority = 1;
  readonly supportedClasses = ['crypto'] as const;
  private readonly baseUrl: string;

  constructor(baseUrl = 'https://api.binance.com/api/v3') {
    super();
    this.baseUrl = baseUrl;
  }

  override async getCryptoMarkets(symbols?: string[]): Promise<NormalizedAsset[]> {
    try {
      const tickers = await fetchJson<BinanceTicker[]>(`${this.baseUrl}/ticker/24hr`);
      const filtered = tickers.filter(t => t.symbol.endsWith('USDT'));

      const list = symbols?.length
        ? filtered.filter(t => symbols.some(s => t.symbol === `${s.toUpperCase()}USDT`))
        : filtered.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume)).slice(0, 100);

      return list.map(t => ({
          symbol: t.symbol.replace('USDT', ''),
          name: t.symbol.replace('USDT', ''),
          price: parseFloat(t.lastPrice),
          change24h: parseFloat(t.priceChangePercent),
          marketCap: null,
          volume24h: parseFloat(t.quoteVolume),
          source: this.name,
          assetClass: 'crypto' as const,
          lastUpdated: nowIso(),
        }));
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      throw new ProviderError(
        err instanceof Error ? err.message : 'Binance failed',
        status === 418 ? 'IP_BAN' : status === 429 ? 'RATE_LIMIT' : 'NETWORK',
        this.name,
      );
    }
  }
}
