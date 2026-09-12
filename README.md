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
| GET | `/api/commentary?symbol=&name=&type=` | — |
| GET | `/api/commentary/sources` | — |
| POST | `/api/chat` | **Bearer** |

Authentication is a **Bearer token** in the `Authorization` header. No cookies
are used, so no cross-site cookie configuration is required.

## Commentary

`GET /api/commentary?symbol=DOGE&name=Dogecoin&type=crypto` gathers recent
commentary about one asset from whatever sources are configured and returns a
single flat list, newest first:

```json
{ "items": [
  { "id": "news-9f2c...", "author": "Jason Nelson", "source": "news",
    "sourceLabel": "Decrypt", "title": "...", "text": "...",
    "url": "https://decrypt.co/...", "publishedAt": "2026-09-11T16:16:05.000Z",
    "sentiment": "bearish" }
]}
```

Only `symbol` is required; `name` and `type` are context that sharpen matching.
`source` is one of `x | news | youtube | reddit | blog | other`, and `sentiment`
is omitted rather than guessed when the wording gives no signal.

**Sources.** Two work with no credentials and are always on — publisher RSS
feeds and Yahoo Finance's per-instrument headline feed, which between them cover
crypto, equities, FX and futures. X, CryptoPanic, NewsAPI, YouTube and Reddit
each switch themselves on when their key is set (see `.env.example`) and are
skipped silently otherwise. `GET /api/commentary/sources` reports which are
live. Adding a source means writing one class and adding a line to the registry
in `src/commentary/service.ts`; nothing else knows which sources exist.

**Guarantees the frontend can rely on.**

- Every item has a real `url`, `author` and `text`. Items missing any of them are
  dropped here rather than padded, and an asset with no coverage returns
  `items: []` — nothing is ever invented.
- Items are filtered for genuine relevance. Open feeds must name the asset in
  the headline; Yahoo's per-instrument feed, which mixes in sector coverage, must
  name it somewhere in the item.
- `publishedAt` is ISO-8601 and the list is sorted newest first.
- One source failing removes only its items. The endpoint answers 200 with
  whatever the rest produced.
- Answers are cached per asset (`COMMENTARY_TTL_SECONDS`, default 10 minutes)
  and feeds are cached once for all assets, so a hundred detail pages do not mean
  a hundred downloads of the same feed. Concurrent requests for one asset share a
  single upstream sweep.
- All credentials stay server-side; the SPA only ever calls this endpoint.

No avatar is returned: the response shape has no field for one, and the frontend
builds initials instead. If avatars are wanted later, they should be proxied
through this origin rather than added to the SPA's `img-src` allowlist.

## AI assistant

`POST /api/chat` is the in-app help chat: a thin LLM proxy that answers
questions about how the app works. Keys never leave the server.

```jsonc
// request
{
  "messages": [{ "role": "user", "content": "Skor sütunu nə deməkdir?" }],
  "context": { "path": "/coin/DOGEUSDT", "symbol": "DOGE", "locale": "az" }
}
```

The reply streams as SSE by default — `data: {"delta":"..."}` per chunk, then
`data: {"done":true}`. Send `Accept: application/json` or `"stream": false`
to get `{ "reply": "..." }` in one piece instead. `context` is optional:
`locale` (az/en/ru/tr) selects the answer language, `path` and `symbol` let
the answer refer to what is on screen.

### Provider

There is no provider lock-in. Every supported backend speaks the OpenAI
`/chat/completions` shape, so one client covers all of them and switching is an
environment variable — which matters when the reason you picked one was that it
was free this quarter.

| Provider | Key | Free tier |
|---|---|---|
| Google Gemini (default) | `GEMINI_API_KEY` | free, no card; best of these at az/ru/tr |
| Groq | `GROQ_API_KEY` | free, very fast, ~30 req/min |
| OpenRouter | `OPENROUTER_API_KEY` | free models, ~20 req/min and 50/day |
| Mistral | `MISTRAL_API_KEY` | free experimental tier |
| anything else | `CHAT_BASE_URL` | any OpenAI-compatible host, incl. a local Ollama |

The first key present wins, in that order; `CHAT_PROVIDER` forces one and
`CHAT_MODEL` overrides the model. `GET /api/chat/providers` reports which are
configured — booleans only, never a key. With no key at all the endpoint answers
503 and nothing else in the API is affected.

One privacy note worth knowing: Gemini's free tier may use prompts to improve
Google products. The panel only ever sends the question and the current route,
never account data — but if that is not acceptable, Groq or a self-hosted model
is the same one-variable switch.

### Behaviour

**Auth is required.** This route is metered, so it sits behind `authMiddleware`
and answers 401 without a valid Bearer token. The rate limit is keyed on the
authenticated user id rather than the IP, which means rotating
`X-Forwarded-For` buys nothing — 15 messages per user per minute by default,
with a global ceiling so one compromised account cannot run up the bill alone.

Only the last `CHAT_HISTORY_LIMIT` turns (default 12) are sent upstream, and any
leading assistant turns are dropped from that slice — the API rejects a
conversation that does not start with a user message.

The system prompt lives in `src/chat/systemPrompt.ts` and describes the actual
UI: the heatmap columns by their real labels, the signal latch rule, the detail
panel, the chart's indicator library, and the rule that the assistant explains
the system and general concepts but never gives financial advice or price
predictions. Stable knowledge comes first and per-request context last, so
providers that cache implicitly can reuse the prefix.

Errors never carry upstream detail: 401 unauthenticated, 400 malformed body, 429
rate limited, 503 when no provider key is set, 502 for an upstream failure. A
failure mid-stream arrives as `data: {"error":"..."}` with wording written for
the reader. Closing the connection aborts the upstream call, so an abandoned
answer stops being billed.

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
