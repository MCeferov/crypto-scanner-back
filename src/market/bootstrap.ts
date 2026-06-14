import { getMarketDataService as createService } from "@workspace/market-data";
import type { MarketDataService } from "@workspace/market-data";
import { logger } from "../lib/logger.js";

let service: MarketDataService | null = null;

export async function getMarketDataService(): Promise<MarketDataService> {
  if (!service) {
    service = await createService({
      redisUrl: process.env.REDIS_URL,
      binanceBaseUrl: process.env.BINANCE_API_BASE ?? "https://api.binance.com/api/v3",
      alphaVantageKey: process.env.ALPHA_VANTAGE_API_KEY,
      fmpApiKey: process.env.FMP_API_KEY,
      log: (msg, meta) => logger.info({ ...meta, event: msg }),
    });
  }
  return service;
}
