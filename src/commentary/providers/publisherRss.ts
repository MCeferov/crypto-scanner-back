import { logger } from "../../lib/logger.js";
import { Cooldown, TtlCache } from "../cache.js";
import { canonicalUrl, cleanByline, fetchText, publisherFromUrl, stableId } from "../http.js";
import { buildRelevance, detectSentiment, isHeadlineRelevant } from "../relevance.js";
import { parseRssItems, type RssItem } from "../rss.js";
import { toIsoDate } from "../rss.js";
import type { CommentaryItem, CommentaryProvider, CommentaryQuery } from "../types.js";

/**
 * Publisher syndication feeds. These are the feeds outlets publish *in order to
 * be read this way*, which is why they are preferred over a news aggregator's
 * feed — several aggregators licence their output and forbid exactly this use.
 *
 * They also carry a real byline in dc:creator, so items from here name the
 * journalist rather than only the outlet.
 */
const FEEDS: { url: string; outlet: string }[] = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", outlet: "CoinDesk" },
  { url: "https://cointelegraph.com/rss", outlet: "Cointelegraph" },
  { url: "https://decrypt.co/feed", outlet: "Decrypt" },
  { url: "https://www.theblock.co/rss.xml", outlet: "The Block" },
  { url: "https://bitcoinmagazine.com/feed", outlet: "Bitcoin Magazine" },
  { url: "https://cryptoslate.com/feed/", outlet: "CryptoSlate" },
];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Keyed on the feed, not on the asset. One fetch of CoinDesk serves every
 * symbol asked about during the TTL — without this, a hundred different detail
 * pages would mean a hundred identical downloads of the same six feeds.
 */
const feedCache = new TtlCache<RssItem[]>(envInt("COMMENTARY_FEED_TTL_SECONDS", 600) * 1000, 64);
const cooldown = new Cooldown();

const FEED_CONCURRENCY = 3;

async function loadFeed(feed: { url: string; outlet: string }): Promise<RssItem[]> {
  if (cooldown.isCooling(feed.url)) return [];
  try {
    const items = await feedCache.load(feed.url, async () => {
      const xml = await fetchText(feed.url, { timeoutMs: 8_000 });
      return parseRssItems(xml, 60);
    });
    cooldown.recordSuccess(feed.url);
    return items;
  } catch (err) {
    cooldown.recordFailure(feed.url);
    logger.warn(
      { event: "commentary_feed_failed", outlet: feed.outlet, err },
      "Commentary feed unavailable",
    );
    return [];
  }
}

function toItem(raw: RssItem, outlet: string, query: CommentaryQuery): CommentaryItem | null {
  const url = raw.link ? canonicalUrl(raw.link) : null;
  const publishedAt = toIsoDate(raw.pubDate);
  // The frontend drops anything without a url, an author and text, so an item
  // missing one of them is dropped here instead of being padded out.
  const text = raw.description || raw.title;
  if (!url || !publishedAt || !text) return null;

  const author = cleanByline(raw.author, outlet) ?? publisherFromUrl(url) ?? outlet;
  if (!author) return null;

  return {
    id: stableId("news", url),
    author,
    source: "news",
    sourceLabel: publisherFromUrl(url) ?? outlet,
    title: raw.title || undefined,
    text,
    url,
    publishedAt,
    sentiment: detectSentiment(raw.title, raw.description),
  };
}

export class PublisherRssProvider implements CommentaryProvider {
  readonly name = "publisher-rss";

  isEnabled(): boolean {
    return true;
  }

  async fetch(query: CommentaryQuery): Promise<CommentaryItem[]> {
    const relevance = buildRelevance(query);
    const results: CommentaryItem[] = [];

    let next = 0;
    const workers = Array.from({ length: Math.min(FEED_CONCURRENCY, FEEDS.length) }, async () => {
      while (next < FEEDS.length) {
        const feed = FEEDS[next++];
        const raws = await loadFeed(feed);
        for (const raw of raws) {
          // These feeds cover the whole market, so the asset has to be named in
          // the headline — a mention buried in a piece about something else is
          // not commentary on this asset.
          if (!isHeadlineRelevant(relevance, raw.title)) continue;
          const item = toItem(raw, feed.outlet, query);
          if (item) results.push(item);
        }
      }
    });
    await Promise.all(workers);

    return results;
  }
}
