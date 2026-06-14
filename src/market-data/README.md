# Market Data Layer — Multi-Provider Failover

## Folder Structure

```
lib/market-data/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                    # Public exports
    ├── types.ts                    # NormalizedAsset, Provider interface
    ├── cache/
    │   ├── ICacheService.ts
    │   ├── MemoryCacheService.ts
    │   ├── RedisCacheService.ts    # via ioredis
    │   └── createCache.ts          # Redis with memory fallback
    ├── failover/
    │   └── ProviderBlacklist.ts
    ├── providers/
    │   ├── BaseProvider.ts
    │   ├── BinanceProvider.ts      # priority 1 — crypto
    │   ├── CoinGeckoProvider.ts    # priority 2 — crypto
    │   ├── CoinCapProvider.ts      # priority 3 — crypto
    │   ├── YahooFinanceProvider.ts # priority 1 — stocks/forex/commodities
    │   ├── AlphaVantageProvider.ts # priority 2 — stocks (needs API key)
    │   └── FmpProvider.ts          # priority 3 — stocks/forex (needs API key)
    ├── services/
    │   ├── FailoverService.ts      # Chain + blacklist + cache
    │   └── MarketDataService.ts    # DI singleton
    └── utils/
        └── http.ts

artifacts/api-server/src/
├── market/bootstrap.ts             # DI wiring
└── routes/markets.ts               # REST endpoints

artifacts/crypto-heatmap/src/services/
└── marketApi.ts                    # Frontend client
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/markets/crypto` | Top crypto (failover: Binance → CoinGecko → CoinCap) |
| GET | `/api/markets/stocks` | Stocks (Yahoo → AlphaVantage → FMP) |
| GET | `/api/markets/forex` | Forex pairs |
| GET | `/api/markets/commodities` | Gold, Silver |
| GET | `/api/markets/asset/:symbol?class=crypto` | Single asset |
| GET | `/api/markets/health` | Provider + cache status |

## Failover Flow

1. Check Redis/memory cache (TTL: crypto 20s, stocks 45s, forex 30s)
2. Try providers sorted by priority (skip blacklisted)
3. On failure: blacklist provider (IP ban 15min, rate limit 5min)
4. Return stale cache if all providers fail (user sees no error)
5. Log `provider_success` / `provider_failed` / `cache_hit`

## Environment

```env
REDIS_URL=redis://localhost:6379   # optional — falls back to memory
ALPHA_VANTAGE_API_KEY=             # optional
FMP_API_KEY=                       # optional
```

## Run

```powershell
pnpm install
pnpm dev:api    # port 8080
$env:PORT="23508"; $env:BASE_PATH="/"; pnpm dev:web
```
