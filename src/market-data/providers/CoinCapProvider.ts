import { BaseProvider } from './BaseProvider.js';
import type { NormalizedAsset } from '../types.js';
import { DEFAULT_CRYPTO_SYMBOLS } from '../types.js';
import { fetchJson, nowIso } from '../utils/http.js';
import { ProviderError } from '../types.js';

interface CoinCapAsset {
  id: string;
  symbol: string;
  name: string;
  priceUsd: string;
  changePercent24Hr: string;
  marketCapUsd: string;
  volumeUsd24Hr: string;
}

interface CoinCapResponse {
  data: CoinCapAsset[];
}

export class CoinCapProvider extends BaseProvider {
  readonly name = 'CoinCap';
  readonly priority = 3;
  readonly supportedClasses = ['crypto'] as const;
  private readonly baseUrl = 'https://api.coincap.io/v2';

  override async getCryptoMarkets(symbols = DEFAULT_CRYPTO_SYMBOLS): Promise<NormalizedAsset[]> {
    try {
      const want = new Set(symbols.map(s => s.toUpperCase()));
      const data = await fetchJson<CoinCapResponse>(`${this.baseUrl}/assets?limit=200`);
      return data.data
        .filter(a => want.has(a.symbol.toUpperCase()))
        .map(a => ({
          symbol: a.symbol.toUpperCase(),
          name: a.name,
          price: parseFloat(a.priceUsd),
          change24h: parseFloat(a.changePercent24Hr),
          marketCap: parseFloat(a.marketCapUsd) || null,
          volume24h: parseFloat(a.volumeUsd24Hr) || null,
          source: this.name,
          assetClass: 'crypto' as const,
          lastUpdated: nowIso(),
        }));
    } catch (err) {
      throw new ProviderError(
        err instanceof Error ? err.message : 'CoinCap failed',
        'NETWORK',
        this.name,
      );
    }
  }
}
