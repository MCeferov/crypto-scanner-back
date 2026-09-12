/** Wire format for GET /api/commentary — the frontend contract, do not reshape. */
export type CommentarySource = "x" | "news" | "youtube" | "reddit" | "blog" | "other";

export type Sentiment = "bullish" | "bearish" | "neutral";

export interface CommentaryItem {
  /** Stable across requests: derived from the canonical URL, never random. */
  id: string;
  author: string;
  handle?: string;
  source: CommentarySource;
  sourceLabel: string;
  title?: string;
  /** Plain text. Never HTML — the frontend renders this directly. */
  text: string;
  /** Real link to the original. */
  url: string;
  /** ISO-8601. */
  publishedAt: string;
  sentiment?: Sentiment;
}

/** What the route asks a provider about. */
export interface CommentaryQuery {
  /** Uppercased ticker, e.g. DOGE, BTC, AAPL. Always present. */
  symbol: string;
  /** Full name when the caller knows it, e.g. "Dogecoin". */
  name?: string;
  /** crypto | stock | forex | commodity, when the caller knows it. */
  type?: string;
}

export interface CommentaryProvider {
  readonly name: string;
  /**
   * False when the provider needs credentials that are not configured. A
   * disabled provider is skipped silently — it is a deployment choice, not a
   * failure, and must never surface as an error to the caller.
   */
  isEnabled(): boolean;
  fetch(query: CommentaryQuery): Promise<CommentaryItem[]>;
}
