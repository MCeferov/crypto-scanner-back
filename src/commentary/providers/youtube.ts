import { logger } from "../../lib/logger.js";
import { Cooldown, TtlCache } from "../cache.js";
import { fetchJson, stableId } from "../http.js";
import { buildRelevance, detectSentiment, isHeadlineRelevant } from "../relevance.js";
import type { CommentaryItem, CommentaryProvider, CommentaryQuery } from "../types.js";

/**
 * YouTube Data API v3 search. Off unless YOUTUBE_API_KEY is set.
 *
 * The author here is the channel, which is exactly the unit a
 * recognised-voices panel cares about. YOUTUBE_CHANNELS narrows the search to a
 * curated set of channel ids when you would rather have five analysts you trust
 * than fifty thumbnails.
 */
const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";

interface YouTubeItem {
  id?: { videoId?: string };
  snippet?: {
    publishedAt?: string;
    channelTitle?: string;
    channelId?: string;
    title?: string;
    description?: string;
  };
}

interface YouTubeResponse {
  items?: YouTubeItem[];
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const cache = new TtlCache<CommentaryItem[]>(envInt("COMMENTARY_TTL_SECONDS", 600) * 1000, 256);
const cooldown = new Cooldown();

function channels(): string[] {
  return (process.env.YOUTUBE_CHANNELS ?? "")
    .split(",")
    .map(c => c.trim())
    .filter(c => /^UC[A-Za-z0-9_-]{20,24}$/.test(c))
    .slice(0, 10);
}

export class YouTubeProvider implements CommentaryProvider {
  readonly name = "youtube";

  isEnabled(): boolean {
    return Boolean(process.env.YOUTUBE_API_KEY);
  }

  async fetch(query: CommentaryQuery): Promise<CommentaryItem[]> {
    const key = process.env.YOUTUBE_API_KEY;
    if (!key) return [];
    if (cooldown.isCooling(this.name)) return [];

    const search = [query.name?.trim(), query.symbol.toUpperCase()].filter(Boolean).join(" ");
    const relevance = buildRelevance(query);
    const channelIds = channels();
    // One request per curated channel, or a single open search when none are set.
    const targets = channelIds.length ? channelIds : [""];

    try {
      const batches = await Promise.all(
        targets.map(channelId =>
          cache.load(`${search}|${channelId}`, async () => {
            const params = new URLSearchParams({
              part: "snippet",
              q: search,
              type: "video",
              order: "date",
              maxResults: String(envInt("YOUTUBE_MAX_RESULTS", 10)),
              relevanceLanguage: "en",
              key,
            });
            if (channelId) params.set("channelId", channelId);

            const body = await fetchJson<YouTubeResponse>(`${SEARCH_URL}?${params.toString()}`, {
              timeoutMs: 8_000,
            });

            const items: CommentaryItem[] = [];
            for (const entry of body.items ?? []) {
              const videoId = entry.id?.videoId;
              const snippet = entry.snippet;
              const author = snippet?.channelTitle?.trim();
              const text = snippet?.description?.trim() || snippet?.title?.trim();
              if (!videoId || !author || !text || !snippet?.publishedAt) continue;
              // YouTube search matches loosely; keep only videos that name the
              // asset in the title rather than merely ranking for it.
              if (!isHeadlineRelevant(relevance, snippet.title)) continue;

              const publishedAt = new Date(snippet.publishedAt);
              if (Number.isNaN(publishedAt.getTime())) continue;

              const url = `https://www.youtube.com/watch?v=${videoId}`;
              items.push({
                id: stableId("youtube", url),
                author,
                source: "youtube",
                sourceLabel: "YouTube",
                title: snippet.title?.trim() || undefined,
                text,
                url,
                publishedAt: publishedAt.toISOString(),
                sentiment: detectSentiment(snippet.title, snippet.description),
              });
            }
            return items;
          }),
        ),
      );

      cooldown.recordSuccess(this.name);
      return batches.flat();
    } catch (err) {
      cooldown.recordFailure(this.name);
      logger.warn({ event: "commentary_youtube_failed", err }, "YouTube search unavailable");
      return [];
    }
  }
}
