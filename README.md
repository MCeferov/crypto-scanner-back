# crypto-heatmap-backend

Express 5 + TypeScript API for the crypto market scanner: JWT authentication
(bcrypt + Prisma + PostgreSQL), a multi-provider market-data layer with
failover and caching, a Binance proxy, an SSE kline stream and i18n message
delivery.

The SPA lives in a separate repository (`crypto-heatmap-frontend`) and talks to
this service over HTTP only — this repo contains no frontend code.

## Requirements

- Node.js >= 22.12
- pnpm 11 (`corepack enable`)
- PostgreSQL (Neon, Supabase or Railway Postgres)

## Setup

```bash
pnpm install                 # runs `prisma generate` via postinstall
cp .env.example .env         # then fill in DATABASE_URL and JWT_SECRET
pnpm db:migrate              # apply migrations
```

## Local development

```bash
pnpm dev            # tsx watch, http://localhost:3000
```

Or run exactly what production runs:

```bash
pnpm build && pnpm start
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Watch mode via tsx |
| `pnpm build` | esbuild bundle → `dist/index.mjs` |
| `pnpm start` | Run the built bundle |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm db:migrate` | `prisma migrate deploy` (production-safe) |
| `pnpm db:migrate:dev` | Create + apply a migration in development |
| `pnpm db:generate` | Regenerate the Prisma client |
| `pnpm db:studio` | Prisma Studio |
| `pnpm db:test` | Verify the database connection |
| `pnpm create-user` | Create a user from the CLI |

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **yes** | PostgreSQL connection string. Neon/Supabase need `?sslmode=require`. Read by both the server and the Prisma CLI. |
| `JWT_SECRET` | **yes** | >= 32 characters. The server exits at boot otherwise. |
| `JWT_EXPIRES_IN` | no | Token lifetime, default `7d`. |
| `FRONTEND_URL` | **in production** | Comma-separated CORS allowlist of SPA origins. The server refuses to boot in production without it. `CORS_ORIGIN` is accepted as a legacy alias. |
| `PORT` | no | Listen port, default `3000`. Railway injects it. |
| `NODE_ENV` | no | `production` enables the strict CORS check. |
| `BINANCE_API_BASE` | no | Default `https://data-api.binance.vision/api/v3`. |
| `REDIS_URL` | no | Falls back to an in-process memory cache when unset. |

## API

| Method | Path | Auth |
|---|---|---|
| GET | `/api/healthz` | — |
| POST | `/api/auth/signup` (alias `/sign-up`) | — |
| POST | `/api/auth/login` (alias `/sign-in`) | — |
| POST | `/api/auth/logout` | Bearer |
| GET | `/api/auth/me` | Bearer |
| GET | `/api/binance/*` | — (proxy) |
| GET | `/api/markets/{crypto,stocks,forex,commodities}` | — |
| GET | `/api/markets/asset/:symbol` | — |
| GET | `/api/markets/klines/chart` | — |
| POST | `/api/markets/klines/batch` | — |
| GET | `/api/markets/klines/stream` | — (SSE) |
| GET | `/api/markets/klines/stats` | — |
| GET | `/api/markets/health` | — |
| GET | `/api/i18n/locales` | — |
| GET | `/api/i18n/messages/:lang` | — |

Authentication is a **Bearer token** in the `Authorization` header. No cookies
are used, so no cross-site cookie configuration is required.

## Deployment (Railway)

`railway.toml` is committed. Two things must be set in the dashboard:

1. **Region: `europe-west4`** (or any EU region). Binance answers HTTP 451 to
   US IPs, which breaks the entire market-data pipeline.
2. **Variables**: `DATABASE_URL`, `JWT_SECRET`, `FRONTEND_URL`,
   `NODE_ENV=production`, and optionally `BINANCE_API_BASE`, `REDIS_URL`.

Migrations run in `preDeployCommand`, so a failed migration aborts the rollout
instead of shipping a mismatched schema.

## Security

The API is public and unauthenticated for market data, so the controls are
layered rather than gate-shaped:

| Layer | Where | Notes |
|---|---|---|
| Security headers | `src/app.ts` (helmet) | `default-src 'none'`, `frame-ancestors 'none'`, nosniff, `no-referrer`, HSTS in production. CORP is `cross-origin` because the SPA is on another origin. |
| CORS allowlist | `src/app.ts` | Exact origins from `FRONTEND_URL`, never `*` — the responses allow credentials. |
| Rate limits | `src/middleware/rateLimit.ts` | Per-client budgets plus `globalMax` ceilings, all tunable by env. See `.env.example`. |
| Account lockout | `src/middleware/bruteForce.ts` | Keyed on the login address, with exponential backoff. Unlike the IP limits it cannot be sidestepped by rewriting a header. |
| Input validation | Zod, per route | Every body, query and path parameter. Symbols are matched against a strict character class before reaching an upstream URL. |
| Upstream protection | `src/services/*`, `src/routes/binance.ts` | TTL caches, request de-duplication, a concurrency gate on Yahoo, an allowlist of proxied Binance paths and parameters. |

### Verifying trust proxy

`TRUST_PROXY` is the one setting that can quietly disable the IP-keyed limits.
It must equal the number of proxies actually in front of the process. Too low
and every visitor collapses into one bucket; too high and a caller can put any
address it likes in `X-Forwarded-For` and be believed.

To check a deployment, watch for `rate_limit_exceeded` in the logs and compare
its `hops` field with `TRUST_PROXY`:

- `hops` consistently **equal to** `TRUST_PROXY` → correct.
- `hops` consistently **greater** → callers are appending their own
  `X-Forwarded-For` entries and the per-client key is forgeable. The account
  lockout and the `*_GLOBAL_MAX` ceilings still hold, but raise them in priority
  and pin the value down.

Until it is confirmed, keep the `*_GLOBAL_MAX` ceilings enabled — they are the
controls that do not depend on the client's address being honest.

## Notes

- Single replica by design: the kline cache, Binance proxy cache and rate-limit
  buckets are all in-process.
- Translations live in `src/i18n/` and are served over `/api/i18n/*`. The same
  source exists in the frontend repo; keep the two copies in sync.
