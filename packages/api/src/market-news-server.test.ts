import { readFileSync } from "node:fs";
import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { WatchlistItem } from "@darkfactory/db/schema";
import {
  DatabasePersistenceError,
  type Repositories,
  type WatchlistRepository,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { createApiContext } from "./server/context.ts";
import type { DeployStatusConfig } from "./server/deploy-status.ts";
import { handleApiRequest } from "./server/handler.ts";
import {
  buildMarketNews,
  cachedSource,
  clearMarketNewsCacheForTesting,
  fetchBoundedText,
  IBKR_NEWS_READS_PER_LOAD,
  IBKR_NEWS_TIMEOUT_MS,
  loadTickerFeeds,
  type MarketNewsOptions,
  mapWithConcurrency,
  marketNewsCacheSizeForTesting,
  NEWS_CACHE_MAX_ENTRIES,
  newsLoad,
  setMarketNewsOptionsForTesting,
} from "./server/market-news.ts";
import { clearResearchLensCacheForTesting } from "./server/research-lenses.ts";

// Upstream fixtures: day-trader-skill tests/fixtures/trader-news (MIT, see fixtures/day-trader-skill/NOTICE.md).
const fixtureBytes = (name: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(
    readFileSync(
      new URL(
        `./fixtures/day-trader-skill/trader-news/${name}`,
        import.meta.url
      )
    )
  );

const NOW = new Date("2026-10-14T00:00:00.000Z");
type Fetch = NonNullable<MarketNewsOptions["fetch"]>;

const xml = (body: BodyInit | null, contentType = "application/rss+xml") =>
  new Response(body, { headers: { "content-type": contentType } });

const EMPTY_RSS =
  '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>';

// Public feed stand-ins: Yahoo RSS by symbol, empty Seeking Alpha and Google News (Reuters) RSS,
// SEC ticker list and 8-K Atom by CIK. Overrides key by Yahoo `s` or by URL path.
const feeds = (overrides: Record<string, () => Response> = {}) => {
  const calls: string[] = [];
  const fetch: Fetch = vi.fn(async (url: string) => {
    calls.push(url);
    const parsed = new URL(url);
    const override = overrides[parsed.searchParams.get("s") ?? parsed.pathname];
    if (override !== undefined) return override();
    if (parsed.hostname === "feeds.finance.yahoo.com") {
      const symbol = parsed.searchParams.get("s");
      return ["AAPL", "KO", "TSLA"].includes(symbol ?? "")
        ? xml(fixtureBytes(`yahoo-${symbol}.xml`))
        : xml(null, "text/html");
    }
    if (
      parsed.hostname === "seekingalpha.com" ||
      parsed.hostname === "news.google.com"
    )
      return xml(EMPTY_RSS, "application/xml; charset=utf-8");
    if (parsed.pathname === "/files/company_tickers.json")
      return new Response(fixtureBytes("company_tickers.json"), {
        headers: { "content-type": "application/json" },
      });
    const cik = parsed.searchParams.get("CIK");
    return ["0000320193", "0000021344"].includes(cik ?? "")
      ? xml(
          fixtureBytes(`sec-8-K-${cik}.xml`),
          "application/atom+xml; charset=ISO-8859-1"
        )
      : new Response("missing", { status: 404 });
  });
  return { calls, fetch };
};

afterEach(() => {
  clearMarketNewsCacheForTesting();
  clearResearchLensCacheForTesting();
  setMarketNewsOptionsForTesting({});
  vi.unstubAllGlobals();
});

describe("bounded XML fetch", () => {
  const request = {
    headers: { "user-agent": "test" },
    label: "Feed",
    url: "https://feeds.example.test/rss",
  };
  const run = (fetch: Fetch, timeoutMs = 1000, maxBytes = 64) =>
    fetchBoundedText(request, { fetch, maxBytes, timeoutMs }).catch(
      (error: unknown) => error
    );

  it("sends a bounded GET without following redirects and returns text", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("<rss/>", {
          headers: { "content-length": "6", "content-type": "text/xml" },
        })
    );
    expect(await run(fetch)).toBe("<rss/>");
    expect(fetch).toHaveBeenCalledWith(request.url, {
      headers: {
        accept: "application/rss+xml, application/atom+xml, text/xml",
        "user-agent": "test",
      },
      method: "GET",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    return expect(await run(async () => xml(null, "application/xml"))).toBe("");
  });

  it("maps HTTP, content type, size and body failures to typed codes", async () => {
    const status = (code: number) => async () =>
      new Response("x", {
        headers: { "content-type": "text/xml" },
        status: code,
      });
    expect(await run(status(404))).toMatchObject({
      code: "NOT_FOUND",
      message: "Feed returned HTTP 404",
    });
    for (const code of [429, 502, 503, 504])
      expect(await run(status(code))).toMatchObject({ code: "UNAVAILABLE" });
    expect(await run(status(301))).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Feed returned HTTP 301",
    });
    // A byte body carries no content-type header at all.
    expect(
      await run(async () => new Response(new TextEncoder().encode("<rss/>")))
    ).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Feed returned an unexpected content type",
    });
    expect(await run(async () => xml("{}", "application/json"))).toMatchObject({
      message: "Feed returned an unexpected content type",
    });
    expect(
      await run(
        async () =>
          new Response("<rss/>", {
            headers: { "content-length": "999", "content-type": "text/xml" },
          })
      )
    ).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Feed response exceeds the size cap",
    });
    const cancel = vi.fn(() => {
      throw new Error("cancel failed");
    });
    expect(
      await run(async () =>
        xml(
          new ReadableStream<Uint8Array>({
            cancel,
            pull: (controller) => controller.enqueue(new Uint8Array(40)),
          })
        )
      )
    ).toMatchObject({ message: "Feed response exceeds the size cap" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(
      await run(async () =>
        xml(
          new ReadableStream<Uint8Array>({
            pull: (controller) => controller.error(new Error("reset")),
          })
        )
      )
    ).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Feed response could not be read",
    });
    return expect(
      await run(async () => xml(Uint8Array.from([0xff, 0xfe])))
    ).toMatchObject({ message: "feed is not valid UTF-8" });
  });

  it("reports transport failures and timeouts as unavailable", async () => {
    expect(
      await run(async () => {
        throw new Error("socket closed");
      })
    ).toMatchObject({ code: "UNAVAILABLE", message: "Feed request failed" });
    const hang: Fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("abort")))
      );
    expect(await run(hang, 5)).toMatchObject({
      code: "UNAVAILABLE",
      message: "Feed request timed out",
    });
    const slowBody: Fetch = async (_url, init) =>
      xml(
        new ReadableStream<Uint8Array>({
          start: (controller) =>
            init.signal?.addEventListener("abort", () =>
              controller.error(new Error("aborted"))
            ),
        })
      );
    return expect(await run(slowBody, 5)).toMatchObject({
      code: "UNAVAILABLE",
      message: "Feed request timed out",
    });
  });

  return it("uses the global fetch, default timeout and default cap", async () => {
    const globalFetch = vi.fn(async () => xml("<rss/>"));
    vi.stubGlobal("fetch", globalFetch);
    expect(await fetchBoundedText(request)).toBe("<rss/>");
    return expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});

describe("ticker feeds", () => {
  it("collects headlines and 8-Ks and records per-source failures", async () => {
    const { calls, fetch } = feeds();
    const news = await buildMarketNews(["AAPL", "BRK.B", "SPY"], 168, {
      fetch,
      now: () => NOW,
    });
    expect(news.receivedAt).toEqual(NOW);
    const [aapl, brk, spy] = news.tickers;
    expect(aapl?.symbol).toBe("AAPL");
    expect(aapl?.headlines).toHaveLength(6);
    expect(aapl?.filings).toEqual([]); // the newest Apple 8-K is from September
    expect(aapl?.errors).toEqual([]);
    expect(brk?.errors).toEqual([
      "headlines: Yahoo headlines returned an unexpected content type",
      "filings: SEC 8-K feed returned HTTP 404",
    ]);
    expect(spy?.errors).toEqual([
      "headlines: Yahoo headlines returned an unexpected content type",
      "filings: no SEC filer matches this symbol",
    ]);
    expect(calls).toContain(
      "https://feeds.finance.yahoo.com/rss/2.0/headline?s=BRK-B&region=US&lang=en-US"
    );
    expect(calls).toContain(
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001067983&type=8-K&dateb=&owner=include&count=10&output=atom"
    );
    // The SEC ticker list is fetched once for all three symbols.
    return expect(
      calls.filter((url) => url.endsWith("company_tickers.json"))
    ).toHaveLength(1);
  });

  it("filters each ticker to the selected window", async () => {
    const { fetch } = feeds();
    const now = new Date("2026-09-03T00:00:00.000Z");
    const news = await buildMarketNews(["AAPL", "KO"], 72, {
      fetch,
      now: () => now,
    });
    expect(news.tickers[0]?.filings.map((filing) => filing.title)).toEqual([
      "Apple Inc. filed a 8-K/A: director or officer change",
    ]);
    expect(news.tickers[0]?.filings[0]?.important).toBe(true);
    expect(news.tickers[1]?.filings).toEqual([]);
    // The 30-day window reaches back to KO's July 16 8-K from mid-August.
    const month = await buildMarketNews(["KO"], 720, {
      fetch,
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });
    expect(month.tickers[0]?.filings.map((filing) => filing.important)).toEqual(
      [true, false]
    );
    const day = await buildMarketNews(["KO"], 24, {
      fetch,
      now: () => new Date("2026-10-14T00:00:00.000Z"),
    });
    return expect(
      day.tickers[0]?.headlines.map((item) => item.publishedAt.toISOString())
    ).toEqual([
      "2026-10-13T20:02:03.000Z",
      "2026-10-13T18:45:42.000Z",
      "2026-10-13T15:37:00.000Z",
      "2026-10-13T12:40:02.000Z",
    ]);
  });

  it("caches successful sources for 5 minutes and retries failures", async () => {
    let now = NOW;
    const { calls, fetch } = feeds();
    const options = { fetch, now: () => now };
    await loadTickerFeeds("KO", options);
    await loadTickerFeeds("SPY", options);
    const first = calls.length;
    now = new Date(NOW.getTime() + 4 * 60 * 1000);
    await loadTickerFeeds("KO", options);
    expect(calls.length).toBe(first);
    await loadTickerFeeds("SPY", options);
    expect(calls.length).toBe(first + 1); // the failed Yahoo read is retried
    now = new Date(NOW.getTime() + 5 * 60 * 1000);
    await loadTickerFeeds("KO", options);
    // Expired: Reuters, Seeking Alpha, Yahoo and the 8-K feed are read again.
    return expect(calls.length).toBe(first + 5);
  });

  it("does not cache headlines tagged while the SEC ticker list failed", async () => {
    const { calls, fetch } = feeds();
    const options = { fetch, now: () => NOW };
    const failing = () => Promise.reject(new Error("SEC list down"));
    const yahooCalls = () =>
      calls.filter((url) => url.includes("feeds.finance.yahoo.com")).length;
    const first = await loadTickerFeeds("KO", options, failing);
    expect(first.headlines).toHaveLength(4);
    expect(first.errors).toEqual(["filings: SEC list down"]);
    await loadTickerFeeds("KO", options, failing);
    expect(yahooCalls()).toBe(2);
    await loadTickerFeeds("KO", options);
    await loadTickerFeeds("KO", options);
    return expect(yahooCalls()).toBe(3);
  });

  it("keeps the source cache bounded: expired entries first, then the oldest", async () => {
    const load = vi.fn(async () => "value");
    for (let index = 0; index < NEWS_CACHE_MAX_ENTRIES; index += 1)
      await cachedSource(`old:${index}`, 0, load);
    expect(marketNewsCacheSizeForTesting()).toBe(NEWS_CACHE_MAX_ENTRIES);
    const later = 5 * 60 * 1000;
    await cachedSource("fresh:0", later, load);
    expect(marketNewsCacheSizeForTesting()).toBe(1);
    for (let index = 1; index < NEWS_CACHE_MAX_ENTRIES; index += 1)
      await cachedSource(`fresh:${index}`, later, load);
    await cachedSource("fresh:0", later + 1, load); // cached: no reload, no eviction
    expect(load).toHaveBeenCalledTimes(NEWS_CACHE_MAX_ENTRIES * 2);
    await cachedSource("fresh:last", later + 1, load);
    expect(marketNewsCacheSizeForTesting()).toBe(NEWS_CACHE_MAX_ENTRIES);
    await cachedSource("fresh:0", later + 2, load);
    return expect(load).toHaveBeenCalledTimes(NEWS_CACHE_MAX_ENTRIES * 2 + 2);
  });

  it("reports a non-Error failure generically", async () => {
    const { fetch } = feeds();
    let calls = 0;
    const now = () => {
      calls += 1;
      if (calls > 1) throw "clock unavailable";
      return NOW;
    };
    const feedsFor = await loadTickerFeeds("KO", { fetch, now });
    expect(feedsFor.headlines).toHaveLength(4);
    return expect(feedsFor.errors).toEqual(["filings: request failed"]);
  });

  it("uses the real clock by default", async () => {
    const { fetch } = feeds();
    const feedsFor = await loadTickerFeeds("KO", { fetch });
    expect(feedsFor.filings).toHaveLength(3);
    const empty = await buildMarketNews([], 24);
    expect(empty.tickers).toEqual([]);
    return expect(empty.receivedAt).toBeInstanceOf(Date);
  });

  return it("runs at most the given number of tasks at once, in input order", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency(
      [5, 1, 4, 2, 3, 0],
      4,
      async (delay) => {
        active += 1;
        peak = Math.max(peak, active);
        // Yield `delay` microtasks so tasks finish out of order without real timers.
        for (let tick = 0; tick < delay; tick += 1) await Promise.resolve();
        active -= 1;
        return delay * 10;
      }
    );
    expect(results).toEqual([50, 10, 40, 20, 30, 0]);
    return expect(peak).toBe(4);
  });
});

// vertex-history /news stand-in (IBKR API news), shaped like vertex-history-news-v1.
const HISTORY: DeployStatusConfig = {
  token: "h".repeat(43),
  url: "https://history.example.test",
};
const ibkrNews = (): Response => {
  const items = [
    {
      articleId: "DJ-N$1",
      headline: "Coca-Cola names new CFO",
      provider: "DJ-N",
      t: 1_791_936_000,
      time: "2026-10-13T22:00:00Z",
    },
  ];
  return Response.json({
    cache: { ageSeconds: 0, hit: false, stale: false, ttlSeconds: 300 },
    client_id: 77,
    contract: {
      conId: 8894,
      currency: "USD",
      exchange: "SMART",
      lastTradeDateOrContractMonth: null,
      localSymbol: "KO",
      longName: "COCA-COLA CO/THE",
      matches: 1,
      multiplier: null,
      secType: "STK",
      timeZoneId: "US/Eastern",
    },
    count: items.length,
    fetchedAt: "2026-10-13T23:00:00Z",
    items,
    providers: [{ code: "DJ-N", name: "Dow Jones Newsletters" }],
    request: {
      count: 20,
      currency: "USD",
      exchange: "SMART",
      secType: "STK",
      symbol: "KO",
    },
    schema: "vertex-history-news-v1",
    source: "ibkr-gateway",
  });
};

const SA_KO = `<?xml version="1.0"?><rss xmlns:sa="https://seekingalpha.com/api/1.0" version="2.0"><channel><title>The Coca-Cola Company - News and Analysis on Seeking Alpha</title>
<item><title>Coca-Cola beats quarterly profit estimates</title><link>https://seekingalpha.com/symbol/KO/news?source=feed_symbol_KO</link><guid isPermaLink="false">https://seekingalpha.com/MarketCurrent:1</guid><pubDate>Tue, 13 Oct 2026 17:00:00 -0400</pubDate><sa:author_name>Seeking Alpha News</sa:author_name></item>
<item><title>Coca-Cola Has Raised Dividends for 63 Years: Can It Make It Another Decade?</title><link>https://seekingalpha.com/article/2-coca-cola-dividends?source=feed_symbol_KO</link><guid isPermaLink="false">https://seekingalpha.com/Article:2</guid><pubDate>Tue, 13 Oct 2026 14:50:00 -0400</pubDate><sa:author_name>Dividend Desk</sa:author_name></item>
</channel></rss>`;

const REUTERS_KO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss version="2.0"><channel><title>"KO site:reuters.com" - Google News</title>
<item><title>Coca-Cola beats quarterly profit estimates - Reuters</title><link>https://news.google.com/rss/articles/CBMiKO1?oc=5</link><guid isPermaLink="false">CBMiKO1</guid><pubDate>Tue, 13 Oct 2026 21:05:00 GMT</pubDate><description>&lt;a href="https://news.google.com/rss/articles/CBMiKO1?oc=5"&gt;Coca-Cola beats&lt;/a&gt;</description><source url="https://www.reuters.com">Reuters</source></item>
<item><title>Coca-Cola names new CFO - Reuters</title><link>https://news.google.com/rss/articles/CBMiKO2?oc=5</link><guid isPermaLink="false">CBMiKO2</guid><pubDate>Tue, 13 Oct 2026 22:01:00 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item>
</channel></rss>`;

const koFeeds = (overrides: Record<string, () => Response> = {}) =>
  feeds({
    "/api/sa/combined/KO.xml": () =>
      xml(SA_KO, "application/xml; charset=utf-8"),
    "/news": ibkrNews,
    "/rss/search": () => xml(REUTERS_KO, "application/xml; charset=utf-8"),
    ...overrides,
  });

describe("merged headline sources", () => {
  it("merges IBKR, Reuters, Seeking Alpha and Yahoo newest first, one copy per story", async () => {
    const { calls, fetch } = koFeeds();
    const news = await buildMarketNews(["KO"], 168, {
      fetch,
      marketHistory: HISTORY,
      now: () => NOW,
    });
    const [ko] = news.tickers;
    expect(ko?.errors).toEqual([]);
    expect(
      ko?.headlines.map((item) => [item.source, item.title, item.tags])
    ).toEqual([
      // Also on Reuters: IBKR ranks first.
      ["ibkr", "Coca-Cola names new CFO", ["executive"]],
      // Also on Seeking Alpha: Reuters ranks above it. "earnings" needs the SEC company name.
      ["reuters", "Coca-Cola beats quarterly profit estimates", ["earnings"]],
      [
        "yahoo",
        "Coca-Cola or Chevron: The One Dividend Stock I’d Hold for the Next 20 Years",
        [],
      ],
      // Near-identical to Yahoo's "…63 Years. Can It…": Seeking Alpha ranks above Yahoo.
      [
        "seekingalpha",
        "Coca-Cola Has Raised Dividends for 63 Years: Can It Make It Another Decade?",
        [],
      ],
      [
        "yahoo",
        "PepsiCo Trades Near 52-Week Low: Should You Buy Now or Wait?",
        [],
      ],
      [
        "yahoo",
        "Is Coca-Cola (KO) Stock Outpacing Its Consumer Staples Peers This Year?",
        [],
      ],
    ]);
    // The IBKR copy has no link of its own: it takes the Reuters copy's.
    expect(ko?.headlines[0]?.url).toBe(
      "https://news.google.com/rss/articles/CBMiKO2?oc=5"
    );
    expect(ko?.headlines[0]?.publisher).toBe("Dow Jones Newsletters");
    expect(ko?.headlines[1]?.url).toBe(
      "https://news.google.com/rss/articles/CBMiKO1?oc=5"
    );
    expect(calls).toContain(
      "https://history.example.test/news?symbol=KO&count=20"
    );
    expect(calls).toContain("https://seekingalpha.com/api/sa/combined/KO.xml");
    // Reuters is searched by the SEC company name without its legal form, last 30 days.
    return expect(calls).toContain(
      "https://news.google.com/rss/search?ceid=US%3Aen&gl=US&hl=en-US&q=%22COCA+COLA%22+site%3Areuters.com+when%3A30d"
    );
  });

  it("keeps the other sources when one fails, naming each failed source", async () => {
    const { fetch } = koFeeds({
      "/api/sa/combined/KO.xml": () => new Response("busy", { status: 503 }),
      "/news": () => new Response(null, { status: 503 }),
      "/rss/search": () => xml("<html>consent</html>", "application/xml"),
    });
    const feedsFor = await loadTickerFeeds("KO", {
      fetch,
      marketHistory: HISTORY,
      now: () => NOW,
    });
    expect(feedsFor.headlines).toHaveLength(4);
    expect(feedsFor.headlines.every((item) => item.source === "yahoo")).toBe(
      true
    );
    expect(feedsFor.filings).toHaveLength(3);
    return expect(feedsFor.errors).toEqual([
      "headlines: IBKR news: History endpoint returned HTTP 503",
      "headlines: Reuters headlines: not an RSS 2.0 document",
      "headlines: Seeking Alpha headlines returned HTTP 503",
    ]);
  });

  it("skips IBKR without a vertex-history config", async () => {
    const { calls, fetch } = koFeeds();
    const feedsFor = await loadTickerFeeds("KO", {
      fetch,
      marketHistory: null,
      now: () => NOW,
    });
    expect(calls.some((url) => url.startsWith(HISTORY.url))).toBe(false);
    expect(feedsFor.errors).toEqual([]);
    return expect(
      feedsFor.headlines.map((item) => [item.source, item.title])
    ).toContainEqual(["reuters", "Coca-Cola names new CFO"]);
  });

  it("reads only 8-K filings when the request includes filings only", async () => {
    const { calls, fetch } = koFeeds();
    const news = await buildMarketNews(
      ["AAPL"],
      720,
      {
        fetch,
        marketHistory: HISTORY,
        now: () => new Date("2026-09-03T00:00:00.000Z"),
      },
      "filings"
    );
    expect(news.tickers[0]?.headlines).toEqual([]);
    expect(news.tickers[0]?.errors).toEqual([]);
    expect(news.tickers[0]?.filings.length).toBeGreaterThan(0);
    return expect(calls.filter((url) => !url.includes("sec.gov"))).toEqual([]);
  });

  it("caches IBKR headlines per symbol, but not while the SEC ticker list is down", async () => {
    const { calls, fetch } = koFeeds();
    const options = { fetch, marketHistory: HISTORY, now: () => NOW };
    const ibkrCalls = () =>
      calls.filter((url) => url.startsWith(HISTORY.url)).length;
    await loadTickerFeeds("KO", options);
    const cached = await loadTickerFeeds("KO", options);
    expect(ibkrCalls()).toBe(1);
    expect(cached.headlines[0]?.source).toBe("ibkr");
    clearMarketNewsCacheForTesting();
    const failing = () => Promise.reject(new Error("SEC list down"));
    await loadTickerFeeds("KO", options, failing);
    const again = await loadTickerFeeds("KO", options, failing);
    expect(ibkrCalls()).toBe(3);
    return expect(again.headlines.map((item) => item.source)).toContain("ibkr");
  });

  // vertex-history never answers for `slowSymbol`: the request is aborted at the IBKR budget.
  const slowIbkr = (slowSymbol: string) => {
    const { calls, fetch: base } = koFeeds();
    const fetch: Fetch = (url, init) => {
      // `base` records every URL it answers; the hanging request is recorded here.
      if (
        !url.startsWith(HISTORY.url) ||
        new URL(url).searchParams.get("symbol") !== slowSymbol
      )
        return base(url, init);
      calls.push(url);
      // The package's TS lib predates Promise.withResolvers.
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      });
    };
    const ibkrSymbols = () =>
      calls
        .filter((url) => url.startsWith(HISTORY.url))
        .map((url) => new URL(url).searchParams.get("symbol"));
    return { fetch, ibkrSymbols };
  };

  it("treats IBKR running past its budget as a hidden skip, remembered for 60 s", async () => {
    const { fetch, ibkrSymbols } = slowIbkr("KO");
    let now = NOW;
    const options = {
      fetch,
      marketHistory: HISTORY,
      now: () => now,
      timeoutMs: 20,
    };
    const load = newsLoad();
    const slow = await loadTickerFeeds("KO", options, undefined, load);
    expect(slow.errors).toEqual([]);
    expect(slow.headlines.length).toBeGreaterThan(0);
    // The timeout ends IBKR for the rest of this load: AAPL does not ask.
    const next = await loadTickerFeeds("AAPL", options, undefined, load);
    expect(next.errors).toEqual([]);
    expect(ibkrSymbols()).toEqual(["KO"]);
    // Remembered: a new load within 60 s neither asks nor shows anything for KO.
    expect((await loadTickerFeeds("KO", options)).errors).toEqual([]);
    expect(ibkrSymbols()).toEqual(["KO"]);
    now = new Date(NOW.getTime() + 61_000);
    await loadTickerFeeds("KO", options);
    return expect(ibkrSymbols()).toEqual(["KO", "KO"]);
  });

  it("asks IBKR for a different symbol on the load after a timeout", async () => {
    const { fetch, ibkrSymbols } = slowIbkr("KO");
    const options = {
      fetch,
      marketHistory: HISTORY,
      now: () => NOW,
      timeoutMs: 20,
    };
    const first = await buildMarketNews(["KO", "AAPL", "TSLA"], 168, options);
    expect(ibkrSymbols()).toEqual(["KO", "AAPL"]);
    expect(
      first.tickers.flatMap((ticker) =>
        ticker.errors.filter((error) => error.includes("IBKR"))
      )
    ).toEqual([]);
    await buildMarketNews(["KO", "AAPL", "TSLA"], 168, options);
    return expect(ibkrSymbols()).toEqual(["KO", "AAPL", "TSLA"]);
  });

  it("reads IBKR through the global fetch when no fetch is given", async () => {
    vi.stubGlobal("fetch", koFeeds().fetch);
    const feedsFor = await loadTickerFeeds("KO", {
      marketHistory: HISTORY,
      now: () => NOW,
    });
    return expect(feedsFor.headlines[0]?.source).toBe("ibkr");
  });

  it("aborts an IBKR read after 5 s by default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { fetch: base } = koFeeds();
      const signals: AbortSignal[] = [];
      const fetch: Fetch = (url, init) => {
        if (!url.startsWith(HISTORY.url)) return base(url, init);
        if (init.signal) signals.push(init.signal);
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        });
      };
      const pending = loadTickerFeeds("KO", {
        fetch,
        marketHistory: HISTORY,
        now: () => NOW,
      });
      await vi.advanceTimersByTimeAsync(IBKR_NEWS_TIMEOUT_MS - 1);
      expect(signals.map((signal) => signal.aborted)).toEqual([false]);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals.map((signal) => signal.aborted)).toEqual([true]);
      expect(IBKR_NEWS_TIMEOUT_MS).toBe(5000);
      return expect((await pending).errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the 8-K feed alongside the headline feeds", async () => {
    const { fetch: base } = koFeeds();
    let releaseYahoo = (): void => undefined;
    const yahooGate = new Promise<void>((resolve) => {
      releaseYahoo = resolve;
    });
    // Yahoo answers only once the 8-K feed has been requested: a sequential read would hang.
    const fetch: Fetch = async (url, init) => {
      if (url.includes("feeds.finance.yahoo.com")) await yahooGate;
      if (url.includes("browse-edgar")) releaseYahoo();
      return base(url, init);
    };
    const feedsFor = await loadTickerFeeds("KO", { fetch, now: () => NOW });
    expect(feedsFor.filings).toHaveLength(3);
    return expect(feedsFor.headlines.length).toBeGreaterThan(0);
  });

  it("caps headline feeds at 512 KB while the 8-K feed keeps 2 MB", async () => {
    const declared = (bytes: number, name: string, type: string) => () =>
      new Response(fixtureBytes(name), {
        headers: { "content-length": String(bytes), "content-type": type },
      });
    const { fetch } = feeds({
      "/cgi-bin/browse-edgar": declared(
        600 * 1024,
        "sec-8-K-0000021344.xml",
        "application/atom+xml; charset=ISO-8859-1"
      ),
      KO: declared(600 * 1024, "yahoo-KO.xml", "application/rss+xml"),
    });
    const big = await loadTickerFeeds("KO", { fetch, now: () => NOW });
    expect(big.errors).toEqual([
      "headlines: Yahoo headlines response exceeds the size cap",
    ]);
    expect(big.filings).toHaveLength(3);
    clearMarketNewsCacheForTesting();
    const { fetch: huge } = feeds({
      "/cgi-bin/browse-edgar": declared(
        2 * 1024 * 1024 + 1,
        "sec-8-K-0000021344.xml",
        "application/atom+xml; charset=ISO-8859-1"
      ),
    });
    return expect(
      (await loadTickerFeeds("KO", { fetch: huge, now: () => NOW })).errors
    ).toEqual(["filings: SEC 8-K feed response exceeds the size cap"]);
  });

  it("asks IBKR for at most two uncached symbols per load", async () => {
    const { calls, fetch } = koFeeds();
    const news = await buildMarketNews(["KO", "AAPL", "TSLA"], 168, {
      fetch,
      marketHistory: HISTORY,
      now: () => NOW,
    });
    expect(
      calls
        .filter((url) => url.startsWith(HISTORY.url))
        .map((url) => {
          return new URL(url).searchParams.get("symbol");
        })
    ).toEqual(["KO", "AAPL"]);
    expect(IBKR_NEWS_READS_PER_LOAD).toBe(2);
    // No IBKR error for TSLA: a skipped source is not a failure.
    expect(
      news.tickers.flatMap((ticker) =>
        ticker.errors.filter((error) => error.startsWith("headlines: "))
      )
    ).toEqual([]);
    // The next load reads KO and AAPL from the cache and spends its budget on TSLA.
    await buildMarketNews(["KO", "AAPL", "TSLA"], 168, {
      fetch,
      marketHistory: HISTORY,
      now: () => NOW,
    });
    return expect(
      calls.filter((url) => url.startsWith(HISTORY.url))
    ).toHaveLength(3);
  });

  it("remembers a paced IBKR answer for its retry wait and stops IBKR for the load", async () => {
    let now = NOW;
    const paced = () =>
      new Response(null, { headers: { "retry-after": "120" }, status: 429 });
    const { calls, fetch } = koFeeds({ "/news": paced });
    const ibkrCalls = () =>
      calls.filter((url) => url.startsWith(HISTORY.url)).length;
    const options = { fetch, marketHistory: HISTORY, now: () => now };
    const load = newsLoad();
    const first = await loadTickerFeeds("KO", options, undefined, load);
    expect(first.errors).toEqual([
      "headlines: IBKR news: IBKR history pacing: retry in 120 s",
    ]);
    expect(load.ibkrReads).toBe(0);
    now = new Date(NOW.getTime() + 90_000);
    const cached = await loadTickerFeeds("KO", options);
    expect(cached.errors).toEqual(first.errors);
    expect(ibkrCalls()).toBe(1);
    now = new Date(NOW.getTime() + 121_000);
    await loadTickerFeeds("KO", options);
    return expect(ibkrCalls()).toBe(2);
  });

  it("keeps asking IBKR after an unknown-contract answer", async () => {
    const { calls, fetch } = koFeeds({
      "/news": () => new Response(null, { status: 422 }),
    });
    const load = newsLoad();
    const options = { fetch, marketHistory: HISTORY, now: () => NOW };
    const ko = await loadTickerFeeds("KO", options, undefined, load);
    expect(ko.errors).toEqual([
      "headlines: IBKR news: History endpoint returned HTTP 422",
    ]);
    await loadTickerFeeds("AAPL", options, undefined, load);
    return expect(
      calls.filter((url) => url.startsWith(HISTORY.url))
    ).toHaveLength(2);
  });

  return it("remembers a failed feed for 60 s, or for its Retry-After", async () => {
    let now = NOW;
    const { calls, fetch } = feeds({
      AAPL: () =>
        new Response("slow down", {
          headers: { "retry-after": "300" },
          status: 429,
        }),
      KO: () => new Response("slow down", { status: 429 }),
      TSLA: () =>
        new Response("slow down", {
          headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
          status: 429,
        }),
    });
    const options = { fetch, now: () => now };
    const yahooCalls = () =>
      calls.filter((url) => url.includes("feeds.finance.yahoo.com")).length;
    const all = async () => {
      for (const symbol of ["KO", "AAPL", "TSLA"])
        await loadTickerFeeds(symbol, options);
    };
    await all();
    expect(yahooCalls()).toBe(3);
    const ko = await loadTickerFeeds("KO", options);
    expect(ko.errors).toEqual(["headlines: Yahoo headlines returned HTTP 429"]);
    now = new Date(NOW.getTime() + 61_000);
    await all();
    // KO and TSLA (an HTTP-date Retry-After counts as no hint) after 60 s; AAPL waits 300 s.
    expect(yahooCalls()).toBe(5);
    now = new Date(NOW.getTime() + 301_000);
    await all();
    return expect(yahooCalls()).toBe(8);
  });
});

const at = new Date("2026-10-01T00:00:00.000Z");
const watchRow = (symbol: string, minute: number): WatchlistItem => ({
  buyZoneHigh: null,
  buyZoneLow: null,
  createdAt: new Date(at.getTime() + minute * 60_000),
  id: `alice-${symbol}`,
  note: null,
  symbol,
  updatedAt: at,
  userId: "alice",
});

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-10-22T12:00:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: at,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: at,
    email: `${userId}@domain.test`,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: at,
  },
});

const repositoryWith = (
  listByUser: WatchlistRepository["listByUser"]
): WatchlistRepository => ({
  addMany: vi.fn(),
  listByUser: vi.fn(listByUser),
  remove: vi.fn(),
  update: vi.fn(),
});

const clientFor = (
  requireSession: () => Promise<SafeAuthSession>,
  watchlist?: WatchlistRepository,
  marketHistory?: DeployStatusConfig
) => {
  const repositories = {
    addresses: {},
    adminUsers: {},
    dashboard: {},
    featureItems: {},
    profiles: {},
    userPreferences: {},
    ...(watchlist === undefined ? {} : { watchlist }),
  } as unknown as Repositories;
  const fetch = async (request: Request): Promise<Response> =>
    handleApiRequest(
      request,
      createApiContext(request, {
        capabilities: {
          ai: false,
          analytics: false,
          emailDelivery: false,
          telemetryExport: false,
        },
        ...(marketHistory === undefined ? {} : { marketHistory }),
        operatorEmails: ["alice@domain.test"],
        repositories,
        requestId: "request-1",
        requireRole: async () => {
          throw new AuthAuthorizationError(
            AUTHORIZATION_ERROR_CODES.FORBIDDEN,
            403
          );
        },
        requireSession,
      })
    );
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number
): Promise<void> => {
  const error = await promise.then(
    () => new Error("Expected the oRPC call to fail"),
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(ORPCError);
  return expect(error).toMatchObject({ code, status });
};

describe("marketNews.watchlist procedure", () => {
  it("rejects signed-out, forbidden and non-operator sessions before reading the watchlist", async () => {
    const repository = repositoryWith(async () => [watchRow("AAPL", 0)]);
    const { fetch } = feeds();
    setMarketNewsOptionsForTesting({ fetch, now: () => NOW });
    await expectCode(
      clientFor(async () => {
        throw new AuthAuthorizationError(
          AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
          401
        );
      }, repository).marketNews.watchlist({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(async () => {
        throw new AuthAuthorizationError(
          AUTHORIZATION_ERROR_CODES.ACCOUNT_SUSPENDED,
          403
        );
      }, repository).marketNews.watchlist({}),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor(async () => {
        throw new Error("auth backend down");
      }, repository).marketNews.watchlist({}),
      "INTERNAL_SERVER_ERROR",
      500
    );
    // A signed-in member who is not on VERTEX_OPERATOR_EMAILS (sign-up is public).
    await expectCode(
      clientFor(async () => session("bob"), repository).marketNews.watchlist(
        {}
      ),
      "FORBIDDEN",
      403
    );
    expect(repository.listByUser).not.toHaveBeenCalled();
    return expect(fetch).not.toHaveBeenCalled();
  });

  it("maps missing and failing watchlist storage", async () => {
    const signedIn = async () => session("alice");
    await expectCode(
      clientFor(signedIn).marketNews.watchlist({}),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor(
        signedIn,
        repositoryWith(async () => {
          throw new DatabasePersistenceError("list watchlist");
        })
      ).marketNews.watchlist({}),
      "STORAGE_ERROR",
      503
    );
    return expectCode(
      clientFor(
        signedIn,
        repositoryWith(async () => {
          throw new Error("unexpected");
        })
      ).marketNews.watchlist({}),
      "INTERNAL_SERVER_ERROR",
      500
    );
  });

  it("returns the operator's watchlist news, newest symbols first", async () => {
    const repository = repositoryWith(async () => [
      watchRow("AAPL", 0),
      watchRow("KO", 5),
    ]);
    const { fetch } = feeds();
    setMarketNewsOptionsForTesting({ fetch, now: () => NOW });
    const client = clientFor(async () => session("alice"), repository);
    const news = await client.marketNews.watchlist({});
    expect(repository.listByUser).toHaveBeenCalledWith("alice");
    expect(news.receivedAt).toEqual(NOW);
    expect(news.tickers.map((ticker) => ticker.symbol)).toEqual(["KO", "AAPL"]);
    expect(news.tickers[1]?.headlines[0]?.publishedAt).toBeInstanceOf(Date);
    const month = await client.marketNews.watchlist({ hours: 720 });
    expect(month.tickers[0]?.headlines).toHaveLength(4);
    const day = await client.marketNews.watchlist({ hours: 24 });
    expect(day.tickers[0]?.headlines).toHaveLength(4);
    return expectCode(
      client.marketNews.watchlist({ hours: 48 as 24 }),
      "BAD_REQUEST",
      400
    );
  });

  it("reads IBKR headlines through the request's vertex-history config", async () => {
    const { calls, fetch } = koFeeds();
    setMarketNewsOptionsForTesting({ fetch, now: () => NOW });
    const client = clientFor(
      async () => session("alice"),
      repositoryWith(async () => [watchRow("KO", 0)]),
      HISTORY
    );
    const news = await client.marketNews.watchlist({ hours: 168 });
    expect(calls).toContain(
      "https://history.example.test/news?symbol=KO&count=20"
    );
    expect(news.tickers[0]?.headlines[0]).toMatchObject({
      source: "ibkr",
      title: "Coca-Cola names new CFO",
      url: "https://news.google.com/rss/articles/CBMiKO2?oc=5",
    });
    // The calendar asks for filings only: no headline source is read.
    clearMarketNewsCacheForTesting();
    calls.length = 0;
    const filings = await client.marketNews.watchlist({
      hours: 720,
      include: "filings",
    });
    expect(filings.tickers[0]?.headlines).toEqual([]);
    return expect(calls.every((url) => url.includes("sec.gov"))).toBe(true);
  });
});
