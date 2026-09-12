import { logger } from "../lib/logger.js";
import { TtlCache } from "./cache.js";
import { CryptoPanicProvider } from "./providers/cryptoPanic.js";
import { NewsApiProvider } from "./providers/newsApi.js";
import { PublisherRssProvider } from "./providers/publisherRss.js";
import { RedditProvider } from "./providers/reddit.js";
import { XProvider } from "./providers/x.js";
import { YahooNewsProvider } from "./providers/yahooNews.js";
import { YouTubeProvider } from "./providers/youtube.js";
import type { CommentaryItem, CommentaryProvider, CommentaryQuery } from "./types.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Registry order is presentation order for ties only — the final list is sorted
 * by time. Adding a source is adding a line here; nothing else in the endpoint
 * knows which sources exist, which is the point of keeping them behind a
 * uniform interface.
 */
const PROVIDERS: CommentaryProvider[] = [
  new PublisherRssProvider(),
  new YahooNewsProvider(),
  new XProvider(),
  new CryptoPanicProvider(),
  new NewsApiProvider(),
  new YouTubeProvider(),
  new RedditProvider(),
];

const TTL_SECONDS = envInt("COMMENTARY_TTL_SECONDS", 600);
const MAX_ITEMS = envInt("COMMENTARY_MAX_ITEMS", 40);
const MAX_AGE_DAYS = envInt("COMMENTARY_MAX_AGE_DAYS", 60);
/** Ceiling on how long one request may wait for the slowest source. */
const PROVIDER_BUDGET_MS = envInt("COMMENTARY_PROVIDER_TIMEOUT_MS", 9_000);

const responseCache = new TtlCache<CommentaryItem[]>(TTL_SECONDS * 1000, 500);

function cacheKey(query: CommentaryQuery): string {
  return [
    query.symbol.toUpperCase(),
    (query.name ?? "").trim().toLowerCase(),
    (query.type ?? "").trim().toLowerCase(),
  ].join("|");
}

/**
 * Headlines are syndicated verbatim, so the same story arrives from several
 * sources under different URLs. Comparing on letters and digits alone survives
 * the punctuation and casing each outlet applies.
 */
function titleKey(item: CommentaryItem): string | null {
  const basis = item.title ?? item.text;
  const normalized = basis.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return normalized.length >= 25 ? normalized.slice(0, 120) : null;
}

/** The contract the frontend enforces, enforced here so it never has to. */
function isComplete(item: CommentaryItem): boolean {
  return Boolean(
    item.url?.startsWith("http") &&
    item.author?.trim() &&
    item.text?.trim() &&
    item.publishedAt &&
    !Number.isNaN(Date.parse(item.publishedAt)),
  );
}

async function runProvider(
  provider: CommentaryProvider,
  query: CommentaryQuery,
): Promise<CommentaryItem[]> {
  if (!provider.isEnabled()) return [];
  try {
    // Providers already fail soft; this is the backstop for one that hangs
    // rather than throws, so a single stalled upstream cannot hold the whole
    // response open.
    return await Promise.race([
      provider.fetch(query),
      new Promise<CommentaryItem[]>((resolve) =>
        setTimeout(() => resolve([]), PROVIDER_BUDGET_MS).unref?.(),
      ),
    ]);
  } catch (err) {
    logger.warn(
      { event: "commentary_provider_failed", provider: provider.name, err },
      "Commentary provider failed",
    );
    return [];
  }
}

export async function getCommentary(query: CommentaryQuery): Promise<CommentaryItem[]> {
  return responseCache.load(cacheKey(query), async () => {
    const started = Date.now();

    // allSettled, not all: one source being down is a normal Tuesday and must
    // never turn into an error for the caller.
    const settled = await Promise.allSettled(PROVIDERS.map(p => runProvider(p, query)));

    const collected: CommentaryItem[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") collected.push(...result.value);
    }

    const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
    const seenUrls = new Set<string>();
    const seenTitles = new Set<string>();
    const items: CommentaryItem[] = [];

    for (const item of collected) {
      if (!isComplete(item)) continue;
      if (Date.parse(item.publishedAt) < cutoff) continue;

      const urlKey = item.url.toLowerCase();
      if (seenUrls.has(urlKey)) continue;
      const tKey = titleKey(item);
      if (tKey && seenTitles.has(tKey)) continue;

      seenUrls.add(urlKey);
      if (tKey) seenTitles.add(tKey);
      items.push(item);
    }

    // Newest first. The frontend sorts too, but a response should not rely on
    // the client to be presentable.
    items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    const trimmed = items.slice(0, MAX_ITEMS);

    logger.info(
      {
        event: "commentary_assembled",
        symbol: query.symbol,
        type: query.type,
        raw: collected.length,
        returned: trimmed.length,
        ms: Date.now() - started,
      },
      "Commentary assembled",
    );

    return trimmed;
  });
}

/** Which sources are live in this deployment — useful when a panel looks thin. */
export function getCommentaryProviderStatus(): { name: string; enabled: boolean }[] {
  return PROVIDERS.map(p => ({ name: p.name, enabled: p.isEnabled() }));
}
