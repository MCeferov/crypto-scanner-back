import { Router, type IRouter } from "express";

const router: IRouter = Router();
const BINANCE_BASE = "https://api.binance.com/api/v3";

const cache = new Map<string, { at: number; status: number; body: string; contentType: string | null }>();

function cacheTtl(path: string): number {
  if (path === "ticker/24hr") return 30_000;
  if (path === "klines") return 12_000;
  return 0;
}

router.get(/.*/, async (req, res) => {
  const subPath = req.path.replace(/^\//, "");
  const qs = new URLSearchParams(
    req.query as Record<string, string>,
  ).toString();
  const url = `${BINANCE_BASE}/${subPath}${qs ? `?${qs}` : ""}`;
  const cacheKey = url;
  const ttl = cacheTtl(subPath);

  if (ttl > 0) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttl) {
      res.status(hit.status);
      if (hit.contentType) res.setHeader("Content-Type", hit.contentType);
      res.send(hit.body);
      return;
    }
  }

  try {
    const response = await fetch(url);
    const body = await response.text();
    const contentType = response.headers.get("content-type");
    if (ttl > 0 && response.ok) {
      cache.set(cacheKey, { at: Date.now(), status: response.status, body, contentType });
    }
    res.status(response.status);
    if (contentType) res.setHeader("Content-Type", contentType);
    res.send(body);
  } catch {
    res.status(502).json({ error: "Binance proxy unreachable" });
  }
});

export default router;
