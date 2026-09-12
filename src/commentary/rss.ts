/**
 * A deliberately small RSS 2.0 / Atom reader.
 *
 * Every feed this service consumes is a machine-generated syndication feed from
 * a major publisher, which is the narrow, well-formed corner of XML — so a
 * focused extractor earns its keep here over pulling in a general parser for
 * six fields. It is intentionally forgiving: a feed that changes shape should
 * yield fewer items, never throw.
 */

export interface RssItem {
  title?: string;
  link?: string;
  description?: string;
  author?: string;
  pubDate?: string;
  guid?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Feed descriptions routinely carry markup, and the contract with the frontend
 * is plain text, so tags come out before entities go in — decoding first would
 * turn an encoded &lt;script&gt; into a real tag on the way out.
 */
export function toPlainText(input: string | undefined): string {
  if (!input) return "";
  const strip = (s: string) =>
    s.replace(/<br\s*\/?>/gi, " ").replace(/<\/p>/gi, " ").replace(/<[^>]*>/g, "");
  // Stripped, decoded, then stripped again: a feed that writes &lt;script&gt;
  // would otherwise decode into a live tag after the only pass. Comparisons
  // like "BTC > 100k" survive, because only bracket pairs are removed.
  return decodeEntities(strip(input))
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapCdata(raw: string): string {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : raw;
}

/** First matching child element's raw inner text, CDATA unwrapped. */
function tagText(block: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, "i"));
    if (match) {
      const value = unwrapCdata(match[1]).trim();
      if (value) return value;
    }
  }
  return undefined;
}

/** Atom links live in an attribute rather than the element body. */
function atomLink(block: string): string | undefined {
  const alternate = block.match(/<link[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i)
    ?? block.match(/<link[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']alternate["']/i)
    ?? block.match(/<link[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
  return alternate ? decodeEntities(alternate[1]).trim() : undefined;
}

export function parseRssItems(xml: string, limit = 60): RssItem[] {
  if (!xml || xml.length > 8_000_000) return [];

  const blocks = xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  const items: RssItem[] = [];

  for (const block of blocks.slice(0, limit)) {
    // <link> in RSS holds the URL as text; in Atom it is an href attribute.
    const linkText = tagText(block, "link");
    const link = linkText && !linkText.startsWith("<") ? decodeEntities(linkText) : atomLink(block);

    items.push({
      title: toPlainText(tagText(block, "title")),
      link,
      description: toPlainText(
        tagText(block, "content:encoded", "description", "summary", "content"),
      ),
      author:
        toPlainText(tagText(block, "dc:creator", "author:name", "creator")) ||
        // Atom nests the display name inside <author><name>.
        toPlainText(tagText(tagText(block, "author") ?? "", "name")) ||
        undefined,
      pubDate: tagText(block, "pubDate", "published", "updated", "dc:date"),
      guid: tagText(block, "guid", "id"),
    });
  }

  return items;
}

/** RFC-822 and ISO dates both parse; anything else is dropped rather than guessed. */
export function toIsoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) return null;
  // A feed dated in the far future is a publisher bug, not news.
  if (parsed.getTime() > Date.now() + 86_400_000) return null;
  return parsed.toISOString();
}
