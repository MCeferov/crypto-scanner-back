import { createCacheService } from '../cache/createCache.js';
import { ProviderBlacklist } from '../failover/ProviderBlacklist.js';
import { AlphaVantageProvider } from '../providers/AlphaVantageProvider.js';
import { BinanceProvider } from '../providers/BinanceProvider.js';
import { CoinCapProvider } from '../providers/CoinCapProvider.js';
import { CoinGeckoProvider } from '../providers/CoinGeckoProvider.js';
import { FmpProvider } from '../providers/FmpProvider.js';
import { YahooFinanceProvider } from '../providers/YahooFinanceProvider.js';
import { FailoverService, type LogFn } from './FailoverService.js';
import type { AssetClass, NormalizedAsset, ProviderHealth } from '../types.js';

export interface MarketDataConfig {
  redisUrl?: string;
  binanceBaseUrl?: string;
  alphaVantageKey?: string;
  fmpApiKey?: string;
  log?: LogFn;
}

export class MarketDataService {
  private failover!: FailoverService;
  private closeCache: () => Promise<void> = async () => {};
  private cacheKind: 'redis' | 'memory' = 'memory';
  private initialized = false;

  async init(config: MarketDataConfig = {}): Promise<void> {
    if (this.initialized) return;

    const { cache, kind, close } = await createCacheService(config.redisUrl);
    this.closeCache = close;
    this.cacheKind = kind;

    const providers = [
      new BinanceProvider(config.binanceBaseUrl),
      new CoinGeckoProvider(),
      new CoinCapProvider(),
      new YahooFinanceProvider(),
      new AlphaVantageProvider(config.alphaVantageKey),
      new FmpProvider(config.fmpApiKey),
    ];

    this.failover = new FailoverService(
      providers,
      cache,
      new ProviderBlacklist(),
      config.log ?? (() => {}),
    );
    this.initialized = true;
    config.log?.('market_data_initialized', { cache: kind, providers: providers.map(p => p.name) });
  }

  async shutdown(): Promise<void> {
    await this.closeCache();
    this.initialized = false;
  }

  getCacheKind(): string {
    return this.cacheKind;
  }

  getProviderHealth(): ProviderHealth[] {
    return this.failover.getProviderHealth();
  }

  async getCryptoMarkets(symbols?: string[]): Promise<NormalizedAsset[]> {
    return this.failover.getCrypto(symbols);
  }

  async getStocks(symbols?: string[]): Promise<NormalizedAsset[]> {
    return this.failover.getStocks(symbols);
  }

  async getForex(pairs?: string[]): Promise<NormalizedAsset[]> {
    return this.failover.getForex(pairs);
  }

  async getCommodities(): Promise<NormalizedAsset[]> {
    return this.failover.getCommodities();
  }

  async getAsset(symbol: string, assetClass: AssetClass): Promise<NormalizedAsset | null> {
    return this.failover.getAsset(symbol, assetClass);
  }
}

/** Singleton for DI in api-server */
let instance: MarketDataService | null = null;

export async function getMarketDataService(config?: MarketDataConfig): Promise<MarketDataService> {
  if (!instance) {
    instance = new MarketDataService();
    await instance.init(config);
  }
  return instance;
}

export async function shutdownMarketDataService(): Promise<void> {
  if (instance) {
    await instance.shutdown();
    instance = null;
  }
}
