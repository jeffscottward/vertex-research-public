import { describe, expect, it } from "vitest";

import {
  historyDurationAllowed,
  type MarketBar,
} from "./contracts/market-data.ts";
import type { DeployStatusConfig } from "./server/deploy-status.ts";
import {
  buildHistoryBarsUrl,
  checkHistoryBarsRequest,
  fetchHistoryBars,
  fetchHistoryBarsPaged,
  fetchHistoryNews,
  type HistoryBarsRequest,
  historyEndDateTime,
  STK_VOLUME_LOT,
} from "./server/ibkr-history.ts";
import { MarketDataError } from "./server/market-data.ts";

const BASE = "https://quantvps.tailnet.test:8443/vertex-history/v1";
const config: DeployStatusConfig = { token: "h".repeat(43), url: BASE };
const DAY = 86_400;

const bar = (t: number, c = 100): MarketBar => ({
  c,
  h: c + 1,
  l: c - 1,
  o: c,
  t,
  v: 1000,
});

// A vertex-history 1.3.0 document echoing the request in `url`.
const document = (url: string, bars: MarketBar[], stale = false) => {
  const params = new URL(url).searchParams;
  const end = params.get("endDateTime");
  const request = {
    barSize: params.get("barSize"),
    contractMonth: params.get("contractMonth"),
    currency: params.get("currency"),
    duration: params.get("duration"),
    exchange: params.get("exchange") ?? "SMART",
    secType: params.get("secType"),
    symbol: params.get("symbol"),
    useRTH: params.get("useRTH") === "1",
    whatToShow: params.get("whatToShow"),
    ...(end === null ? {} : { endDateTime: end }),
  };
  return {
    as_of: bars.length > 0 ? "2026-11-09T00:00:00Z" : null,
    bars,
    cache: { age_seconds: 0, hit: false, stale, ttl_seconds: 3600 },
    client_id: 77,
    contract: {
      conId: 756_733,
      currency: "USD",
      exchange: params.get("exchange") ?? "SMART",
      lastTradeDateOrContractMonth: null,
      localSymbol: params.get("symbol"),
      longName: null,
      matches: 1,
      multiplier: null,
      secType: params.get("secType"),
      timeZoneId: "US/Eastern",
    },
    count: bars.length,
    fetched_at: "2026-11-10T20:00:00Z",
    request,
    schema: "vertex-history-bars-v1",
    source: "ibkr-gateway",
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const recorder = (answer: (url: string, index: number) => Response) => {
  const urls: string[] = [];
  const fetch = (input: string, init: RequestInit): Promise<Response> => {
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    urls.push(input);
    return Promise.resolve(answer(input, urls.length - 1));
  };
  return { fetch, urls };
};

describe("historyDurationAllowed", () => {
  it("allows daily windows up to 30 Y, above 365 days in years only", () => {
    expect(historyDurationAllowed("1 day", "30 Y")).toBe(true);
    expect(historyDurationAllowed("1 day", "365 D")).toBe(true);
    expect(historyDurationAllowed("1 day", "31 Y")).toBe(false);
    expect(historyDurationAllowed("1 day", "400 D")).toBe(false);
    expect(historyDurationAllowed("1 day", "13 M")).toBe(false);
    expect(historyDurationAllowed("1 hour", "31 D")).toBe(true);
    expect(historyDurationAllowed("1 hour", "1 Y")).toBe(false);
    expect(historyDurationAllowed("1 min", "1 W")).toBe(false);
    expect(historyDurationAllowed("1 day", "1Y")).toBe(false);
  });
});

describe("checkHistoryBarsRequest", () => {
  const ok: HistoryBarsRequest[] = [
    {
      barSize: "1 day",
      duration: "30 Y",
      symbol: "SPY",
      whatToShow: "ADJUSTED_LAST",
    },
    {
      barSize: "1 day",
      duration: "5 Y",
      exchange: "CBOE",
      secType: "IND",
      symbol: "VIX",
    },
    { barSize: "1 hour", duration: "31 D", secType: "CASH", symbol: "EUR" },
    {
      barSize: "1 day",
      duration: "1 Y",
      endDateTime: "20101001-20:00:00",
      symbol: "SPY",
    },
  ];
  const bad: [HistoryBarsRequest, string][] = [
    [{ barSize: "1 day", duration: "31 Y", symbol: "SPY" }, "Duration"],
    [
      {
        barSize: "1 day",
        duration: "1 Y",
        endDateTime: "2010-10-01",
        symbol: "SPY",
      },
      "endDateTime",
    ],
    [
      { barSize: "1 day", duration: "1 Y", secType: "IND", symbol: "VIX" },
      "exchange",
    ],
    [
      {
        barSize: "1 day",
        duration: "1 Y",
        endDateTime: "20101001-20:00:00",
        exchange: "CME",
        secType: "CONTFUT",
        symbol: "ES",
      },
      "CONTFUT",
    ],
    [
      {
        barSize: "1 hour",
        duration: "2 D",
        symbol: "SPY",
        whatToShow: "ADJUSTED_LAST",
      },
      "ADJUSTED_LAST",
    ],
    [
      {
        barSize: "1 day",
        duration: "1 Y",
        endDateTime: "20101001-20:00:00",
        symbol: "SPY",
        whatToShow: "ADJUSTED_LAST",
      },
      "ADJUSTED_LAST",
    ],
    [
      {
        barSize: "1 day",
        duration: "1 Y",
        exchange: "CME",
        secType: "FUT",
        symbol: "ES",
        whatToShow: "BID_ASK",
      },
      "BID_ASK",
    ],
    [
      {
        barSize: "1 day",
        duration: "1 Y",
        exchange: "CBOE",
        secType: "IND",
        symbol: "VIX",
        whatToShow: "MIDPOINT",
      },
      "IND",
    ],
  ];
  it("accepts the 1.3.0 additions", () => {
    for (const request of ok)
      expect(() => checkHistoryBarsRequest(request)).not.toThrow();
  });
  it("refuses requests the service would refuse, as BAD_REQUEST", () => {
    for (const [request, message] of bad) {
      expect(() => checkHistoryBarsRequest(request)).toThrow(message);
      try {
        checkHistoryBarsRequest(request);
      } catch (error) {
        expect((error as MarketDataError).code).toBe("BAD_REQUEST");
      }
    }
  });
});

describe("buildHistoryBarsUrl", () => {
  it("sends only the given optional fields", () => {
    const url = new URL(
      buildHistoryBarsUrl(`${BASE}/`, {
        barSize: "1 day",
        duration: "30 Y",
        endDateTime: "20101001-20:00:00",
        exchange: "cboe",
        secType: "IND",
        symbol: "vix",
      })
    );
    expect(url.pathname).toBe("/vertex-history/v1/bars");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      barSize: "1 day",
      currency: "USD",
      duration: "30 Y",
      endDateTime: "20101001-20:00:00",
      exchange: "CBOE",
      secType: "IND",
      symbol: "VIX",
      useRTH: "1",
      whatToShow: "TRADES",
    });
    const plain = new URL(
      buildHistoryBarsUrl(BASE, {
        barSize: "5 mins",
        duration: "1 D",
        symbol: "SPY",
        useRTH: false,
      })
    );
    expect(plain.searchParams.has("exchange")).toBe(false);
    expect(plain.searchParams.has("endDateTime")).toBe(false);
    expect(plain.searchParams.get("useRTH")).toBe("0");
  });

  it("formats end dates in IBKR's UTC form", () => {
    expect(historyEndDateTime(new Date("2026-10-01T20:00:05.900Z"))).toBe(
      "20261001-20:00:05"
    );
  });

  it("passes a futures contract month", () => {
    const url = new URL(
      buildHistoryBarsUrl(BASE, {
        barSize: "1 day",
        contractMonth: "202612",
        duration: "1 Y",
        exchange: "CME",
        secType: "FUT",
        symbol: "ES",
      })
    );
    expect(url.searchParams.get("contractMonth")).toBe("202612");
  });
});

describe("fetchHistoryBars", () => {
  it("parses an ADJUSTED_LAST document and sorts the bars", async () => {
    const t0 = Date.UTC(2026, 9, 1) / 1000;
    const { urls, fetch } = recorder((url) =>
      json(document(url, [bar(t0 + DAY, 101), bar(t0, 100)]))
    );
    const result = await fetchHistoryBars(
      config,
      {
        barSize: "1 day",
        duration: "30 Y",
        symbol: "SPY",
        whatToShow: "ADJUSTED_LAST",
      },
      { fetch }
    );
    expect(urls).toHaveLength(1);
    expect(result.request.whatToShow).toBe("ADJUSTED_LAST");
    expect(result.bars.map((b) => b.t)).toEqual([t0, t0 + DAY]);
    expect(result.stale).toBe(false);
  });

  it("does not call the service for a refused request or without config", async () => {
    const { urls, fetch } = recorder(() => json({}));
    await expect(
      fetchHistoryBars(
        config,
        { barSize: "1 day", duration: "31 Y", symbol: "SPY" },
        { fetch }
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      fetchHistoryBars(
        null,
        { barSize: "1 day", duration: "1 Y", symbol: "SPY" },
        { fetch }
      )
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(urls).toEqual([]);
  });

  it("rejects a document that breaks the schema", async () => {
    const { fetch } = recorder((url) =>
      json({ ...document(url, []), client_id: 78 })
    );
    await expect(
      fetchHistoryBars(
        config,
        { barSize: "1 day", duration: "1 Y", symbol: "SPY" },
        { fetch }
      )
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("fetchHistoryBarsPaged", () => {
  const t0 = Date.UTC(2026, 9, 1, 13, 30) / 1000;
  const hour = 3600;

  it("walks back one window at a time, ending each before the previous first bar", async () => {
    const pages = [
      [bar(t0 + 2 * hour), bar(t0 + 3 * hour)],
      [bar(t0), bar(t0 + hour), bar(t0 + 2 * hour)],
      [bar(t0 - hour)],
    ];
    const { urls, fetch } = recorder((url, index) =>
      json(document(url, pages[index] ?? [], index === 1))
    );
    const result = await fetchHistoryBarsPaged(
      config,
      { barSize: "1 hour", duration: "31 D", symbol: "SPY" },
      3,
      { fetch }
    );
    expect(urls).toHaveLength(3);
    expect(new URL(urls[0] as string).searchParams.has("endDateTime")).toBe(
      false
    );
    expect(new URL(urls[1] as string).searchParams.get("endDateTime")).toBe(
      historyEndDateTime(new Date((t0 + 2 * hour - 1) * 1000))
    );
    expect(new URL(urls[2] as string).searchParams.get("endDateTime")).toBe(
      historyEndDateTime(new Date((t0 - 1) * 1000))
    );
    expect(result.bars.map((b) => b.t)).toEqual([
      t0 - hour,
      t0,
      t0 + hour,
      t0 + 2 * hour,
      t0 + 3 * hour,
    ]);
    expect(result.stale).toBe(true);
  });

  it("stops at an empty window and before 1990", async () => {
    const early = Date.UTC(1990, 0, 1) / 1000;
    const { urls, fetch } = recorder((url, index) =>
      json(document(url, index === 0 ? [bar(early)] : []))
    );
    await fetchHistoryBarsPaged(
      config,
      { barSize: "1 day", duration: "1 Y", symbol: "SPY" },
      5,
      { fetch }
    );
    expect(urls).toHaveLength(1);
    const empty = recorder((url) => json(document(url, [])));
    await fetchHistoryBarsPaged(
      config,
      { barSize: "1 day", duration: "1 Y", symbol: "SPY" },
      5,
      {
        fetch: empty.fetch,
      }
    );
    expect(empty.urls).toHaveLength(1);
  });

  it("retries a paced page after a wait, then gives up", async () => {
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    const paced = () => json({ error: "paced", retry_after_seconds: 12 }, 429);
    const once = recorder((url, index) =>
      index === 0 ? paced() : json(document(url, [bar(t0)]))
    );
    const result = await fetchHistoryBarsPaged(
      config,
      { barSize: "1 hour", duration: "31 D", symbol: "SPY" },
      1,
      {
        fetch: once.fetch,
        pacedWaitMs: 7,
        sleep,
      }
    );
    expect(result.bars).toHaveLength(1);
    expect(result.complete).toBe(true);
    expect(waits).toEqual([12_000]);
    const always = recorder(paced);
    await expect(
      fetchHistoryBarsPaged(
        config,
        { barSize: "1 hour", duration: "31 D", symbol: "SPY" },
        1,
        {
          fetch: always.fetch,
          pacedRetries: 2,
          sleep,
        }
      )
    ).rejects.toMatchObject({ code: "PACED" });
    expect(always.urls).toHaveLength(3);
  });

  it("fails at once when the service asks for a longer wait than allowed", async () => {
    const waits: number[] = [];
    const violation = recorder(() =>
      json({ error: "pacing_violation", retry_after_seconds: 600 }, 429)
    );
    await expect(
      fetchHistoryBarsPaged(
        config,
        { barSize: "1 hour", duration: "31 D", symbol: "SPY" },
        1,
        {
          fetch: violation.fetch,
          sleep: (ms) => {
            waits.push(ms);
            return Promise.resolve();
          },
        }
      )
    ).rejects.toMatchObject({ code: "PACED", retryAfterSeconds: 600 });
    expect(violation.urls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("retries an unavailable page once, and keeps earlier pages when a later one fails", async () => {
    const sleep = () => Promise.resolve();
    const down = () => json({ error: "unavailable", message: "gateway" }, 503);
    const flaky = recorder((url, index) =>
      index === 0 ? down() : json(document(url, [bar(t0)]))
    );
    const once = await fetchHistoryBarsPaged(
      config,
      { barSize: "1 hour", duration: "31 D", symbol: "SPY" },
      1,
      { fetch: flaky.fetch, sleep }
    );
    expect(once.bars).toHaveLength(1);
    expect(flaky.urls).toHaveLength(2);
    const later = recorder((url, index) =>
      index === 0 ? json(document(url, [bar(t0), bar(t0 + 3600)])) : down()
    );
    const partial = await fetchHistoryBarsPaged(
      config,
      { barSize: "1 hour", duration: "31 D", symbol: "SPY" },
      3,
      { fetch: later.fetch, sleep }
    );
    expect(partial.complete).toBe(false);
    expect(partial.bars.map((b) => b.t)).toEqual([t0, t0 + 3600]);
    expect(later.urls).toHaveLength(3);
    const first = recorder(() => down());
    await expect(
      fetchHistoryBarsPaged(
        config,
        { barSize: "1 hour", duration: "31 D", symbol: "SPY" },
        3,
        { fetch: first.fetch, sleep }
      )
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const notFound = recorder(() =>
      json({ error: "no_contract", message: "none" }, 422)
    );
    await expect(
      fetchHistoryBarsPaged(
        config,
        { barSize: "1 hour", duration: "31 D", symbol: "ZZZZ" },
        2,
        { fetch: notFound.fetch, sleep }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(notFound.urls).toHaveLength(1);
  });

  it("stops when a window does not reach further back, keeping the newer copy of a duplicate", async () => {
    const same = recorder((url, index) =>
      json(document(url, [bar(t0, index === 0 ? 101 : 99)]))
    );
    const result = await fetchHistoryBarsPaged(
      config,
      { barSize: "1 day", duration: "1 D", symbol: "SPY" },
      5,
      { fetch: same.fetch }
    );
    expect(same.urls).toHaveLength(2);
    expect(result.bars).toEqual([
      { ...bar(t0, 101), v: 1000 * STK_VOLUME_LOT },
    ]);
  });

  it("waits with real timers when no sleep is given", async () => {
    const once = recorder((url, index) =>
      index === 0
        ? json({ error: "paced" }, 429)
        : json(document(url, [bar(t0)]))
    );
    const result = await fetchHistoryBarsPaged(
      config,
      { barSize: "1 hour", duration: "31 D", symbol: "SPY" },
      1,
      { fetch: once.fetch, pacedWaitMs: 1 }
    );
    expect(result.bars).toHaveLength(1);
    expect(once.urls).toHaveLength(2);
  });

  it("allows one page only for CONTFUT and ADJUSTED_LAST", async () => {
    const { urls, fetch } = recorder((url) => json(document(url, [])));
    await expect(
      fetchHistoryBarsPaged(
        config,
        {
          barSize: "1 day",
          duration: "1 Y",
          exchange: "CME",
          secType: "CONTFUT",
          symbol: "ES",
        },
        2,
        { fetch }
      )
    ).rejects.toBeInstanceOf(MarketDataError);
    await expect(
      fetchHistoryBarsPaged(
        config,
        {
          barSize: "1 day",
          duration: "30 Y",
          symbol: "SPY",
          whatToShow: "ADJUSTED_LAST",
        },
        2,
        {
          fetch,
        }
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(urls).toEqual([]);
  });
});

describe("fetchHistoryNews", () => {
  const newsDocument = (overrides: Record<string, unknown> = {}) => ({
    cache: { ageSeconds: 0, hit: false, stale: false, ttlSeconds: 300 },
    client_id: 77,
    contract: {
      conId: 265_598,
      currency: "USD",
      exchange: "SMART",
      lastTradeDateOrContractMonth: null,
      localSymbol: "AAPL",
      longName: "APPLE INC",
      matches: 1,
      multiplier: null,
      secType: "STK",
      timeZoneId: "US/Eastern",
    },
    count: 1,
    fetchedAt: "2026-11-10T20:00:00Z",
    items: [
      {
        articleId: "BRFG$1",
        headline: "Apple holds capex steady",
        provider: "BRFG",
        t: 1_794_340_000,
        time: "2026-11-10T19:46:40Z",
      },
    ],
    providers: [{ code: "BRFG", name: "Briefing.com General Market Columns" }],
    request: {
      count: 5,
      currency: "USD",
      exchange: "SMART",
      secType: "STK",
      symbol: "AAPL",
    },
    schema: "vertex-history-news-v1",
    source: "ibkr-gateway",
    ...overrides,
  });

  it("reads the newest headlines with their providers", async () => {
    const { urls, fetch } = recorder(() => json(newsDocument()));
    const news = await fetchHistoryNews(config, "aapl", 5, { fetch });
    expect(urls).toEqual([`${BASE}/news?symbol=AAPL&count=5`]);
    expect(news.items[0]?.headline).toBe("Apple holds capex steady");
    expect(news.providers.map((p) => p.code)).toEqual(["BRFG"]);
    expect(news.stale).toBe(false);
  });

  it("maps a missing news permission to ENTITLEMENT", async () => {
    const { fetch } = recorder(() =>
      json(
        {
          error: "entitlement",
          ibkr_code: 10_276,
          message: "News feed is not allowed",
        },
        502
      )
    );
    await expect(
      fetchHistoryNews(config, "AAPL", 5, { fetch })
    ).rejects.toMatchObject({
      code: "ENTITLEMENT",
    });
  });

  it("refuses a bad count without a request and a bad document after one", async () => {
    const { urls, fetch } = recorder(() => json(newsDocument({ count: 2 })));
    await expect(
      fetchHistoryNews(config, "AAPL", 51, { fetch })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(urls).toEqual([]);
    await expect(
      fetchHistoryNews(config, "AAPL", 5, { fetch })
    ).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });
});

describe("volume units", () => {
  it("scales US stock volume from lots of 100 to shares, other volume unchanged", async () => {
    const t0 = Date.UTC(2026, 9, 1) / 1000;
    const stock = recorder((url) => json(document(url, [bar(t0)])));
    const shares = await fetchHistoryBars(
      config,
      { barSize: "1 day", duration: "1 Y", symbol: "SPY" },
      { fetch: stock.fetch }
    );
    expect(shares.bars[0]?.v).toBe(1000 * STK_VOLUME_LOT);
    const index = recorder((url) =>
      json(document(url, [{ ...bar(t0), v: null }]))
    );
    const vix = await fetchHistoryBars(
      config,
      {
        barSize: "1 day",
        duration: "1 Y",
        exchange: "CBOE",
        secType: "IND",
        symbol: "VIX",
      },
      { fetch: index.fetch }
    );
    expect(vix.bars[0]?.v).toBeNull();
    const futures = recorder((url) => json(document(url, [bar(t0)])));
    const es = await fetchHistoryBars(
      config,
      {
        barSize: "1 day",
        duration: "1 Y",
        exchange: "CME",
        secType: "CONTFUT",
        symbol: "ES",
      },
      { fetch: futures.fetch }
    );
    expect(es.bars[0]?.v).toBe(1000);
  });
});
