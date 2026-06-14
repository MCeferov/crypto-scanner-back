import { BaseProvider } from './BaseProvider.js';
import type { NormalizedAsset } from '../types.js';
import { DEFAULT_STOCK_SYMBOLS } from '../types.js';
import { fetchJson, nowIso } from '../utils/http.js';
import { ProviderError } from '../types.js';

interface AvQuote {
  '05. price': string;
  '09. change': string;
  '10. change percent': string;
}

interface AvGlobalQuote {
  'Global Quote': AvQuote;
}

export class AlphaVantageProvider extends BaseProvider {
  readonly name = 'AlphaVantage';
  readonly priority = 2;
  readonly supportedClasses = ['stocks', 'forex'] as const;

  constructor(private readonly apiKey?: string) {
    super();
  }

  private enabled(): boolean {
    return Boolean(this.apiKey);
  }

  private async fetchQuote(symbol: string): Promise<NormalizedAsset | null> {
    if (!this.apiKey) return null;
    const data = await fetchJson<AvGlobalQuote>(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${this.apiKey}`,
    );
    const q = data['Global Quote'];
    if (!q?.['05. price']) return null;
    const changePct = parseFloat((q['10. change percent'] ?? '0').replace('%', ''));
    return {
      symbol: symbol.toUpperCase(),
      name: symbol,
      price: parseFloat(q['05. price']),
      change24h: changePct,
      marketCap: null,
      volume24h: null,
      source: this.name,
      assetClass: 'stocks',
      lastUpdated: nowIso(),
    };
  }

  override async getStocks(symbols = DEFAULT_STOCK_SYMBOLS): Promise<NormalizedAsset[]> {
    if (!this.enabled()) return [];
    try {
      const out: NormalizedAsset[] = [];
      for (const s of symbols.slice(0, 5)) {
        const q = await this.fetchQuote(s);
        if (q) out.push({ ...q, assetClass: 'stocks' });
        await new Promise(r => setTimeout(r, 300));
      }
      return out;
    } catch (err) {
      throw new ProviderError(err instanceof Error ? err.message : 'AlphaVantage failed', 'RATE_LIMIT', this.name);
    }
  }

  override async getForex(): Promise<NormalizedAsset[]> {
    if (!this.enabled()) return [];
    return [];
  }
}
