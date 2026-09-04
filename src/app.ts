import type { IncomingMessage, ServerResponse } from "node:http";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { envInt, rateLimit } from "./middleware/rateLimit";

const app: Express = express();
const isProd = process.env.NODE_ENV === "production";

/**
 * Railway terminates TLS in front of this process, so X-Forwarded-* has to be
 * honoured for req.ip and req.protocol to mean anything at all.
 *
 * The hop count is security-relevant, not cosmetic: set it higher than the
 * number of proxies actually in front of the app and a client can put whatever
 * it likes in X-Forwarded-For and have Express believe it, which silently
 * defeats every IP-keyed control. It is configurable because the correct value
 * is a property of the deployment, not of the code — see README.
 */
const trustProxyRaw = process.env.TRUST_PROXY ?? "1";
app.set(
  "trust proxy",
  /^\d+$/.test(trustProxyRaw) ? Number(trustProxyRaw)
  : trustProxyRaw === "false" ? false
  : trustProxyRaw === "true" ? true
  : trustProxyRaw,
);
app.disable("x-powered-by");

/**
 * This service answers JSON and nothing else, so the policy is the restrictive
 * one: no scripts, no framing, no form targets. It matters even for an API —
 * a browser that is talked into rendering a response as a document should find
 * nothing it is willing to execute.
 *
 * Two defaults are deliberately overridden:
 *  - CORP must be cross-origin, because the SPA lives on another origin and
 *    the browser would otherwise refuse to hand it the response body.
 *  - COEP is off; it buys nothing for a JSON API and breaks embedders.
 */
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        "base-uri": ["'none'"],
        "form-action": ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
    // Only meaningful over HTTPS, and asserting it in development would pin
    // localhost to a scheme it does not serve.
    hsts: isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: false } : false,
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req: IncomingMessage & { id?: string | number }) {
        return {
          id: req.id,
          method: req.method,
          // Query strings are dropped: they are the one place a token or key
          // reaches the server somewhere a log would keep it.
          url: req.url?.split("?")[0],
        };
      },
      res(res: ServerResponse) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

/**
 * This API runs on its own origin (Railway) and the SPA on another (Netlify),
 * so CORS is the only thing standing between the browser and the API.
 * FRONTEND_URL is a comma-separated allowlist of exact origins; CORS_ORIGIN is
 * accepted as a legacy alias.
 *
 * In development an unset value means "reflect any origin", which keeps
 * localhost and LAN testing frictionless. In production an empty allowlist is
 * a configuration error, not a reason to open the API to every site on the
 * internet — so the server refuses to boot.
 */
const rawOrigins = process.env.FRONTEND_URL ?? process.env.CORS_ORIGIN ?? "";
const allowedOrigins = rawOrigins
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

if (isProd && allowedOrigins.length === 0) {
  throw new Error(
    "FRONTEND_URL must be set in production — it is the CORS allowlist for the SPA origin(s), e.g. https://crypto-heatmap.netlify.app",
  );
}

app.use(
  cors({
    // An explicit list, never a wildcard: credentials are allowed on these
    // responses, and the two are not permitted to combine.
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
    // The API only ever reads and posts; advertising the rest invites probing.
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    // Lets the SPA surface throttling to the user instead of guessing.
    exposedHeaders: ["Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining"],
    maxAge: 86_400,
  }),
);
logger.info(
  { cors: allowedOrigins.length > 0 ? allowedOrigins : "reflect-any (development)" },
  "CORS configured",
);

/**
 * A floor under every /api route, including ones added later that forget their
 * own limiter. Generous on purpose — the per-endpoint limiters do the tight
 * work; this only stops a single client from monopolising the process. The
 * platform health check is exempt so throttling can never mark the service down.
 */
app.use(
  "/api",
  rateLimit({
    windowMs: envInt("API_RATE_WINDOW_SECONDS", 60) * 1000,
    max: envInt("API_RATE_MAX", 300),
    keyPrefix: "api:general",
    skip: (req) => req.path === "/healthz",
  }),
);

app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

app.use("/api", router);

// Unknown /api/* paths must return JSON, not Express's HTML 404 page —
// the frontend always calls res.json() on responses.
app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ message: "Not found" });
});

// API-only service; the SPA is hosted separately. A bare root request (uptime
// pings, someone opening the Railway URL) gets a useful JSON answer instead of
// an Express HTML 404.
app.get("/", (_req: Request, res: Response) => {
  res.json({ service: "crypto-heatmap-backend", health: "/api/healthz" });
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ message: "Not found" });
});

/**
 * Final safety net: without this, Express 5 renders an HTML stack trace for any
 * route that throws outside its own try/catch.
 *
 * Body-parser failures are separated out because they are the caller's fault,
 * not the server's — answering a truncated JSON body with 500 both misleads the
 * client and buries a real 500 in the noise.
 */
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const type = (err as { type?: string } | null)?.type;

  if (type === "entity.too.large") {
    logger.warn({ event: "request_too_large", url: req.url }, "Rejected oversized request body");
    res.status(413).json({ message: "Request body too large" });
    return;
  }
  if (type === "entity.parse.failed" || type === "encoding.unsupported" || err instanceof SyntaxError) {
    res.status(400).json({ message: "Malformed request body" });
    return;
  }

  logger.error({ err, url: req.url?.split("?")[0] }, "Unhandled route error");
  if (res.headersSent) return;
  // Never the message, never the stack: both routinely name internal hosts,
  // file paths and driver internals.
  res.status(500).json({ message: "Internal server error" });
});

export default app;
