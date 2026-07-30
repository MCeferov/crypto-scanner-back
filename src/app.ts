import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

/**
 * Single-service deploy: when the built SPA is present the API also serves it,
 * so frontend and API share one origin (no CORS, no proxy hop, and the SSE
 * kline stream is not passed through a third-party edge with its own timeout).
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const staticDir = process.env.STATIC_DIR
  ?? path.join(repoRoot, "artifacts/crypto-heatmap/dist/public");
const serveStatic = existsSync(path.join(staticDir, "index.html"));

const app: Express = express();

// Behind the Vite dev proxy / platform router — needed for correct req.ip in rate limiting.
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
const corsOrigin = process.env.CORS_ORIGIN;
const isProd = process.env.NODE_ENV === "production";
// Same-origin deploys make cross-origin requests impossible, so CORS_ORIGIN is
// only mandatory when the frontend is hosted somewhere else.
if (isProd && !corsOrigin && !serveStatic) {
  throw new Error(
    "CORS_ORIGIN must be set in production when the API does not serve the frontend",
  );
}
app.use(
  cors({
    origin: corsOrigin ? corsOrigin.split(",").map((o) => o.trim()) : true,
    credentials: true,
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

if (serveStatic) {
  logger.info({ staticDir }, "Serving frontend");
  // Hashed asset filenames are immutable; index.html must never be cached or
  // clients keep booting an old bundle after a deploy.
  app.use(
    express.static(staticDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );
  // SPA fallback — client-side routing owns every non-API path.
  app.get(/.*/, (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

// Final safety net: without this, Express 5 renders an HTML stack trace
// for any route that throws outside its own try/catch.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err, url: req.url }, "Unhandled route error");
  if (res.headersSent) return;
  res.status(500).json({ message: "Internal server error" });
});

export default app;
