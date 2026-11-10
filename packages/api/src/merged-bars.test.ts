import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MarketBar } from "./contracts/market-data.ts";
import type { DeployStatusFetch } from "./server/deploy-status.ts";
import type { HistoryBarsRequest } from "./server/ibkr-history.ts";
import {
  DAILY_HISTORY_DURATION,
  historyDate,
  historyInstrument,
  IBKR_DEFERRED_REASON,
  IBKR_PACING,
  loadMergedBars,
  type MergedBarsPlan,
  newYorkTime,
  resetIbkrPacing,
  sessionOpen,
  sessionRunning,
  windowFillBefore,
} from "./server/merged-bars.ts";
import {
  HISTORY_CONFIG,
  historyBar,
  historyResponse,
  withHistory,
} from "./server/merged-bars.test-support.ts";

const DAY = 86_400;
const T0 = Date.UTC(2026, 9, 1) / 1000;
const NOW = new Date("2026-11-10T21:00:00Z");

type Row = Readonly<{ date: string; c: number; v: number | null }>;

const yahooRows = (dates: readonly string[], c = 50, v = 1150): Row[] =>
  dates.map((date) => ({ c, date, v }));

const STOCK: HistoryBarsRequest = {
  barSize: "1 day",
  duration: "1 Y",
  symbol: "AAA",
};

const planOf = (
  fetch: DeployStatusFetch,
  yahoo: () => Promise<readonly Row[]>,
  overrides: Partial<MergedBarsPlan<Row>> = {}
): MergedBarsPlan<Row> => ({
  config: HISTORY_CONFIG,
  fromIbkr: (bar: MarketBar) =>
    bar.c > 0 ? { c: bar.c, date: historyDate(bar.t), v: bar.v } : null,
  keyOf: (row) => row.date,
  options: { fetch, now: () => NOW },
  request: STOCK,
  yahoo,
  ...overrides,
});

const noYahoo = vi.fn(async (): Promise<Response> => {
  throw new Error("unexpected Yahoo request");
});

beforeEach(() => {
  resetIbkrPacing();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadMergedBars", () => {
  it("uses IBKR alone when it covers the window (no Yahoo request)", async () => {
    const history = withHistory(
      (url) =>
        historyResponse(url, [historyBar(T0, 10), historyBar(T0 + DAY, 11)]),
      noYahoo
    );
    const yahoo = vi.fn(async () => yahooRows(["2026-09-30"]));
    const merged = await loadMergedBars(
      planOf(history.fetch, yahoo, { fillBefore: "2026-10-01" })
    );
    expect(yahoo).not.toHaveBeenCalled();
    expect(history.urls).toHaveLength(1);
    // Other URLs go to the site's fake (here: none expected).
    await expect(history.fetch("https://query1.test/", {})).rejects.toThrow(
      "unexpected Yahoo request"
    );
    expect(history.urls[0]).toContain(
      "barSize=1+day&currency=USD&duration=1+Y"
    );
    expect(merged.ibkrError).toBeNull();
    expect(merged.history?.complete).toBe(true);
    // US stock volume arrives in lots of 100 and is reported in shares.
    expect(merged.bars).toEqual([
      { c: 10, date: "2026-10-01", source: "ibkr", v: 1000 },
      { c: 11, date: "2026-10-02", source: "ibkr", v: 1000 },
    ]);
    // Without fillBefore any IBKR answer counts as complete.
    const plain = await loadMergedBars(planOf(history.fetch, yahoo));
    expect(plain.bars).toHaveLength(2);
    expect(yahoo).not.toHaveBeenCalled();
  });

  it("reads Yahoo for the whole series when IBKR fails, is missing or sends nothing", async () => {
    const yahoo = vi.fn(async () => yahooRows(["2026-10-01"]));
    const failing = withHistory(
      () => Response.json({ error: "down" }, { status: 503 }),
      noYahoo
    );
    const failed = await loadMergedBars(planOf(failing.fetch, yahoo));
    expect(failed.history).toBeNull();
    expect(failed.ibkrError).toEqual(expect.any(String));
    expect(failed.bars).toEqual([
      { c: 50, date: "2026-10-01", source: "yahoo", v: 1150 },
    ]);
    const unconfigured = await loadMergedBars(
      planOf(failing.fetch, yahoo, { config: null })
    );
    expect(unconfigured.ibkrError).toBe("IBKR history not configured");
    const noContract = await loadMergedBars(
      planOf(failing.fetch, yahoo, { request: null })
    );
    expect(noContract.ibkrError).toBe("No IBKR contract for this symbol");
    expect(failing.urls).toHaveLength(1);
    const empty = withHistory((url) => historyResponse(url, []), noYahoo);
    expect((await loadMergedBars(planOf(empty.fetch, yahoo))).ibkrError).toBe(
      "IBKR returned no bars"
    );
    const dropped = withHistory(
      (url) => historyResponse(url, [historyBar(T0, 0)]),
      noYahoo
    );
    expect(
      (await loadMergedBars(planOf(dropped.fetch, yahoo))).bars[0]?.source
    ).toBe("yahoo");
    // A Yahoo failure after an IBKR failure is the site's error.
    await expect(
      loadMergedBars(
        planOf(failing.fetch, async () => {
          throw new Error("Yahoo down");
        })
      )
    ).rejects.toThrow("Yahoo down");
  });

  it("rejects a stale service copy only when asked", async () => {
    const stale = withHistory(
      (url) => historyResponse(url, [historyBar(T0, 10)], { stale: true }),
      noYahoo
    );
    const yahoo = vi.fn(async () => yahooRows(["2026-10-01"]));
    const used = await loadMergedBars(planOf(stale.fetch, yahoo));
    expect(used.bars[0]?.source).toBe("ibkr");
    const rejected = await loadMergedBars(
      planOf(stale.fetch, yahoo, { rejectStale: true })
    );
    expect(rejected.ibkrError).toBe("IBKR answered with a stale copy");
    expect(rejected.bars[0]?.source).toBe("yahoo");
  });

  it("fills only the dates before IBKR's late first bar from Yahoo, volume continuous at the seam", async () => {
    const history = withHistory(
      (url) =>
        historyResponse(url, [
          historyBar(T0, 10, 12),
          historyBar(T0 + DAY, 11, 13),
        ]),
      noYahoo
    );
    const yahoo = vi.fn(async () =>
      yahooRows(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"])
    );
    const merged = await loadMergedBars(
      planOf(history.fetch, yahoo, { fillBefore: "2026-09-29" })
    );
    expect(yahoo).toHaveBeenCalledTimes(1);
    expect(merged.bars).toEqual([
      { c: 50, date: "2026-09-29", source: "yahoo", v: 1150 },
      { c: 50, date: "2026-09-30", source: "yahoo", v: 1150 },
      { c: 10, date: "2026-10-01", source: "ibkr", v: 1200 },
      { c: 11, date: "2026-10-02", source: "ibkr", v: 1300 },
    ]);
    // A failed gap fill keeps the IBKR bars.
    const kept = await loadMergedBars(
      planOf(
        history.fetch,
        async () => {
          throw new Error("Yahoo down");
        },
        { fillBefore: "2026-09-29" }
      )
    );
    expect(kept.bars.map((bar) => bar.source)).toEqual(["ibkr", "ibkr"]);
    expect(kept.ibkrError).toBeNull();
  });

  it("fills from Yahoo when a page walk stops early (complete: false)", async () => {
    const history = withHistory(
      (url) =>
        url.includes("endDateTime")
          ? Response.json({ error: "down" }, { status: 503 })
          : historyResponse(url, [historyBar(T0, 10)]),
      noYahoo
    );
    const yahoo = vi.fn(async () => yahooRows(["2026-09-30", "2026-10-01"]));
    const merged = await loadMergedBars(
      planOf(history.fetch, yahoo, {
        pages: 2,
        request: { ...STOCK, barSize: "15 mins", duration: "31 D" },
      })
    );
    expect(history.urls).toHaveLength(3);
    expect(merged.history?.complete).toBe(false);
    expect(merged.bars.map((bar) => `${bar.date}:${bar.source}`)).toEqual([
      "2026-09-30:yahoo",
      "2026-10-01:ibkr",
    ]);
  });

  it("paces live requests to IBKR_PACING per window and defers the rest to Yahoo", async () => {
    let now = NOW.getTime();
    const history = withHistory(
      (url) => historyResponse(url, [historyBar(T0, 10)]),
      noYahoo
    );
    const yahoo = vi.fn(async () => yahooRows(["2026-10-01"]));
    const plan = planOf(history.fetch, yahoo, {
      options: { fetch: history.fetch, now: () => new Date(now) },
    });
    const sources: string[] = [];
    for (let index = 0; index <= IBKR_PACING.requests; index += 1)
      sources.push((await loadMergedBars(plan)).bars[0]?.source as string);
    expect(sources).toEqual(["ibkr", "ibkr", "ibkr", "yahoo"]);
    expect((await loadMergedBars(plan)).ibkrError).toBe(IBKR_DEFERRED_REASON);
    now += IBKR_PACING.windowMs;
    // Two pages take two slots.
    const paged = await loadMergedBars({
      ...plan,
      pages: 2,
      request: { ...STOCK, barSize: "15 mins", duration: "31 D" },
    });
    expect(paged.history).not.toBeNull();
    expect((await loadMergedBars({ ...plan, pages: 2 })).ibkrError).toBe(
      IBKR_DEFERRED_REASON
    );
    // Offline runs take no slot.
    expect(
      (await loadMergedBars({ ...plan, offline: true })).bars[0]?.source
    ).toBe("ibkr");
  });

  it("retries paced pages offline and rethrows a failure that is not market data", async () => {
    let calls = 0;
    const history = withHistory((url) => {
      calls += 1;
      return calls === 1
        ? Response.json({ error: "paced", retry_after: 1 }, { status: 429 })
        : historyResponse(url, [historyBar(T0, 10)]);
    }, noYahoo);
    const sleep = vi.fn(async () => undefined);
    const merged = await loadMergedBars(
      planOf(history.fetch, noYahoo as never, {
        offline: true,
        options: { fetch: history.fetch, sleep },
      })
    );
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(merged.bars[0]?.source).toBe("ibkr");
    calls = 0;
    await expect(
      loadMergedBars(
        planOf(history.fetch, noYahoo as never, {
          offline: true,
          options: {
            fetch: history.fetch,
            sleep: async () => {
              throw new TypeError("sleep broke");
            },
          },
        })
      )
    ).rejects.toThrow("sleep broke");
  });

  it("uses the real clock and global fetch by default", async () => {
    const history = withHistory(
      (url) => historyResponse(url, [historyBar(T0, 10)]),
      noYahoo
    );
    vi.stubGlobal("fetch", history.fetch);
    const merged = await loadMergedBars(
      planOf(history.fetch, noYahoo as never, { options: undefined as never })
    );
    expect(merged.bars[0]?.source).toBe("ibkr");
  });
});

describe("merged-bars helpers", () => {
  it("maps Yahoo ranges and IBKR daily times", () => {
    expect(DAILY_HISTORY_DURATION).toEqual({
      "10y": "10 Y",
      "1y": "1 Y",
      "2y": "2 Y",
      "5y": "5 Y",
    });
    expect(historyDate(T0)).toBe("2026-10-01");
    expect(windowFillBefore(NOW, 30).toISOString()).toBe(
      "2026-10-16T21:00:00.000Z"
    );
  });

  it("converts New York wall time in both offsets and across UTC midnight", () => {
    expect(newYorkTime("2026-01-05", 570).toISOString()).toBe(
      "2026-01-05T14:30:00.000Z"
    );
    expect(newYorkTime("2026-07-06", 570).toISOString()).toBe(
      "2026-07-06T13:30:00.000Z"
    );
    expect(newYorkTime("2026-07-06", 23 * 60 + 30).toISOString()).toBe(
      "2026-07-07T03:30:00.000Z"
    );
    expect(sessionOpen(NOW).toISOString()).toBe("2026-11-10T14:30:00.000Z");
  });

  it("knows when a daily session is still running", () => {
    expect(sessionRunning("2026-11-10", new Date("2026-11-10T20:59:00Z"))).toBe(
      true
    );
    expect(sessionRunning("2026-11-10", NOW)).toBe(false);
    expect(sessionRunning("2026-11-09", new Date("2026-11-10T15:00:00Z"))).toBe(
      false
    );
  });

  it("maps site symbols to IBKR instruments", () => {
    expect(historyInstrument("aapl")).toEqual({
      secType: "STK",
      symbol: "AAPL",
    });
    expect(historyInstrument("NQ=F")).toEqual({
      exchange: "CME",
      secType: "CONTFUT",
      symbol: "NQ",
    });
    expect(historyInstrument("CL=F")?.exchange).toBe("NYMEX");
    expect(historyInstrument("GC=F")?.exchange).toBe("COMEX");
    expect(historyInstrument("ZN=F")?.exchange).toBe("CBOT");
    expect(historyInstrument("XX=F")).toBeNull();
    expect(historyInstrument("BRK.B")).toBeNull();
    expect(historyInstrument("^GSPC")).toBeNull();
  });
});
