import type { IncomingMessage, ServerResponse } from "node:http";
import express, { type Express } from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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
if (isProd && !corsOrigin) {
  throw new Error("CORS_ORIGIN must be set in production");
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

export default app;
