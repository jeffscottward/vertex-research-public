import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { MarketNewsHeadline } from "./contracts/market-news.ts";
import {
  childAttribute,
  childText,
  decodeFeedBytes,
  decodeXmlText,
  describe8kItems,
  headlineKey,
  IMPORTANT_8K_ITEMS,
  ITEMS_8K,
  ibkrHeadlines,
  MarketNewsParseError,
  mentionPattern,
  mergeHeadlines,
  parseFeedTime,
  parseReutersRss,
  parseSecAtom,
  parseSeekingAlphaRss,
  parseYahooRss,
  selectNewsSymbols,
  stripSourceSuffix,
  tagHeadline,
  withinHours,
  xmlBlocks,
  yahooSymbol,
} from "./market-news.ts";

// Fixtures: day-trader-skill tests/fixtures/trader-news (MIT, see fixtures/day-trader-skill/NOTICE.md).
const fixture = (name: string): string =>
  readFileSync(
    new URL(`./fixtures/day-trader-skill/trader-news/${name}`, import.meta.url),
    "latin1"
  );
const utf8Fixture = (name: string): string =>
  readFileSync(
    new URL(`./fixtures/day-trader-skill/trader-news/${name}`, import.meta.url),
    "utf8"
  );

const ACME = { name: "Acme Corp", symbol: "ACME" };
const APPLE = { name: "Apple Inc.", symbol: "AAPL" };
const COKE = { name: "COCA COLA CO", symbol: "KO" };
const TESLA = { name: "Tesla, Inc.", symbol: "TSLA" };

const rss = (items: string): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;
const atom = (body: string): string =>
  `<feed xmlns="http://www.w3.org/2005/Atom">${body}</feed>`;

describe("Yahoo headline RSS", () => {
  it("parses the AAPL fixture newest first with UTC times and https links", () => {
    const headlines = parseYahooRss(utf8Fixture("yahoo-AAPL.xml"), APPLE);
    expect(headlines).toHaveLength(6);
    expect(headlines.map((item) => item.publishedAt.toISOString())).toEqual([
      "2026-10-13T22:21:00.000Z",
      "2026-10-13T20:37:00.000Z",
      "2026-10-13T20:36:44.000Z",
      "2026-10-13T20:24:24.000Z",
      "2026-10-13T19:50:32.000Z",
      "2026-10-13T19:46:52.000Z",
    ]);
    const oldest = headlines.at(-1);
    expect(oldest?.title).toBe(
      "Apple may have a way to dominate the smart home space"
    );
    expect(oldest?.url).toBe(
      "https://finance.yahoo.com/video/apple-may-have-a-way-to-dominate-the-smart-home-space-194652300.html?.tsrc=rss"
    );
    expect(oldest?.publisher).toBeNull();
    expect(headlines[2]?.tags).toEqual(["legal"]);
    expect(headlines.every((item) => item.source === "yahoo")).toBe(true);
    return expect(
      headlines.every((item) => item.url?.startsWith("https://"))
    ).toBe(true);
  });

  it("tags KO and TSLA headlines from title and description", () => {
    const ko = parseYahooRss(utf8Fixture("yahoo-KO.xml"), COKE);
    expect(ko).toHaveLength(4);
    expect(ko.map((item) => item.title.slice(0, 20))).toContain(
      "Is Coca-Cola (KO) St"
    );
    const tsla = parseYahooRss(utf8Fixture("yahoo-TSLA.xml"), TESLA);
    expect(tsla).toHaveLength(18);
    const merger = tsla.find((item) =>
      item.title.startsWith("Tesla-SpaceX Merger Mania")
    );
    return expect(merger?.tags).toEqual(["earnings", "deal"]);
  });

  it("decodes CDATA and entities, reads <source>, drops invalid items and repeats", () => {
    const headlines = parseYahooRss(
      rss(`
        <item><title><![CDATA[Acme & Co <b>beats</b>]]></title>
          <link>https://example.com/a?x=1&amp;y=2</link>
          <pubDate>Tue, 13 Oct 2026 20:02:03 +0000</pubDate>
          <source url="https://wire.example">Wire &#8211; Desk</source></item>
        <item><title>Same link</title><link>https://example.com/a?x=1&amp;y=2</link>
          <pubDate>Tue, 13 Oct 2026 21:00:00 +0000</pubDate></item>
        <item><title>ACME &amp; co: &lt;b&gt;beats&lt;/b&gt;!</title><link>https://example.com/b</link>
          <pubDate>Tue, 13 Oct 2026 21:00:00 +0000</pubDate></item>
        <item><title>Script link</title><link>javascript:alert(1)</link>
          <pubDate>Tue, 13 Oct 2026 21:00:00 +0000</pubDate></item>
        <item><title>No date</title><link>https://example.com/c</link></item>
        <item><title></title><link>https://example.com/d</link>
          <pubDate>Tue, 13 Oct 2026 21:00:00 +0000</pubDate></item>
        <item><title>Not a URL</title><link>not a url</link>
          <pubDate>Tue, 13 Oct 2026 21:00:00 +0000</pubDate></item>
        <item><title>Older</title><link>http://example.com/e</link>
          <pubDate>13 Oct 2026 08:00 GMT</pubDate></item>`),
      ACME
    );
    return expect(headlines).toEqual([
      {
        publishedAt: new Date("2026-10-13T20:02:03Z"),
        publisher: "Wire – Desk",
        source: "yahoo",
        tags: [],
        title: "Acme & Co <b>beats</b>",
        url: "https://example.com/a?x=1&y=2",
      },
      {
        publishedAt: new Date("2026-10-13T08:00:00Z"),
        publisher: null,
        source: "yahoo",
        tags: [],
        title: "Older",
        url: "http://example.com/e",
      },
    ]);
  });

  return it("rejects documents that are not RSS or are malformed", () => {
    expect(() =>
      parseYahooRss("<html><body>blocked</body></html>", ACME)
    ).toThrow(MarketNewsParseError);
    expect(() => parseYahooRss("<rss><title>x</title></rss>", ACME)).toThrow(
      "not an RSS 2.0 document"
    );
    expect(() => parseYahooRss(rss("<item><title>x</title>"), ACME)).toThrow(
      "unbalanced <item> elements"
    );
    expect(() =>
      parseYahooRss(rss("<item><title><![CDATA[x</title></item>"), ACME)
    ).toThrow("unterminated CDATA section");
    return expect(parseYahooRss(rss(""), ACME)).toEqual([]);
  });
});

describe("SEC 8-K Atom", () => {
  it("labels Apple's 8-K items and flags the important ones", () => {
    const filings = parseSecAtom(fixture("sec-8-K-0000320193.xml"), "AAPL");
    expect(filings.map((filing) => filing.form)).toEqual([
      "8-K/A",
      "8-K",
      "8-K",
    ]);
    expect(filings[0]?.title).toBe(
      "Apple Inc. filed a 8-K/A: director or officer change"
    );
    const earnings = filings[1];
    expect(earnings?.items).toEqual([
      { code: "2.02", label: "earnings results" },
      { code: "9.01", label: "exhibits" },
    ]);
    expect(earnings?.important).toBe(true);
    expect(earnings?.title).toBe("Apple Inc. filed a 8-K: earnings results");
    expect(earnings?.url).toContain("000032019326000018");
    // 16:30:28 New York time is 20:30:28 UTC.
    return expect(earnings?.filedAt.toISOString()).toBe(
      "2026-07-30T20:30:28.000Z"
    );
  });

  it("marks KO's other-events filing as not important", () => {
    const filings = parseSecAtom(fixture("sec-8-K-0000021344.xml"), "KO");
    expect(filings.map((filing) => filing.important)).toEqual([
      true,
      false,
      true,
    ]);
    return expect(filings[1]?.title).toBe(
      "COCA COLA CO filed a 8-K: other events"
    );
  });

  it("falls back to the given name, the filing-href and plain titles", () => {
    const filings = parseSecAtom(
      atom(`
        <entry><content><filing-type>8-K</filing-type>
          <filing-href>https://www.sec.gov/x-index.htm</filing-href>
          <items-desc>item 6.03 and 9.01</items-desc></content>
          <updated>2026-09-01T16:30:35-04:00</updated></entry>
        <entry><content><filing-type>8-K</filing-type></content>
          <link href='https://www.sec.gov/y-index.htm' />
          <updated>2026-09-02T00:00:00Z</updated></entry>
        <entry><content><filing-type>8-K</filing-type></content>
          <updated>2026-09-03T00:00:00Z</updated></entry>`),
      "Acme Corp"
    );
    return expect(filings).toEqual([
      {
        filedAt: new Date("2026-09-02T00:00:00Z"),
        form: "8-K",
        important: false,
        items: [],
        title: "Acme Corp filed a 8-K",
        url: "https://www.sec.gov/y-index.htm",
      },
      {
        filedAt: new Date("2026-09-01T20:30:35Z"),
        form: "8-K",
        important: false,
        items: [
          { code: "6.03", label: "item 6.03" },
          { code: "9.01", label: "exhibits" },
        ],
        title: "Acme Corp filed a 8-K: item 6.03",
        url: "https://www.sec.gov/x-index.htm",
      },
    ]);
  });

  return it("rejects documents that are not Atom", () =>
    expect(() => parseSecAtom(utf8Fixture("yahoo-KO.xml"), "KO")).toThrow(
      "not an Atom document"
    ));
});

describe("XML scanning helpers", () => {
  it("decodes named, decimal and hex entities and keeps unknown ones", () => {
    expect(
      decodeXmlText(
        " a &amp; b &LT;&gt; &quot;q&quot; &apos;s&apos;&nbsp;&#65;&#x42;&#X43; &copy; &#0;&#9999999; "
      )
    ).toBe(`a & b <> "q" 's' ABC &copy;`);
    return expect(decodeXmlText("x<![CDATA[ &amp; ]]>y\n\n z")).toBe(
      "x &amp; y z"
    );
  });

  it("reads blocks, child text and attributes", () => {
    expect(xmlBlocks("<a><i x='1'>one</i><i>two</i></a>", "i")).toEqual([
      "one",
      "two",
    ]);
    expect(xmlBlocks("<a/>", "i")).toEqual([]);
    expect(
      childText("<x><items-desc>2.02</items-desc></x>", "items-desc")
    ).toBe("2.02");
    expect(childText("<x/>", "title")).toBe("");
    expect(childText("<x><a.b>dot</a.b><aXb>no</aXb></x>", "a.b")).toBe("dot");
    expect(
      childAttribute(
        '<link rel="alt" href="https://a.test/?a=1&amp;b=2"/>',
        "link",
        "href"
      )
    ).toBe("https://a.test/?a=1&b=2");
    expect(childAttribute("<link rel='alt'/>", "link", "href")).toBe("");
    return expect(childAttribute("<x/>", "link", "href")).toBe("");
  });

  it("parses RFC 822 and zoned ISO 8601 times only", () => {
    expect(
      parseFeedTime("Tue, 13 Oct 2026 20:02:03 +0000")?.getUTCHours()
    ).toBe(20);
    expect(parseFeedTime("2026-09-01T16:30:35-04:00")?.toISOString()).toBe(
      "2026-09-01T20:30:35.000Z"
    );
    expect(parseFeedTime("soon")).toBeNull();
    expect(parseFeedTime("2026-09-01T16:30:35")).toBeNull();
    return expect(parseFeedTime("2026-13-45T99:00:00Z")).toBeNull();
  });

  return it("decodes ISO-8859-1 feeds and requires valid UTF-8 otherwise", () => {
    const latin = Uint8Array.from([0x43, 0x61, 0x66, 0xe9]);
    expect(decodeFeedBytes(latin, "text/xml; charset=ISO-8859-1")).toBe("Café");
    const declared = new TextEncoder().encode(
      `<?xml version="1.0" encoding="ISO-8859-1" ?><feed>${"x".repeat(9000)}</feed>`
    );
    expect(decodeFeedBytes(declared, "application/atom+xml")).toHaveLength(
      declared.length
    );
    expect(
      decodeFeedBytes(new TextEncoder().encode("<rss>é</rss>"), "text/xml")
    ).toBe("<rss>é</rss>");
    return expect(() => decodeFeedBytes(latin, "application/rss+xml")).toThrow(
      "feed is not valid UTF-8"
    );
  });
});

describe("tags, items and selection", () => {
  it("tags each headline category", () => {
    const acme = mentionPattern(ACME);
    const tag = (title: string, description = "") =>
      tagHeadline(title, description, acme);
    expect(tag("Acme Q3 earnings beat; full-year guidance raised")).toEqual([
      "earnings",
      "guidance",
    ]);
    expect(tag("Acme to acquire Beta in $2B deal")).toEqual(["deal"]);
    expect(tag("Analyst upgrades Acme, lifts price target")).toEqual([
      "analyst",
    ]);
    expect(tag("FTC sues Acme over antitrust concerns")).toEqual(["legal"]);
    expect(tag("Acme prices $500M secondary offering")).toEqual(["offering"]);
    expect(tag("Acme CEO steps down; CFO named successor")).toEqual([
      "executive",
    ]);
    return expect(tag("Acme opens a new store")).toEqual([]);
  });

  it("tags earnings only when the title names the company", () => {
    const acme = mentionPattern(ACME);
    expect(
      tagHeadline(
        "Acme stock jumps",
        "Quarterly revenue topped estimates.",
        acme
      )
    ).toEqual(["earnings"]);
    expect(
      tagHeadline("Stock futures rebound", "Earnings season heats up.", acme)
    ).toEqual([]);
    expect(tagHeadline("Acme results and revenue rise", "", acme)).toEqual([]);
    const tsla = parseYahooRss(utf8Fixture("yahoo-TSLA.xml"), TESLA);
    return expect(
      tsla
        .filter((item) => item.tags.includes("earnings"))
        .map((item) => item.title)
    ).toEqual([
      "Tesla-SpaceX Merger Mania Strikes Wall Street Ahead of Earnings",
    ]);
  });

  it("recognises the ticker and the SEC company name in headlines", () => {
    const coke = mentionPattern(COKE);
    expect(coke.test("Coca-Cola Has Raised Dividends")).toBe(true);
    expect(coke.test("Is (KO) a buy?")).toBe(true);
    expect(coke.test("Buy $ko now")).toBe(true);
    expect(coke.test("NYSE: KO slips")).toBe(true);
    expect(coke.test("KOALA rally")).toBe(false);
    const bank = mentionPattern({
      name: "BANK OF AMERICA CORP /DE/",
      symbol: "BAC",
    });
    expect(bank.test("Bank of America beats")).toBe(true);
    expect(bank.test("DE corp news")).toBe(false);
    const brk = mentionPattern({ name: null, symbol: "BRK.B" });
    expect(brk.test("Berkshire (BRK.B) adds")).toBe(true);
    expect(brk.test("Berkshire (BRKXB) adds")).toBe(false);
    // A name shorter than four letters would match too much, so only the ticker counts.
    const short = mentionPattern({ name: "GE Co", symbol: "GE" });
    expect(short.test("General update for ge fans")).toBe(false);
    return expect(short.test("(GE) rises")).toBe(true);
  });

  it("labels 8-K items once each and keeps the upstream important set", () => {
    expect(describe8kItems("items 2.02, 2.02 and 9.01")).toEqual([
      { code: "2.02", label: ITEMS_8K["2.02"] },
      { code: "9.01", label: "exhibits" },
    ]);
    expect(describe8kItems("")).toEqual([]);
    return expect(Object.keys(IMPORTANT_8K_ITEMS)).toEqual([
      "1.03",
      "1.05",
      "2.02",
      "2.04",
      "2.06",
      "3.01",
      "4.02",
      "5.01",
      "5.02",
    ]);
  });

  it("maps class shares to Yahoo symbols", () =>
    expect(yahooSymbol("brk.b")).toBe("BRK-B"));

  it("takes the 25 newest watchlist symbols, ties A-Z", () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
    const rows = Array.from({ length: 30 }, (_, index) => ({
      createdAt: at(index),
      symbol: `S${String(index).padStart(2, "0")}`,
    }));
    rows.push({ createdAt: at(29), symbol: "AAA" });
    const symbols = selectNewsSymbols(rows);
    expect(symbols).toHaveLength(25);
    return expect(symbols.slice(0, 3)).toEqual(["AAA", "S29", "S28"]);
  });

  return it("keeps records inside the window up to the limit", () => {
    const now = new Date("2026-10-14T00:00:00Z");
    const records = [
      new Date("2026-10-13T23:00:00Z"),
      new Date("2026-10-13T01:00:00Z"),
      new Date("2026-10-13T00:00:00Z"),
      new Date("2026-10-12T00:00:00Z"),
    ];
    expect(withinHours(records, (date) => date, 24, now, 10)).toHaveLength(3);
    return expect(
      withinHours(records, (date) => date, 72, now, 2)
    ).toHaveLength(2);
  });
});

// Small inline stand-ins shaped like the live feeds read on 2026-11-10.
const SA_FEED = `<?xml version="1.0"?>
<rss xmlns:sa="https://seekingalpha.com/api/1.0" xmlns:media="http://search.yahoo.com/mrss/" version="2.0">
  <channel>
    <title>Apple Inc. - News and Analysis on Seeking Alpha</title>
    <link>https://seekingalpha.com</link>
    <item>
      <title>Apple holds capex steady as peers accelerate AI infrastructure buildout</title>
      <link>https://seekingalpha.com/symbol/AAPL/news?source=feed_symbol_AAPL</link>
      <guid isPermaLink="false">https://seekingalpha.com/MarketCurrent:4669982</guid>
      <pubDate>Tue, 10 Nov 2026 12:18:52 -0500</pubDate>
      <sa:author_name>Jason Capul</sa:author_name>
      <media:thumbnail url=""/>
      <sa:stock><sa:symbol>AAPL</sa:symbol><sa:company_name>Apple Inc.</sa:company_name></sa:stock>
    </item>
    <item>
      <title>Apple price target raised at Wedbush</title>
      <link>https://seekingalpha.com/symbol/AAPL/news?source=feed_symbol_AAPL</link>
      <guid isPermaLink="false">https://seekingalpha.com/MarketCurrent:4669990</guid>
      <pubDate>Tue, 10 Nov 2026 14:00:00 -0500</pubDate>
      <sa:author_name>Seeking Alpha News</sa:author_name>
    </item>
    <item>
      <title>Apple price target raised at Wedbush (repeat)</title>
      <link>https://seekingalpha.com/symbol/AAPL/news?source=feed_symbol_AAPL</link>
      <guid isPermaLink="false">https://seekingalpha.com/MarketCurrent:4669990</guid>
      <pubDate>Tue, 10 Nov 2026 14:01:00 -0500</pubDate>
    </item>
    <item>
      <title>Where To Buy The Dip</title>
      <link>https://seekingalpha.com/article/4965290-where-to-buy-the-dip?source=feed_symbol_AAPL</link>
      <pubDate>Mon, 09 Nov 2026 16:04:00 -0500</pubDate>
    </item>
  </channel>
</rss>`;

const GOOGLE_REUTERS_FEED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><generator>NFE/5.0</generator><title>"AAPL site:reuters.com" - Google News</title><link>https://news.google.com/search?q=AAPL+site:reuters.com&amp;hl=en-US&amp;gl=US&amp;ceid=US:en</link>
<item><title>Apple raises $7.5 billion from bond sale, term sheet seen by Reuters shows - Reuters</title><link>https://news.google.com/rss/articles/CBMiswFBVV95cUxP?oc=5</link><guid isPermaLink="false">CBMiswFBVV95cUxP</guid><pubDate>Thu, 05 Nov 2026 23:43:27 GMT</pubDate><description>&lt;a href="https://news.google.com/rss/articles/CBMiswFBVV95cUxP?oc=5" target="_blank"&gt;Apple raises $7.5 billion from bond sale&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Reuters&lt;/font&gt;</description><source url="https://www.reuters.com">Reuters</source></item>
<item><title>Apple faces EU antitrust probe over App Store fees - Reuters</title><link>https://news.google.com/rss/articles/CBMizAFBVV95cUxO?oc=5</link><guid isPermaLink="false">CBMizAFBVV95cUxO</guid><pubDate>Fri, 06 Nov 2026 10:15:00 GMT</pubDate><description>&lt;a href="https://news.google.com/rss/articles/CBMizAFBVV95cUxO?oc=5"&gt;Apple faces EU probe&lt;/a&gt;</description><source url="https://www.reuters.com">Reuters</source></item>
</channel></rss>`;

const IBKR_NEWS = {
  items: [
    {
      headline: "Apple  price target raised at Wedbush",
      provider: "BRFG",
      time: "2026-11-10T19:30:00Z",
    },
    {
      headline: "Apple names new CFO",
      provider: "DJ-N",
      time: "2026-11-10T21:00:00Z",
    },
    {
      headline: "Apple quiet day",
      provider: null,
      time: "2026-11-10T18:00:00Z",
    },
    // Dropped: repeats a story, an unreadable time, a blank headline.
    {
      headline: "APPLE NAMES NEW CFO!",
      provider: "BRFG",
      time: "2026-11-10T20:00:00Z",
    },
    { headline: "Bad time", provider: "BRFG", time: "not a time" },
    { headline: "   ", provider: "BRFG", time: "2026-11-10T18:00:00Z" },
  ],
  providers: [{ code: "BRFG", name: "Briefing.com General Market Columns" }],
} as const;

describe("Seeking Alpha, Reuters and IBKR headlines", () => {
  it("parses Seeking Alpha per-symbol RSS: guid repeats, author as publisher", () => {
    const headlines = parseSeekingAlphaRss(SA_FEED, APPLE);
    expect(
      headlines.map((item) => [item.title, item.publisher, item.tags])
    ).toEqual([
      [
        "Apple price target raised at Wedbush",
        "Seeking Alpha News",
        ["analyst"],
      ],
      [
        "Apple holds capex steady as peers accelerate AI infrastructure buildout",
        "Jason Capul",
        [],
      ],
      ["Where To Buy The Dip", null, []],
    ]);
    expect(headlines.every((item) => item.source === "seekingalpha")).toBe(
      true
    );
    // News items share the symbol-page link; the guid keeps them apart.
    expect(headlines[0]?.url).toBe(
      "https://seekingalpha.com/symbol/AAPL/news?source=feed_symbol_AAPL"
    );
    expect(headlines[0]?.publishedAt).toEqual(new Date("2026-11-10T19:00:00Z"));
    return expect(() => parseSeekingAlphaRss("<html></html>", APPLE)).toThrow(
      "not an RSS 2.0 document"
    );
  });

  it("parses Reuters from Google News RSS without the ' - Reuters' suffix", () => {
    const headlines = parseReutersRss(GOOGLE_REUTERS_FEED, APPLE);
    expect(headlines).toEqual([
      {
        publishedAt: new Date("2026-11-06T10:15:00Z"),
        publisher: "Reuters",
        source: "reuters",
        // Tagged from the description text, its HTML markup removed.
        tags: ["legal"],
        title: "Apple faces EU antitrust probe over App Store fees",
        url: "https://news.google.com/rss/articles/CBMizAFBVV95cUxO?oc=5",
      },
      {
        publishedAt: new Date("2026-11-05T23:43:27Z"),
        publisher: "Reuters",
        source: "reuters",
        tags: [],
        title:
          "Apple raises $7.5 billion from bond sale, term sheet seen by Reuters shows",
        url: "https://news.google.com/rss/articles/CBMiswFBVV95cUxP?oc=5",
      },
    ]);
    // Words inside description markup ("deal" in a link) never tag a headline.
    return expect(
      parseReutersRss(
        rss(
          `<item><title>Apple supplier story</title><description>&lt;a href="https://example.com/deal"&gt;Apple outlook&lt;/a&gt;</description><link>https://news.google.com/x</link><pubDate>Fri, 06 Nov 2026 10:15:00 GMT</pubDate></item>`
        ),
        APPLE
      )[0]?.tags
    ).toEqual(["guidance"]);
  });

  return it("maps IBKR news to unlinked headlines named by provider", () =>
    expect(ibkrHeadlines(IBKR_NEWS, APPLE)).toEqual([
      {
        publishedAt: new Date("2026-11-10T21:00:00Z"),
        publisher: "DJ-N",
        source: "ibkr",
        tags: ["executive"],
        title: "Apple names new CFO",
        url: null,
      },
      {
        publishedAt: new Date("2026-11-10T19:30:00Z"),
        publisher: "Briefing.com General Market Columns",
        source: "ibkr",
        tags: ["analyst"],
        title: "Apple price target raised at Wedbush",
        url: null,
      },
      {
        publishedAt: new Date("2026-11-10T18:00:00Z"),
        publisher: null,
        source: "ibkr",
        tags: [],
        title: "Apple quiet day",
        url: null,
      },
    ]));
});

const headline = (
  source: MarketNewsHeadline["source"],
  title: string,
  at: string
): MarketNewsHeadline => ({
  publishedAt: new Date(at),
  publisher: null,
  source,
  tags: [],
  title,
  url: source === "ibkr" ? null : `https://example.com/${source}/${at}`,
});

describe("headline merge", () => {
  it("normalises titles: case, punctuation, spacing and publisher suffixes", () => {
    expect(stripSourceSuffix("Apple beats - Reuters")).toBe("Apple beats");
    expect(stripSourceSuffix("Apple beats | Seeking Alpha")).toBe(
      "Apple beats"
    );
    expect(stripSourceSuffix("Apple beats – Yahoo Finance")).toBe(
      "Apple beats"
    );
    expect(stripSourceSuffix("Reuters-Ipsos poll")).toBe("Reuters-Ipsos poll");
    expect(headlineKey("  Apple’s Q3:  BEATS estimates!! - Reuters")).toBe(
      "apple s q3 beats estimates"
    );
    return expect(headlineKey("Apple's Q3 beats estimates")).toBe(
      "apple s q3 beats estimates"
    );
  });

  return it("keeps one copy per story from the highest-priority source, newest first", () => {
    const yahoo = [
      headline("yahoo", "Apple beats estimates", "2026-11-10T12:00:00Z"),
      headline("yahoo", "Only on Yahoo", "2026-11-10T09:00:00Z"),
      headline("yahoo", "Tie at eight", "2026-11-10T08:00:00Z"),
    ];
    const seekingAlpha = [
      headline(
        "seekingalpha",
        "APPLE BEATS ESTIMATES!",
        "2026-11-10T12:05:00Z"
      ),
      headline("seekingalpha", "Apple names new CFO", "2026-11-10T10:00:00Z"),
      headline("seekingalpha", "Other tie", "2026-11-10T08:00:00Z"),
    ];
    const reuters = [
      headline("reuters", "Apple beats estimates", "2026-11-10T12:01:00Z"),
    ];
    const ibkr = [
      headline("ibkr", "Apple names new CFO.", "2026-11-10T10:02:00Z"),
    ];
    // Lower-priority lists come first and last: the kept copy never depends on list order.
    const merged = mergeHeadlines([yahoo, ibkr, seekingAlpha, reuters]);
    expect(merged.map((item) => [item.source, item.title])).toEqual([
      ["reuters", "Apple beats estimates"],
      ["ibkr", "Apple names new CFO."],
      ["yahoo", "Only on Yahoo"],
      // Same time: the higher-priority source first.
      ["seekingalpha", "Other tie"],
      ["yahoo", "Tie at eight"],
    ]);
    expect(mergeHeadlines([reuters, yahoo])[0]?.source).toBe("reuters");
    return expect(mergeHeadlines([])).toEqual([]);
  });
});
