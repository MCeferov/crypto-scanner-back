import { logger } from "../../lib/logger.js";
import { Cooldown, TtlCache } from "../cache.js";
import { fetchJson, stableId } from "../http.js";
import { detectSentiment } from "../relevance.js";
import type { CommentaryItem, CommentaryProvider, CommentaryQuery } from "../types.js";

/**
 * X (Twitter) API v2 recent search.
 *
 * Off unless X_BEARER_TOKEN is set. X search is metered and the paid tiers are
 * the expensive part of this endpoint, so results are cached for the full
 * commentary TTL and the query is built to be as narrow as the caller allows.
 *
 * X_ACCOUNTS turns this from "what is the timeline saying" into "what are these
 * specific people saying", which is what a recognised-voices panel actually
 * wants. Without it the search leans on verified accounts instead.
 */
const SEARCH_URL = "https://api.x.com/2/tweets/search/recent";

interface XUser {
  id: string;
  name?: string;
  username?: string;
}

interface XTweet {
  id: string;
  text?: string;
  created_at?: string;
  author_id?: string;
}

interface XResponse {
  data?: XTweet[];
  includes?: { users?: XUser[] };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const cache = new TtlCache<CommentaryItem[]>(envInt("COMMENTARY_TTL_SECONDS", 600) * 1000, 256);
const cooldown = new Cooldown(5 * 60_000, 60 * 60_000);

/** Curated handles, comma separated, with or without a leading @. */
function accounts(): string[] {
  return (process.env.X_ACCOUNTS ?? "")
    .split(",")
    .map(a => a.trim().replace(/^@/, ""))
    .filter(a => /^[A-Za-z0-9_]{1,15}$/.test(a))
    .slice(0, 25);
}

function buildQuery(query: CommentaryQuery): string {
  const symbol = query.symbol.toUpperCase();
  const terms = [`$${symbol}`, `#${symbol}`];
  if (query.name && query.name.trim().length >= 3) terms.push(`"${query.name.trim()}"`);
  const subject = `(${terms.join(" OR ")})`;

  const handles = accounts();
  const who = handles.length
    ? `(${handles.map(h => `from:${h}`).join(" OR ")})`
    : "is:verified";

  // Retweets and replies are noise in a "what are people saying" panel: the
  // first is someone else's words, the second is usually half a conversation.
  const filters = process.env.X_SEARCH_EXTRA ?? "-is:retweet -is:reply lang:en";
  return `${subject} ${who} ${filters}`.trim();
}

export class XProvider implements CommentaryProvider {
  readonly name = "x";

  isEnabled(): boolean {
    return Boolean(process.env.X_BEARER_TOKEN);
  }

  async fetch(query: CommentaryQuery): Promise<CommentaryItem[]> {
    const token = process.env.X_BEARER_TOKEN;
    if (!token) return [];

    const searchQuery = buildQuery(query);
    const key = searchQuery;
    if (cooldown.isCooling(this.name)) return [];

    try {
      return await cache.load(key, async () => {
        const params = new URLSearchParams({
          query: searchQuery,
          max_results: String(envInt("X_MAX_RESULTS", 25)),
          "tweet.fields": "created_at,author_id",
          expansions: "author_id",
          "user.fields": "name,username",
        });
        const body = await fetchJson<XResponse>(`${SEARCH_URL}?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: 8_000,
        });

        const users = new Map((body.includes?.users ?? []).map(u => [u.id, u]));
        const items: CommentaryItem[] = [];

        for (const tweet of body.data ?? []) {
          const user = tweet.author_id ? users.get(tweet.author_id) : undefined;
          const username = user?.username;
          const text = tweet.text?.trim();
          // Without a handle there is no real permalink to give, and the
          // contract says every item links to its original.
          if (!username || !text || !tweet.created_at) continue;

          const url = `https://x.com/${username}/status/${tweet.id}`;
          const publishedAt = new Date(tweet.created_at);
          if (Number.isNaN(publishedAt.getTime())) continue;

          items.push({
            id: stableId("x", url),
            author: user?.name?.trim() || username,
            handle: `@${username}`,
            source: "x",
            sourceLabel: "X",
            text,
            url,
            publishedAt: publishedAt.toISOString(),
            sentiment: detectSentiment(text),
          });
        }

        cooldown.recordSuccess(this.name);
        return items;
      });
    } catch (err) {
      cooldown.recordFailure(this.name);
      logger.warn({ event: "commentary_x_failed", err }, "X search unavailable");
      return [];
    }
  }
}
