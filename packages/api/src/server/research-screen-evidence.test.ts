import { afterEach, describe, expect, it, vi } from "vitest";

import type { CatalogEntry } from "../research-screen.ts";
import { researchScreenChartUrl } from "../research-screen-quote.ts";
import { SWINGLYTICS_PARSE_ERRORS, SWINGLYTICS_URL } from "../swinglytics.ts";
import type { DeployStatusFetch } from "./deploy-status.ts";
import {
  HISTORY_CONFIG,
  historyBar,
  historyResponse,
  withHistory,
} from "./merged-bars.test-support.ts";
import type * as MergedBarsModule from "./merged-bars.ts";
import {
  readChart,
  readIbkrBars,
  readSwinglytics,
  researchScreenNow,
  setResearchScreenOptionsForTesting,
} from "./research-screen-evidence.ts";

// The plans readIbkrBars hands to loadMergedBars (which still runs): the transport options and the
// Yahoo side of the plan are not visible in its result.
type SeenPlan = Omit<MergedBarsModule.MergedBarsPlan<unknown>, "keyOf">;
const seen = vi.hoisted(() => {
  const plans: SeenPlan[] = [];
  return { plans };
});

vi.mock("./merged-bars.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof MergedBarsModule>();
  return {
    ...actual,
    loadMergedBars: <T>(
      plan: MergedBarsModule.MergedBarsPlan<T>
    ): Promise<MergedBarsModule.MergedBars<T>> => {
      seen.plans.push(plan);
      return actual.loadMergedBars(plan);
    },
  };
});

const NOW = new Date("2026-11-10T20:05:00Z");
const DAY_SECONDS = 86_400;
const NOV_5 = Date.UTC(2026, 10, 5) / 1000;

type Call = Readonly<{ url: string; init: RequestInit }>;

/** Installs a fake fetch that answers every request with `answer` and records the calls. */
const useFetch = (answer: (call: Call) => Promise<Response> | Response) => {
  const calls: Call[] = [];
  const fetch: DeployStatusFetch = async (url, init) => {
    calls.push({ init, url });
    return answer({ init, url });
  };
  setResearchScreenOptionsForTesting({ fetch, now: () => NOW });
  return calls;
};

/** A fetch that never answers and rejects when its signal aborts, as a stalled request does. */
const stalled = ({ init }: Call): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError"))
    );
  });

/** A body of `count` chunks of `size` bytes without a declared length. */
const streamOf = (count: number, size: number): ReadableStream<Uint8Array> => {
  let sent = 0;
  return new ReadableStream({
    pull: (controller) => {
      if (sent === count) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(size).fill(32));
    },
  });
};

afterEach(() => {
  setResearchScreenOptionsForTesting({});
  seen.plans.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("researchScreenNow", () => {
  it("is the system clock without a seam and the seam's clock with one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-07T15:00:00Z"));
    expect(researchScreenNow()).toEqual(new Date("2030-01-07T15:00:00Z"));
    setResearchScreenOptionsForTesting({ now: () => NOW });
    expect(researchScreenNow()).toBe(NOW);
  });
});

describe("readChart", () => {
  // Synthetic chart answer: two daily bars of an invented instrument.
  const chart = {
    chart: {
      error: null,
      result: [
        {
          indicators: {
            quote: [
              {
                close: [101, 103],
                high: [102, 104],
                low: [99, 100],
                open: [100, 101],
              },
            ],
          },
          meta: {
            currency: "USD",
            currentTradingPeriod: {
              regular: { end: 1_794_344_400, start: 1_794_321_000 },
            },
            exchangeTimezoneName: "America/New_York",
            instrumentType: "EQUITY",
            regularMarketPrice: 103.5,
            regularMarketTime: 1_794_340_000,
          },
          timestamp: [1_793_975_400, 1_794_234_600],
        },
      ],
    },
  };

  it("reads the quote and the bars with one bounded GET", async () => {
    const calls = useFetch(() => Response.json(chart));

    const read = await readChart("BRK.B");

    expect(read).toStrictEqual({
      bars: [
        { c: 101, date: "2026-11-06", h: 102, l: 99, o: 100 },
        { c: 103, date: "2026-11-09", h: 104, l: 100, o: 101 },
      ],
      ok: true,
      quote: {
        currency: "USD",
        instrumentType: "EQUITY",
        price: 103.5,
        quoteAt: new Date(1_794_340_000_000),
        sessionEnd: new Date(1_794_344_400_000),
        sessionStart: new Date(1_794_321_000_000),
        timeZone: "America/New_York",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(researchScreenChartUrl("BRK.B"));
    expect(calls[0]?.init).toStrictEqual({
      headers: {
        accept: "application/json",
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) vertex-research/research-screen",
      },
      method: "GET",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
  });

  it("uses the global fetch without a seam; a malformed answer has no quote and no bars", async () => {
    const fetch = vi.fn(async () => Response.json({ chart: {} }));
    vi.stubGlobal("fetch", fetch);

    expect(await readChart("AAPL")).toStrictEqual({
      bars: [],
      ok: true,
      quote: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, "rate-limited"],
    [302, "provider-http"],
    [404, "provider-http"],
    [500, "provider-http"],
  ] as const)("maps HTTP %i to %s", async (status, errorCode) => {
    useFetch(() => new Response(null, { status }));

    expect(await readChart("AAPL")).toStrictEqual({
      errorCode,
      errorMessage: `Yahoo chart returned HTTP ${status}`,
      ok: false,
    });
  });

  it("maps a network error to provider-timeout without its text", async () => {
    useFetch(() => {
      throw new TypeError(`fetch failed: ${researchScreenChartUrl("AAPL")}`);
    });

    expect(await readChart("AAPL")).toStrictEqual({
      errorCode: "provider-timeout",
      errorMessage: "Yahoo chart request failed",
      ok: false,
    });
  });

  it("aborts after 10 seconds and maps the abort to provider-timeout", async () => {
    vi.useFakeTimers();
    const calls = useFetch(stalled);

    const pending = readChart("AAPL");
    await vi.advanceTimersByTimeAsync(9999);
    expect(calls[0]?.init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toStrictEqual({
      errorCode: "provider-timeout",
      errorMessage: "Yahoo chart request timed out",
      ok: false,
    });
  });

  it("refuses a body above 4 MiB", async () => {
    // 4 MiB and one byte, in 5 chunks.
    useFetch(() => new Response(streamOf(4, 1024 * 1024 + 1)));

    expect(await readChart("AAPL")).toStrictEqual({
      errorCode: "provider-http",
      errorMessage: "Yahoo chart response exceeds the size cap",
      ok: false,
    });
  });

  it("accepts a body of exactly 4 MiB", async () => {
    useFetch(() => new Response(streamOf(4, 1024 * 1024)));

    expect(await readChart("AAPL")).toMatchObject({
      errorMessage: "Yahoo chart response is not valid JSON",
    });
  });

  it.each([
    ["an HTML page", "<html>blocked</html>"],
    ["an empty body", null],
  ])("refuses %s as not JSON", async (_name, body) => {
    useFetch(() => new Response(body));

    expect(await readChart("AAPL")).toStrictEqual({
      errorCode: "provider-http",
      errorMessage: "Yahoo chart response is not valid JSON",
      ok: false,
    });
  });
});

describe("readIbkrBars", () => {
  const entry = (overrides: Partial<CatalogEntry> = {}): CatalogEntry => ({
    aliases: [],
    assetType: "equity",
    currency: "USD",
    hasContractSpecs: false,
    id: "report-aaa",
    providerSymbol: "AAA",
    status: "active",
    symbol: "AAA",
    timeZone: "America/New_York",
    ...overrides,
  });
  // 5 and 6 November are complete; the bar of 9 November has no close; the session of
  // 10 November still runs when the service fetched the bars (15:00 New York).
  const bars = [
    historyBar(NOV_5, 100),
    historyBar(NOV_5 + DAY_SECONDS, 102),
    historyBar(NOV_5 + 4 * DAY_SECONDS, 0),
    historyBar(NOV_5 + 5 * DAY_SECONDS, 104),
  ];
  const noOther: DeployStatusFetch = () => {
    throw new Error("unexpected request");
  };

  it.each([
    [
      "a currency other than USD",
      entry({ currency: "EUR" }),
      "IBKR bars are read for USD instruments only",
    ],
    [
      "an index",
      entry({ assetType: "index", providerSymbol: "AAA" }),
      "IBKR bars are read for stocks, ETFs and futures only",
    ],
    [
      "a class share",
      entry({ providerSymbol: "BRK.B" }),
      "No IBKR contract for this symbol",
    ],
    [
      "an unknown futures root",
      entry({ assetType: "future", providerSymbol: "ZZZZ=F" }),
      "No IBKR contract for this symbol",
    ],
  ])("does not serve %s", async (_name, report, message) => {
    const calls = useFetch(() => Response.error());

    expect(await readIbkrBars(report, HISTORY_CONFIG)).toStrictEqual({
      message,
      ok: false,
      reason: "not-served",
    });
    expect(calls).toHaveLength(0);
    expect(seen.plans).toHaveLength(0);
  });

  it.each([null, undefined])(
    "is not configured without a history service (%s)",
    async (config) => {
      const calls = useFetch(() => Response.error());

      expect(await readIbkrBars(entry(), config)).toStrictEqual({
        message: "IBKR history not configured",
        ok: false,
        reason: "not-configured",
      });
      expect(calls).toHaveLength(0);
    }
  );

  it("reads the completed daily bars of a stock from the history service", async () => {
    const history = withHistory((url) => historyResponse(url, bars), noOther);
    const now = (): Date => NOW;
    setResearchScreenOptionsForTesting({ fetch: history.fetch, now });

    const read = await readIbkrBars(
      entry({ assetType: "etf" }),
      HISTORY_CONFIG
    );

    expect(read).toStrictEqual({
      bars: [
        { c: 100, date: "2026-11-05", h: 101, l: 99, o: 100 },
        { c: 102, date: "2026-11-06", h: 103, l: 101, o: 102 },
      ],
      ok: true,
    });
    expect(history.urls).toHaveLength(1);
    const params = new URL(history.urls[0] ?? "").searchParams;
    expect(Object.fromEntries(params)).toMatchObject({
      barSize: "1 day",
      duration: "1 Y",
      secType: "STK",
      symbol: "AAA",
      whatToShow: "TRADES",
    });
    expect(seen.plans).toHaveLength(1);
    const [plan] = seen.plans;
    expect(plan).toMatchObject({
      config: HISTORY_CONFIG,
      ibkrOnly: true,
      offline: true,
      options: {
        fetch: history.fetch,
        maxPacedWaitMs: 70_000,
        now: researchScreenNow,
        pacedRetries: 1,
        timeoutMs: 20_000,
        unavailableRetries: 0,
      },
      request: {
        barSize: "1 day",
        duration: "1 Y",
        secType: "STK",
        symbol: "AAA",
        whatToShow: "TRADES",
      },
      site: "research-screen",
    });
    expect(plan).not.toHaveProperty("fillBefore");
    expect(plan).not.toHaveProperty("pages");
    // IBKR only: the plan's Yahoo side holds no bars (the chart answer has the Yahoo bars).
    expect(await plan?.yahoo()).toStrictEqual([]);
  });

  it("reads a continuous future through the global fetch without a seam", async () => {
    const history = withHistory(
      (url) => historyResponse(url, bars.slice(0, 1)),
      noOther
    );
    vi.stubGlobal("fetch", history.fetch);

    const read = await readIbkrBars(
      entry({ assetType: "future", providerSymbol: "GC=F" }),
      HISTORY_CONFIG
    );

    expect(read).toStrictEqual({
      bars: [{ c: 100, date: "2026-11-05", h: 101, l: 99, o: 100 }],
      ok: true,
    });
    const params = new URL(history.urls[0] ?? "").searchParams;
    expect(Object.fromEntries(params)).toMatchObject({
      exchange: "COMEX",
      secType: "CONTFUT",
      symbol: "GC",
      whatToShow: "TRADES",
    });
    expect(seen.plans[0]?.options).not.toHaveProperty("fetch");
  });

  it("fails with the reason of the history service", async () => {
    const history = withHistory(
      () => new Response("down", { status: 500 }),
      noOther
    );
    setResearchScreenOptionsForTesting({
      fetch: history.fetch,
      now: () => NOW,
    });

    const read = await readIbkrBars(entry(), HISTORY_CONFIG);

    expect(read).toStrictEqual({
      message: "History endpoint returned HTTP 500",
      ok: false,
      reason: "failed",
    });
    expect(history.urls).toHaveLength(1);
  });

  it.each([
    // 27 November 2026 is the day after Thanksgiving: the session closes at 13:00 New York.
    ["an early-close day at 15:00 New York", "2026-11-27T20:00:00Z", true],
    ["an early-close day at 12:59 New York", "2026-11-27T17:59:59Z", false],
    ["a normal day at 15:00 New York", "2026-11-10T20:00:00Z", false],
    ["a normal day one second before the close", "2026-11-10T20:59:59Z", false],
    ["a normal day at the close", "2026-11-10T21:00:00Z", true],
    ["a normal day at 16:01 New York", "2026-11-10T21:01:00Z", true],
    // Thanksgiving and a Saturday have no NYSE session, so their bar is never forming.
    ["a holiday at 15:00 New York", "2026-11-26T20:00:00Z", true],
    ["a Saturday at 15:00 New York", "2026-11-07T20:00:00Z", true],
  ])(
    "judges the newest bar of %s by the close of its NYSE session",
    async (_name, fetchedAt, kept) => {
      const day = Date.parse(`${fetchedAt.slice(0, 10)}T00:00:00Z`) / 1000;
      const history = withHistory(
        (url) =>
          historyResponse(url, [historyBar(NOV_5, 100), historyBar(day, 104)], {
            fetchedAt,
          }),
        noOther
      );
      setResearchScreenOptionsForTesting({
        fetch: history.fetch,
        now: () => new Date(fetchedAt),
      });

      const read = await readIbkrBars(entry(), HISTORY_CONFIG);

      expect(read).toStrictEqual({
        bars: [
          { c: 100, date: "2026-11-05", h: 101, l: 99, o: 100 },
          ...(kept
            ? [{ c: 104, date: fetchedAt.slice(0, 10), h: 105, l: 103, o: 104 }]
            : []),
        ],
        ok: true,
      });
    }
  );

  it("fails at once when the history service paces beyond the wait limit", async () => {
    // 71 seconds is above maxPacedWaitMs (70 seconds): no wait and no second request.
    const history = withHistory(
      () =>
        Response.json(
          { error: "paced", retry_after_seconds: 71 },
          { status: 429 }
        ),
      noOther
    );
    setResearchScreenOptionsForTesting({
      fetch: history.fetch,
      now: () => NOW,
    });

    expect(await readIbkrBars(entry(), HISTORY_CONFIG)).toStrictEqual({
      message: "IBKR history pacing: retry in 71 s",
      ok: false,
      reason: "failed",
    });
    expect(history.urls).toHaveLength(1);
  });

  it("fails when no bar is complete", async () => {
    const history = withHistory(
      (url) => historyResponse(url, bars.slice(2)),
      noOther
    );
    setResearchScreenOptionsForTesting({
      fetch: history.fetch,
      now: () => NOW,
    });

    expect(await readIbkrBars(entry(), HISTORY_CONFIG)).toStrictEqual({
      message: "IBKR returned no bars",
      ok: false,
      reason: "failed",
    });
  });
});

describe("readSwinglytics", () => {
  // Synthetic page: invented values in the element form the parser reads. No copy of the site.
  const page = (data: unknown): string =>
    `<!doctype html><html><body><script>self.__next_f.push(${JSON.stringify([
      1,
      `5:${JSON.stringify(["$", "div", null, { data }])}\n`,
    ])})</script></body></html>`;
  const dashboard = {
    breadth: { breadth_regime: "Neutral", breadth_score: 55.5 },
    generated_at: "2026-11-10T19:00:00Z",
    market_regime: { regime: "Test Regime" },
    scanner: { scan_stats: { total_scanned: 500 } },
    vix: { level: 18.5 },
  };
  const html = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Response(body, {
      headers: { "content-type": "text/html; charset=utf-8", ...headers },
    });
  const expectError = async (error: string): Promise<void> => {
    expect(await readSwinglytics()).toStrictEqual({ error, ok: false });
    expect(error.length).toBeLessThanOrEqual(240);
    expect(error).not.toMatch(/[\r\n]/u);
  };

  it("reads the start page as a snapshot with one bounded GET", async () => {
    const calls = useFetch(() => html(page(dashboard)));

    const read = await readSwinglytics();

    expect(read).toMatchObject({
      generatedAt: new Date("2026-11-10T19:00:00Z"),
      ok: true,
      retrievedAt: NOW,
      snapshot: {
        breadth: { regime: "Neutral", score: 55.5 },
        regime: { label: "Test Regime" },
        scanner: { total: 500 },
        setups: [],
        themes: [],
        vix: { level: 18.5 },
      },
    });
    expect(calls).toStrictEqual([
      {
        init: {
          headers: {
            accept: "text/html",
            "user-agent": "Vertex Research/1.0 (low-frequency public context)",
          },
          method: "GET",
          redirect: "error",
          signal: expect.any(AbortSignal),
        },
        url: SWINGLYTICS_URL,
      },
    ]);
  });

  it.each([404, 429, 503])("refuses HTTP %i", async (status) => {
    useFetch(() => new Response(null, { status }));

    await expectError(`Swinglytics returned HTTP ${status}`);
  });

  it.each([
    [
      "JSON",
      new Response("{}", { headers: { "content-type": "application/json" } }),
    ],
    [
      "a longer type name",
      html(page(dashboard), { "content-type": "text/html5" }),
    ],
    [
      "no content type",
      new Response(new TextEncoder().encode(page(dashboard))),
    ],
  ])("refuses %s", async (_name, response) => {
    useFetch(() => response);

    await expectError("Swinglytics returned an unexpected content type");
  });

  it("accepts the bare content type", async () => {
    useFetch(() => html(page(dashboard), { "content-type": "TEXT/HTML" }));

    expect(await readSwinglytics()).toMatchObject({ ok: true });
  });

  it("refuses a declared length above 1,000,000 bytes", async () => {
    useFetch(() => html(page(dashboard), { "content-length": "1000001" }));

    await expectError("Swinglytics response exceeds the size cap");
  });

  it("refuses a body above 1,000,000 bytes", async () => {
    useFetch(() => html(streamOf(1001, 1000)));

    await expectError("Swinglytics response exceeds the size cap");
  });

  it("refuses bytes that are not valid UTF-8", async () => {
    useFetch(() => html(new Uint8Array([0x3c, 0xff, 0xfe, 0x3e])));

    await expectError("Swinglytics response is not valid UTF-8");
  });

  it("refuses a page the parser refuses", async () => {
    useFetch(() =>
      html("<!doctype html><html><body>maintenance</body></html>")
    );

    await expectError(SWINGLYTICS_PARSE_ERRORS.noDashboard);
  });

  it("reports a network error without its text", async () => {
    useFetch(() => {
      throw new TypeError("fetch failed\nredirect mode is set to error");
    });

    await expectError("Swinglytics request failed");
  });

  it("aborts after 10 seconds", async () => {
    vi.useFakeTimers();
    useFetch(stalled);

    const pending = readSwinglytics();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toStrictEqual({
      error: "Swinglytics request timed out",
      ok: false,
    });
  });
});
