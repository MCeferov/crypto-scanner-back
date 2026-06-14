import Redis from 'ioredis';
import type { ICacheService } from './ICacheService.js';
import { MemoryCacheService } from './MemoryCacheService.js';

export class RedisCacheService implements ICacheService {
  constructor(private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSec);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

export async function createCacheService(redisUrl?: string): Promise<{
  cache: ICacheService;
  kind: 'redis' | 'memory';
  close: () => Promise<void>;
}> {
  if (!redisUrl) {
    return {
      cache: new MemoryCacheService(),
      kind: 'memory',
      close: async () => {},
    };
  }

  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
    connectTimeout: 3_000,
  });

  try {
    await redis.connect();
    await redis.ping();
    return {
      cache: new RedisCacheService(redis),
      kind: 'redis',
      close: async () => { await redis.quit(); },
    };
  } catch {
    redis.disconnect();
    return {
      cache: new MemoryCacheService(),
      kind: 'memory',
      close: async () => {},
    };
  }
}
