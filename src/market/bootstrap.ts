import { getMarketDataService as createService } from "../market-data";
import type { MarketDataService } from "../market-data";
import { logger } from "../lib/logger.js";

let servicePromise: Promise<MarketDataService> | null = null;

export async function getMarketDataService(): Promise<MarketDataService> {
  // Cache the promise so two concurrent first requests share one init
  // (the previous instance-after-await pattern opened duplicate Redis connections).
  if (!servicePromise) {
    servicePromise = createService({
      redisUrl: process.env.REDIS_URL,
      binanceBaseUrl: process.env.BINANCE_API_BASE ?? "https://api.binance.com/api/v3",
      alphaVantageKey: process.env.ALPHA_VANTAGE_API_KEY,
      fmpApiKey: process.env.FMP_API_KEY,
      log: (msg, meta) => logger.info({ ...meta, event: msg }),
    }).catch((err) => {
      servicePromise = null;
      throw err;
    });
  }
  return servicePromise;
}
