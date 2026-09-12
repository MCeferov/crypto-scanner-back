import { Router, type IRouter, type Request, type Response } from "express";
import { getCommentary, getCommentaryProviderStatus } from "../commentary/service.js";
import { logger } from "../lib/logger.js";
import { sanitizeText } from "../lib/sanitize.js";
import { envInt, rateLimit } from "../middleware/rateLimit.js";

const router: IRouter = Router();

/**
 * Answers are cached per asset, so repeat traffic is nearly free — but a caller
 * walking through made-up symbols would still reach the metered sources once
 * each, and X in particular bills by the request. globalMax is the backstop for
 * that, since the per-client key ultimately comes from a header.
 */
const commentaryLimiter = rateLimit({
  windowMs: envInt("COMMENTARY_RATE_WINDOW_SECONDS", 60) * 1000,
  max: envInt("COMMENTARY_RATE_MAX", 30),
  globalMax: envInt("COMMENTARY_RATE_GLOBAL_MAX", 300),
  keyPrefix: "commentary",
});

/** Same ticker shape the market routes accept (BRK.B, BTCUSDT, DOGE). */
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,19}$/;
const VALID_TYPES = new Set(["crypto", "stock", "stocks", "forex", "commodity", "commodities"]);

/** Free text from the query string: length-bounded and stripped of controls. */
function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // sanitizeText drops control characters but keeps spacing, so multi-word
  // names like "Bitcoin Cash" survive intact.
  const value = sanitizeText(raw).slice(0, 60).trim();
  return value.length >= 2 ? value : undefined;
}

/**
 * GET /api/commentary?symbol=DOGE&name=Dogecoin&type=crypto
 *
 * Always 200 with an items array when the symbol is valid. A source being down
 * removes its items, never the response: a panel with fewer quotes is useful,
 * an error is not.
 */
router.get("/", commentaryLimiter, async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol ?? "").trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) {
    res.status(400).json({ error: "A valid symbol is required" });
    return;
  }

  const typeRaw = String(req.query.type ?? "").trim().toLowerCase();
  const type = VALID_TYPES.has(typeRaw) ? typeRaw : undefined;

  try {
    const items = await getCommentary({ symbol, name: cleanName(req.query.name), type });
    // Short client-side cache as well: the panel re-mounts on every navigation
    // back to a detail page, and that should not become a new request.
    res.setHeader("Cache-Control", `public, max-age=${envInt("COMMENTARY_TTL_SECONDS", 600)}`);
    res.json({ items });
  } catch (err) {
    // Only reachable if the aggregator itself breaks; individual sources are
    // already isolated. Still answer in the contract's shape.
    logger.error({ err, event: "commentary_failed", symbol }, "Commentary aggregation failed");
    res.json({ items: [] });
  }
});

/** Which sources are configured in this deployment. Booleans only, no keys. */
router.get("/sources", commentaryLimiter, (_req: Request, res: Response) => {
  res.json({ sources: getCommentaryProviderStatus() });
});

export default router;
