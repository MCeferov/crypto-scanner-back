import { logger } from "../../lib/logger.js";
import { Cooldown, TtlCache } from "../cache.js";
import { COMMENTARY_UA, fetchJson, stableId } from "../http.js";
import { buildRelevance, detectSentiment, isHeadlineRelevant } from "../relevance.js";
import type { CommentaryItem, CommentaryProvider, CommentaryQuery } from "../types.js";

/**
 * Reddit search. Off unless REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are set —
 * the anonymous JSON endpoints now answer 403 to server traffic, so there is no
 * keyless path worth shipping.
 *
 * Create a "script" app at https://www.reddit.com/prefs/apps to get the pair.
 */
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const SEARCH_URL = "https://oauth.reddit.com/search";

interface RedditChild {
  data?: {
    id?: string;
    author?: string;
    title?: string;
    selftext?: string;
    permalink?: string;
    created_utc?: number;
    subreddit?: string;
    score?: number;
    over_18?: boolean;
  };
}

interface RedditResponse {
  data?: { children?: RedditChild[] };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const cache = new TtlCache<CommentaryItem[]>(envInt("COMMENTARY_TTL_SECONDS", 600) * 1000, 256);
const cooldown = new Cooldown();

/** Access tokens last an hour; refreshed a minute early to avoid a race. */
let token: { value: string; expiresAt: number } | null = null;

async function getToken(): Promise<string | null> {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (token && Date.now() < token.expiresAt) return token.value;

  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": COMMENTARY_UA,
    },
    body,
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Reddit auth failed: HTTP ${res.status}`);

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Reddit auth returned no token");

  token = {
    value: json.access_token,
    expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000,
  };
  return token.value;
}

export class RedditProvider implements CommentaryProvider {
  readonly name = "reddit";

  isEnabled(): boolean {
    return Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
  }

  async fetch(query: CommentaryQuery): Promise<CommentaryItem[]> {
    if (!this.isEnabled()) return [];
    if (cooldown.isCooling(this.name)) return [];

    const search = query.name?.trim() ? `"${query.name.trim()}" OR "$${query.symbol}"` : `"$${query.symbol}"`;
    const relevance = buildRelevance(query);

    try {
      const items = await cache.load(search, async () => {
        const access = await getToken();
        if (!access) return [];

        const params = new URLSearchParams({
          q: search,
          sort: "new",
          limit: String(envInt("REDDIT_LIMIT", 25)),
          t: "week",
          type: "link",
        });
        const body = await fetchJson<RedditResponse>(`${SEARCH_URL}?${params.toString()}`, {
          headers: { Authorization: `Bearer ${access}` },
          timeoutMs: 8_000,
        });

        const results: CommentaryItem[] = [];
        for (const child of body.data?.children ?? []) {
          const post = child.data;
          const author = post?.author?.trim();
          const text = post?.selftext?.trim() || post?.title?.trim();
          if (!post?.permalink || !author || !text || post.created_utc === undefined) continue;
          // Deleted accounts leave no one to attribute the opinion to.
          if (author === "[deleted]" || author === "AutoModerator") continue;
          if (post.over_18) continue;
          if (!isHeadlineRelevant(relevance, post.title)) continue;

          const url = `https://www.reddit.com${post.permalink}`;
          results.push({
            id: stableId("reddit", url),
            author,
            handle: `u/${author}`,
            source: "reddit",
            sourceLabel: post.subreddit ? `r/${post.subreddit}` : "Reddit",
            title: post.title?.trim() || undefined,
            // Long self-posts are trimmed: the panel shows a quote, not an essay.
            text: text.length > 600 ? `${text.slice(0, 597)}...` : text,
            url,
            publishedAt: new Date(post.created_utc * 1000).toISOString(),
            sentiment: detectSentiment(post.title, post.selftext),
          });
        }
        return results;
      });

      cooldown.recordSuccess(this.name);
      return items;
    } catch (err) {
      cooldown.recordFailure(this.name);
      logger.warn({ event: "commentary_reddit_failed", err }, "Reddit search unavailable");
      return [];
    }
  }
}
