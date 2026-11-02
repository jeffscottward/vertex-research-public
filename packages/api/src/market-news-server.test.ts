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
import { handleApiRequest } from "./server/handler.ts";
import {
  buildMarketNews,
  cachedSource,
  clearMarketNewsCacheForTesting,
  fetchBoundedText,
  loadTickerFeeds,
  type MarketNewsOptions,
  mapWithConcurrency,
  marketNewsCacheSizeForTesting,
  NEWS_CACHE_MAX_ENTRIES,
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

// Public feed stand-ins: Yahoo RSS by symbol, SEC ticker list and 8-K Atom by CIK.
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
    return expect(calls.length).toBe(first + 3);
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
  watchlist?: WatchlistRepository
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
});
