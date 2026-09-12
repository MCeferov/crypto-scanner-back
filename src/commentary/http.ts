import { createHash } from "node:crypto";

/** Identifies the service to publishers; several feeds reject blank agents. */
export const COMMENTARY_UA =
  "Mozilla/5.0 (compatible; CryptoScannerBot/1.0; +https://coinaxtar.netlify.app)";

const DEFAULT_TIMEOUT_MS = 8_000;
/** A single feed is never worth more memory than this. */
const MAX_BODY_BYTES = 4_000_000;

export async function fetchText(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": COMMENTARY_UA, Accept: "*/*", ...opts.headers },
    redirect: "follow",
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${new URL(url).host}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const body = await res.text();
  if (body.length > MAX_BODY_BYTES) {
    throw new Error(`Response too large from ${new URL(url).host}`);
  }
  return body;
}

export async function fetchJson<T>(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<T> {
  const text = await fetchText(url, {
    ...opts,
    headers: { Accept: "application/json", ...opts.headers },
  });
  return JSON.parse(text) as T;
}

/**
 * Stable id for an item: the same article must keep the same id across
 * requests and across restarts, because the frontend keys its list on it.
 * Derived from the canonical URL, which is the one thing every source has.
 */
export function stableId(source: string, url: string): string {
  return `${source}-${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
}

/**
 * Query strings on syndicated links are tracking noise (?utm_source=rss_feed,
 * ?.tsrc=rss). Removing them keeps ids stable when a publisher changes its
 * campaign tags, and makes cross-source de-duplication actually work.
 */
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_|ref$|ref_|source$|\.tsrc$|cmpid$|smid$)/i;

export function canonicalUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

const PUBLISHER_LABELS: Record<string, string> = {
  "coindesk.com": "CoinDesk",
  "cointelegraph.com": "Cointelegraph",
  "decrypt.co": "Decrypt",
  "theblock.co": "The Block",
  "bitcoinmagazine.com": "Bitcoin Magazine",
  "cryptoslate.com": "CryptoSlate",
  "finance.yahoo.com": "Yahoo Finance",
  "yahoo.com": "Yahoo Finance",
  "benzinga.com": "Benzinga",
  "reuters.com": "Reuters",
  "bloomberg.com": "Bloomberg",
  "cnbc.com": "CNBC",
  "marketwatch.com": "MarketWatch",
  "investors.com": "Investor's Business Daily",
  "barrons.com": "Barron's",
  "fool.com": "The Motley Fool",
  "insidermonkey.com": "Insider Monkey",
  "zacks.com": "Zacks",
  "businessinsider.com": "Business Insider",
  "ft.com": "Financial Times",
  "wsj.com": "The Wall Street Journal",
  "forbes.com": "Forbes",
  "techcrunch.com": "TechCrunch",
  "theverge.com": "The Verge",
  "protos.com": "Protos",
  "blockworks.co": "Blockworks",
  "dlnews.com": "DL News",
  "ambcrypto.com": "AMBCrypto",
  "beincrypto.com": "BeInCrypto",
  "newsbtc.com": "NewsBTC",
  "u.today": "U.Today",
  "cryptobriefing.com": "Crypto Briefing",
  "coingape.com": "CoinGape",
  "watcher.guru": "Watcher.Guru",
  "thestreet.com": "TheStreet",
  "seekingalpha.com": "Seeking Alpha",
};

/**
 * The outlet behind a link, used as the author when a feed carries no byline.
 * That is a statement of fact about where the piece was published, not an
 * invented attribution.
 */
export function publisherFromUrl(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    if (PUBLISHER_LABELS[host]) return PUBLISHER_LABELS[host];

    const parent = Object.keys(PUBLISHER_LABELS).find(
      known => host === known || host.endsWith(`.${known}`),
    );
    if (parent) return PUBLISHER_LABELS[parent];

    // Unknown outlet: title-case the registrable-ish part rather than drop the
    // item, so a new syndication partner still produces a usable byline.
    const bare = host.replace(/\.(com|co|io|net|org|news|xyz|guru|today|to|uk|us)(\.[a-z]{2})?$/, "");
    const label = bare.split(".").pop() ?? bare;
    if (!label) return null;
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    return null;
  }
}

/** "Cointelegraph by Nate Kostar" -> "Nate Kostar". */
export function cleanByline(raw: string | undefined, outlet?: string): string | undefined {
  if (!raw) return undefined;
  let value = raw.trim();
  value = value.replace(/^(?:by\s+)/i, "");
  if (outlet) {
    const escaped = outlet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    value = value.replace(new RegExp(`^${escaped}\\s+by\\s+`, "i"), "");
  }
  value = value.replace(/^[A-Za-z][\w.'-]*(?:\s[\w.'-]+)?\s+by\s+/i, "");
  value = value.trim();
  return value.length >= 2 && value.length <= 80 ? value : undefined;
}
