import { ASSET_NAMES, COMMODITY_SPECS } from "../market-data/types.js";
import type { CommentaryQuery, Sentiment } from "./types.js";

/**
 * Tickers that are also ordinary words or common abbreviations. A bare-ticker
 * match on any of these would pull in most of the feed, so they only ever
 * qualify through a cashtag or the asset's full name.
 */
const AMBIGUOUS_TICKERS = new Set([
  "ALL", "AND", "ANY", "ARE", "CAN", "FOR", "GET", "HAS", "HIS", "HOW", "ITS", "NEW", "NOT",
  "NOW", "ONE", "OUT", "OWN", "SEE", "SHE", "THE", "TWO", "USE", "WAS", "WAY", "WHO", "YOU",
  "CEO", "CFO", "ETF", "USD", "EUR", "GDP", "CPI", "API", "SEC", "FED", "IPO", "NFT", "USA",
  "EPS", "IRS", "LLC", "INC", "TOP", "BIG", "LOW", "BUY", "PAY", "RUN", "SET", "TON",
]);

const BULLISH = [
  "surge", "surges", "surged", "rally", "rallies", "rallied", "soar", "soars", "soared",
  "jump", "jumps", "jumped", "gain", "gains", "climb", "climbs", "climbed", "bullish",
  "all-time high", "record high", "breakout", "upgrade", "upgraded", "approval", "approved",
  "adoption", "inflow", "inflows", "accumulate", "accumulating", "outperform", "moon",
  "skyrocket", "spike", "spikes", "buy rating", "surging",
];

const BEARISH = [
  "plunge", "plunges", "plunged", "crash", "crashes", "crashed", "slump", "slumps",
  "tumble", "tumbles", "tumbled", "sink", "sinks", "sank", "bearish", "selloff", "sell-off",
  "liquidation", "liquidations", "hack", "hacked", "exploit", "lawsuit", "sue", "sued",
  "ban", "banned", "outflow", "outflows", "downgrade", "downgraded", "delist", "delisted",
  "fraud", "collapse", "collapsed", "warning", "plummet", "plummets", "slide", "slides",
];

export interface Relevance {
  /** Case-insensitive phrases: the asset's name and known aliases. */
  phrases: RegExp[];
  /** Case-sensitive bare ticker, only when the symbol is unambiguous enough. */
  bareTicker: RegExp | null;
  cashtag: RegExp;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A bare ticker is only trusted when it is long enough to be distinctive and
 * not a word in its own right — and even then only in its exact uppercase
 * form, which is how headlines write a ticker. "Boeing" gets found by name;
 * "BA" on its own would otherwise match half the newswire.
 */
function bareTickerPattern(symbol: string): RegExp | null {
  if (symbol.length < 3 || AMBIGUOUS_TICKERS.has(symbol)) return null;
  return new RegExp(`(?<![A-Z0-9])${escape(symbol)}(?![A-Z0-9])`);
}

export function buildRelevance(query: CommentaryQuery): Relevance {
  const symbol = query.symbol.toUpperCase();
  const type = (query.type ?? "").toLowerCase();
  const aliases = new Set<string>();

  if (query.name && query.name.trim().length >= 3) aliases.add(query.name.trim());
  // The market-data module already knows the display names for the instruments
  // this app lists, so a caller that omits ?name= still gets name matching.
  const known = ASSET_NAMES[symbol] ?? COMMODITY_SPECS[symbol]?.name;
  if (known && known.length >= 3) aliases.add(known);

  // Currency pairs are written with a slash everywhere except in tickers, so
  // EURUSD alone matches nothing in a headline that says "EUR/USD". Deriving
  // the spaced forms here means a caller does not have to know to pass ?name=
  // for forex to work at all.
  if (type === "forex" && /^[A-Z]{6}$/.test(symbol)) {
    const base = symbol.slice(0, 3);
    const quote = symbol.slice(3);
    aliases.add(`${base}/${quote}`);
    aliases.add(`${base}-${quote}`);
    aliases.add(`${base} ${quote}`);
  }

  return {
    phrases: [...aliases].map(a => new RegExp(`(?<![\\w])${escape(a)}(?![\\w])`, "i")),
    bareTicker: bareTickerPattern(symbol),
    cashtag: new RegExp(`\\$${escape(symbol)}(?![A-Za-z0-9])`, "i"),
  };
}

/** True when the combined text genuinely refers to this asset. */
export function isRelevant(relevance: Relevance, ...parts: (string | undefined)[]): boolean {
  const haystack = parts.filter(Boolean).join(" \n ");
  if (!haystack) return false;
  if (relevance.cashtag.test(haystack)) return true;
  if (relevance.phrases.some(p => p.test(haystack))) return true;
  return relevance.bareTicker?.test(haystack) ?? false;
}

/**
 * The stricter test: the asset has to be named in the headline.
 *
 * Sources that search the whole newswire need this. A passing mention of gold
 * in a macro piece about Bitcoin makes that piece a hit for "Gold" under the
 * looser test, but nobody would call it commentary on gold — whereas an outlet
 * that puts the asset in the headline is, by definition, writing about it.
 *
 * Sources that are already scoped to one instrument upstream use the looser
 * test instead, because the feed itself is the first piece of evidence.
 */
export function isHeadlineRelevant(relevance: Relevance, title: string | undefined): boolean {
  return Boolean(title) && isRelevant(relevance, title);
}

/**
 * A transparent keyword lean, not a claim of analysis. When the wording gives
 * no signal the field is left off entirely rather than asserting "neutral" —
 * the frontend treats it as optional, and an invented label is worse than none.
 */
export function detectSentiment(...parts: (string | undefined)[]): Sentiment | undefined {
  const haystack = parts.filter(Boolean).join(" ").toLowerCase();
  if (!haystack) return undefined;

  let up = 0;
  let down = 0;
  for (const word of BULLISH) if (haystack.includes(word)) up++;
  for (const word of BEARISH) if (haystack.includes(word)) down++;

  if (up === 0 && down === 0) return undefined;
  if (up > down) return "bullish";
  if (down > up) return "bearish";
  return "neutral";
}
