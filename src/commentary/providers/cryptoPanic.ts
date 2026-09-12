import { logger } from "../../lib/logger.js";
import { Cooldown, TtlCache } from "../cache.js";
import { canonicalUrl, fetchJson, stableId } from "../http.js";
import { detectSentiment } from "../relevance.js";
import type { CommentaryItem, CommentaryProvider, CommentaryQuery, Sentiment } from "../types.js";

/**
 * CryptoPanic aggregates crypto newsrooms and, unusually, carries a community
 * vote per item — a far better sentiment signal than reading adjectives out of
 * a headline, so votes win over the keyword heuristic when they are present.
 *
 * Off unless CRYPTOPANIC_TOKEN is set.
 */
const API_URL = "https://cryptopanic.com/api/v1/posts/";

interface PanicPost {
  id?: number;
  title?: string;
  url?: string;
  published_at?: string;
  created_at?: string;
  source?: { title?: string; domain?: string };
  votes?: { positive?: number; negative?: number; important?: number };
}

interface PanicResponse {
  results?: PanicPost[];
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const cache = new TtlCache<CommentaryItem[]>(envInt("COMMENTARY_TTL_SECONDS", 600) * 1000, 256);
const cooldown = new Cooldown();

function votesToSentiment(votes: PanicPost["votes"]): Sentiment | undefined {
  const positive = votes?.positive ?? 0;
  const negative = votes?.negative ?? 0;
  if (positive === 0 && negative === 0) return undefined;
  if (positive > negative) return "bullish";
  if (negative > positive) return "bearish";
  return "neutral";
}

export class CryptoPanicProvider implements CommentaryProvider {
  readonly name = "cryptopanic";

  isEnabled(): boolean {
    return Boolean(process.env.CRYPTOPANIC_TOKEN);
  }

  async fetch(query: CommentaryQuery): Promise<CommentaryItem[]> {
    const token = process.env.CRYPTOPANIC_TOKEN;
    if (!token) return [];

    const type = (query.type ?? "crypto").toLowerCase();
    // The whole feed is crypto; asking it about an equity wastes a call.
    if (type !== "crypto" && type !== "") return [];
    if (cooldown.isCooling(this.name)) return [];

    const symbol = query.symbol.toUpperCase();

    try {
      return await cache.load(symbol, async () => {
        const params = new URLSearchParams({
          auth_token: token,
          currencies: symbol,
          public: "true",
        });
        const body = await fetchJson<PanicResponse>(`${API_URL}?${params.toString()}`, {
          timeoutMs: 8_000,
        });

        const items: CommentaryItem[] = [];
        for (const post of body.results ?? []) {
          const url = post.url ? canonicalUrl(post.url) : null;
          const text = post.title?.trim();
          const outlet = post.source?.title?.trim() || post.source?.domain?.trim();
          const when = post.published_at ?? post.created_at;
          if (!url || !text || !outlet || !when) continue;

          const publishedAt = new Date(when);
          if (Number.isNaN(publishedAt.getTime())) continue;

          items.push({
            id: stableId("news", url),
            author: outlet,
            source: "news",
            sourceLabel: outlet,
            title: post.title?.trim(),
            text,
            url,
            publishedAt: publishedAt.toISOString(),
            sentiment: votesToSentiment(post.votes) ?? detectSentiment(text),
          });
        }

        cooldown.recordSuccess(this.name);
        // The query is scoped by currency upstream, so no keyword re-filter.
        return items;
      });
    } catch (err) {
      cooldown.recordFailure(this.name);
      logger.warn({ event: "commentary_cryptopanic_failed", err }, "CryptoPanic unavailable");
      return [];
    }
  }
}
