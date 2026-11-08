import type {
  FlowOptionGapRecord,
  FlowOptionPrintRecord,
  FlowRepository,
  FlowSampleRecord,
} from "@darkfactory/db/server";
import { describe, expect, it, vi } from "vitest";

import type { FlowSource, FlowSymbol } from "../contracts/flow.ts";
import type {
  MarketDepthOutput,
  MarketTicksOutput,
} from "../contracts/market-data.ts";
import type { OptionsAnalyticsOutput } from "../contracts/options-analytics.ts";
import {
  FLOW_DUE_SECONDS,
  FLOW_OPTION_LOOKBACK_MS,
  FLOW_SEED_OPTION_LOOKBACK_MS,
  FLOW_OPTION_PAGES_MAX,
  FLOW_OPTION_RUN_PAGES_MAX,
  FLOW_RETENTION_DAYS,
  type FlowCollectDeps,
  runFlowCollect,
} from "./flow-collect.ts";
import type { QuantDataClient, QuantDataResult } from "./quantdata-client.ts";

// Monday 2026-11-09 10:00 New York (EST, UTC-5): every source's market is open.
const OPEN = new Date("2026-11-09T15:00:00.000Z");
const NOW_S = OPEN.getTime() / 1000;

const contract = {
  conId: 1,
  currency: "USD",
  exchange: "SMART",
  lastTradeDateOrContractMonth: null,
  localSymbol: "SPY",
  longName: null,
  matches: 1,
  multiplier: null,
  secType: "STK",
  timeZoneId: null,
};

const ticksOutput = (
  overrides: Partial<MarketTicksOutput> = {}
): MarketTicksOutput => ({
  asOf: new Date((NOW_S - 30) * 1000).toISOString(),
  cache: { ageSeconds: 0, hit: false, stale: false, ttlSeconds: 30 },
  contract,
  fetchedAt: OPEN.toISOString(),
  minTick: 0.01,
  quotes: [{ ap: 600.02, as: 5, bp: 600, bs: 5, t: NOW_S - 120 }],
  receivedAt: OPEN.toISOString(),
  request: {
    contractMonth: null,
    count: 1000,
    currency: "USD",
    exchange: "SMART",
    quotes: true,
    secType: "STK",
    symbol: "SPY",
    useRTH: false,
  },
  source: "ibkr-gateway",
  trades: [
    { c: null, p: 600.02, s: 100, t: NOW_S - 90, x: null },
    { c: null, p: 600, s: 50, t: NOW_S - 30, x: null },
  ],
  ...overrides,
});

const level = (price: number) => ({ price, size: 10, venue: null });

const depthOutput = (
  overrides: Partial<MarketDepthOutput> = {}
): MarketDepthOutput =>
  ({
    asks: [level(6001), level(6002)],
    bids: [level(5999), level(5998)],
    contract,
    minTick: 0.25,
    receivedAt: OPEN.toISOString(),
    request: {
      contractMonth: null,
      currency: "USD",
      exchange: "CME",
      rows: 10,
      secType: "FUT",
      smartDepth: false,
      symbol: "ES",
    },
    sizeMultiplier: 1,
    source: "ibkr-gateway",
    updates: 3,
    venues: null,
    ...overrides,
  }) as MarketDepthOutput;

interface AnalyticsShape {
  context: {
    regime: string;
    levels: {
      callWall: number | null;
      flip: number | null;
      putWall: number | null;
    };
    iv: { regime: string };
    greeks: { netDex: number | null };
    flow: { zeroDteShare: number | null };
  };
  exposure: {
    status: "ok" | "empty" | "unavailable";
    message: string | null;
    maxPain: number | null;
    totalGex: number | null;
  };
  spot: number | null;
}

const analyticsOutput = (
  overrides: {
    spot?: number | null;
    exposure?: Partial<AnalyticsShape["exposure"]>;
    regime?: string;
  } = {}
): OptionsAnalyticsOutput => {
  const shape: AnalyticsShape = {
    context: {
      flow: { zeroDteShare: 0.4 },
      greeks: { netDex: 1000 },
      iv: { regime: "normal" },
      levels: { callWall: 6100, flip: 5950, putWall: 5900 },
      regime: overrides.regime ?? "positive",
    },
    exposure: {
      maxPain: 6000,
      message: null,
      status: "ok",
      totalGex: 5e9,
      ...overrides.exposure,
    },
    spot: overrides.spot === undefined ? 5990 : overrides.spot,
  };
  return shape as unknown as OptionsAnalyticsOutput;
};

const optionRow = (overrides: Record<string, unknown> = {}) => ({
  askPrice: 2.1,
  bidPrice: 2,
  contractType: "CALL",
  dte: 0,
  expirationDate: "2026-11-09T00:00:00",
  id: "abc",
  impliedVolatility: 0.2,
  isGoldenSweep: true,
  isOpeningPosition: true,
  isUnusual: true,
  isVolumeGreaterThanOpenInterest: true,
  moneyness: { degreeInPercent: 1.5, moneyType: "OUT_OF_THE_MONEY" },
  openInterest: 1000,
  optionPrice: 2.05,
  premium: 2_000_000,
  sentimentType: "BULLISH",
  size: 12,
  stockPrice: 600,
  strikePrice: 605,
  tradeConsolidationType: "SWEEP",
  tradeSideCode: "ASK",
  tradeTime: OPEN.getTime() - 60_000,
  volume: 5000,
  ...overrides,
});

const page = (
  data: unknown,
  nextSearchAfter: unknown = null
): QuantDataResult => ({
  body: { nextSearchAfter },
  data,
  ok: true,
});

const refused = (message: string): QuantDataResult => ({
  message,
  ok: false,
  reason: "http",
  retryAfterSeconds: null,
});

const sample = (
  symbol: FlowSymbol,
  source: FlowSource,
  secondsAgo: number,
  now: Date = OPEN
): FlowSampleRecord => ({
  at: new Date(now.getTime() - secondsAgo * 1000),
  items: 1,
  message: null,
  source,
  status: "ok",
  symbol,
});

/**
 * In-memory option gaps keyed like the table (symbol + start), so a test can run several collects
 * and see what the previous run left.
 */
const gapStore = (initial: FlowOptionGapRecord[] = []) => {
  const rows = new Map<string, FlowOptionGapRecord>();
  const key = (symbol: string, start: Date) => `${symbol}@${start.getTime()}`;
  for (const gap of initial) rows.set(key(gap.symbol, gap.startTime), gap);
  return {
    addOptionGap: vi.fn<FlowRepository["addOptionGap"]>(async (gap) => {
      const stored = rows.get(key(gap.symbol, gap.startTime));
      rows.set(
        key(gap.symbol, gap.startTime),
        stored === undefined || stored.endTime < gap.endTime ? gap : stored
      );
    }),
    deleteOptionGap: vi.fn<FlowRepository["deleteOptionGap"]>(
      async (symbol, start) => {
        rows.delete(key(symbol, start));
      }
    ),
    moveOptionGapEnd: vi.fn<FlowRepository["moveOptionGapEnd"]>(
      async (symbol, start, endTime) => {
        const stored = rows.get(key(symbol, start));
        if (stored !== undefined)
          rows.set(key(symbol, start), { ...stored, endTime });
      }
    ),
    optionGaps: vi.fn<FlowRepository["optionGaps"]>(async (symbol) =>
      [...rows.values()]
        .filter((gap) => gap.symbol === symbol)
        .sort((a, b) => b.endTime.getTime() - a.endTime.getTime())
    ),
    rows: () => [...rows.values()],
  };
};

const fakeRepository = (
  latest: FlowSampleRecord[] = [],
  newestOptionPrintAt: FlowRepository["newestOptionPrintAt"] = async () => null,
  gaps: ReturnType<typeof gapStore> = gapStore()
) => {
  const count = async (rows: readonly unknown[]) => rows.length;
  return {
    addOptionGap: gaps.addOptionGap,
    deleteOptionGap: gaps.deleteOptionGap,
    insertBooks: vi.fn(count),
    insertEvents: vi.fn(count),
    insertGex: vi.fn(count),
    insertOptionPrints: vi.fn(count),
    latestSamples: vi.fn(async (symbol: FlowSymbol) => ({
      latest: latest.filter((row) => row.symbol === symbol),
      latestOk: [],
    })),
    moveOptionGapEnd: gaps.moveOptionGapEnd,
    newestDataAt: vi.fn(async () => null),
    newestOptionPrintAt: vi.fn(newestOptionPrintAt),
    optionGaps: gaps.optionGaps,
    prune: vi.fn(async () => 42),
    readWindow: vi.fn(),
    recordSample: vi.fn<FlowRepository["recordSample"]>(async () => undefined),
    upsertMinutes: vi.fn(count),
  } satisfies FlowRepository;
};

const fakeQuantData = (results: QuantDataResult[] = [page([optionRow()])]) => {
  const queue = [...results];
  return {
    cooldownSeconds: () => 0,
    request: vi.fn<QuantDataClient["request"]>(
      async () => queue.shift() ?? page([])
    ),
  } satisfies QuantDataClient;
};

type Deps = Omit<FlowCollectDeps, "repository" | "quantData"> & {
  repository: ReturnType<typeof fakeRepository>;
  quantData: ReturnType<typeof fakeQuantData> | null;
};

const depsWith = (overrides: Partial<Deps> = {}): Deps => ({
  analytics: vi.fn(async () => analyticsOutput()),
  depth: vi.fn(async () => depthOutput()),
  now: OPEN,
  pacing: vi.fn(async () => ({ backoffSeconds: 0, recentRequests: 0 })),
  pruneDue: false,
  quantData: fakeQuantData(),
  repository: fakeRepository(),
  ticks: vi.fn(async () => ticksOutput()),
  ...overrides,
});

const collect = async (
  deps: Deps,
  input: { dryRun?: boolean; seed?: boolean; symbols?: FlowSymbol[] } = {}
) => {
  const output = await runFlowCollect(
    {
      dryRun: input.dryRun ?? false,
      seed: input.seed ?? false,
      symbols: input.symbols,
    },
    deps
  );
  const run = (symbol: FlowSymbol, source: FlowSource) => {
    const found = output.runs.find(
      (row) => row.symbol === symbol && row.source === source
    );
    if (found === undefined) throw new Error(`no run ${symbol}:${source}`);
    return found;
  };
  return { output, run };
};

const recorded = (deps: Deps) =>
  deps.repository.recordSample.mock.calls.map(
    ([row]) => `${row.symbol}:${row.source}:${row.status}`
  );

describe("runFlowCollect market hours (New York)", () => {
  const closed = async (iso: string) => {
    const deps = depsWith({ now: new Date(iso) });
    const { run } = await collect(deps);
    const isClosed = (symbol: FlowSymbol, source: FlowSource) =>
      run(symbol, source).message === "market closed";
    return {
      deps,
      es: (source: FlowSource) => isClosed("ES", source),
      spy: (source: FlowSource) => isClosed("SPY", source),
    };
  };

  it("skips every source on Saturday and stores nothing", async () => {
    const { deps, es, spy } = await closed("2026-11-07T15:00:00.000Z");
    for (const source of ["depth", "ticks", "options", "gex"] as const) {
      expect(es(source)).toBe(true);
      expect(spy(source)).toBe(true);
    }
    expect(deps.repository.recordSample).not.toHaveBeenCalled();
    expect(deps.depth).not.toHaveBeenCalled();
  });

  it("closes options and GEX after 16:15 while ES and SPY trade", async () => {
    const { es, spy } = await closed("2026-11-09T21:20:00.000Z"); // 16:20
    expect([es("options"), es("gex"), spy("options"), spy("gex")]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect([es("depth"), spy("depth")]).toEqual([false, false]);
  });

  it("opens options at 9:30 and keeps them open until 16:15", async () => {
    const early = await closed("2026-11-09T14:29:00.000Z"); // 9:29
    expect(early.spy("options")).toBe(true);
    expect(early.spy("depth")).toBe(false); // SPY premarket
    const open = await closed("2026-11-09T14:30:00.000Z"); // 9:30
    expect(open.spy("options")).toBe(false);
    const late = await closed("2026-11-09T21:14:00.000Z"); // 16:14
    expect(late.spy("gex")).toBe(false);
  });

  it("follows the ES Globex week and its 17:00-18:00 break", async () => {
    const pause = await closed("2026-11-09T22:30:00.000Z"); // Mon 17:30
    expect([pause.es("depth"), pause.spy("depth")]).toEqual([true, false]);
    const night = await closed("2026-11-10T02:00:00.000Z"); // Mon 21:00
    expect([night.es("depth"), night.spy("depth")]).toEqual([false, true]);
    const sundayEarly = await closed("2026-11-08T20:00:00.000Z"); // Sun 15:00
    expect(sundayEarly.es("depth")).toBe(true);
    const sundayOpen = await closed("2026-11-08T23:30:00.000Z"); // Sun 18:30
    expect(sundayOpen.es("depth")).toBe(false);
    const fridayClose = await closed("2026-11-13T22:30:00.000Z"); // Fri 17:30
    expect(fridayClose.es("depth")).toBe(true);
  });
});

describe("runFlowCollect seed (operator backfill)", () => {
  const SATURDAY = new Date("2026-11-07T15:00:00.000Z");

  it("ignores closed markets, due times and the stagger, but keeps the IBKR budget", async () => {
    const deps = depsWith({
      now: SATURDAY,
      repository: fakeRepository([
        sample("SPY", "ticks", 10, SATURDAY),
        sample("ES", "depth", 10, SATURDAY),
      ]),
    });
    const { run } = await collect(deps, { seed: true });
    for (const symbol of ["SPY", "ES"] as const)
      for (const source of ["depth", "ticks", "options", "gex"] as const)
        expect(run(symbol, source).status).not.toBe("skipped");
    expect(run("SPY", "ticks").status).toBe("ok");
    expect(run("ES", "ticks").status).toBe("ok");
    expect(deps.ticks).toHaveBeenCalledTimes(2);
    expect(deps.pacing).toHaveBeenCalledTimes(1);
    const [, payload] = deps.quantData?.request.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      timeRange: {
        startTime: new Date(
          SATURDAY.getTime() - FLOW_SEED_OPTION_LOOKBACK_MS
        ).toISOString(),
      },
    });
  });

  it("still leaves a busy IBKR window to /charts", async () => {
    const deps = depsWith({
      now: SATURDAY,
      pacing: vi.fn(async () => ({ backoffSeconds: 0, recentRequests: 4 })),
    });
    const { run } = await collect(deps, { seed: true });
    expect(run("SPY", "ticks").message).toBe(
      "IBKR window busy (4/6 in 120 s); /charts has priority"
    );
    expect(deps.ticks).not.toHaveBeenCalled();
  });
});

describe("runFlowCollect due and pacing", () => {
  it("skips a source whose last attempt is too recent, per source", async () => {
    const deps = depsWith({
      repository: fakeRepository([
        sample("ES", "depth", 20),
        sample("ES", "options", FLOW_DUE_SECONDS.options + 5),
      ]),
    });
    const { run } = await collect(deps);
    expect(run("ES", "depth")).toMatchObject({
      message: "not due (last attempt 20 s ago)",
      status: "skipped",
    });
    expect(run("SPY", "depth").status).toBe("ok");
    expect(run("ES", "options").status).not.toBe("skipped");
    expect(recorded(deps)).not.toContain("ES:depth:skipped");
  });

  it("fetches ticks for one symbol and staggers the other", async () => {
    const deps = depsWith();
    const { run } = await collect(deps);
    expect(run("SPY", "ticks").status).toBe("ok");
    expect(run("ES", "ticks")).toMatchObject({
      message: "staggered: another tick sample 0 s ago",
      status: "skipped",
    });
    expect(deps.ticks).toHaveBeenCalledTimes(1);
  });

  it("staggers against a stored tick sample of the other symbol", async () => {
    const deps = depsWith({
      repository: fakeRepository([sample("SPY", "ticks", 60)]),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(run("ES", "ticks").message).toBe(
      "staggered: another tick sample 60 s ago"
    );
    expect(deps.pacing).not.toHaveBeenCalled();
  });

  it("waits when the pacing health check fails", async () => {
    const deps = depsWith({
      pacing: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "ticks").message).toBe(
      "IBKR pacing unknown (history health failed)"
    );
    expect(deps.ticks).not.toHaveBeenCalled();
  });

  it("waits during an IBKR back-off", async () => {
    const deps = depsWith({
      pacing: vi.fn(async () => ({ backoffSeconds: 12, recentRequests: 0 })),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(run("ES", "ticks").message).toBe("IBKR pacing back-off, 12 s left");
  });

  it("leaves a busy window to /charts and reads pacing once per run", async () => {
    const deps = depsWith({
      pacing: vi.fn(async () => ({ backoffSeconds: 0, recentRequests: 3 })),
    });
    const { run } = await collect(deps);
    const busy = "IBKR window busy (3/6 in 120 s); /charts has priority";
    expect(run("ES", "ticks").message).toBe(busy);
    expect(run("SPY", "ticks").message).toBe(busy);
    expect(deps.pacing).toHaveBeenCalledTimes(1);
    expect(deps.ticks).not.toHaveBeenCalled();
  });

  it("fetches at exactly 2 recent requests and blocks the second symbol", async () => {
    const deps = depsWith({
      pacing: vi.fn(async () => ({ backoffSeconds: 0, recentRequests: 2 })),
    });
    const { run } = await collect(deps);
    expect(run("SPY", "ticks").status).toBe("ok");
    expect(run("ES", "ticks").status).toBe("skipped");
    expect(deps.ticks).toHaveBeenCalledTimes(1);
  });
});

describe("runFlowCollect ticks", () => {
  it("stores minutes and events and reports the print span", async () => {
    const deps = depsWith();
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "ticks")).toMatchObject({
      message: `2 prints, ${new Date((NOW_S - 90) * 1000).toISOString()} to ${new Date((NOW_S - 30) * 1000).toISOString()}`,
      status: "ok",
    });
    expect(deps.repository.upsertMinutes).toHaveBeenCalled();
    expect(recorded(deps)).toContain("SPY:ticks:ok");
  });

  it("marks cache hits and falls back to the default min tick", async () => {
    const deps = depsWith({
      ticks: vi.fn(async () =>
        ticksOutput({
          cache: { ageSeconds: 5, hit: true, stale: false, ttlSeconds: 30 },
          minTick: null,
        })
      ),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(run("ES", "ticks").message).toMatch(/ \(cache\)$/);
    const [minutes] = deps.repository.upsertMinutes.mock.calls[0] ?? [];
    expect(minutes?.length).toBeGreaterThan(0);
  });

  it("reports an empty tick window", async () => {
    const deps = depsWith({
      ticks: vi.fn(async () =>
        ticksOutput({ asOf: null, quotes: [], trades: [] })
      ),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "ticks")).toMatchObject({
      items: 0,
      message: "no prints",
      status: "empty",
    });
  });

  it("records a failed fetch as unavailable", async () => {
    const deps = depsWith({
      ticks: vi.fn(async () => {
        throw new Error("x".repeat(400));
      }),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "ticks").status).toBe("unavailable");
    expect(run("SPY", "ticks").message).toHaveLength(300);
    expect(recorded(deps)).toContain("SPY:ticks:unavailable");
  });

  it("uses a generic message for non-Error failures", async () => {
    const deps = depsWith({
      ticks: vi.fn(async () => {
        throw "boom";
      }),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "ticks").message).toBe("request failed");
  });
});

describe("runFlowCollect depth", () => {
  it("stores a book and reports missing venue subscriptions", async () => {
    const deps = depsWith({
      depth: vi.fn(async () =>
        depthOutput({
          venues: { depth: [], missing: ["ARCA", "BATS"], top: [] },
        })
      ),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "depth")).toMatchObject({
      items: 1,
      message: "4 levels; no depth subscription for ARCA, BATS",
      status: "ok",
    });
  });

  it("omits the venue note when nothing is missing", async () => {
    const deps = depsWith({
      depth: vi.fn(async () =>
        depthOutput({ venues: { depth: ["ARCA"], missing: [], top: [] } })
      ),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "depth").message).toBe("4 levels");
  });

  it("reports an empty book without storing it", async () => {
    const deps = depsWith({
      depth: vi.fn(async () => depthOutput({ asks: [], bids: [] })),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(run("ES", "depth")).toMatchObject({
      items: 0,
      message: "0 levels",
      status: "empty",
    });
    expect(deps.repository.insertBooks).not.toHaveBeenCalled();
  });

  it("records a failed depth fetch", async () => {
    const deps = depsWith({
      depth: vi.fn(async () => {
        throw new Error("no depth");
      }),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(run("ES", "depth")).toMatchObject({
      message: "no depth",
      status: "unavailable",
    });
  });
});

describe("runFlowCollect options", () => {
  it("skips without QuantData and stores no sample", async () => {
    const deps = depsWith({ analytics: null, quantData: null });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    for (const source of ["options", "gex"] as const)
      expect(run("SPY", source)).toMatchObject({
        message: "QuantData not configured",
        status: "skipped",
      });
    expect(recorded(deps)).not.toContain("SPY:options:skipped");
  });

  it("records a failed newest-print lookup", async () => {
    const deps = depsWith({
      repository: fakeRepository([], async () => {
        throw new Error("db down");
      }),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "options")).toMatchObject({
      message: "db down",
      status: "unavailable",
    });
  });

  it("starts at the lookback floor without stored prints", async () => {
    const deps = depsWith();
    const { run } = await collect(deps, { symbols: ["SPY"] });
    const floor = new Date(OPEN.getTime() - FLOW_OPTION_LOOKBACK_MS);
    expect(run("SPY", "options")).toMatchObject({
      events: 1,
      items: 1,
      message: `1 prints on 1 page(s) since ${floor.toISOString()}`,
      status: "ok",
    });
    expect(deps.quantData?.request).toHaveBeenCalledWith(
      "orderFlow",
      {
        filter: { ticker: "SPY" },
        timeRange: {
          endTime: OPEN.toISOString(),
          startTime: floor.toISOString(),
        },
      },
      30_000
    );
  });

  it("starts at the newest stored print when it is inside the lookback", async () => {
    const newest = new Date(OPEN.getTime() - 60_000);
    const deps = depsWith({
      repository: fakeRepository([], async () => newest),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "options").message).toContain(
      `since ${newest.toISOString()}`
    );
  });

  it("ignores a stored print older than the lookback", async () => {
    const deps = depsWith({
      repository: fakeRepository(
        [],
        async () => new Date(OPEN.getTime() - 2 * FLOW_OPTION_LOOKBACK_MS)
      ),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    const floor = new Date(OPEN.getTime() - FLOW_OPTION_LOOKBACK_MS);
    expect(run("SPY", "options").message).toContain(
      `since ${floor.toISOString()}`
    );
  });

  it("records a failed first page", async () => {
    const deps = depsWith({ quantData: fakeQuantData([refused("429")]) });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "options")).toMatchObject({
      message: "429",
      status: "unavailable",
    });
  });

  it("keeps earlier pages when a later page fails", async () => {
    const quantData = fakeQuantData([
      page([optionRow()], [1, "a"]),
      refused("later"),
    ]);
    const deps = depsWith({ quantData });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "options")).toMatchObject({
      items: 1,
      status: "ok",
    });
    expect(run("SPY", "options").message).toMatch(/^1 prints on 1 page\(s\)/);
    expect(quantData.request.mock.calls[1]?.[1]).toMatchObject({
      searchAfter: [1, "a"],
    });
  });

  it("pages up to the cap, stores the rest as a gap and reads it with the run's spare requests", async () => {
    const pages = Array.from(
      { length: FLOW_OPTION_RUN_PAGES_MAX + 2 },
      (_, i) => page([optionRow({ id: `p${i}` }), { broken: true }], [i])
    );
    const quantData = fakeQuantData(pages);
    const gaps = gapStore();
    const deps = depsWith({
      quantData,
      repository: fakeRepository([], undefined, gaps),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    const floor = new Date(OPEN.getTime() - FLOW_OPTION_LOOKBACK_MS);
    const oldest = new Date(OPEN.getTime() - 60_000);
    const gapPages = FLOW_OPTION_RUN_PAGES_MAX - FLOW_OPTION_PAGES_MAX;
    expect(quantData.request).toHaveBeenCalledTimes(FLOW_OPTION_RUN_PAGES_MAX);
    // The gap ends 1 ms after the oldest print, so prints sharing its millisecond are read again.
    expect(gaps.addOptionGap).toHaveBeenCalledWith({
      createdAt: OPEN,
      endTime: new Date(oldest.getTime() + 1),
      startTime: floor,
      symbol: "SPY",
    });
    expect(
      quantData.request.mock.calls[FLOW_OPTION_PAGES_MAX]?.[1]
    ).toStrictEqual({
      filter: { ticker: "SPY" },
      timeRange: {
        endTime: new Date(oldest.getTime() + 1).toISOString(),
        startTime: floor.toISOString(),
      },
    });
    expect(run("SPY", "options")).toMatchObject({
      items: FLOW_OPTION_RUN_PAGES_MAX,
      message: [
        `${FLOW_OPTION_PAGES_MAX} prints on ${FLOW_OPTION_PAGES_MAX} page(s) since ${floor.toISOString()}`,
        `page cap ${FLOW_OPTION_PAGES_MAX} reached, older prints of this window queued as a gap`,
        `${FLOW_OPTION_PAGES_MAX} rows failed the schema`,
        `gaps: ${gapPages} prints on ${gapPages} page(s), 0 closed, 1 left (oldest from ${floor.toISOString()})`,
        `${gapPages} gap rows failed the schema`,
      ].join("; "),
      status: "ok",
    });
    // Every print sat at one instant: the end still moves back, so the next run moves on.
    expect(gaps.rows()).toStrictEqual([
      { createdAt: OPEN, endTime: oldest, startTime: floor, symbol: "SPY" },
    ]);
  });

  it("queues the whole capped window when its rows carry no trade time", async () => {
    const pages = Array.from({ length: FLOW_OPTION_PAGES_MAX }, (_, i) =>
      page([{ broken: true }], [i])
    );
    const gaps = gapStore();
    const deps = depsWith({
      quantData: fakeQuantData(pages),
      repository: fakeRepository([], undefined, gaps),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    const floor = new Date(OPEN.getTime() - FLOW_OPTION_LOOKBACK_MS);
    expect(gaps.addOptionGap).toHaveBeenCalledWith({
      createdAt: OPEN,
      endTime: OPEN,
      startTime: floor,
      symbol: "SPY",
    });
    expect(run("SPY", "options")).toMatchObject({ status: "empty" });
    expect(run("SPY", "options").message).toContain(
      `page cap ${FLOW_OPTION_PAGES_MAX} reached, older prints of this window queued as a gap`
    );
  });

  it("queues nothing for a capped window of a single millisecond", async () => {
    const gaps = gapStore();
    const { run } = await collect(
      depsWith({
        quantData: fakeQuantData(
          Array.from({ length: FLOW_OPTION_PAGES_MAX }, (_, i) =>
            page([optionRow({ id: `m${i}`, tradeTime: OPEN.getTime() })], [i])
          )
        ),
        repository: fakeRepository([], async () => OPEN, gaps),
      }),
      { symbols: ["SPY"] }
    );
    expect(run("SPY", "options").message).toContain(
      `page cap ${FLOW_OPTION_PAGES_MAX} reached, nothing older left in this window`
    );
    expect(gaps.addOptionGap).not.toHaveBeenCalled();
  });

  it("queues the prints between an old newest print and the look-back as a gap", async () => {
    const newest = new Date(OPEN.getTime() - 2 * FLOW_OPTION_LOOKBACK_MS);
    const floor = new Date(OPEN.getTime() - FLOW_OPTION_LOOKBACK_MS);
    const gaps = gapStore();
    const deps = depsWith({
      repository: fakeRepository([], async () => newest, gaps),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(gaps.addOptionGap).toHaveBeenCalledWith({
      createdAt: OPEN,
      endTime: floor,
      startTime: newest,
      symbol: "SPY",
    });
    expect(run("SPY", "options").message).toBe(
      [
        `1 prints on 1 page(s) since ${floor.toISOString()}`,
        `prints from ${newest.toISOString()} to the look-back queued as a gap`,
        "gaps: 0 prints on 1 page(s), 1 closed, 0 left",
      ].join("; ")
    );
    expect(gaps.rows()).toStrictEqual([]);
  });

  it("reports an empty window", async () => {
    const deps = depsWith({ quantData: fakeQuantData([page([])]) });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(run("ES", "options")).toMatchObject({
      events: 0,
      items: 0,
      status: "empty",
    });
  });
});

/**
 * A QuantData order-flow source with one print per entry of `times` (epoch ms, newest first), ids
 * s0, s1, ..., served like order-flow/consolidated: inside the inclusive time range, newest first,
 * `size` rows per page, nextSearchAfter = [time, id] of the page's last row while rows remain.
 */
const flowSource = (times: readonly number[], size = 2) => {
  const rows = times.map((time, i) =>
    optionRow({ id: `s${i}`, tradeTime: time })
  );
  const request = vi.fn<QuantDataClient["request"]>(async (_, payload) => {
    const { searchAfter, timeRange } = payload as {
      searchAfter?: [number, string];
      timeRange: { endTime: string; startTime: string };
    };
    const start = Date.parse(timeRange.startTime);
    const end = Date.parse(timeRange.endTime);
    const inRange = rows.filter(
      (row) => row.tradeTime >= start && row.tradeTime <= end
    );
    const from =
      searchAfter === undefined
        ? 0
        : inRange.findIndex((row) => row.id === searchAfter[1]) + 1;
    const data = inRange.slice(from, from + size);
    const last = data.at(-1);
    return page(
      data,
      last !== undefined && from + size < inRange.length
        ? [last.tradeTime, last.id]
        : null
    );
  });
  return {
    client: { cooldownSeconds: () => 0, request } satisfies QuantDataClient,
    ids: rows.map((row) => row.id),
    request,
  };
};

/** `count` times one second apart, back from `newest`. */
const secondsBack = (count: number, newest: Date) =>
  Array.from({ length: count }, (_, i) => newest.getTime() - i * 1000);

/** A repository whose option prints persist across runs (newest print drives the next window). */
const printStore = (gaps: ReturnType<typeof gapStore>) => {
  const prints = new Map<string, Date>();
  const repository = fakeRepository(
    [],
    async () =>
      prints.size === 0
        ? null
        : new Date(Math.max(...[...prints.values()].map((at) => at.getTime()))),
    gaps
  );
  repository.insertOptionPrints.mockImplementation(async (rows) => {
    let added = 0;
    for (const row of rows as readonly FlowOptionPrintRecord[])
      if (!prints.has(row.id)) {
        prints.set(row.id, row.tradedAt);
        added += 1;
      }
    return added;
  });
  return { ids: () => [...prints.keys()].sort(), repository };
};

const CLOSE = new Date("2026-11-09T21:20:00.000Z"); // 16:20 New York, options closed

describe("runFlowCollect options gaps (page-cap resume)", () => {
  it("continues a capped window on the next run until every print is stored", async () => {
    // 2 rows per page. Run 1: 6 window pages (s0-s11), then 2 gap pages from s11 (s11 again,
    // stored once, to s14): 15 of 28 stored. Run 2: the new window holds s0 only (1 page), the
    // gap gets the other 7 pages and reads s14-s27 to the end.
    const newest = new Date(OPEN.getTime() - 1000);
    const times = secondsBack(28, newest);
    const source = flowSource(times);
    const gaps = gapStore();
    const store = printStore(gaps);
    const first = depsWith({
      quantData: source.client,
      repository: store.repository,
    });
    const one = await collect(first, { symbols: ["SPY"] });
    expect(one.run("SPY", "options")).toMatchObject({
      items: 15,
      status: "ok",
    });
    expect(one.run("SPY", "options").message).toContain(
      "gaps: 4 prints on 2 page(s), 0 closed, 1 left"
    );
    expect(store.ids()).toHaveLength(15);
    const floor = new Date(OPEN.getTime() - FLOW_OPTION_LOOKBACK_MS);
    expect(gaps.rows()).toStrictEqual([
      {
        createdAt: OPEN,
        endTime: new Date((times[14] ?? 0) + 1),
        startTime: floor,
        symbol: "SPY",
      },
    ]);
    const second = depsWith({
      now: new Date(OPEN.getTime() + 120_000),
      quantData: source.client,
      repository: store.repository,
    });
    const two = await collect(second, { symbols: ["SPY"] });
    expect(two.run("SPY", "options")).toMatchObject({
      items: 13,
      status: "ok",
    });
    expect(two.run("SPY", "options").message).toContain(
      "gaps: 14 prints on 7 page(s), 1 closed, 0 left"
    );
    expect(store.ids()).toStrictEqual([...source.ids].sort());
    expect(gaps.rows()).toStrictEqual([]);
    expect(gaps.deleteOptionGap).toHaveBeenCalledWith("SPY", floor);
  });

  it("reads prints that share the oldest millisecond across a page boundary", async () => {
    // s10-s13 share one millisecond; the window stops after s11, the gap resumes at s10's time.
    const newest = new Date(OPEN.getTime() - 1000);
    const tie = newest.getTime() - 10_000;
    const times = [
      ...secondsBack(10, newest),
      tie,
      tie,
      tie,
      tie,
      ...secondsBack(6, new Date(tie - 1000)),
    ];
    const source = flowSource(times);
    const gaps = gapStore();
    const store = printStore(gaps);
    await collect(
      depsWith({ quantData: source.client, repository: store.repository }),
      { symbols: ["SPY"] }
    );
    expect(store.ids()).toEqual(expect.arrayContaining(["s12", "s13"]));
    expect(gaps.rows()[0]?.endTime).toStrictEqual(new Date(tie));
    await collect(
      depsWith({
        now: new Date(OPEN.getTime() + 120_000),
        quantData: source.client,
        repository: store.repository,
      }),
      { symbols: ["SPY"] }
    );
    expect(store.ids()).toStrictEqual([...source.ids].sort());
    expect(gaps.rows()).toStrictEqual([]);
  });

  it("catches up while new prints keep capping the window", async () => {
    // 2 rows per page, 20 new prints between runs: every window is capped and queues a gap.
    const runs = [0, 120_000, 240_000];
    const times = runs.flatMap((offset) =>
      secondsBack(20, new Date(OPEN.getTime() + offset - 1000))
    );
    times.sort((a, b) => b - a);
    const source = flowSource(times);
    const gaps = gapStore();
    const store = printStore(gaps);
    for (const offset of runs)
      await collect(
        depsWith({
          now: new Date(OPEN.getTime() + offset),
          quantData: source.client,
          repository: store.repository,
        }),
        { symbols: ["SPY"] }
      );
    expect(gaps.rows()).toHaveLength(3);
    // After the close, the gaps get every request until all prints are stored.
    for (let minutes = 0; gaps.rows().length > 0 && minutes < 20; minutes += 2)
      await collect(
        depsWith({
          now: new Date(CLOSE.getTime() + minutes * 60_000),
          quantData: source.client,
          repository: store.repository,
        }),
        { symbols: ["SPY"] }
      );
    expect(gaps.rows()).toStrictEqual([]);
    expect(store.ids()).toStrictEqual([...source.ids].sort());
  });

  it("reads stored gaps after the options close and stops when none are left", async () => {
    const newest = new Date(CLOSE.getTime() - 3_600_000);
    const source = flowSource(secondsBack(5, newest));
    const gaps = gapStore([
      {
        createdAt: OPEN,
        endTime: newest,
        startTime: new Date(CLOSE.getTime() - 7_200_000),
        symbol: "SPY",
      },
    ]);
    const store = printStore(gaps);
    const deps = depsWith({
      now: CLOSE,
      quantData: source.client,
      repository: store.repository,
    });
    const { run } = await collect(deps, { symbols: ["SPY", "ES"] });
    expect(run("SPY", "options")).toMatchObject({
      items: 5,
      message:
        "market closed, gaps only; gaps: 5 prints on 3 page(s), 1 closed, 0 left",
      status: "ok",
    });
    expect(run("ES", "options").message).toBe("market closed");
    expect(run("SPY", "gex").message).toBe("market closed");
    expect(gaps.rows()).toStrictEqual([]);
    const after = await collect(
      depsWith({
        now: new Date(CLOSE.getTime() + 120_000),
        quantData: source.client,
        repository: store.repository,
      }),
      { symbols: ["SPY"] }
    );
    expect(after.run("SPY", "options").message).toBe("market closed");
    expect(source.request).toHaveBeenCalledTimes(3);
  });

  it("reads the newest gap first and leaves the next one when the requests are spent", async () => {
    const newest = new Date(CLOSE.getTime() - 3_600_000);
    const source = flowSource(secondsBack(20, newest));
    const newer = {
      createdAt: OPEN,
      endTime: newest,
      startTime: new Date(newest.getTime() - 15_000),
      symbol: "SPY" as const,
    };
    const older = {
      createdAt: OPEN,
      endTime: new Date(newest.getTime() - 16_000),
      startTime: new Date(newest.getTime() - 3_600_000),
      symbol: "SPY" as const,
    };
    const gaps = gapStore([older, newer]);
    const deps = depsWith({
      now: CLOSE,
      quantData: source.client,
      repository: printStore(gaps).repository,
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "options").message).toBe(
      `market closed, gaps only; gaps: 16 prints on ${FLOW_OPTION_RUN_PAGES_MAX} page(s), 1 closed, 1 left (oldest from ${older.startTime.toISOString()})`
    );
    expect(gaps.rows()).toStrictEqual([older]);
  });

  it("stores the window's gap and reads no gap after a failed window page", async () => {
    const stored = {
      createdAt: OPEN,
      endTime: new Date(OPEN.getTime() - 3_600_000),
      startTime: new Date(OPEN.getTime() - 7_200_000),
      symbol: "SPY" as const,
    };
    const gaps = gapStore([stored]);
    const quantData = fakeQuantData([
      page([optionRow({ id: "n1" })], [1]),
      refused("later"),
    ]);
    const deps = depsWith({
      quantData,
      repository: fakeRepository([], undefined, gaps),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "options").message).toContain(
      "page 2 failed, older prints of this window queued as a gap; gaps not read after a failed page (2 left)"
    );
    expect(quantData.request).toHaveBeenCalledTimes(2);
    expect(gaps.rows()).toHaveLength(2);
  });

  it("keeps a gap whose fetch fails and the gap stored before it", async () => {
    const stored = {
      createdAt: OPEN,
      endTime: new Date(OPEN.getTime() - 3_600_000),
      startTime: new Date(OPEN.getTime() - 7_200_000),
      symbol: "SPY" as const,
    };
    const gaps = gapStore([stored]);
    const deps = depsWith({
      quantData: fakeQuantData([page([optionRow()]), refused("gap 503")]),
      repository: fakeRepository([], undefined, gaps),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "options")).toMatchObject({ items: 1, status: "ok" });
    expect(run("SPY", "options").message).toContain(
      `gaps: 0 prints on 0 page(s), 0 closed, 1 left (oldest from ${stored.startTime.toISOString()}); gap fetch stopped: gap 503`
    );
    expect(gaps.rows()).toStrictEqual([stored]);
  });

  it("stores the window's gap before its prints, so a failed insert cannot lose it", async () => {
    const source = flowSource(secondsBack(20, new Date(OPEN.getTime() - 1000)));
    const gaps = gapStore();
    const repository = fakeRepository([], undefined, gaps);
    repository.insertOptionPrints.mockRejectedValueOnce(new Error("db down"));
    const deps = depsWith({ quantData: source.client, repository });
    await expect(collect(deps, { symbols: ["SPY"] })).rejects.toThrow(
      "db down"
    );
    expect(gaps.rows()).toHaveLength(1);
  });

  it("records a failed gap fetch after the close as unavailable", async () => {
    const gaps = gapStore([
      {
        createdAt: OPEN,
        endTime: new Date(CLOSE.getTime() - 60_000),
        startTime: new Date(CLOSE.getTime() - 120_000),
        symbol: "SPY",
      },
    ]);
    const deps = depsWith({
      now: CLOSE,
      quantData: fakeQuantData([refused("429")]),
      repository: fakeRepository([], undefined, gaps),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "options")).toMatchObject({
      message: "gaps: 429",
      status: "unavailable",
    });
    expect(gaps.rows()).toHaveLength(1);
  });

  it("keeps a gap whose capped rows carry no trade time, and resumes one whose rows do", async () => {
    const stored = {
      createdAt: OPEN,
      endTime: new Date(OPEN.getTime() - 3_600_000),
      startTime: new Date(OPEN.getTime() - 7_200_000),
      symbol: "SPY" as const,
    };
    const timeless = gapStore([stored]);
    const one = await collect(
      depsWith({
        quantData: fakeQuantData([
          page([]),
          ...Array.from({ length: FLOW_OPTION_RUN_PAGES_MAX }, (_, i) =>
            page([{ broken: true }], [i])
          ),
        ]),
        repository: fakeRepository([], undefined, timeless),
      }),
      { symbols: ["SPY"] }
    );
    expect(one.run("SPY", "options").message).toContain(
      "gap fetch stopped: capped pages held no trade time"
    );
    expect(timeless.rows()).toStrictEqual([stored]);
    expect(timeless.deleteOptionGap).not.toHaveBeenCalled();
    // Rows that fail the schema but carry a trade time still move the gap on.
    const at = new Date(OPEN.getTime() - 5_400_000);
    const timed = gapStore([stored]);
    await collect(
      depsWith({
        quantData: fakeQuantData([
          page([]),
          ...Array.from({ length: FLOW_OPTION_RUN_PAGES_MAX }, (_, i) =>
            page([{ broken: true, tradeTime: at.getTime() }], [i])
          ),
        ]),
        repository: fakeRepository([], undefined, timed),
      }),
      { symbols: ["SPY"] }
    );
    expect(timed.rows()).toStrictEqual([
      { ...stored, endTime: new Date(at.getTime() + 1) },
    ]);
  });

  it("closes a single-millisecond gap whose capped pages leave nothing older", async () => {
    const at = new Date(OPEN.getTime() - 60_000);
    const gaps = gapStore([
      { createdAt: OPEN, endTime: at, startTime: at, symbol: "SPY" },
    ]);
    const deps = depsWith({
      quantData: fakeQuantData([
        page([]),
        ...Array.from({ length: FLOW_OPTION_RUN_PAGES_MAX }, (_, i) =>
          page([optionRow({ id: `g${i}`, tradeTime: at.getTime() })], [i])
        ),
      ]),
      repository: fakeRepository([], undefined, gaps),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "options").message).toContain(
      `gaps: ${FLOW_OPTION_RUN_PAGES_MAX - 1} prints on ${FLOW_OPTION_RUN_PAGES_MAX - 1} page(s), 1 closed, 0 left`
    );
    expect(gaps.rows()).toStrictEqual([]);
  });

  it("records a failed gap lookup while open and skips the closed market without a sample", async () => {
    const gaps = gapStore();
    gaps.optionGaps.mockRejectedValue(new Error("relation missing"));
    const open = depsWith({ repository: fakeRepository([], undefined, gaps) });
    const one = await collect(open, { symbols: ["SPY"] });
    expect(one.run("SPY", "options")).toMatchObject({
      message: "relation missing",
      status: "unavailable",
    });
    expect(open.quantData?.request).not.toHaveBeenCalled();
    const closed = depsWith({
      now: CLOSE,
      repository: fakeRepository([], undefined, gaps),
    });
    const two = await collect(closed, { symbols: ["SPY"] });
    expect(two.run("SPY", "options")).toMatchObject({
      message: "market closed; gaps unavailable: relation missing",
      status: "skipped",
    });
    expect(recorded(closed)).not.toContain("SPY:options:skipped");
  });

  it("uses a generic message for a non-Error gap lookup failure", async () => {
    const gaps = gapStore();
    gaps.optionGaps.mockRejectedValue("boom");
    const { run } = await collect(
      depsWith({ now: CLOSE, repository: fakeRepository([], undefined, gaps) }),
      { symbols: ["SPY"] }
    );
    expect(run("SPY", "options").message).toBe(
      "market closed; gaps unavailable: lookup failed"
    );
  });

  it("reads a gap once when a quiet window queues it again with a later end", async () => {
    const newest = new Date(OPEN.getTime() - 2 * FLOW_OPTION_LOOKBACK_MS);
    const floor = new Date(OPEN.getTime() - FLOW_OPTION_LOOKBACK_MS);
    const gaps = gapStore([
      {
        createdAt: OPEN,
        endTime: new Date(floor.getTime() - 60_000),
        startTime: newest,
        symbol: "SPY",
      },
    ]);
    const quantData = fakeQuantData([page([]), page([])]);
    const { run } = await collect(
      depsWith({
        quantData,
        repository: fakeRepository([], async () => newest, gaps),
      }),
      { symbols: ["SPY"] }
    );
    expect(run("SPY", "options").message).toContain(
      "gaps: 0 prints on 1 page(s), 1 closed, 0 left"
    );
    expect(quantData.request).toHaveBeenCalledTimes(2);
    expect(quantData.request.mock.calls[1]?.[1]).toMatchObject({
      timeRange: { endTime: floor.toISOString() },
    });
    expect(gaps.rows()).toStrictEqual([]);
  });

  it("writes no gap in a dry run", async () => {
    const stored = {
      createdAt: OPEN,
      endTime: new Date(OPEN.getTime() - 3_600_000),
      startTime: new Date(OPEN.getTime() - 7_200_000),
      symbol: "SPY" as const,
    };
    const capped = gapStore([stored]);
    const one = await collect(
      depsWith({
        quantData: flowSource(secondsBack(30, new Date(OPEN.getTime() - 1000)))
          .client,
        repository: fakeRepository([], undefined, capped),
      }),
      { dryRun: true, symbols: ["SPY"] }
    );
    expect(one.run("SPY", "options").items).toBe(2 * FLOW_OPTION_RUN_PAGES_MAX);
    expect(capped.addOptionGap).not.toHaveBeenCalled();
    expect(capped.moveOptionGapEnd).not.toHaveBeenCalled();
    // An uncapped window leaves requests for the stored gap, which reads to its end.
    const closing = gapStore([stored]);
    const two = await collect(
      depsWith({
        quantData: flowSource(secondsBack(3, new Date(OPEN.getTime() - 1000)))
          .client,
        repository: fakeRepository([], undefined, closing),
      }),
      { dryRun: true, symbols: ["SPY"] }
    );
    expect(two.run("SPY", "options").message).toContain("1 closed, 0 left");
    expect(closing.deleteOptionGap).not.toHaveBeenCalled();
    expect(closing.rows()).toStrictEqual([stored]);
  });
});

describe("runFlowCollect GEX", () => {
  it("records analytics failures", async () => {
    const deps = depsWith({
      analytics: vi.fn(async () => {
        throw new Error("qd");
      }),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "gex")).toMatchObject({
      message: "qd",
      status: "unavailable",
    });
  });

  it("maps an unavailable exposure to unavailable", async () => {
    const deps = depsWith({
      analytics: vi.fn(async () =>
        analyticsOutput({
          exposure: { message: "chain failed", status: "unavailable" },
        })
      ),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "gex")).toMatchObject({
      items: 0,
      message: "chain failed",
      status: "unavailable",
    });
  });

  it("maps an empty exposure to empty", async () => {
    const deps = depsWith({
      analytics: vi.fn(async () =>
        analyticsOutput({ exposure: { message: "no chain", status: "empty" } })
      ),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "gex").status).toBe("empty");
  });

  it("reports an unknown regime as empty", async () => {
    const deps = depsWith({
      analytics: vi.fn(async () => analyticsOutput({ regime: "unknown" })),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "gex")).toMatchObject({
      message: "No GEX estimate (regime unknown)",
      status: "empty",
    });
    expect(deps.repository.insertGex).not.toHaveBeenCalled();
  });

  it("stores SPY GEX with a zero basis", async () => {
    const deps = depsWith({
      analytics: vi.fn(async () => analyticsOutput({ spot: null })),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "gex")).toMatchObject({
      items: 1,
      message: "positive gamma",
      status: "ok",
    });
    expect(deps.repository.insertGex.mock.calls[0]?.[0][0]).toMatchObject({
      basis: 0,
      symbol: "SPY",
      ticker: "SPY",
    });
  });

  it("derives the ES basis from this run's depth mid", async () => {
    const deps = depsWith({
      ticks: vi.fn(async () => {
        throw new Error("skip");
      }),
    });
    await collect(deps, { symbols: ["ES"] });
    expect(deps.repository.insertGex.mock.calls[0]?.[0][0]).toMatchObject({
      basis: 10, // mid 6000 - spot 5990
      ticker: "SPX",
    });
  });

  it("leaves the ES basis unknown without a price or a spot", async () => {
    const noPrice = depsWith({
      depth: vi.fn(async () => depthOutput({ asks: [] })),
      ticks: vi.fn(async () => {
        throw new Error("skip");
      }),
    });
    const { run } = await collect(noPrice, { symbols: ["ES"] });
    expect(run("ES", "gex").message).toBe("positive gamma; basis unknown");
    const noSpot = depsWith({
      analytics: vi.fn(async () => analyticsOutput({ spot: null })),
    });
    const second = await collect(noSpot, { symbols: ["ES"] });
    expect(second.run("ES", "gex").message).toBe(
      "positive gamma; basis unknown"
    );
  });
});

describe("runFlowCollect storage", () => {
  it("dry run writes nothing but counts rows", async () => {
    const deps = depsWith({ pruneDue: true });
    const { output, run } = await collect(deps, { dryRun: true });
    expect(output).toMatchObject({ busy: false, dryRun: true, pruned: 0 });
    expect(deps.repository.prune).not.toHaveBeenCalled();
    expect(run("ES", "depth").items).toBe(1);
    expect(run("SPY", "ticks").items).toBeGreaterThan(0);
    expect(run("SPY", "options").items).toBe(1);
    expect(run("SPY", "gex").items).toBe(1);
    const repo = deps.repository;
    for (const write of [
      repo.recordSample,
      repo.upsertMinutes,
      repo.insertBooks,
      repo.insertEvents,
      repo.insertOptionPrints,
      repo.insertGex,
      repo.prune,
    ])
      expect(write).not.toHaveBeenCalled();
  });

  it("stores one sample per recorded attempt", async () => {
    const deps = depsWith();
    const { output } = await collect(deps);
    expect(output.runs).toHaveLength(8);
    expect(recorded(deps)).toEqual([
      "SPY:depth:ok",
      "ES:depth:ok",
      "SPY:ticks:ok",
      "SPY:options:ok",
      "ES:options:empty",
      "SPY:gex:ok",
      "ES:gex:ok",
    ]);
    expect(output.at).toBe(OPEN.toISOString());
  });

  it("prunes only when due, with the retention cutoff", async () => {
    const off = depsWith();
    expect((await collect(off)).output.pruned).toBe(0);
    expect(off.repository.prune).not.toHaveBeenCalled();
    const due = depsWith({ pruneDue: true });
    expect((await collect(due)).output.pruned).toBe(42);
    expect(due.repository.prune).toHaveBeenCalledWith(
      new Date(OPEN.getTime() - FLOW_RETENTION_DAYS * 86_400_000)
    );
  });

  it("collects only the requested symbols but reads every symbol's samples", async () => {
    const deps = depsWith();
    const { output } = await collect(deps, { symbols: ["SPY"] });
    expect(new Set(output.runs.map((row) => row.symbol))).toEqual(
      new Set(["SPY"])
    );
    expect(deps.repository.latestSamples).toHaveBeenCalledWith("ES");
    expect(deps.repository.latestSamples).toHaveBeenCalledWith("SPY");
  });
});
