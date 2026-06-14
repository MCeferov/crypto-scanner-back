export type {
  AssetClass,
  NormalizedAsset,
  MarketDataProvider,
  ProviderHealth,
  ProviderErrorCode,
} from './types.js';
export { ProviderError, CACHE_TTL_MS, DEFAULT_CRYPTO_SYMBOLS, DEFAULT_STOCK_SYMBOLS } from './types.js';

export { MarketDataService, getMarketDataService, shutdownMarketDataService } from './services/MarketDataService.js';
export type { MarketDataConfig } from './services/MarketDataService.js';
export { FailoverService } from './services/FailoverService.js';

export { BinanceProvider } from './providers/BinanceProvider.js';
export { CoinGeckoProvider } from './providers/CoinGeckoProvider.js';
export { CoinCapProvider } from './providers/CoinCapProvider.js';
export { YahooFinanceProvider } from './providers/YahooFinanceProvider.js';
export { AlphaVantageProvider } from './providers/AlphaVantageProvider.js';
export { FmpProvider } from './providers/FmpProvider.js';

export { createCacheService } from './cache/createCache.js';
export type { ICacheService } from './cache/ICacheService.js';
