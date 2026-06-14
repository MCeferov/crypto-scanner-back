import type { ICacheService } from '../cache/ICacheService.js';
import { ProviderBlacklist } from '../failover/ProviderBlacklist.js';
import type {
  AssetClass,
  MarketDataProvider,
  NormalizedAsset,
  ProviderHealth,
} from '../types.js';
import { CACHE_TTL_MS, ProviderError } from '../types.js';

export type LogFn = (msg: string, meta?: Record<string, unknown>) => void;

const BAN_MS_BY_CODE: Record<string, number> = {
  IP_BAN: 15 * 60_000,
  RATE_LIMIT: 5 * 60_000,
  TIMEOUT: 2 * 60_000,
  NETWORK: 90_000,
  INVALID_DATA: 60_000,
};

export class FailoverService {
  constructor(
    private readonly providers: MarketDataProvider[],
    private readonly cache: ICacheService,
    private readonly blacklist: ProviderBlacklist,
    private readonly log: LogFn = () => {},
  ) {}

  getProviderHealth(): ProviderHealth[] {
    return this.providers.map(p => ({
      name: p.name,
      healthy: !this.blacklist.isBlacklisted(p.name),
      blacklisted: this.blacklist.isBlacklisted(p.name),
      blacklistedUntil: this.blacklist.getUntil(p.name),
    }));
  }

  private sorted(assetClass: AssetClass): MarketDataProvider[] {
    return [...this.providers]
      .filter(p => p.supportedClasses.includes(assetClass))
      .filter(p => !this.blacklist.isBlacklisted(p.name))
      .sort((a, b) => a.priority - b.priority);
  }

  private cacheKey(assetClass: AssetClass, suffix: string): string {
    return `market:${assetClass}:${suffix}`;
  }

  private handleFailure(provider: MarketDataProvider, err: unknown): void {
    const code = err instanceof ProviderError ? err.code : 'UNKNOWN';
    const banMs = BAN_MS_BY_CODE[code] ?? 60_000;
    this.blacklist.blacklist(provider.name, banMs);
    this.log('provider_failed', {
      provider: provider.name,
      code,
      blacklistedMs: banMs,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  async fetchWithFailover(
    assetClass: AssetClass,
    fetcher: (p: MarketDataProvider) => Promise<NormalizedAsset[]>,
    cacheSuffix: string,
  ): Promise<NormalizedAsset[]> {
    const key = this.cacheKey(assetClass, cacheSuffix);
    const cached = await this.cache.get<NormalizedAsset[]>(key);
    if (cached?.length) {
      this.log('cache_hit', { assetClass, key });
      return cached;
    }

    const chain = this.sorted(assetClass);
    for (const provider of chain) {
      try {
        const data = await fetcher(provider);
        if (data.length > 0) {
          await this.cache.set(key, data, CACHE_TTL_MS[assetClass]);
          this.log('provider_success', { provider: provider.name, assetClass, count: data.length });
          return data;
        }
      } catch (err) {
        this.handleFailure(provider, err);
      }
    }

    const stale = await this.cache.get<NormalizedAsset[]>(`${key}:stale`);
    if (stale?.length) {
      this.log('stale_fallback', { assetClass });
      return stale;
    }

    return [];
  }

  async saveStale(assetClass: AssetClass, suffix: string, data: NormalizedAsset[]): Promise<void> {
    if (data.length) {
      await this.cache.set(`${this.cacheKey(assetClass, suffix)}:stale`, data, 3600_000);
    }
  }

  async getCrypto(symbols?: string[]): Promise<NormalizedAsset[]> {
    const suffix = symbols?.join(',') ?? 'top';
    return this.fetchWithFailover('crypto', p => p.getCryptoMarkets(symbols), suffix);
  }

  async getStocks(symbols?: string[]): Promise<NormalizedAsset[]> {
    const suffix = symbols?.join(',') ?? 'default';
    return this.fetchWithFailover('stocks', p => p.getStocks(symbols), suffix);
  }

  async getForex(pairs?: string[]): Promise<NormalizedAsset[]> {
    const suffix = pairs?.join(',') ?? 'default';
    return this.fetchWithFailover('forex', p => p.getForex(pairs), suffix);
  }

  async getCommodities(): Promise<NormalizedAsset[]> {
    return this.fetchWithFailover('commodities', p => p.getCommodities(), 'default');
  }

  async getAsset(symbol: string, assetClass: AssetClass): Promise<NormalizedAsset | null> {
    const key = this.cacheKey(assetClass, `asset:${symbol.toUpperCase()}`);
    const cached = await this.cache.get<NormalizedAsset>(key);
    if (cached) return cached;

    const chain = this.sorted(assetClass);
    for (const provider of chain) {
      try {
        const asset = await provider.getAsset(symbol, assetClass);
        if (asset) {
          await this.cache.set(key, asset, CACHE_TTL_MS[assetClass]);
          this.log('provider_success', { provider: provider.name, assetClass, symbol });
          return asset;
        }
      } catch (err) {
        this.handleFailure(provider, err);
      }
    }
    return null;
  }
}
