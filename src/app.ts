import type { IncomingMessage, ServerResponse } from "node:http";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Behind Railway's router / the Vite dev proxy — needed for correct req.ip in rate limiting.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req: IncomingMessage & { id?: string | number }) {
        return {
          id: req.id,
          method: req.method,
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
const isProd = process.env.NODE_ENV === "production";
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
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  }),
);
logger.info(
  { cors: allowedOrigins.length > 0 ? allowedOrigins : "reflect-any (development)" },
  "CORS configured",
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

// Final safety net: without this, Express 5 renders an HTML stack trace
// for any route that throws outside its own try/catch.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err, url: req.url }, "Unhandled route error");
  if (res.headersSent) return;
  res.status(500).json({ message: "Internal server error" });
});

export default app;
