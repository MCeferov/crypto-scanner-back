import { logger } from "../../lib/logger.js";
import { COMMODITY_SPECS } from "../../market-data/types.js";
import { Cooldown, TtlCache } from "../cache.js";
import { canonicalUrl, cleanByline, fetchText, publisherFromUrl, stableId } from "../http.js";
import { buildRelevance, detectSentiment, isRelevant } from "../relevance.js";
import { parseRssItems, toIsoDate, type RssItem } from "../rss.js";
import type { CommentaryItem, CommentaryProvider, CommentaryQuery } from "../types.js";

/**
 * Yahoo Finance publishes a headline feed per instrument, which makes it the
 * one keyless source already scoped to the asset, and the only one that covers
 * crypto, equities, FX and futures alike.
 *
 * Its items carry no byline, so the author is the outlet the link points at.
 * Yahoo syndicates from Decrypt, Benzinga, Reuters and others, so that is
 * usually a real publisher name rather than "Yahoo".
 */
const FEED = "https://feeds.finance.yahoo.com/rss/2.0/headline";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const cache = new TtlCache<RssItem[]>(envInt("COMMENTARY_FEED_TTL_SECONDS", 600) * 1000, 256);
const cooldown = new Cooldown();

/**
 * Yahoo's ticker spelling per asset class. Commodities reuse the futures
 * symbols the market-data module already maintains, so the two can never drift
 * apart the way a second hand-written copy would.
 */
function yahooTicker(query: CommentaryQuery): string | null {
  const symbol = query.symbol.toUpperCase();
  const type = (query.type ?? "").toLowerCase();

  if (type === "crypto") return `${symbol}-USD`;
  if (type === "forex") return `${symbol.replace("/", "")}=X`;
  if (type === "commodity" || type === "commodities") {
    return COMMODITY_SPECS[symbol]?.yahoo ?? null;
  }
  if (type === "stock" || type === "stocks") return symbol;

  // No type given: a known commodity name wins, otherwise treat it as an
  // equity ticker, which is what a bare symbol means on Yahoo.
  return COMMODITY_SPECS[symbol]?.yahoo ?? symbol;
}

function toItem(raw: RssItem): CommentaryItem | null {
  const url = raw.link ? canonicalUrl(raw.link) : null;
  const publishedAt = toIsoDate(raw.pubDate);
  const text = raw.description || raw.title;
  if (!url || !publishedAt || !text) return null;

  const outlet = publisherFromUrl(url);
  const author = cleanByline(raw.author, outlet ?? undefined) ?? outlet;
  if (!author) return null;

  return {
    id: stableId("news", url),
    author,
    source: "news",
    sourceLabel: outlet ?? "Yahoo Finance",
    title: raw.title || undefined,
    text,
    url,
    publishedAt,
    sentiment: detectSentiment(raw.title, raw.description),
  };
}

export class YahooNewsProvider implements CommentaryProvider {
  readonly name = "yahoo-news";

  isEnabled(): boolean {
    return true;
  }

  async fetch(query: CommentaryQuery): Promise<CommentaryItem[]> {
    const ticker = yahooTicker(query);
    if (!ticker) return [];
    if (cooldown.isCooling(ticker)) return [];

    try {
      const raws = await cache.load(ticker, async () => {
        const url = `${FEED}?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
        const xml = await fetchText(url, { timeoutMs: 8_000 });
        return parseRssItems(xml, 40);
      });
      cooldown.recordSuccess(ticker);

      // The per-instrument feed turns out to include sector and peer coverage —
      // a GameStop story arrives on the BTC feed, PayPal on Visa's — so being
      // scoped upstream is evidence, not proof. The asset still has to be named
      // somewhere, but body text counts here (unlike the open feeds) because
      // the feed itself already vouches for the symbol.
      const relevance = buildRelevance(query);
      return raws
        .filter(raw => isRelevant(relevance, raw.title, raw.description))
        .map(toItem)
        .filter((i): i is CommentaryItem => i !== null);
    } catch (err) {
      cooldown.recordFailure(ticker);
      logger.warn({ event: "commentary_yahoo_failed", ticker, err }, "Yahoo headline feed unavailable");
      return [];
    }
  }
}
