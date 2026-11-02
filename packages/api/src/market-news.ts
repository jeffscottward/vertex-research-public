import {
  MARKET_NEWS_HEADLINE_TAGS,
  MARKET_NEWS_MAX_TICKERS,
  type MarketNewsFiling,
  type MarketNewsFilingItem,
  MarketNewsFilingSchema,
  type MarketNewsHeadline,
  MarketNewsHeadlineSchema,
  type MarketNewsHeadlineTag,
} from "./contracts/market-news.ts";

// Pure parsing and tagging for the watchlist news monitor. The Worker runtime has no DOMParser,
// so a small strict scanner reads <item>/<entry> blocks; every parsed record is Zod-validated and
// invalid records are dropped. 8-K item labels, the important-item set and the keyword-tag idea
// are adapted from day-trader-skill trader-news/news.py (MIT, Jake Schincariol, commit 3d0f4ef).

export class MarketNewsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketNewsParseError";
  }
}

/** SEC 8-K item number -> short plain label. */
export const ITEMS_8K: Readonly<Record<string, string>> = Object.freeze({
  "1.01": "material agreement",
  "1.02": "agreement ended",
  "1.03": "bankruptcy",
  "1.05": "cybersecurity incident",
  "2.01": "acquisition or sale of assets",
  "2.02": "earnings results",
  "2.03": "new debt",
  "2.04": "debt acceleration",
  "2.05": "restructuring costs",
  "2.06": "impairment",
  "3.01": "delisting notice",
  "3.02": "unregistered share sale",
  "3.03": "shareholder rights change",
  "4.01": "auditor change",
  "4.02": "past financials no longer reliable",
  "5.01": "change in control",
  "5.02": "director or officer change",
  "5.03": "bylaws or fiscal year change",
  "5.07": "shareholder vote results",
  "7.01": "Regulation FD disclosure",
  "8.01": "other events",
  "9.01": "exhibits",
});

/** 8-K items that usually move a stock: the filing is flagged important. */
export const IMPORTANT_8K_ITEMS: Readonly<Record<string, true>> = Object.freeze(
  {
    "1.03": true,
    "1.05": true,
    "2.02": true,
    "2.04": true,
    "2.06": true,
    "3.01": true,
    "4.02": true,
    "5.01": true,
    "5.02": true,
  }
);

// Case-insensitive keyword rules, matched on the headline title and description.
const HEADLINE_TAG_RULES: Readonly<Record<MarketNewsHeadlineTag, RegExp>> = {
  analyst:
    /\bupgrade[sd]?\b|\bdowngrade[sd]?\b|\bprice target\b|\boutperform\b|\bunderperform\b|\binitiates? coverage\b/iu,
  deal: /\bacqui(?:re|res|red|ring|sition)s?\b|\bmergers?\b|\bbuyout\b|\btakeover\b|\bdeal\b|\bM&A\b/iu,
  // Strong earnings words only; "results" or "revenue" alone tag too many market wraps.
  earnings:
    /\bearnings\b|\bEPS\b|\b(?:quarterly|Q[1-4]) (?:results|profit|loss|revenue|sales)\b|\b(?:beats?|miss(?:es)?|tops?) (?:estimates|expectations)\b/iu,
  executive:
    /\bCEO\b|\bCFO\b|\bCOO\b|\bchief executive\b|\bresign|\bsteps? down\b|\bappoint|\bsuccessor\b/iu,
  guidance: /\bguidance\b|\bforecasts?\b|\boutlook\b/iu,
  legal:
    /\blawsuits?\b|\bsue[sd]?\b|\bprobe\b|\binvestigation\b|\bSEC charges\b|\bantitrust\b|\bjudge\b|\bcourt\b|\bFDA\b|\bFTC\b|\bDOJ\b|\bregulators?\b|\bsettlement\b/iu,
  offering:
    /\boffering\b|\bshare sale\b|\bconvertible notes?\b|\bdilut(?:e|es|ed|ion|ive)\b/iu,
};

/** The ticker a feed belongs to; `name` is the SEC company title when known. */
export type HeadlineSubject = Readonly<{ symbol: string; name: string | null }>;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// Legal-form words and state tags ("/DE/") that headlines never repeat.
const COMPANY_FORM_WORDS =
  /\b(?:inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|llc|lp|n\.v|s\.a|ag|se|the)\b\.?/giu;

/**
 * Matches a headline that names the company: "(KO)", "$KO", "NYSE: KO", or the SEC name
 * without its legal form ("COCA COLA CO" matches "Coca-Cola"). Names under 4 letters are skipped.
 */
export const mentionPattern = (subject: HeadlineSubject): RegExp => {
  const symbol = escapeRegExp(subject.symbol);
  const alternatives = [
    `\\(${symbol}\\)`,
    `\\$${symbol}\\b`,
    `\\b(?:NYSE|NASDAQ)\\s*:\\s*${symbol}\\b`,
  ];
  const words = (subject.name ?? "")
    .replace(/\/[^/]*\//gu, " ")
    .replace(COMPANY_FORM_WORDS, " ")
    .replace(/[^\p{L}\p{N}&]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "");
  if (words.join("").length >= 4)
    alternatives.push(`\\b${words.join("[\\s-]+")}\\b`);
  return new RegExp(alternatives.join("|"), "iu");
};

/**
 * Keyword tags for one headline, in MARKET_NEWS_HEADLINE_TAGS order. "earnings" also needs the
 * title to name the company, so market-wide earnings-season stories stay untagged.
 */
export const tagHeadline = (
  title: string,
  description: string,
  mention: RegExp
): MarketNewsHeadlineTag[] =>
  MARKET_NEWS_HEADLINE_TAGS.filter(
    (tag) =>
      HEADLINE_TAG_RULES[tag].test(`${title} ${description}`) &&
      (tag !== "earnings" || mention.test(title))
  );

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

const decodeEntities = (value: string): string =>
  value.replace(
    /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/giu,
    (whole, name: string) => {
      if (name.startsWith("#")) {
        const code = /^#x/iu.test(name)
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : "";
      }
      return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    }
  );

/** XML character data -> plain text: CDATA kept verbatim, entities decoded, whitespace collapsed. */
export const decodeXmlText = (raw: string): string => {
  let out = "";
  let rest = raw;
  while (rest !== "") {
    const start = rest.indexOf("<![CDATA[");
    if (start < 0) {
      out += decodeEntities(rest);
      break;
    }
    const end = rest.indexOf("]]>", start + 9);
    if (end < 0) throw new MarketNewsParseError("unterminated CDATA section");
    out += decodeEntities(rest.slice(0, start)) + rest.slice(start + 9, end);
    rest = rest.slice(end + 3);
  }
  return out.replace(/\s+/gu, " ").trim();
};

// Element and attribute names here are fixed identifiers; only "." needs escaping in a pattern.
const escapeName = (name: string): string => name.replace(/\./gu, "\\.");

const elementPattern = (name: string, flags: string): RegExp => {
  const tag = escapeName(name);
  return new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}\\s*>`, flags);
};

// The opening tag cannot contain ">", so the inner markup starts after the first one.
const innerMarkup = (element: string): string =>
  element.slice(element.indexOf(">") + 1, element.lastIndexOf("</"));

/** Inner markup of every <name>…</name> block (attributes allowed). Unbalanced tags are an error. */
export const xmlBlocks = (xml: string, name: string): string[] => {
  const tag = escapeName(name);
  const opens = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gu")) ?? [];
  const closes = xml.match(new RegExp(`</${tag}\\s*>`, "gu")) ?? [];
  if (opens.length !== closes.length)
    throw new MarketNewsParseError(`unbalanced <${name}> elements`);
  return (xml.match(elementPattern(name, "gu")) ?? []).map(innerMarkup);
};

/** Decoded text of the first <name> child, or "" when absent or empty. */
export const childText = (block: string, name: string): string => {
  const element = elementPattern(name, "u").exec(block)?.[0];
  return element === undefined ? "" : decodeXmlText(innerMarkup(element));
};

/** Decoded value of `attribute` on the first <name …> tag, or "". */
export const childAttribute = (
  block: string,
  name: string,
  attribute: string
): string => {
  const element =
    new RegExp(`<${escapeName(name)}\\s[^>]*>`, "u").exec(block)?.[0] ?? "";
  // ` name="value"` or ` name='value'`: the value sits between the quotes.
  const pair = new RegExp(
    `\\s${escapeName(attribute)}\\s*=\\s*(?:"[^"]*"|'[^']*')`,
    "u"
  ).exec(element)?.[0];
  return pair === undefined
    ? ""
    : decodeXmlText(pair.slice(pair.search(/["']/u) + 1, -1));
};

const RFC_822 =
  /^(?:[A-Z][a-z]{2},\s*)?\d{1,2}\s[A-Z][a-z]{2}\s\d{4}\s\d{2}:\d{2}(?::\d{2})?\s(?:[+-]\d{4}|GMT|UTC?|Z|[ECMP][SD]T)$/u;
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** RFC 822 (RSS) or ISO 8601 with a zone (Atom) -> Date; anything else -> null. */
export const parseFeedTime = (value: string): Date | null => {
  const trimmed = value.trim();
  if (!(RFC_822.test(trimmed) || ISO_8601.test(trimmed))) return null;
  const time = Date.parse(trimmed);
  return Number.isNaN(time) ? null : new Date(time);
};

/** Yahoo's symbol form: upper case, class shares with a dash (BRK.B -> BRK-B). */
export const yahooSymbol = (symbol: string): string =>
  symbol.toUpperCase().replace(/\./gu, "-");

/** Yahoo Finance headline RSS 2.0 -> validated headlines, newest first, one per story. */
export const parseYahooRss = (
  xml: string,
  subject: HeadlineSubject
): MarketNewsHeadline[] => {
  if (!(/<rss[\s>]/u.test(xml) && /<channel[\s>]/u.test(xml)))
    throw new MarketNewsParseError("not an RSS 2.0 document");
  const mention = mentionPattern(subject);
  const seen = new Set<string>();
  const out: MarketNewsHeadline[] = [];
  for (const item of xmlBlocks(xml, "item")) {
    const title = childText(item, "title");
    const description = childText(item, "description");
    const publisher = childText(item, "source");
    const parsed = MarketNewsHeadlineSchema.safeParse({
      publishedAt: parseFeedTime(childText(item, "pubDate")),
      publisher: publisher === "" ? null : publisher,
      tags: tagHeadline(title, description, mention),
      title,
      url: childText(item, "link"),
    });
    if (!parsed.success) continue;
    const keys = [
      parsed.data.url,
      parsed.data.title.toLowerCase().replace(/\W+/gu, " ").trim(),
    ];
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    out.push(parsed.data);
  }
  return out.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
};

/** 8-K item numbers found in an EDGAR `items-desc` string, labelled. */
export const describe8kItems = (itemsDesc: string): MarketNewsFilingItem[] =>
  [...new Set(itemsDesc.match(/\d{1,2}\.\d{2}/gu) ?? [])].map((code) => ({
    code,
    label: ITEMS_8K[code] ?? `item ${code}`,
  }));

/** EDGAR company filings Atom -> validated filings, newest first. */
export const parseSecAtom = (
  xml: string,
  fallbackName: string
): MarketNewsFiling[] => {
  if (!/<feed[\s>]/u.test(xml))
    throw new MarketNewsParseError("not an Atom document");
  const company = childText(xml, "conformed-name") || fallbackName;
  const out: MarketNewsFiling[] = [];
  for (const entry of xmlBlocks(xml, "entry")) {
    const form = childText(entry, "filing-type");
    const items = describe8kItems(childText(entry, "items-desc"));
    const labels = items
      .filter((item) => item.code !== "9.01")
      .map((item) => item.label);
    const parsed = MarketNewsFilingSchema.safeParse({
      filedAt: parseFeedTime(childText(entry, "updated")),
      form,
      important: items.some((item) => IMPORTANT_8K_ITEMS[item.code] === true),
      items,
      title: `${company} filed a ${form}${labels.length === 0 ? "" : `: ${labels.join(", ")}`}`,
      url:
        childAttribute(entry, "link", "href") ||
        childText(entry, "filing-href"),
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out.sort((a, b) => b.filedAt.getTime() - a.filedAt.getTime());
};

/** Bytes -> text. EDGAR declares ISO-8859-1; everything else must be valid UTF-8. */
export const decodeFeedBytes = (
  bytes: Uint8Array,
  contentType: string
): string => {
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 200));
  const declared =
    /charset\s*=\s*"?([\w-]+)/iu.exec(contentType)?.[1] ??
    /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/iu.exec(head)?.[1] ??
    "utf-8";
  if (/^(?:iso-8859-1|latin-?1|us-ascii)$/iu.test(declared)) {
    let out = "";
    for (let start = 0; start < bytes.length; start += 8192)
      out += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return out;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MarketNewsParseError("feed is not valid UTF-8");
  }
};

/** The watchlist rows the monitor covers: newest first (then A-Z), at most 25 symbols. */
export const selectNewsSymbols = (
  items: readonly Readonly<{ symbol: string; createdAt: Date }>[]
): string[] =>
  [...items]
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        a.symbol.localeCompare(b.symbol)
    )
    .map((item) => item.symbol)
    .slice(0, MARKET_NEWS_MAX_TICKERS);

/** Records published at or after `now - hours`, capped at `limit`. Input is newest first. */
export const withinHours = <T>(
  records: readonly T[],
  at: (record: T) => Date,
  hours: number,
  now: Date,
  limit: number
): T[] => {
  const since = now.getTime() - hours * 60 * 60 * 1000;
  return records
    .filter((record) => at(record).getTime() >= since)
    .slice(0, limit);
};
