export type AssetClass = 'crypto' | 'stocks' | 'forex' | 'commodities';

export interface NormalizedAsset {
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  marketCap: number | null;
  volume24h: number | null;
  source: string;
  assetClass: AssetClass;
  lastUpdated: string;
}

export interface ProviderHealth {
  name: string;
  healthy: boolean;
  blacklisted: boolean;
  blacklistedUntil: number | null;
}

export interface MarketDataProvider {
  readonly name: string;
  readonly priority: number;
  readonly supportedClasses: readonly AssetClass[];

  getCryptoMarkets(symbols?: string[]): Promise<NormalizedAsset[]>;
  getStocks(symbols?: string[]): Promise<NormalizedAsset[]>;
  getForex(pairs?: string[]): Promise<NormalizedAsset[]>;
  getCommodities(): Promise<NormalizedAsset[]>;
  getAsset(symbol: string, assetClass: AssetClass): Promise<NormalizedAsset | null>;
  healthCheck(): Promise<boolean>;
}

export type ProviderErrorCode =
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'IP_BAN'
  | 'NETWORK'
  | 'INVALID_DATA'
  | 'UNKNOWN';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: ProviderErrorCode,
    readonly provider: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const CACHE_TTL_MS: Record<AssetClass, number> = {
  crypto: 20_000,
  stocks: 45_000,
  forex: 30_000,
  commodities: 45_000,
};

export const DEFAULT_CRYPTO_SYMBOLS = [
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK',
  'MATIC', 'LTC', 'SHIB', 'TRX', 'ATOM', 'UNI', 'XLM', 'ETC', 'FIL', 'APT',
];

export const DEFAULT_STOCK_SYMBOLS = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'TSLA', 'META', 'JPM', 'V', 'WMT',
];

export const DEFAULT_FOREX_PAIRS = [
  'EURUSD', 'GBPUSD', 'USDTRY', 'USDAZN', 'USDJPY',
];

export const COMMODITY_SYMBOLS = ['GOLD', 'SILVER', 'OIL', 'NATGAS'];

/** Human-readable names for known symbols */
export const ASSET_NAMES: Record<string, string> = {
  BTC: 'Bitcoin', ETH: 'Ethereum', BNB: 'BNB', SOL: 'Solana', XRP: 'XRP',
  DOGE: 'Dogecoin', ADA: 'Cardano', AVAX: 'Avalanche', DOT: 'Polkadot', LINK: 'Chainlink',
  AAPL: 'Apple', MSFT: 'Microsoft', NVDA: 'Nvidia', AMZN: 'Amazon',
  GOOGL: 'Google', TSLA: 'Tesla', META: 'Meta', JPM: 'JPMorgan', V: 'Visa', WMT: 'Walmart',
  GOLD: 'Gold', SILVER: 'Silver', OIL: 'Crude Oil', NATGAS: 'Natural Gas',
  USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound', TRY: 'Turkish Lira', AZN: 'Azerbaijani Manat',
};
