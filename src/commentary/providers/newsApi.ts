import { logger } from "../../lib/logger.js";
import { Cooldown, TtlCache } from "../cache.js";
import { canonicalUrl, cleanByline, fetchJson, publisherFromUrl, stableId } from "../http.js";
import { buildRelevance, detectSentiment, isHeadlineRelevant } from "../relevance.js";
import type { CommentaryItem, CommentaryProvider, CommentaryQuery } from "../types.js";

/**
 * NewsAPI.org general news search — the broadest of the key-gated sources and
 * the only one that covers equities as well as crypto.
 *
 * Off unless NEWSAPI_KEY is set. Note that NewsAPI's free tier is licensed for
 * development only; a production deployment needs a paid plan.
 */
const API_URL = "https://newsapi.org/v2/everything";

interface NewsApiArticle {
  source?: { name?: string };
  author?: string;
  title?: string;
  description?: string;
  url?: string;
  publishedAt?: string;
}

interface NewsApiResponse {
  status?: string;
  articles?: NewsApiArticle[];
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const cache = new TtlCache<CommentaryItem[]>(envInt("COMMENTARY_TTL_SECONDS", 600) * 1000, 256);
const cooldown = new Cooldown();

/**
 * Quote the name so "Bitcoin Cash" cannot match a story about cash, and only
 * fall back to the bare ticker when it is long enough to mean something on its
 * own — a search for "V" returns the newswire.
 */
function buildSearch(query: CommentaryQuery): string {
  const symbol = query.symbol.toUpperCase();
  const terms: string[] = [];
  if (query.name && query.name.trim().length >= 3) terms.push(`"${query.name.trim()}"`);
  if (symbol.length >= 4) terms.push(`"${symbol}"`);
  if (terms.length === 0) terms.push(`"${symbol}"`);
  return terms.join(" OR ");
}

export class NewsApiProvider implements CommentaryProvider {
  readonly name = "newsapi";

  isEnabled(): boolean {
    return Boolean(process.env.NEWSAPI_KEY);
  }

  async fetch(query: CommentaryQuery): Promise<CommentaryItem[]> {
    const key = process.env.NEWSAPI_KEY;
    if (!key) return [];
    if (cooldown.isCooling(this.name)) return [];

    const search = buildSearch(query);
    const relevance = buildRelevance(query);

    try {
      return await cache.load(search, async () => {
        const params = new URLSearchParams({
          q: search,
          language: "en",
          sortBy: "publishedAt",
          pageSize: String(envInt("NEWSAPI_PAGE_SIZE", 25)),
        });
        const body = await fetchJson<NewsApiResponse>(`${API_URL}?${params.toString()}`, {
          // The key travels in a header, never the query string: URLs end up in
          // proxy logs and error messages far more often than headers do.
          headers: { "X-Api-Key": key },
          timeoutMs: 8_000,
        });

        const items: CommentaryItem[] = [];
        for (const article of body.articles ?? []) {
          const url = article.url ? canonicalUrl(article.url) : null;
          const text = article.description?.trim() || article.title?.trim();
          if (!url || !text || !article.publishedAt) continue;
          if (!isHeadlineRelevant(relevance, article.title)) continue;

          const outlet = article.source?.name?.trim() || publisherFromUrl(url);
          const author = cleanByline(article.author, outlet ?? undefined) ?? outlet;
          if (!author) continue;

          const publishedAt = new Date(article.publishedAt);
          if (Number.isNaN(publishedAt.getTime())) continue;

          items.push({
            id: stableId("news", url),
            author,
            source: "news",
            sourceLabel: outlet ?? "News",
            title: article.title?.trim() || undefined,
            text,
            url,
            publishedAt: publishedAt.toISOString(),
            sentiment: detectSentiment(article.title, article.description),
          });
        }

        cooldown.recordSuccess(this.name);
        return items;
      });
    } catch (err) {
      cooldown.recordFailure(this.name);
      logger.warn({ event: "commentary_newsapi_failed", err }, "NewsAPI unavailable");
      return [];
    }
  }
}
