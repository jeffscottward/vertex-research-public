import {
  MARKET_NEWS_HEADLINE_TAGS,
  MARKET_NEWS_MAX_TICKERS,
  MARKET_NEWS_SOURCES,
  type MarketNewsFiling,
  type MarketNewsFilingItem,
  MarketNewsFilingSchema,
  type MarketNewsHeadline,
  MarketNewsHeadlineSchema,
  type MarketNewsHeadlineTag,
  type MarketNewsSource,
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

/** The SEC company name without legal form or state tag, as words ("COCA COLA CO" -> COCA, COLA). */
export const companyWords = (name: string | null): string[] =>
  (name ?? "")
    .replace(/\/[^/]*\//gu, " ")
    .replace(COMPANY_FORM_WORDS, " ")
    .replace(/[^\p{L}\p{N}&]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "");

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
  const words = companyWords(subject.name);
  if (words.join("").length >= 4)
    alternatives.push(`\\b${words.join("[\\s-]+")}\\b`);
  return new RegExp(alternatives.join("|"), "iu");
};

/**
 * Google News search for Reuters stories about one company. By the SEC name without its legal
 * form ("FORD MOTOR CO" -> "FORD MOTOR"): a short ticker alone (F, T, ON, NOW) finds unrelated
 * stories. Without a usable name: the quoted ticker plus "stock".
 */
export const reutersSearchQuery = (subject: HeadlineSubject): string => {
  const words = companyWords(subject.name);
  return words.join("").length >= 4
    ? `"${words.join(" ")}" site:reuters.com`
    : `"${subject.symbol.toUpperCase()}" stock site:reuters.com`;
};

/**
 * True when `text` names the company: any `mentionPattern` form, the ticker as a word in upper case
 * (two or more letters; a lone "A" or "T" is an ordinary word), or the first name word of three or
 * more letters in any case ("Ford" for "FORD MOTOR CO").
 */
export const companyMention = (
  subject: HeadlineSubject
): ((text: string) => boolean) => {
  const patterns = [mentionPattern(subject)];
  const symbol = subject.symbol.toUpperCase();
  if (symbol.length >= 2)
    patterns.push(new RegExp(`\\b${escapeRegExp(symbol)}\\b`, "u"));
  const first = companyWords(subject.name).find((word) => word.length >= 3);
  if (first !== undefined)
    patterns.push(new RegExp(`\\b${escapeRegExp(first)}\\b`, "iu"));
  return (text) => patterns.some((pattern) => pattern.test(text));
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

// Each pattern is compiled once per (kind, name, flags): a feed reads the same few child names
// for every item, and Workers CPU time is short. Names are fixed identifiers, so the map stays
// small. Shared global patterns are safe: String#match resets `lastIndex`, and `exec` on a
// non-global pattern ignores it.
const compiled = new Map<string, RegExp>();
const xmlPattern = (
  kind: "element" | "open" | "close" | "tag" | "attribute",
  name: string,
  flags: string
): RegExp => {
  const key = `${kind} ${name} ${flags}`;
  const hit = compiled.get(key);
  if (hit !== undefined) return hit;
  const tag = escapeName(name);
  const source = {
    attribute: `\\s${tag}\\s*=\\s*(?:"[^"]*"|'[^']*')`,
    close: `</${tag}\\s*>`,
    element: `<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}\\s*>`,
    open: `<${tag}(?:\\s[^>]*)?>`,
    tag: `<${tag}\\s[^>]*>`,
  }[kind];
  const pattern = new RegExp(source, flags);
  compiled.set(key, pattern);
  return pattern;
};

// The opening tag cannot contain ">", so the inner markup starts after the first one.
const innerMarkup = (element: string): string =>
  element.slice(element.indexOf(">") + 1, element.lastIndexOf("</"));

/** Inner markup of every <name>…</name> block (attributes allowed). Unbalanced tags are an error. */
export const xmlBlocks = (xml: string, name: string): string[] => {
  const opens = xml.match(xmlPattern("open", name, "gu")) ?? [];
  const closes = xml.match(xmlPattern("close", name, "gu")) ?? [];
  if (opens.length !== closes.length)
    throw new MarketNewsParseError(`unbalanced <${name}> elements`);
  return (xml.match(xmlPattern("element", name, "gu")) ?? []).map(innerMarkup);
};

/** Decoded text of the first <name> child, or "" when absent or empty. */
export const childText = (block: string, name: string): string => {
  const element = xmlPattern("element", name, "u").exec(block)?.[0];
  return element === undefined ? "" : decodeXmlText(innerMarkup(element));
};

/** Decoded value of `attribute` on the first <name …> tag, or "". */
export const childAttribute = (
  block: string,
  name: string,
  attribute: string
): string => {
  const element = xmlPattern("tag", name, "u").exec(block)?.[0] ?? "";
  // ` name="value"` or ` name='value'`: the value sits between the quotes.
  const pair = xmlPattern("attribute", attribute, "u").exec(element)?.[0];
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

// A trailing publisher name that aggregators append to titles ("… - Reuters").
const SOURCE_SUFFIX =
  /\s+[-–—|]\s+(?:Reuters|Seeking Alpha|Yahoo Finance|Yahoo)$/iu;

/** A title without an aggregator's trailing publisher name ("… - Reuters"). */
export const stripSourceSuffix = (title: string): string =>
  title.replace(SOURCE_SUFFIX, "");

/**
 * Dedupe key for one story across sources: the title without a publisher suffix, lower case,
 * letters and digits only, single-spaced. Case, punctuation and spacing differences collapse.
 */
export const headlineKey = (title: string): string =>
  stripSourceSuffix(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Items read per headline feed; the rest of a long feed is never scanned. */
export const MARKET_NEWS_FEED_MAX_ITEMS = 60;

/** `since`: items published before it are dropped before tagging and validation. */
export type HeadlineParseOptions = Readonly<{ since?: Date }>;

/** How one RSS 2.0 headline feed is read. */
type RssHeadlineFeed = Readonly<{
  source: MarketNewsSource;
  /** In-feed repeat key: the item link, or its guid where one link serves many items. */
  identity: "link" | "guid";
  /** Keep only items whose title or description names the company (search feeds). */
  mentionRequired: boolean;
}>;

const isOlder = (time: Date | null, options: HeadlineParseOptions): boolean =>
  time !== null &&
  options.since !== undefined &&
  time.getTime() < options.since.getTime();

/** One RSS <item> -> a validated headline with its in-feed identity, or null to skip it. */
const readRssItem = (
  item: string,
  feed: RssHeadlineFeed,
  options: HeadlineParseOptions,
  mention: RegExp,
  names: ((text: string) => boolean) | null
): Readonly<{ headline: MarketNewsHeadline; identity: string }> | null => {
  const publishedAt = parseFeedTime(childText(item, "pubDate"));
  if (isOlder(publishedAt, options)) return null;
  const title = stripSourceSuffix(childText(item, "title"));
  // Google News descriptions are escaped HTML: markup is dropped before keyword matching.
  const description = childText(item, "description").replace(/<[^>]*>/gu, " ");
  if (names !== null && !names(`${title} ${description}`)) return null;
  // <source> on Yahoo and Google News items; Seeking Alpha names the author instead.
  const publisher =
    childText(item, "source") || childText(item, "sa:author_name");
  const url = childText(item, "link");
  const parsed = MarketNewsHeadlineSchema.safeParse({
    publishedAt,
    publisher: publisher === "" ? null : publisher,
    source: feed.source,
    tags: tagHeadline(title, description, mention),
    title,
    url,
  });
  if (!parsed.success) return null;
  return {
    headline: parsed.data,
    identity: feed.identity === "guid" ? childText(item, "guid") || url : url,
  };
};

/** RSS 2.0 headlines -> validated headlines from `feed.source`, newest first, one per story. */
const parseRssHeadlines = (
  xml: string,
  subject: HeadlineSubject,
  feed: RssHeadlineFeed,
  options: HeadlineParseOptions
): MarketNewsHeadline[] => {
  if (!(/<rss[\s>]/u.test(xml) && /<channel[\s>]/u.test(xml)))
    throw new MarketNewsParseError("not an RSS 2.0 document");
  const mention = mentionPattern(subject);
  const names = feed.mentionRequired ? companyMention(subject) : null;
  const seen = new Set<string>();
  const out: MarketNewsHeadline[] = [];
  const items = xmlBlocks(xml, "item").slice(0, MARKET_NEWS_FEED_MAX_ITEMS);
  for (const item of items) {
    const read = readRssItem(item, feed, options, mention, names);
    if (read === null) continue;
    const keys = [read.identity, headlineKey(read.headline.title)];
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    out.push(read.headline);
  }
  return out.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
};

/** Yahoo Finance headline RSS 2.0 -> validated headlines, newest first, one per story. */
export const parseYahooRss = (
  xml: string,
  subject: HeadlineSubject,
  options: HeadlineParseOptions = {}
): MarketNewsHeadline[] =>
  parseRssHeadlines(
    xml,
    subject,
    { identity: "link", mentionRequired: false, source: "yahoo" },
    options
  );

/**
 * Seeking Alpha per-symbol RSS (`/api/sa/combined/{SYMBOL}.xml`) -> validated headlines. News
 * items share one symbol-page link, so repeats are keyed by guid.
 */
export const parseSeekingAlphaRss = (
  xml: string,
  subject: HeadlineSubject,
  options: HeadlineParseOptions = {}
): MarketNewsHeadline[] =>
  parseRssHeadlines(
    xml,
    subject,
    { identity: "guid", mentionRequired: false, source: "seekingalpha" },
    options
  );

/**
 * Google News RSS search restricted to reuters.com -> validated Reuters headlines. Titles lose
 * their " - Reuters" suffix; links stay the Google News redirect URLs as given. A search also
 * returns stories that only share a word with the query, so items that do not name the company
 * (`companyMention`) are dropped.
 */
export const parseReutersRss = (
  xml: string,
  subject: HeadlineSubject,
  options: HeadlineParseOptions = {}
): MarketNewsHeadline[] =>
  parseRssHeadlines(
    xml,
    subject,
    { identity: "link", mentionRequired: true, source: "reuters" },
    options
  );

/** The part of a vertex-history /news answer the monitor reads (see server/ibkr-history.ts). */
export type IbkrNews = Readonly<{
  providers: readonly Readonly<{ code: string; name: string | null }>[];
  items: readonly Readonly<{
    time: string;
    provider: string | null;
    headline: string;
  }>[];
}>;

/** IBKR API news headlines -> validated headlines (no public link), newest first, one per story. */
export const ibkrHeadlines = (
  news: IbkrNews,
  subject: HeadlineSubject,
  options: HeadlineParseOptions = {}
): MarketNewsHeadline[] => {
  const mention = mentionPattern(subject);
  const names = new Map(
    news.providers.map((provider) => [provider.code, provider.name])
  );
  const seen = new Set<string>();
  const out: MarketNewsHeadline[] = [];
  for (const item of news.items) {
    const publishedAt = new Date(item.time);
    if (isOlder(publishedAt, options)) continue;
    const title = item.headline.replace(/\s+/gu, " ").trim();
    const parsed = MarketNewsHeadlineSchema.safeParse({
      publishedAt,
      publisher:
        item.provider === null
          ? null
          : (names.get(item.provider) ?? item.provider),
      source: "ibkr",
      tags: tagHeadline(title, "", mention),
      title,
      url: null,
    });
    if (!parsed.success) continue;
    const key = headlineKey(parsed.data.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed.data);
  }
  return out.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
};

const sourceRank = (headline: MarketNewsHeadline): number =>
  MARKET_NEWS_SOURCES.indexOf(headline.source);

/**
 * One list from every source, newest first. Near-identical titles (same `headlineKey`) are one
 * story: the copy from the highest-priority source (MARKET_NEWS_SOURCES order) is kept, with the
 * link of the best-ranked copy that has one (IBKR copies have none) and the tags of every copy.
 */
export const mergeHeadlines = (
  lists: readonly (readonly MarketNewsHeadline[])[]
): MarketNewsHeadline[] => {
  const stories = new Map<string, MarketNewsHeadline[]>();
  for (const list of lists)
    for (const headline of list) {
      const key = headlineKey(headline.title);
      stories.set(key, [...(stories.get(key) ?? []), headline]);
    }
  const kept = [...stories.values()].map((copies) => {
    const [best, ...rest] = [...copies].sort(
      (a, b) => sourceRank(a) - sourceRank(b)
    ) as [MarketNewsHeadline, ...MarketNewsHeadline[]];
    return {
      ...best,
      tags: MARKET_NEWS_HEADLINE_TAGS.filter((tag) =>
        copies.some((copy) => copy.tags.includes(tag))
      ),
      url: best.url ?? rest.find((copy) => copy.url !== null)?.url ?? null,
    };
  });
  return kept.sort(
    (a, b) =>
      b.publishedAt.getTime() - a.publishedAt.getTime() ||
      sourceRank(a) - sourceRank(b)
  );
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
