import { Router, type IRouter, type Request, type Response } from "express";
import type { AssetClass } from "@workspace/market-data";
import { getMarketDataService } from "../market/bootstrap.js";
import {
  batchFetchKlinesForAssets,
  fetchSingleAssetKlines,
  getKlineCacheStats,
  type KlineAsset,
  type KlineAssetType,
} from "../services/klineBatchService.js";

const router: IRouter = Router();

function parseSymbols(query: string | undefined): string[] | undefined {
  if (!query) return undefined;
  return query.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
}

function parseList(param: string | string[] | undefined): string[] {
  if (!param) return [];
  const raw = Array.isArray(param) ? param.join(",") : param;
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

const VALID_TYPES = new Set<KlineAssetType>(["crypto", "stock", "forex", "commodity"]);

function toKlineAsset(type: KlineAssetType, symbol: string): KlineAsset {
  const sym = symbol.toUpperCase();
  if (type === "crypto") {
    const trading = sym.endsWith("USDT") ? sym : `${sym}USDT`;
    const base = trading.replace(/USDT$/, "");
    return { id: `crypto:${base}`, symbol: trading, type: "crypto" };
  }
  return { id: `${type}:${sym}`, symbol: sym, type };
}

function parseAssetsParam(raw: string | undefined): KlineAsset[] {
  if (!raw) return [];
  return raw.split(",").map((entry) => {
    const colon = entry.indexOf(":");
    if (colon < 0) return null;
    const type = entry.slice(0, colon).toLowerCase() as KlineAssetType;
    const symbol = entry.slice(colon + 1).trim();
    if (!VALID_TYPES.has(type) || !symbol) return null;
    return toKlineAsset(type, symbol);
  }).filter((a): a is KlineAsset => a !== null);
}

function parseAssetsBody(body: unknown): KlineAsset[] {
  const assets = (body as { assets?: KlineAsset[] })?.assets;
  if (!Array.isArray(assets)) return [];
  return assets.filter(a =>
    a?.id && a?.symbol && VALID_TYPES.has(a.type),
  ).slice(0, 80);
}

/** GET /api/markets/klines/chart — tək asset chart datası */
router.get("/klines/chart", async (req: Request, res: Response) => {
  try {
    const type = String(req.query.type ?? "crypto").toLowerCase() as KlineAssetType;
    let symbol = String(req.query.symbol ?? "").toUpperCase();
    const interval = String(req.query.interval ?? "1h");
    const limit = Math.min(500, Math.max(20, Number(req.query.limit) || 200));

    if (!symbol || !VALID_TYPES.has(type)) {
      res.status(400).json({ error: "type and symbol required" });
      return;
    }
    if (type === "crypto" && !symbol.endsWith("USDT")) {
      symbol = `${symbol}USDT`;
    }

    const data = await fetchSingleAssetKlines(type, symbol, interval, limit);
    res.json({ data, type, symbol, interval, count: data.length });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "chart klines failed" });
  }
});

/** POST /api/markets/klines/batch — bir sorğuda bütün klines (server paralel) */
router.post("/klines/batch", async (req: Request, res: Response) => {
  try {
    const assets = parseAssetsBody(req.body);
    const intervals: string[] = req.body?.intervals ?? ["15m", "1h", "4h"];

    if (assets.length > 0) {
      const data = await batchFetchKlinesForAssets(assets, intervals);
      res.json({ data, count: Object.keys(data).length });
      return;
    }

    const symbols: string[] = req.body?.symbols ?? [];
    if (!symbols.length) {
      res.status(400).json({ error: "symbols or assets required" });
      return;
    }
    const legacyAssets: KlineAsset[] = symbols.map(sym => {
      const s = sym.endsWith("USDT") ? sym : `${sym}USDT`;
      const base = s.replace(/USDT$/, "");
      return { id: `crypto:${base}`, symbol: s, type: "crypto" as const };
    });
    const data = await batchFetchKlinesForAssets(legacyAssets.slice(0, 60), intervals);
    res.json({ data, count: Object.keys(data).length });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "batch failed" });
  }
});

/** GET /api/markets/klines/stream — SSE, hər asset hazır olanda göndər */
router.get("/klines/stream", async (req: Request, res: Response) => {
  const assetsParam = parseAssetsParam(req.query.assets as string | undefined);
  const intervals = parseList(req.query.intervals as string | undefined);
  const tfs = intervals.length ? intervals : ["15m", "1h", "4h"];

  let assets = assetsParam;
  if (!assets.length) {
    const symbols = parseList(req.query.symbols as string | undefined).map(s =>
      s.endsWith("USDT") ? s.toUpperCase() : `${s.toUpperCase()}USDT`,
    );
    assets = symbols.map(sym => {
      const base = sym.replace(/USDT$/, "");
      return { id: `crypto:${base}`, symbol: sym, type: "crypto" as const };
    });
  }

  if (!assets.length) {
    res.status(400).json({ error: "assets or symbols required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(": connected\n\n");

  try {
    await batchFetchKlinesForAssets(assets.slice(0, 80), tfs, (id, klines, done, total) => {
      res.write(`data: ${JSON.stringify({ id, klines, done, total })}\n\n`);
    });
    res.write(`data: ${JSON.stringify({ complete: true })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err instanceof Error ? err.message : "stream failed" })}\n\n`);
  }
  res.end();
});

router.get("/klines/stats", (_req: Request, res: Response) => {
  res.json(getKlineCacheStats());
});

router.get("/crypto", async (req: Request, res: Response) => {
  try {
    const svc = await getMarketDataService();
    const symbols = parseSymbols(req.query.symbols as string | undefined);
    const data = await svc.getCryptoMarkets(symbols);
    res.json({ data, source: data[0]?.source ?? "cache", count: data.length });
  } catch {
    res.status(200).json({ data: [], source: "none", count: 0 });
  }
});

router.get("/stocks", async (req: Request, res: Response) => {
  try {
    const svc = await getMarketDataService();
    const symbols = parseSymbols(req.query.symbols as string | undefined);
    const data = await svc.getStocks(symbols);
    res.json({ data, source: data[0]?.source ?? "cache", count: data.length });
  } catch {
    res.status(200).json({ data: [], source: "none", count: 0 });
  }
});

router.get("/forex", async (req: Request, res: Response) => {
  try {
    const svc = await getMarketDataService();
    const pairs = req.query.pairs
      ? (req.query.pairs as string).split(",").map(s => s.trim())
      : undefined;
    const data = await svc.getForex(pairs);
    res.json({ data, source: data[0]?.source ?? "cache", count: data.length });
  } catch {
    res.status(200).json({ data: [], source: "none", count: 0 });
  }
});

router.get("/commodities", async (_req: Request, res: Response) => {
  try {
    const svc = await getMarketDataService();
    const data = await svc.getCommodities();
    res.json({ data, source: data[0]?.source ?? "cache", count: data.length });
  } catch {
    res.status(200).json({ data: [], source: "none", count: 0 });
  }
});

router.get("/health", async (_req: Request, res: Response) => {
  const svc = await getMarketDataService();
  res.json({
    cache: svc.getCacheKind(),
    providers: svc.getProviderHealth(),
  });
});

router.get("/asset/:symbol", async (req: Request, res: Response) => {
  const assetClass = (req.query.class as AssetClass) ?? "crypto";
  const symbol = String(req.params.symbol);
  const svc = await getMarketDataService();
  const asset = await svc.getAsset(symbol, assetClass);
  if (!asset) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }
  res.json({ data: asset });
});

export default router;
