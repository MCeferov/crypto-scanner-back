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
  getCommodities(symbols?: string[]): Promise<NormalizedAsset[]>;
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
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'TSLA', 'GOOGL', 'META', 'AMD',
  'NFLX', 'INTC', 'JPM', 'V', 'MA', 'DIS', 'BA', 'KO',
  'PEP', 'WMT', 'XOM', 'PFE', 'BABA', 'UBER', 'COIN', 'PLTR',
];

export const DEFAULT_FOREX_PAIRS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD', 'EURGBP',
  'EURJPY', 'GBPJPY', 'AUDJPY', 'EURCHF', 'USDTRY', 'EURTRY', 'USDAZN', 'USDRUB',
  'USDCNY', 'USDINR', 'USDMXN', 'USDZAR', 'USDSEK', 'USDNOK',
];

export interface CommoditySpec {
  /** Yahoo Finance futures ticker */
  yahoo: string;
  name: string;
}

/**
 * The single source of truth for commodities: both the quote path
 * (YahooFinanceProvider) and the kline path (yahooKlineService) resolve tickers
 * through this map. They used to keep separate copies, which is why a symbol
 * could return a quote and still 404 on its chart.
 *
 * Keys are the public symbols the frontend builds asset ids from
 * (`commodity:GOLD`) and stores in localStorage favourites — never rename one.
 */
export const COMMODITY_SPECS: Record<string, CommoditySpec> = {
  GOLD:      { yahoo: 'GC=F', name: 'Gold' },
  SILVER:    { yahoo: 'SI=F', name: 'Silver' },
  OIL:       { yahoo: 'CL=F', name: 'Crude Oil' },
  NATGAS:    { yahoo: 'NG=F', name: 'Natural Gas' },
  COPPER:    { yahoo: 'HG=F', name: 'Copper' },
  PLATINUM:  { yahoo: 'PL=F', name: 'Platinum' },
  PALLADIUM: { yahoo: 'PA=F', name: 'Palladium' },
  BRENT:     { yahoo: 'BZ=F', name: 'Brent Crude Oil' },
  GASOLINE:  { yahoo: 'RB=F', name: 'RBOB Gasoline' },
  HEATOIL:   { yahoo: 'HO=F', name: 'Heating Oil' },
  WHEAT:     { yahoo: 'ZW=F', name: 'Wheat' },
  CORN:      { yahoo: 'ZC=F', name: 'Corn' },
  SOYBEAN:   { yahoo: 'ZS=F', name: 'Soybean' },
  SUGAR:     { yahoo: 'SB=F', name: 'Sugar' },
  COFFEE:    { yahoo: 'KC=F', name: 'Coffee' },
  COCOA:     { yahoo: 'CC=F', name: 'Cocoa' },
  COTTON:    { yahoo: 'CT=F', name: 'Cotton' },
  CATTLE:    { yahoo: 'LE=F', name: 'Live Cattle' },
};

export const COMMODITY_SYMBOLS: string[] = Object.keys(COMMODITY_SPECS);

/** Human-readable names for known symbols */
export const ASSET_NAMES: Record<string, string> = {
  BTC: 'Bitcoin', ETH: 'Ethereum', BNB: 'BNB', SOL: 'Solana', XRP: 'XRP',
  DOGE: 'Dogecoin', ADA: 'Cardano', AVAX: 'Avalanche', DOT: 'Polkadot', LINK: 'Chainlink',
  AAPL: 'Apple', MSFT: 'Microsoft', NVDA: 'Nvidia', AMZN: 'Amazon',
  GOOGL: 'Google', TSLA: 'Tesla', META: 'Meta', JPM: 'JPMorgan', V: 'Visa', WMT: 'Walmart',
  GOLD: 'Gold', SILVER: 'Silver', OIL: 'Crude Oil', NATGAS: 'Natural Gas',
  USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound', TRY: 'Turkish Lira', AZN: 'Azerbaijani Manat',
};
