import { BaseProvider } from './BaseProvider.js';
import type { NormalizedAsset } from '../types.js';
import { DEFAULT_CRYPTO_SYMBOLS } from '../types.js';
import { fetchJson, nowIso } from '../utils/http.js';
import { ProviderError } from '../types.js';

interface CoinGeckoMarket {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  price_change_percentage_24h: number | null;
  market_cap: number | null;
  total_volume: number | null;
}

const SYMBOL_TO_ID: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana',
  XRP: 'ripple', DOGE: 'dogecoin', ADA: 'cardano', AVAX: 'avalanche-2',
  DOT: 'polkadot', LINK: 'chainlink', MATIC: 'matic-network', LTC: 'litecoin',
  SHIB: 'shiba-inu', TRX: 'tron', ATOM: 'cosmos', UNI: 'uniswap',
  XLM: 'stellar', ETC: 'ethereum-classic', FIL: 'filecoin', APT: 'aptos',
};

export class CoinGeckoProvider extends BaseProvider {
  readonly name = 'CoinGecko';
  readonly priority = 2;
  readonly supportedClasses = ['crypto'] as const;
  private readonly baseUrl = 'https://api.coingecko.com/api/v3';

  override async getCryptoMarkets(symbols = DEFAULT_CRYPTO_SYMBOLS): Promise<NormalizedAsset[]> {
    try {
      const ids = symbols.map(s => SYMBOL_TO_ID[s.toUpperCase()] ?? s.toLowerCase()).join(',');
      const data = await fetchJson<CoinGeckoMarket[]>(
        `${this.baseUrl}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false`,
      );
      return data.map(c => ({
        symbol: c.symbol.toUpperCase(),
        name: c.name,
        price: c.current_price,
        change24h: c.price_change_percentage_24h ?? 0,
        marketCap: c.market_cap,
        volume24h: c.total_volume,
        source: this.name,
        assetClass: 'crypto' as const,
        lastUpdated: nowIso(),
      }));
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      throw new ProviderError(
        err instanceof Error ? err.message : 'CoinGecko failed',
        status === 429 ? 'RATE_LIMIT' : 'NETWORK',
        this.name,
      );
    }
  }
}
