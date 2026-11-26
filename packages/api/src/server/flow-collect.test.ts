import type {
  FlowOptionGapRecord,
  FlowOptionPrintRecord,
  FlowRepository,
  FlowSampleRecord,
} from "@darkfactory/db/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FlowOptionPrintSymbol,
  FlowSource,
  FlowSymbol,
} from "../contracts/flow.ts";
import type {
  MarketDepthOutput,
  MarketTicksOutput,
} from "../contracts/market-data.ts";
import type { OptionsAnalyticsOutput } from "../contracts/options-analytics.ts";
import {
  FLOW_GROUPS,
  FLOW_INSTRUMENTS,
  type FlowInstrument,
} from "../flow-features.ts";
import { netDriftRequest as netDriftRequestFor } from "../flow-net-drift.ts";
import {
  FLOW_DUE_SECONDS,
  FLOW_OPTION_LOOKBACK_MS,
  FLOW_OPTION_PAGES_MAX,
  FLOW_OPTION_RUN_PAGES_MAX,
  FLOW_QUANTDATA_CALLER_RESERVE,
  FLOW_RETENTION_DAYS,
  FLOW_SEED_OPTION_LOOKBACK_MS,
  FLOW_TAPE_DUE_SECONDS,
  FLOW_TAPE_LOOKBACK_SECONDS,
  FLOW_TAPE_MAX_ANSWERS,
  FLOW_TAPE_REREAD_SECONDS,
  FLOW_TICKS_STAGGER_SECONDS,
  FLOW_TICKS_STARVED_SECONDS,
  type FlowCollectDeps,
  flowQuantDataRunWorstCase,
  flowTickTurns,
  netDriftTurn,
  runFlowCollect,
} from "./flow-collect.ts";
import type { MarketTape } from "./market-data.ts";
import {
  DEFAULT_MAX_PER_MINUTE,
  type QuantDataClient,
  type QuantDataResult,
} from "./quantdata-client.ts";

// The collector reads the registry of instruments at run time. This module copy of the registry
// lets a test set ES and NQ back to sampled ticks (their tick mode before the streamed tape), so
// the sampled code for more than one symbol and for a future stays under test.
vi.mock("../flow-features.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../flow-features.ts")>();
  return { ...actual, FLOW_INSTRUMENTS: { ...actual.FLOW_INSTRUMENTS } };
});

const registry = FLOW_INSTRUMENTS as Record<FlowSymbol, FlowInstrument>;
const STREAMED = { ES: FLOW_INSTRUMENTS.ES, NQ: FLOW_INSTRUMENTS.NQ };

/** In the describe block that calls it, ES and NQ are read as sampled ticks (not the tape). */
const withSampledFutures = (): void => {
  beforeEach(() => {
    registry.ES = { ...STREAMED.ES, ticks: "trades_and_quotes" };
    registry.NQ = { ...STREAMED.NQ, ticks: "trades_and_quotes" };
  });
  afterEach(() => {
    registry.ES = STREAMED.ES;
    registry.NQ = STREAMED.NQ;
  });
};

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

/**
 * One tape answer. The default is the read of a run at OPEN whose last ok sample is 60 s old: the
 * range starts at OPEN - 120 s and holds one complete minute with three prints.
 */
const tapeOutput = (overrides: Partial<MarketTape> = {}): MarketTape => ({
  contract: {
    ...contract,
    exchange: "CME",
    localSymbol: "ESZ6",
    secType: "FUT",
  },
  covered: [[NOW_S - 120, NOW_S - 3]],
  fetchedAt: OPEN.toISOString(),
  minTick: 0.25,
  more: false,
  previousDifferentPrice: null,
  previousPrice: 6000,
  receivedAt: OPEN.toISOString(),
  since: NOW_S - 120,
  source: "ibkr-gateway",
  stream: { error: null, state: "live" },
  symbol: "ES",
  trades: [
    [NOW_S - 110, 6000.25, 2, 6000, 6000.25],
    [NOW_S - 90, 6000, 3, 6000, 6000.25],
    [NOW_S - 30, 6000.5, 1, 6000.25, 6000.5],
  ],
  until: NOW_S - 3,
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
      kingNode: number | null;
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
    ivRegime?: string;
  } = {}
): OptionsAnalyticsOutput => {
  const shape: AnalyticsShape = {
    context: {
      flow: { zeroDteShare: 0.4 },
      greeks: { netDex: 1000 },
      iv: { regime: overrides.ivRegime ?? "contango" },
      levels: { callWall: 6100, flip: 5950, kingNode: 6100, putWall: 5900 },
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
  gaps: ReturnType<typeof gapStore> = gapStore(),
  latestOk: FlowSampleRecord[] = []
) => {
  const count = async (rows: readonly unknown[]) => rows.length;
  return {
    addOptionGap: gaps.addOptionGap,
    deleteOptionGap: gaps.deleteOptionGap,
    insertBooks: vi.fn(count),
    insertEvents: vi.fn(count),
    insertGex: vi.fn(count),
    insertOptionPrints: vi.fn(count),
    insertTickSample: vi.fn<FlowRepository["insertTickSample"]>(
      async ({ events, trades }) => ({
        events: events.length,
        trades: trades.length,
      })
    ),
    latestSamples: vi.fn<FlowRepository["latestSamples"]>(
      async (symbol, sources) => ({
        latest: latest.filter(
          (row) =>
            row.symbol === symbol &&
            (sources === undefined || sources.includes(row.source))
        ),
        latestOk: latestOk.filter(
          (row) =>
            row.symbol === symbol &&
            (sources === undefined || sources.includes(row.source))
        ),
      })
    ),
    marketPremiumLedger: vi.fn<FlowRepository["marketPremiumLedger"]>(
      async () => []
    ),
    marketPremiumRanking: vi.fn<FlowRepository["marketPremiumRanking"]>(),
    moveOptionGapEnd: gaps.moveOptionGapEnd,
    netDriftPriceAtOrBefore: vi.fn(async () => null),
    newestDataAt: vi.fn(async () => null),
    newestNetDriftMinute: vi.fn(async () => null),
    newestOptionPrintAt: vi.fn(newestOptionPrintAt),
    optionGaps: gaps.optionGaps,
    prune: vi.fn(async () => 42),
    readBookSnapshots: vi.fn(async () => []),
    readEvents: vi.fn(async () => []),
    readHedgingPrints: vi.fn(async () => []),
    readLargeOptionPrints: vi.fn(async () => []),
    readLargeTrades: vi.fn(async () => []),
    readMinuteStarts: vi.fn(async () => []),
    readMinutes: vi.fn(async () => []),
    readNetDrift: vi.fn(async () => []),
    readOptionPrintDays: vi.fn(async () => []),
    readOptionPrintMinutes: vi.fn(async () => []),
    readOptionPrintSlotPrices: vi.fn(async () => []),
    readOptionPrintStrikeBuckets: vi.fn(async () => []),
    readOptionStrikeTotals: vi.fn(async () => []),
    readOptionTape: vi.fn<FlowRepository["readOptionTape"]>(async () => ({
      prints: [],
      summary: {
        bearishPremium: 0,
        blocks: 0,
        bullishPremium: 0,
        callPremium: 0,
        goldenSweeps: 0,
        putPremium: 0,
        sweeps: 0,
        trades: 0,
        unusualCount: 0,
      },
    })),
    readTapeSeconds: vi.fn(async () => []),
    readWindow: vi.fn(),
    recentSamples: vi.fn<FlowRepository["recentSamples"]>(async () => []),
    recordSample: vi.fn<FlowRepository["recordSample"]>(async () => undefined),
    storeMarketPremium: vi.fn<FlowRepository["storeMarketPremium"]>(
      async ({ rows }) => rows.length
    ),
    upsertBookSnapshots: vi.fn<FlowRepository["upsertBookSnapshots"]>(
      async (rows) => rows.length
    ),
    upsertMinutes: vi.fn(
      async (rows: readonly unknown[], _replace?: "coverage" | "trades") =>
        rows.length
    ),
    upsertNetDrift: vi.fn<FlowRepository["upsertNetDrift"]>(
      async (rows) => rows.length
    ),
    upsertTapeSeconds: vi.fn<FlowRepository["upsertTapeSeconds"]>(
      async (rows) => rows.length
    ),
  } satisfies FlowRepository;
};

const netDriftAnswer = (data: unknown = {}): QuantDataResult => ({
  body: { data },
  data,
  ok: true,
});

/**
 * Net drift requests go to `netDrift`, gainers-losers requests to `marketPremium`; every other
 * request goes to `pages` (option pages).
 */
const fakeQuantData = (results: QuantDataResult[] = [page([optionRow()])]) => {
  const queue = [...results];
  const pages = vi.fn<QuantDataClient["request"]>(
    async () => queue.shift() ?? page([])
  );
  const netDrift = vi.fn<QuantDataClient["request"]>(async () =>
    netDriftAnswer()
  );
  const marketPremium = vi.fn<QuantDataClient["request"]>(async () => ({
    body: {},
    data: {
      AAPL: {
        bearishPremium: 1,
        bullishPremium: 2,
        premium: 3,
        tradeCount: 1,
        volume: 10,
      },
    },
    ok: true,
  }));
  return {
    cooldownSeconds: () => 0,
    freeStarts: vi.fn(() => 24),
    marketPremium,
    netDrift,
    pages,
    request: (endpoint, ...rest) =>
      endpoint === "netDrift"
        ? netDrift(endpoint, ...rest)
        : endpoint === "gainersLosers"
          ? marketPremium(endpoint, ...rest)
          : pages(endpoint, ...rest),
  } satisfies QuantDataClient & Record<string, unknown>;
};

type Deps = Omit<FlowCollectDeps, "repository" | "quantData"> & {
  repository: ReturnType<typeof fakeRepository>;
  quantData: ReturnType<typeof fakeQuantData> | null;
};

const depsWith = (overrides: Partial<Deps> = {}): Deps => ({
  analytics: vi.fn(async () => analyticsOutput()),
  depth: vi.fn(async () => depthOutput()),
  elapsedMs: () => 1500,
  now: OPEN,
  pacing: vi.fn(async () => ({ backoffSeconds: 0, recentRequests: 0 })),
  pruneDue: false,
  quantData: fakeQuantData(),
  repository: fakeRepository(),
  tape: vi.fn(async () => tapeOutput()),
  ticks: vi.fn(async () => ticksOutput()),
  ...overrides,
});

const collect = async (
  deps: Deps,
  input: {
    dryRun?: boolean;
    seed?: boolean;
    symbols?: FlowOptionPrintSymbol[];
  } = {}
) => {
  const output = await runFlowCollect(
    {
      dryRun: input.dryRun ?? false,
      seed: input.seed ?? false,
      symbols: input.symbols,
    },
    deps
  );
  const run = (symbol: FlowOptionPrintSymbol, source: FlowSource) => {
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

  it("skips every source on Saturday and stores only the market premium gap fill", async () => {
    const { deps, es, spy } = await closed("2026-11-07T15:00:00.000Z");
    for (const source of ["depth", "ticks", "options", "gex"] as const) {
      expect(es(source)).toBe(true);
      expect(spy(source)).toBe(true);
    }
    expect(
      deps.repository.recordSample.mock.calls.map(
        ([sample]) => `${sample.symbol}:${sample.source}:${sample.status}`
      )
    ).toEqual(["SPY:market_premium:ok"]);
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
  withSampledFutures();
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
      for (const source of ["depth", "ticks", "options"] as const)
        expect(run(symbol, source).status).not.toBe("skipped");
    expect(run("SPY", "gex").status).toBe("ok");
    expect(run("ES", "gex")).toMatchObject({
      message: "staggered: GEX ran for another symbol in this run",
      status: "skipped",
    });
    expect(run("SPY", "ticks").status).toBe("ok");
    expect(run("ES", "ticks").status).toBe("ok");
    expect(deps.ticks).toHaveBeenCalledTimes(2);
    expect(deps.pacing).toHaveBeenCalledTimes(1);
    const [, payload] = deps.quantData?.pages.mock.calls[0] ?? [];
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

describe("runFlowCollect sampled tick turns", () => {
  it("one turn every 360 s stays inside the starved limit", () => {
    const turns = flowTickTurns(FLOW_INSTRUMENTS);
    expect(turns).toEqual([["SPY"]]);
    // The 60 s timer starts the one turn on the first run after it is due (350 s): every 360 s.
    const turnSeconds = Math.ceil(FLOW_DUE_SECONDS.ticks / 60) * 60;
    expect(turnSeconds).toBe(360);
    expect(turnSeconds).toBeLessThanOrEqual(FLOW_TICKS_STARVED_SECONDS);
    // More turns must fit too: the stagger starts one turn about every 120 s.
    const staggerSeconds = Math.ceil(FLOW_TICKS_STAGGER_SECONDS / 60) * 60;
    expect(turns.length * staggerSeconds).toBeLessThanOrEqual(
      FLOW_TICKS_STARVED_SECONDS
    );
  });
});

describe("runFlowCollect due and pacing", () => {
  withSampledFutures();

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

  it("fetches the SPY turn and staggers ES and NQ", async () => {
    const deps = depsWith();
    const { run } = await collect(deps);
    expect(run("SPY", "ticks").status).toBe("ok");
    for (const symbol of ["ES", "NQ"] as const)
      expect(run(symbol, "ticks")).toMatchObject({
        message: "staggered: another tick sample 0 s ago",
        status: "skipped",
      });
    expect(deps.ticks).toHaveBeenCalledTimes(1);
  });

  it("the three symbols take turns: SPY, then ES 120 s later, then NQ", async () => {
    const fetched: FlowSymbol[] = [];
    const attempts = new Map<FlowSymbol, number>();
    for (const offset of [0, 60, 120, 180, 240, 300, 360]) {
      const now = new Date(OPEN.getTime() + offset * 1000);
      const deps = depsWith({
        now,
        repository: fakeRepository(
          [...attempts].map(([symbol, at]) =>
            sample(symbol, "ticks", offset - at, now)
          )
        ),
        ticks: vi.fn(async (instrument) => {
          fetched.push(instrument.symbol);
          attempts.set(instrument.symbol, offset);
          return ticksOutput();
        }),
      });
      await collect(deps);
    }
    expect(fetched).toEqual(["SPY", "ES", "NQ", "SPY"]);
    expect([...attempts]).toEqual([
      ["SPY", 360],
      ["ES", 120],
      ["NQ", 240],
    ]);
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
      "IBKR history health check failed (no pacing data); tick sample skipped, retry next run"
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
      repository: fakeRepository([
        sample("ES", "ticks", FLOW_DUE_SECONDS.ticks + 5),
        sample("NQ", "ticks", FLOW_DUE_SECONDS.ticks + 5),
        sample("SPY", "ticks", FLOW_DUE_SECONDS.ticks + 5),
      ]),
    });
    const { run } = await collect(deps);
    const busy = "IBKR window busy (3/6 in 120 s); /charts has priority";
    expect(run("ES", "ticks").message).toBe(busy);
    expect(run("NQ", "ticks").message).toBe(busy);
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

  // 2026-11-09: a bar backfill held the window at 3 to 4 of 6 for 3 h and no tick sample ran.
  it("stops yielding a busy window once a symbol's ticks are too old", async () => {
    const deps = depsWith({
      pacing: vi.fn(async () => ({ backoffSeconds: 0, recentRequests: 4 })),
      repository: fakeRepository([
        sample("SPY", "ticks", FLOW_TICKS_STARVED_SECONDS - 1),
        sample("ES", "ticks", FLOW_TICKS_STARVED_SECONDS + 1),
      ]),
    });
    const { run } = await collect(deps);
    expect(run("SPY", "ticks").message).toBe(
      "IBKR window busy (4/6 in 120 s); /charts has priority"
    );
    expect(run("ES", "ticks").status).toBe("ok");
    expect(deps.ticks).toHaveBeenCalledTimes(1);
  });

  it("treats a symbol with no tick sample as too old", async () => {
    const deps = depsWith({
      pacing: vi.fn(async () => ({ backoffSeconds: 0, recentRequests: 4 })),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(run("ES", "ticks").status).toBe("ok");
  });

  it("keeps too-old ticks waiting while the window has no room for two requests", async () => {
    const deps = depsWith({
      pacing: vi.fn(async () => ({ backoffSeconds: 0, recentRequests: 5 })),
      repository: fakeRepository([
        sample("ES", "ticks", FLOW_TICKS_STARVED_SECONDS + 1),
      ]),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(run("ES", "ticks").message).toBe(
      "IBKR window full (5/6 in 120 s); no room for 2 requests"
    );
    expect(deps.ticks).not.toHaveBeenCalled();
  });

  it("keeps too-old ticks waiting during an IBKR back-off", async () => {
    const deps = depsWith({
      pacing: vi.fn(async () => ({ backoffSeconds: 12, recentRequests: 0 })),
      repository: fakeRepository([
        sample("ES", "ticks", FLOW_TICKS_STARVED_SECONDS + 1),
      ]),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(run("ES", "ticks").message).toBe("IBKR pacing back-off, 12 s left");
    expect(deps.ticks).not.toHaveBeenCalled();
  });

  it("lets one starved symbol per run take the window; the other one is staggered", async () => {
    const deps = depsWith({
      pacing: vi.fn(async () => ({ backoffSeconds: 0, recentRequests: 4 })),
      repository: fakeRepository([
        sample("SPY", "ticks", FLOW_TICKS_STARVED_SECONDS + 1),
        sample("ES", "ticks", FLOW_TICKS_STARVED_SECONDS + 1),
      ]),
    });
    const { run } = await collect(deps);
    expect(run("SPY", "ticks").status).toBe("ok");
    expect(run("ES", "ticks").message).toBe(
      "staggered: another tick sample 0 s ago"
    );
    expect(deps.ticks).toHaveBeenCalledTimes(1);
  });

  it("counts a failed attempt: no retry behind a busy window for the starved time", async () => {
    const deps = depsWith({
      pacing: vi.fn(async () => ({ backoffSeconds: 0, recentRequests: 4 })),
      repository: fakeRepository([
        {
          ...sample("ES", "ticks", FLOW_DUE_SECONDS.ticks + 5),
          status: "unavailable",
        },
      ]),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(run("ES", "ticks").message).toBe(
      "IBKR window busy (4/6 in 120 s); /charts has priority"
    );
    expect(deps.ticks).not.toHaveBeenCalled();
  });
});

describe("runFlowCollect ticks", () => {
  withSampledFutures();

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

  it("does not store a stale copy served for a paced-out request as a fresh sample", async () => {
    const deps = depsWith({
      ticks: vi.fn(async () =>
        ticksOutput({
          cache: { ageSeconds: 400, hit: true, stale: true, ttlSeconds: 15 },
        })
      ),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(run("ES", "ticks")).toMatchObject({
      message: "stale copy (400 s old, request paced out); not stored",
      status: "unavailable",
    });
    expect(deps.repository.upsertMinutes).not.toHaveBeenCalled();
    expect(recorded(deps)).toContain("ES:ticks:unavailable");
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
    expect(deps.quantData?.pages).toHaveBeenCalledWith(
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
    expect(quantData.pages.mock.calls[1]?.[1]).toMatchObject({
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
    expect(quantData.pages).toHaveBeenCalledTimes(FLOW_OPTION_RUN_PAGES_MAX);
    // The gap ends 1 ms after the oldest print, so prints sharing its millisecond are read again.
    expect(gaps.addOptionGap).toHaveBeenCalledWith({
      createdAt: OPEN,
      endTime: new Date(oldest.getTime() + 1),
      startTime: floor,
      symbol: "SPY",
    });
    expect(
      quantData.pages.mock.calls[FLOW_OPTION_PAGES_MAX]?.[1]
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
    client: {
      cooldownSeconds: () => 0,
      freeStarts: vi.fn(() => 24),
      marketPremium: vi.fn<QuantDataClient["request"]>(),
      netDrift: vi.fn<QuantDataClient["request"]>(async () => netDriftAnswer()),
      pages: request,
      request: (endpoint, ...rest) =>
        endpoint === "netDrift"
          ? Promise.resolve(netDriftAnswer())
          : endpoint === "gainersLosers"
            ? Promise.resolve({ body: {}, data: {}, ok: true as const })
            : request(endpoint, ...rest),
    } satisfies QuantDataClient & Record<string, unknown>,
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
    expect(quantData.pages).toHaveBeenCalledTimes(2);
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
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "options")).toMatchObject({
      message: "storage: write failed (Error)",
      status: "unavailable",
    });
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

  it("ignores a bad trade time outside the gap when it resumes", async () => {
    const stored = {
      createdAt: OPEN,
      endTime: new Date(OPEN.getTime() - 3_600_000),
      startTime: new Date(OPEN.getTime() - 7_200_000),
      symbol: "SPY" as const,
    };
    const at = new Date(OPEN.getTime() - 5_400_000);
    const gaps = gapStore([stored]);
    await collect(
      depsWith({
        quantData: fakeQuantData([
          page([]),
          ...Array.from({ length: FLOW_OPTION_RUN_PAGES_MAX }, (_, i) =>
            page(
              [
                optionRow({ id: `b${i}`, tradeTime: at.getTime() }),
                { broken: true, tradeTime: 0 },
              ],
              [i]
            )
          ),
        ]),
        repository: fakeRepository([], undefined, gaps),
      }),
      { symbols: ["SPY"] }
    );
    expect(gaps.rows()).toStrictEqual([
      { ...stored, endTime: new Date(at.getTime() + 1) },
    ]);
  });

  it("records a gap that cannot be read after the close as unavailable", async () => {
    const gaps = gapStore([
      {
        createdAt: OPEN,
        endTime: new Date(CLOSE.getTime() - 60_000),
        startTime: new Date(CLOSE.getTime() - 120_000),
        symbol: "SPY",
      },
    ]);
    const { run } = await collect(
      depsWith({
        now: CLOSE,
        quantData: fakeQuantData(
          Array.from({ length: FLOW_OPTION_RUN_PAGES_MAX }, (_, i) =>
            page([{ broken: true }], [i])
          )
        ),
        repository: fakeRepository([], undefined, gaps),
      }),
      { symbols: ["SPY"] }
    );
    expect(run("SPY", "options")).toMatchObject({
      message: "gaps: capped pages held no trade time",
      status: "unavailable",
    });
    expect(gaps.rows()).toHaveLength(1);
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
    expect(open.quantData?.pages).not.toHaveBeenCalled();
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
    expect(quantData.pages).toHaveBeenCalledTimes(2);
    expect(quantData.pages.mock.calls[1]?.[1]).toMatchObject({
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

  it("reports a net GEX of exactly zero as empty and stores no row", async () => {
    const deps = depsWith({
      analytics: vi.fn(async () => analyticsOutput({ regime: "zero" })),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "gex")).toMatchObject({
      message: "Not stored: net GEX is exactly 0 (no sign)",
      status: "empty",
    });
    expect(deps.repository.insertGex).not.toHaveBeenCalled();
  });

  it("stores no row for a regime without an estimate", async () => {
    // The analytics set a message for every missing estimate; this is the guard text.
    const silent = depsWith({
      analytics: vi.fn(async () => analyticsOutput({ regime: "no_data" })),
    });
    const first = await collect(silent, { symbols: ["SPY"] });
    expect(first.run("SPY", "gex")).toMatchObject({
      message: "Not stored: no GEX estimate",
      status: "empty",
    });
    expect(silent.repository.insertGex).not.toHaveBeenCalled();
    const named = depsWith({
      analytics: vi.fn(async () =>
        analyticsOutput({
          exposure: {
            message:
              "Open interest shown; GEX needs option-chain IV and a spot price.",
          },
          regime: "no_data",
        })
      ),
    });
    const second = await collect(named, { symbols: ["SPY"] });
    expect(second.run("SPY", "gex").message).toBe(
      "Open interest shown; GEX needs option-chain IV and a spot price."
    );
    expect(named.repository.insertGex).not.toHaveBeenCalled();
  });

  it("stores the word unknown for an IV regime without term data", async () => {
    // Rule 9: the stored word of flow_gex.iv_regime does not change with the contract.
    const deps = depsWith({
      analytics: vi.fn(async () =>
        analyticsOutput({ ivRegime: "no_term_data", regime: "negative" })
      ),
    });
    await collect(deps, { symbols: ["SPY"] });
    expect(deps.repository.insertGex.mock.calls[0]?.[0][0]).toMatchObject({
      ivRegime: "unknown",
      regime: "negative",
    });
    const kept = depsWith({
      analytics: vi.fn(async () => analyticsOutput({ ivRegime: "inverted" })),
    });
    await collect(kept, { symbols: ["SPY"] });
    expect(kept.repository.insertGex.mock.calls[0]?.[0][0]).toMatchObject({
      ivRegime: "inverted",
      regime: "positive",
    });
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
      kingNode: 6100,
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

  it("names the missing input when the ES basis is not computed", async () => {
    const skipTicks = vi.fn(async () => {
      throw new Error("skip");
    });
    const noPrice = depsWith({
      depth: vi.fn(async () => depthOutput({ asks: [] })),
      tape: skipTicks,
      ticks: skipTicks,
    });
    const first = await collect(noPrice, { symbols: ["ES"] });
    expect(first.run("ES", "gex").message).toBe(
      "positive gamma; basis not computed: no ES price in this run"
    );
    expect(noPrice.repository.insertGex.mock.calls[0]?.[0][0]).toMatchObject({
      basis: null,
    });
    const noSpot = depsWith({
      analytics: vi.fn(async () => analyticsOutput({ spot: null })),
    });
    const second = await collect(noSpot, { symbols: ["ES"] });
    expect(second.run("ES", "gex").message).toBe(
      "positive gamma; basis not computed: QuantData sent no SPX spot"
    );
    // Both missing: the price is checked first.
    const neither = depsWith({
      analytics: vi.fn(async () => analyticsOutput({ spot: null })),
      depth: vi.fn(async () => depthOutput({ asks: [] })),
      tape: skipTicks,
      ticks: skipTicks,
    });
    const third = await collect(neither, { symbols: ["ES"] });
    expect(third.run("ES", "gex").message).toBe(
      "positive gamma; basis not computed: no ES price in this run"
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
    expect(output.runs).toHaveLength(22);
    expect(recorded(deps)).toEqual([
      "SPY:net_drift:empty",
      "ES:net_drift:empty",
      "SPY:depth:ok",
      "ES:depth:ok",
      "QQQ:depth:ok",
      "NQ:depth:ok",
      "SPY:ticks:ok",
      "ES:ticks:ok",
      "NQ:ticks:ok",
      "SPY:options:ok",
      "ES:options:empty",
      "IWM:options:empty",
      "SPY:gex:ok",
      "SPY:market_premium:ok",
    ]);
    expect(output.at).toBe(OPEN.toISOString());
  });

  it("prunes each table with its own cutoff", async () => {
    const off = depsWith();
    expect((await collect(off)).output.pruned).toBe(0);
    expect(off.repository.prune).not.toHaveBeenCalled();
    const due = depsWith({ pruneDue: true });
    expect((await collect(due)).output.pruned).toBe(42);
    const days14 = new Date(OPEN.getTime() - 14 * 86_400_000);
    expect(due.repository.prune).toHaveBeenCalledWith({
      flow_book: days14,
      flow_book_snapshots: new Date(OPEN.getTime() - 7 * 86_400_000),
      flow_events: days14,
      flow_gex: new Date(OPEN.getTime() - 730 * 86_400_000),
      flow_large_trades: new Date(OPEN.getTime() - 730 * 86_400_000),
      flow_minutes: new Date(OPEN.getTime() - 730 * 86_400_000),
      flow_net_drift: new Date(OPEN.getTime() - 730 * 86_400_000),
      flow_option_gaps: days14,
      flow_option_prints: days14,
      flow_samples: days14,
    });
    expect(FLOW_RETENTION_DAYS.flow_net_drift).toBe(730);
    expect(FLOW_RETENTION_DAYS.flow_minutes).toBe(730);
    expect(FLOW_RETENTION_DAYS.flow_gex).toBe(730);
  });

  it("prunes flow_large_trades with the 730-day cutoff", async () => {
    const due = depsWith({ pruneDue: true });
    await collect(due);
    expect(FLOW_RETENTION_DAYS.flow_large_trades).toBe(730);
    expect(due.repository.prune).toHaveBeenCalledWith(
      expect.objectContaining({
        flow_large_trades: new Date(OPEN.getTime() - 730 * 86_400_000),
      })
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

describe("runFlowCollect storage errors and the run budget", () => {
  it("records a storage error as a sample and continues with the next source", async () => {
    const deps = depsWith();
    deps.repository.upsertMinutes.mockRejectedValueOnce(
      new TypeError("relation missing: secret sql")
    );
    const { output, run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "ticks")).toMatchObject({
      events: 0,
      items: 0,
      message: "storage: write failed (TypeError)",
      status: "unavailable",
    });
    expect(JSON.stringify(output)).not.toContain("secret sql");
    expect(run("SPY", "options").status).toBe("ok");
    expect(recorded(deps)).toContain("SPY:ticks:unavailable");
  });

  it("names a thrown value that is not an error by its type", async () => {
    const deps = depsWith();
    deps.repository.upsertMinutes.mockRejectedValueOnce("plain text");
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "ticks").message).toBe("storage: write failed (string)");
  });

  const throwingQuotes = (thrown: unknown): MarketTicksOutput =>
    Object.defineProperty(ticksOutput(), "quotes", {
      get: () => {
        throw thrown;
      },
    });

  it("names an error outside the repository as a collector failure, not storage", async () => {
    const deps = depsWith({
      ticks: vi.fn(async () => throwingQuotes(new RangeError("bad tape"))),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "ticks")).toMatchObject({
      message: "collector failed (RangeError)",
      status: "unavailable",
    });
  });

  it("names a non-error thrown outside the repository by its type", async () => {
    const deps = depsWith({
      ticks: vi.fn(async () => throwingQuotes("plain text")),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "ticks").message).toBe("collector failed (string)");
  });

  it("returns the run entry when the sample write also fails", async () => {
    const deps = depsWith();
    deps.repository.recordSample.mockRejectedValue(new Error("db down"));
    const { output } = await collect(deps, { symbols: ["SPY"] });
    expect(output.runs.map((row) => row.source)).toEqual([
      "net_drift",
      "depth",
      "ticks",
      "options",
      "gex",
      "market_premium",
    ]);
  });

  it("ends the run when the sample lookup fails", async () => {
    const deps = depsWith();
    deps.repository.latestSamples.mockRejectedValueOnce(new Error("db down"));
    await expect(collect(deps)).rejects.toThrow("db down");
  });

  it("runs GEX for one symbol per run", async () => {
    const deps = depsWith();
    const { run } = await collect(deps);
    expect(run("SPY", "gex").status).toBe("ok");
    expect(run("ES", "gex")).toMatchObject({
      message: "staggered: GEX ran for another symbol in this run",
      status: "skipped",
    });
    expect(deps.analytics).toHaveBeenCalledTimes(1);
    expect(recorded(deps)).not.toContain("ES:gex:skipped");
  });

  it("skips a source whose worst case does not fit in the free starts and stores no sample for it", async () => {
    const quantData = fakeQuantData();
    quantData.freeStarts.mockReturnValue(7);
    const deps = depsWith({ quantData });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "options")).toMatchObject({
      message:
        "budget: 7 QuantData starts free beyond the reserve of 6, 8 needed",
      status: "skipped",
    });
    expect(run("SPY", "gex").status).toBe("ok");
    expect(quantData.pages).not.toHaveBeenCalled();
    expect(recorded(deps)).not.toContain("SPY:options:skipped");
    quantData.freeStarts.mockReturnValue(2);
    const second = await collect(depsWith({ quantData }), { symbols: ["SPY"] });
    expect(second.run("SPY", "gex").message).toBe(
      "budget: 2 QuantData starts free beyond the reserve of 6, 3 needed"
    );
  });

  it("applies the free-start check on a seed run", async () => {
    const quantData = fakeQuantData();
    quantData.freeStarts.mockReturnValue(0);
    const deps = depsWith({
      now: new Date("2026-11-07T15:00:00.000Z"),
      quantData,
    });
    const { run } = await collect(deps, { seed: true, symbols: ["SPY"] });
    expect(run("SPY", "options").message).toBe(
      "budget: 0 QuantData starts free beyond the reserve of 6, 8 needed"
    );
    expect(run("SPY", "gex").status).toBe("skipped");
  });

  it("reports the free starts, the reserve, the IBKR window and the run time", async () => {
    const { output } = await collect(depsWith({ elapsedMs: () => 12_600 }));
    expect(output.budget).toEqual({
      ibkrLimit: 6,
      ibkrRecent: 2,
      quantDataFree: 24,
      quantDataReserve: 6,
      runSeconds: 13,
    });
    const closed = await collect(
      depsWith({ now: new Date("2026-11-08T15:00:00.000Z"), quantData: null })
    );
    expect(closed.output.budget).toMatchObject({
      ibkrRecent: null,
      quantDataFree: null,
    });
  });
});

describe("runFlowCollect net drift", () => {
  const ODD = new Date(OPEN.getTime() + 60_000);
  const BUCKET = {
    netCallPremium: 1000,
    netCallVolume: 10,
    netPutPremium: -200,
    netPutVolume: -2,
    stockPrice: 683.4,
  };
  const answer = (...starts: Date[]): QuantDataResult =>
    netDriftAnswer(
      Object.fromEntries(starts.map((at) => [String(at.getTime()), BUCKET]))
    );
  const withNetDrift = (
    ...results: QuantDataResult[]
  ): ReturnType<typeof fakeQuantData> => {
    const quantData = fakeQuantData();
    for (const result of results)
      quantData.netDrift.mockResolvedValueOnce(result);
    return quantData;
  };
  const minuteAgo = (minutes: number, now: Date = OPEN) =>
    new Date(now.getTime() - minutes * 60_000);

  it("runs net drift first", async () => {
    const { output } = await collect(depsWith(), { symbols: ["SPY"] });
    expect(output.runs[0]?.source).toBe("net_drift");
  });

  it("skips a source that the symbol does not list", async () => {
    const deps = depsWith({ now: ODD });
    const { output } = await collect(deps, { symbols: ["QQQ", "NQ"] });
    expect(output.runs.map((row) => `${row.symbol}:${row.source}`)).toEqual([
      "QQQ:net_drift",
      "NQ:net_drift",
      "QQQ:depth",
      "NQ:depth",
      "NQ:ticks",
      "QQQ:options",
      "NQ:options",
      "QQQ:gex",
      "NQ:gex",
    ]);
    expect(deps.ticks).not.toHaveBeenCalled();
    expect(deps.tape).toHaveBeenCalledTimes(1);
    expect(deps.tape).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "NQ" }),
      expect.any(Number)
    );
    expect(deps.quantData?.pages).toHaveBeenCalledTimes(2);
  });

  it("sends the total and the zero_dte request per symbol and stores both parts", async () => {
    const quantData = withNetDrift(
      answer(minuteAgo(2), minuteAgo(1)),
      answer(minuteAgo(1))
    );
    const deps = depsWith({ quantData });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(quantData.netDrift.mock.calls.map((call) => call[1])).toEqual([
      netDriftRequestFor("2026-11-09", "SPX", "total"),
      netDriftRequestFor("2026-11-09", "SPX", "zero_dte"),
    ]);
    expect(quantData.netDrift.mock.calls[0]?.[2]).toBe(30_000);
    const written = deps.repository.upsertNetDrift.mock.calls.flatMap(
      ([rows]) => rows
    );
    expect(written.map((row) => `${row.ticker}:${row.part}`)).toEqual([
      "SPX:total",
      "SPX:total",
      "SPX:zero_dte",
    ]);
    expect(written[0]).toMatchObject({
      filterProfile: "otm-clean.v1",
      minute: minuteAgo(2),
      netCallPremium: 1000,
      underlyingPrice: 683.4,
    });
    expect(run("ES", "net_drift")).toMatchObject({
      items: 3,
      message: "SPX total 2 buckets, zero_dte 1, newest 09:59 NY, 2 requests",
      status: "ok",
    });
  });

  it("runs sp500 on even minutes and nasdaq100 on odd minutes", async () => {
    expect(netDriftTurn("sp500", OPEN)).toBe(true);
    expect(netDriftTurn("nasdaq100", OPEN)).toBe(false);
    expect(netDriftTurn("nasdaq100", ODD)).toBe(true);
    const even = await collect(depsWith(), { symbols: ["SPY", "QQQ"] });
    expect(even.run("QQQ", "net_drift")).toMatchObject({
      message: "staggered: nasdaq100 net drift runs on odd minutes",
      status: "skipped",
    });
    expect(even.run("SPY", "net_drift").status).toBe("empty");
    const odd = await collect(depsWith({ now: ODD }), {
      symbols: ["SPY", "QQQ"],
    });
    expect(odd.run("SPY", "net_drift").message).toBe(
      "staggered: sp500 net drift runs on even minutes"
    );
    expect(odd.run("QQQ", "net_drift").status).toBe("empty");
  });

  it("ignores the stagger on a seed run and asks for the newest weekday", async () => {
    const sunday = new Date("2026-11-08T15:01:00.000Z");
    const quantData = fakeQuantData();
    const { run } = await collect(depsWith({ now: sunday, quantData }), {
      seed: true,
      symbols: ["SPY"],
    });
    expect(run("SPY", "net_drift").status).toBe("empty");
    expect(quantData.netDrift.mock.calls[0]?.[1]).toMatchObject({
      sessionDate: "2026-11-06",
    });
  });

  it("records unavailable with the vendor rate limit end time when the total part is refused", async () => {
    const limited = (retryAfterSeconds: number | null): QuantDataResult => ({
      message: "QuantData netDrift: HTTP 429.",
      ok: false,
      reason: "rate_limited",
      retryAfterSeconds,
    });
    const quantData = withNetDrift(limited(120));
    const { run } = await collect(depsWith({ quantData }), {
      symbols: ["SPY"],
    });
    expect(run("SPY", "net_drift")).toMatchObject({
      message: "rate limited until 10:02 ET",
      status: "unavailable",
    });
    expect(quantData.netDrift).toHaveBeenCalledTimes(1);
    const cooling = {
      ...withNetDrift(limited(null)),
      cooldownSeconds: () => 300,
    };
    const second = await collect(depsWith({ quantData: cooling }), {
      symbols: ["SPY"],
    });
    expect(second.run("SPY", "net_drift").message).toBe(
      "rate limited until 10:05 ET"
    );
    const failing = withNetDrift(refused("QuantData netDrift: HTTP 500."));
    const third = await collect(depsWith({ quantData: failing }), {
      symbols: ["SPY"],
    });
    expect(third.run("SPY", "net_drift")).toMatchObject({
      message: "QuantData netDrift: HTTP 500.",
      status: "unavailable",
    });
  });

  it("skips net drift and stores no sample when the total part is refused for the caller reserve", async () => {
    const quantData = withNetDrift({
      message: "kept free",
      ok: false,
      reason: "reserved",
      retryAfterSeconds: 10,
    });
    const deps = depsWith({ quantData });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(run("SPY", "net_drift")).toMatchObject({
      message: "budget: QuantData starts kept free for other callers",
      status: "skipped",
    });
    expect(quantData.netDrift).toHaveBeenCalledTimes(1);
    expect(recorded(deps)).not.toContain("SPY:net_drift:skipped");
  });

  it("stays ok and names the failed zero_dte part", async () => {
    const quantData = withNetDrift(
      answer(minuteAgo(1)),
      refused("QuantData netDrift: HTTP 502.")
    );
    const { run } = await collect(depsWith({ quantData }), {
      symbols: ["SPY"],
    });
    expect(run("SPY", "net_drift")).toMatchObject({
      items: 1,
      message:
        "SPY total 1 buckets, zero_dte 0, newest 09:59 NY, 2 requests; zero_dte failed (QuantData netDrift: HTTP 502.)",
      status: "ok",
    });
    const reserved = withNetDrift(answer(minuteAgo(1)), {
      message: "QuantData netDrift: 6 kept free.",
      ok: false,
      reason: "reserved",
      retryAfterSeconds: 5,
    });
    const second = await collect(depsWith({ quantData: reserved }), {
      symbols: ["SPY"],
    });
    expect(second.run("SPY", "net_drift").message).toContain(
      "; zero_dte failed (QuantData netDrift: 6 kept free.)"
    );
  });

  it("records empty without a newest time for zero buckets", async () => {
    const quantData = withNetDrift(answer(), answer());
    const { run } = await collect(depsWith({ quantData }), {
      symbols: ["SPY"],
    });
    expect(run("SPY", "net_drift")).toMatchObject({
      message: "SPY total 0 buckets, zero_dte 0, 2 requests",
      status: "empty",
    });
  });

  it("records empty for a newest bucket older than 300 s", async () => {
    const quantData = withNetDrift(answer(minuteAgo(6)), answer());
    const { run } = await collect(depsWith({ quantData }), {
      symbols: ["SPY"],
    });
    expect(run("SPY", "net_drift")).toMatchObject({
      message: "SPY total 1 buckets, zero_dte 0, newest 09:54 NY, 2 requests",
      status: "empty",
    });
    const exact = withNetDrift(answer(minuteAgo(5)), answer());
    const second = await collect(depsWith({ quantData: exact }), {
      symbols: ["SPY"],
    });
    expect(second.run("SPY", "net_drift").status).toBe("ok");
  });

  it("records a total answer of an unexpected shape as unavailable", async () => {
    const quantData = withNetDrift(netDriftAnswer("not an object"));
    const { run } = await collect(depsWith({ quantData }), {
      symbols: ["SPY"],
    });
    expect(run("SPY", "net_drift")).toMatchObject({
      message: "net drift answer has an unexpected shape: (root)",
      status: "unavailable",
    });
  });

  it("answers not configured without a client", async () => {
    const { run } = await collect(depsWith({ quantData: null }), {
      symbols: ["SPY"],
    });
    expect(run("SPY", "net_drift")).toMatchObject({
      message: "QuantData not configured",
      status: "skipped",
    });
  });

  it("stores nothing on a dry run but counts the buckets", async () => {
    const quantData = withNetDrift(answer(minuteAgo(1)), answer(minuteAgo(1)));
    const deps = depsWith({ quantData });
    const { run } = await collect(deps, { dryRun: true, symbols: ["SPY"] });
    expect(run("SPY", "net_drift").items).toBe(2);
    expect(deps.repository.upsertNetDrift).not.toHaveBeenCalled();
  });

  it("keeps the worst case of one run inside the client window minus the caller reserve", () => {
    expect(flowQuantDataRunWorstCase(FLOW_INSTRUMENTS, FLOW_GROUPS)).toBe(32);
    expect(32).toBeLessThanOrEqual(
      DEFAULT_MAX_PER_MINUTE - FLOW_QUANTDATA_CALLER_RESERVE
    );
  });

  it("reads net drift on every run of the group's minute", async () => {
    const deps = depsWith({
      repository: fakeRepository([sample("SPY", "net_drift", 1)]),
    });
    const { run } = await collect(deps, { symbols: ["SPY"] });
    expect(FLOW_DUE_SECONDS.net_drift).toBe(0);
    expect(run("SPY", "net_drift").status).toBe("empty");
  });

  it("is closed after 16:20 New York", async () => {
    const { run } = await collect(
      depsWith({ now: new Date("2026-11-09T21:20:00.000Z") }),
      { symbols: ["SPY"] }
    );
    expect(run("SPY", "net_drift").message).toBe("market closed");
  });
});

describe("runFlowCollect deep trades", () => {
  withSampledFutures();
  const T = NOW_S - 60;
  const futureTape = ticksOutput({
    quotes: [{ ap: 6870.25, as: 5, bp: 6870, bs: 5, t: T }],
    trades: [
      { c: null, p: 6870, s: 1, t: T, x: null },
      { c: null, p: 6870.25, s: 45, t: T + 10, x: null },
      { c: null, p: 6870.25, s: 50, t: T + 10, x: null },
      { c: null, p: 6870.5, s: 2, t: T + 20, x: null },
    ],
  });
  const tickTurn = (symbol: FlowSymbol): FlowSymbol[] => [symbol];

  it("stores the events and the deep trades of a future in one write, and SPY events as before", async () => {
    const es = depsWith({ ticks: vi.fn(async () => futureTape) });
    const { run } = await collect(es, { symbols: tickTurn("ES") });
    expect(es.repository.insertTickSample).toHaveBeenCalledTimes(1);
    const [[input]] = es.repository.insertTickSample.mock.calls as [
      [Parameters<FlowRepository["insertTickSample"]>[0]],
    ];
    expect(input.trades.map((row) => [row.size, row.seq, row.side])).toEqual([
      [45, 0, "buy"],
      [50, 1, "buy"],
    ]);
    expect(input.events.map((event) => event.kind)).toContain("large_print");
    // insertEvents only takes the options events of ES; the tick events went with the trades.
    for (const [rows] of es.repository.insertEvents.mock.calls)
      expect(
        (rows as readonly { kind: string }[]).map((row) => row.kind)
      ).not.toContain("large_print");
    expect(run("ES", "ticks").events).toBe(input.events.length);

    const spy = depsWith();
    await collect(spy, { symbols: tickTurn("SPY") });
    expect(spy.repository.insertTickSample).not.toHaveBeenCalled();
    // SPY tick events still go through insertEvents (empty for this tape).
    expect(spy.repository.insertEvents).toHaveBeenCalledWith([]);
  });

  it("does not call the deep-trade detector for an empty sample", async () => {
    const deps = depsWith({
      ticks: vi.fn(async () => ticksOutput({ quotes: [], trades: [] })),
    });
    const { run } = await collect(deps, { symbols: tickTurn("NQ") });
    expect(deps.repository.insertTickSample).toHaveBeenCalledWith({
      events: [],
      trades: [],
    });
    expect(run("NQ", "ticks")).toMatchObject({
      message:
        "no prints; 0 deep trades, 0 new, 0 deep prints without a side, 0 with an invalid price",
      status: "empty",
    });
  });

  it("counts new deep trades and deep prints without a side in the message", async () => {
    const repository = fakeRepository();
    repository.insertTickSample.mockResolvedValueOnce({ events: 0, trades: 1 });
    const deps = depsWith({
      repository,
      ticks: vi.fn(async () =>
        ticksOutput({
          quotes: [],
          trades: [
            { c: null, p: 6870, s: 1, t: T, x: null },
            { c: null, p: 6870.25, s: 45, t: T + 10, x: null },
            { c: null, p: 6870.25, s: 50, t: T + 10, x: null },
            { c: null, p: 6870.5, s: 2, t: T + 20, x: null },
          ],
        })
      ),
    });
    const { run } = await collect(deps, { symbols: tickTurn("ES") });
    expect(run("ES", "ticks").message).toMatch(
      /; 2 deep trades, 1 new, 0 deep prints without a side, 0 with an invalid price$/
    );
    const unsigned = depsWith({
      ticks: vi.fn(async () =>
        ticksOutput({
          quotes: [],
          trades: [
            { c: null, p: 6870, s: 45, t: T, x: null },
            { c: null, p: 6870, s: 45, t: T + 10, x: null },
            { c: null, p: 6870, s: 2, t: T + 20, x: null },
          ],
        })
      ),
    });
    const second = await collect(unsigned, { symbols: tickTurn("ES") });
    expect(second.run("ES", "ticks").message).toMatch(
      /; 0 deep trades, 0 new, 1 deep prints without a side, 0 with an invalid price$/
    );
  });

  it("leaves out a deep print with an invalid price, stores the rest of the sample and counts it", async () => {
    const deps = depsWith({
      ticks: vi.fn(async () =>
        ticksOutput({
          quotes: [],
          trades: [
            { c: null, p: 6870, s: 1, t: T, x: null },
            { c: null, p: 6870.25, s: 45, t: T + 10, x: null },
            { c: null, p: 0, s: 60, t: T + 10, x: null },
            { c: null, p: 6870.5, s: 2, t: T + 20, x: null },
          ],
        })
      ),
    });
    const { run } = await collect(deps, { symbols: tickTurn("ES") });
    const [[input]] = deps.repository.insertTickSample.mock.calls as [
      [Parameters<FlowRepository["insertTickSample"]>[0]],
    ];
    expect(input.trades.map((row) => [row.size, row.seq, row.price])).toEqual([
      [45, 0, 6870.25],
    ]);
    expect(run("ES", "ticks").message).toMatch(
      /; 1 deep trades, 1 new, 0 deep prints without a side, 1 with an invalid price$/
    );
  });

  it("stores nothing on a dry run and reports the counts", async () => {
    const deps = depsWith({ ticks: vi.fn(async () => futureTape) });
    const { run } = await collect(deps, {
      dryRun: true,
      symbols: tickTurn("ES"),
    });
    expect(deps.repository.insertTickSample).not.toHaveBeenCalled();
    expect(run("ES", "ticks").message).toMatch(
      /; 2 deep trades, 2 new, 0 deep prints without a side, 0 with an invalid price$/
    );
    expect(run("ES", "ticks").events).toBeGreaterThan(0);
  });
});

describe("runFlowCollect streamed tape (ES and NQ)", () => {
  // The default range of these tests: one complete minute, from OPEN - 120 s to OPEN - 60 s.
  const SINCE = NOW_S - 120;
  const END = NOW_S - 60;
  const minuteOf = (second: number) => new Date(second * 1000);

  /** A run at OPEN; the last stored ok tick sample of ES and NQ is `secondsAgo` old. */
  const tapeDeps = (overrides: Partial<Deps> = {}, secondsAgo = 60): Deps =>
    depsWith({
      repository: fakeRepository([], undefined, undefined, [
        sample("ES", "ticks", secondsAgo),
        sample("NQ", "ticks", secondsAgo),
      ]),
      ...overrides,
    });
  const storedMinutes = (deps: Deps) =>
    deps.repository.upsertMinutes.mock.calls.flatMap(
      ([rows]) => rows as readonly { coveredSeconds: number; minute: Date }[]
    );
  const tickSample = (deps: Deps) => {
    const [[input]] = deps.repository.insertTickSample.mock.calls as [
      [Parameters<FlowRepository["insertTickSample"]>[0]],
    ];
    return input;
  };

  it("starts one minute before the minute of the last ok sample and stores the complete minute", async () => {
    const deps = tapeDeps({}, 65);
    // The sample is 65 s old: its minute starts at OPEN - 120 s, and the read one minute before.
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(deps.tape).toHaveBeenCalledTimes(1);
    expect(deps.tape).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "ES" }),
      SINCE - FLOW_TAPE_REREAD_SECONDS
    );
    expect(run("ES", "ticks")).toEqual({
      events: 0,
      items: 1,
      message:
        "streamed tape ESZ6: 2 prints in 1 complete minutes, 60 of 120 s covered; 0 deep trades, 0 new; 0 prints signed by the tick rule, 0 without a side",
      source: "ticks",
      status: "ok",
      symbol: "ES",
    });
    expect(recorded(deps)).toContain("ES:ticks:ok");
  });

  it("starts two minutes before the present minute without an ok sample, so one complete minute is in the range", async () => {
    const deps = depsWith();
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(deps.tape).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "ES" }),
      NOW_S - 2 * FLOW_TAPE_REREAD_SECONDS
    );
    // The answer ends at OPEN - 3 s: the complete minutes end at OPEN - 60 s.
    expect(run("ES", "ticks")).toMatchObject({
      items: 1,
      message:
        "streamed tape ESZ6: 2 prints in 1 complete minutes, 60 of 60 s covered; 0 deep trades, 0 new; 0 prints signed by the tick rule, 0 without a side",
      status: "ok",
    });
    expect(storedMinutes(deps)).toEqual([
      expect.objectContaining({ coveredSeconds: 60, minute: minuteOf(SINCE) }),
    ]);
  });

  it("is ok without an ok sample when the read reaches the service at second 1 of a minute", async () => {
    const now = new Date(OPEN.getTime() + 1000);
    const deps = depsWith({
      now,
      // The service serves seconds up to 3 s before its time: the answer ends in the last minute.
      tape: vi.fn(async () =>
        tapeOutput({ covered: [[SINCE, NOW_S - 2]], until: NOW_S - 2 })
      ),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(deps.tape).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "ES" }),
      SINCE
    );
    expect(run("ES", "ticks")).toMatchObject({ items: 1, status: "ok" });
    // The last minute is not complete yet: the run stores the minute before it.
    expect(storedMinutes(deps)).toEqual([
      expect.objectContaining({
        coveredSeconds: 60,
        minute: minuteOf(SINCE),
        trades: 2,
      }),
    ]);
    expect(recorded(deps)).toContain("ES:ticks:ok");
  });

  it("replaces a minute row by its print count; the sampled ticks keep the coverage rule", async () => {
    const tape = tapeDeps();
    await collect(tape, { symbols: ["ES"] });
    expect(tape.repository.upsertMinutes.mock.calls).toEqual([
      [[expect.objectContaining({ symbol: "ES" })], "trades"],
    ]);
    const sampled = depsWith();
    await collect(sampled, { symbols: ["SPY"] });
    // No second argument: the repository default ("coverage").
    expect(sampled.repository.upsertMinutes.mock.calls).toEqual([
      [expect.any(Array)],
    ]);
  });

  it("keeps complete minutes only: the minute in progress is left to the next run", async () => {
    const deps = tapeDeps();
    await collect(deps, { symbols: ["ES"] });
    // The print at OPEN - 30 s is in the minute in progress.
    expect(storedMinutes(deps)).toEqual([
      expect.objectContaining({
        buyVolume: 2,
        close: 6000,
        coveredSeconds: 60,
        minute: minuteOf(SINCE),
        open: 6000.25,
        sellVolume: 3,
        symbol: "ES",
        trades: 2,
        volume: 5,
      }),
    ]);
    expect(tickSample(deps)).toEqual({ events: [], trades: [] });
  });

  it("joins the answers before it signs: the tick rule runs across the answer border", async () => {
    const tape = vi
      .fn<Deps["tape"]>()
      .mockResolvedValueOnce(
        tapeOutput({
          covered: [[SINCE, SINCE + 20]],
          more: true,
          previousPrice: 6000,
          trades: [[SINCE + 10, 6001, 1, null, null]],
          until: SINCE + 20,
        })
      )
      .mockResolvedValueOnce(
        tapeOutput({
          covered: [[SINCE + 21, NOW_S - 3]],
          // Signed alone, the second answer would compare its print with this price: a sell.
          previousPrice: 9999,
          since: SINCE + 21,
          trades: [[SINCE + 25, 6002, 4, null, null]],
        })
      );
    const deps = tapeDeps({ tape });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(tape.mock.calls.map(([, since]) => since)).toEqual([
      SINCE,
      SINCE + 21,
    ]);
    expect(storedMinutes(deps)).toEqual([
      expect.objectContaining({
        buyVolume: 5,
        coveredSeconds: 60,
        sellVolume: 0,
        trades: 2,
      }),
    ]);
    expect(run("ES", "ticks").message).toBe(
      "streamed tape ESZ6: 2 prints in 1 complete minutes, 60 of 60 s covered; 0 deep trades, 0 new; 2 prints signed by the tick rule, 0 without a side"
    );
  });

  it("counts the covered seconds of each minute from the covered pairs", async () => {
    const start = NOW_S - 240;
    const deps = tapeDeps(
      {
        tape: vi.fn(async () =>
          tapeOutput({
            contract: null,
            covered: [
              // 31 s of the first minute.
              [start + 10, start + 40],
              // 30 s of the second minute; the third minute twice (never more than 60 s).
              [start + 90, NOW_S - 61],
              [start + 120, NOW_S - 3],
            ],
            minTick: null,
            previousPrice: null,
            since: start,
            trades: [
              [start + 20, 6000, 1, null, null],
              [start + 100, 6000, 1, 6000, 6000.25],
              [start + 130, 6000.25, 1, 6000, 6000.25],
              [NOW_S - 20, 6000.25, 1, 6000, 6000.25],
            ],
          })
        ),
      },
      180
    );
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(
      storedMinutes(deps).map((row) => [row.minute, row.coveredSeconds])
    ).toEqual([
      [minuteOf(start), 31],
      [minuteOf(start + 60), 30],
      [minuteOf(start + 120), 60],
    ]);
    // Without a contract the message names the symbol; the first print has no side.
    expect(run("ES", "ticks").message).toBe(
      "streamed tape ES: 3 prints in 3 complete minutes, 121 of 180 s covered; 0 deep trades, 0 new; 0 prints signed by the tick rule, 1 without a side"
    );
  });

  it("is ok with covered seconds and no print", async () => {
    const deps = tapeDeps({
      tape: vi.fn(async () => tapeOutput({ trades: [] })),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(run("ES", "ticks")).toMatchObject({
      items: 0,
      message:
        "streamed tape ESZ6: 0 prints in 0 complete minutes, 60 of 60 s covered; 0 deep trades, 0 new; 0 prints signed by the tick rule, 0 without a side",
      status: "ok",
    });
  });

  it("is empty when a live feed has no print and no covered second", async () => {
    const deps = tapeDeps({
      tape: vi.fn(async () => tapeOutput({ covered: [], trades: [] })),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(run("ES", "ticks")).toMatchObject({
      events: 0,
      items: 0,
      message:
        "streamed tape ESZ6: no print and no covered second in the complete minutes",
      status: "empty",
    });
    expect(recorded(deps)).toContain("ES:ticks:empty");
    expect(deps.repository.upsertMinutes).not.toHaveBeenCalled();
  });

  it.each([
    ["down", "connection closed", "tape stream down: connection closed"],
    ["off", "switched off", "tape stream off: switched off"],
    ["down", null, "tape stream down: no tick"],
  ] as const)(
    "records a feed that is %s (%s) as unavailable",
    async (state, error, message) => {
      const deps = tapeDeps({
        tape: vi.fn(async () =>
          tapeOutput({ covered: [], stream: { error, state }, trades: [] })
        ),
      });
      const { run } = await collect(deps, { symbols: ["ES"] });
      expect(run("ES", "ticks")).toMatchObject({
        events: 0,
        items: 0,
        message,
        status: "unavailable",
      });
      expect(recorded(deps)).toContain("ES:ticks:unavailable");
      expect(deps.repository.insertTickSample).not.toHaveBeenCalled();
    }
  );

  it("stores the prints that a feed delivered before it went down", async () => {
    const deps = tapeDeps({
      tape: vi.fn(async () =>
        tapeOutput({
          covered: [[SINCE, SINCE + 30]],
          stream: { error: "connection closed", state: "down" },
        })
      ),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(run("ES", "ticks").status).toBe("ok");
    expect(storedMinutes(deps)).toEqual([
      expect.objectContaining({ coveredSeconds: 31, trades: 2 }),
    ]);
  });

  it("records a failed request as unavailable and stores nothing", async () => {
    const first = tapeDeps({
      tape: vi.fn(async () => {
        throw new Error("History service timeout");
      }),
    });
    expect(
      (await collect(first, { symbols: ["ES"] })).run("ES", "ticks")
    ).toMatchObject({
      message: "History service timeout",
      status: "unavailable",
    });
    const later = tapeDeps({
      tape: vi
        .fn<Deps["tape"]>()
        .mockResolvedValueOnce(tapeOutput({ more: true, until: SINCE + 20 }))
        .mockRejectedValueOnce(new Error("History service returned 503")),
    });
    expect(
      (await collect(later, { symbols: ["ES"] })).run("ES", "ticks")
    ).toMatchObject({
      message: "History service returned 503",
      status: "unavailable",
    });
    for (const deps of [first, later]) {
      expect(deps.repository.upsertMinutes).not.toHaveBeenCalled();
      expect(deps.repository.insertTickSample).not.toHaveBeenCalled();
    }
  });

  it("counts a read that still has more after the answer bound as a failed request", async () => {
    let until = SINCE;
    const tape = vi.fn<Deps["tape"]>(async () => {
      until += 1;
      return tapeOutput({ more: true, until });
    });
    const deps = tapeDeps({ tape });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(tape).toHaveBeenCalledTimes(FLOW_TAPE_MAX_ANSWERS);
    expect(FLOW_TAPE_MAX_ANSWERS).toBe(12);
    expect(run("ES", "ticks")).toMatchObject({
      message: "tape read not complete after 12 answers",
      status: "unavailable",
    });
    expect(deps.repository.upsertMinutes).not.toHaveBeenCalled();
  });

  it("accepts a read that is complete with the last allowed answer", async () => {
    let answers = 0;
    const tape = vi.fn<Deps["tape"]>(async () => {
      answers += 1;
      return tapeOutput({ more: answers < FLOW_TAPE_MAX_ANSWERS });
    });
    const deps = tapeDeps({ tape });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(tape).toHaveBeenCalledTimes(FLOW_TAPE_MAX_ANSWERS);
    expect(run("ES", "ticks").status).toBe("ok");
  });

  it("reads no IBKR pacing and takes no part in the IBKR budget", async () => {
    const deps = tapeDeps({
      pacing: vi.fn(async () => ({ backoffSeconds: 30, recentRequests: 6 })),
    });
    const { output, run } = await collect(deps, { symbols: ["ES", "NQ"] });
    expect(run("ES", "ticks").status).toBe("ok");
    expect(run("NQ", "ticks").status).toBe("ok");
    expect(deps.tape).toHaveBeenCalledTimes(2);
    expect(deps.tape).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "NQ" }),
      SINCE
    );
    expect(deps.pacing).not.toHaveBeenCalled();
    expect(deps.ticks).not.toHaveBeenCalled();
    expect(output.budget.ibkrRecent).toBeNull();
  });

  it("is due every 50 s, not at the due time of the sampled ticks", async () => {
    expect(FLOW_TAPE_DUE_SECONDS).toBe(50);
    const early = depsWith({
      repository: fakeRepository([
        sample("ES", "ticks", FLOW_TAPE_DUE_SECONDS - 10),
      ]),
    });
    expect(
      (await collect(early, { symbols: ["ES"] })).run("ES", "ticks")
    ).toMatchObject({
      message: "not due (last attempt 40 s ago)",
      status: "skipped",
    });
    expect(early.tape).not.toHaveBeenCalled();
    const due = depsWith({
      repository: fakeRepository([
        sample("ES", "ticks", FLOW_TAPE_DUE_SECONDS + 5),
      ]),
    });
    expect(FLOW_TAPE_DUE_SECONDS + 5).toBeLessThan(FLOW_DUE_SECONDS.ticks);
    await collect(due, { symbols: ["ES"] });
    expect(due.tape).toHaveBeenCalledTimes(1);
    // A sampled symbol with an attempt of the same age is not due.
    const spy = depsWith({
      repository: fakeRepository([
        sample("SPY", "ticks", FLOW_TAPE_DUE_SECONDS + 5),
      ]),
    });
    expect(
      (await collect(spy, { symbols: ["SPY"] })).run("SPY", "ticks").message
    ).toBe("not due (last attempt 55 s ago)");
  });

  it("does not hold a sampled symbol back: the SPY stagger ignores tape samples", async () => {
    const deps = depsWith({
      repository: fakeRepository([
        sample("ES", "ticks", 10),
        sample("NQ", "ticks", 20),
      ]),
    });
    const { run } = await collect(deps);
    expect(run("SPY", "ticks").status).toBe("ok");
    expect(deps.ticks).toHaveBeenCalledTimes(1);
    expect(deps.ticks).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "SPY" })
    );
    expect(run("ES", "ticks").message).toBe("not due (last attempt 10 s ago)");
  });

  it("stores streamed deep trades of the whole range and the events in one write", async () => {
    const deps = tapeDeps({
      repository: {
        ...fakeRepository([], undefined, undefined, [
          sample("ES", "ticks", 60),
        ]),
        insertTickSample: vi.fn<FlowRepository["insertTickSample"]>(
          async ({ events }) => ({ events: events.length, trades: 1 })
        ),
      },
      tape: vi.fn(async () =>
        tapeOutput({
          trades: [
            // The first and the last second of the range are whole seconds: nothing is cut.
            [SINCE, 6000.25, 45, 6000, 6000.25],
            [SINCE, 6000, 50, 6000, 6000.25],
            [SINCE + 30, 6000.25, 39, 6000, 6000.25],
            [END - 1, 6000.25, 40, 6000, 6000.25],
            [END, 6000.25, 60, 6000, 6000.25],
          ],
        })
      ),
    });
    const { run } = await collect(deps, { symbols: ["ES"] });
    expect(deps.repository.insertTickSample).toHaveBeenCalledTimes(1);
    const input = tickSample(deps);
    expect(
      input.trades.map((row) => [row.second, row.seq, row.side, row.size])
    ).toEqual([
      [minuteOf(SINCE), 0, "buy", 45],
      [minuteOf(SINCE), 1, "sell", 50],
      [minuteOf(END - 1), 0, "buy", 40],
    ]);
    for (const row of input.trades)
      expect(row).toMatchObject({
        capture: "streamed",
        limitSize: 40,
        sampledAt: OPEN,
        signing: "quote",
        symbol: "ES",
      });
    expect(input.events.map((event) => event.kind)).toContain("large_print");
    // insertEvents only takes the options events of ES; the tape events went with the trades.
    for (const [rows] of deps.repository.insertEvents.mock.calls)
      expect(
        (rows as readonly { kind: string }[]).map((row) => row.kind)
      ).not.toContain("large_print");
    expect(run("ES", "ticks")).toMatchObject({
      events: input.events.length,
      items: 1,
      message:
        "streamed tape ESZ6: 4 prints in 1 complete minutes, 60 of 60 s covered; 3 deep trades, 1 new; 0 prints signed by the tick rule, 0 without a side",
      status: "ok",
    });
  });

  it("stores nothing on a dry run and reports the counts", async () => {
    const deps = tapeDeps({
      tape: vi.fn(async () =>
        tapeOutput({ trades: [[SINCE + 5, 6000.25, 50, 6000, 6000.25]] })
      ),
    });
    const { run } = await collect(deps, { dryRun: true, symbols: ["ES"] });
    expect(deps.repository.upsertMinutes).not.toHaveBeenCalled();
    expect(deps.repository.insertTickSample).not.toHaveBeenCalled();
    expect(deps.repository.recordSample).not.toHaveBeenCalled();
    const result = run("ES", "ticks");
    expect(result).toMatchObject({
      items: 1,
      message:
        "streamed tape ESZ6: 1 prints in 1 complete minutes, 60 of 60 s covered; 1 deep trades, 1 new; 0 prints signed by the tick rule, 0 without a side",
      status: "ok",
    });
    expect(result.events).toBeGreaterThan(0);
  });

  it("reads the tape on a seed run in a closed market", async () => {
    const saturday = new Date("2026-11-07T15:00:00.000Z");
    const deps = depsWith({
      now: saturday,
      repository: fakeRepository([sample("ES", "ticks", 10, saturday)]),
    });
    await collect(deps, { seed: true, symbols: ["ES"] });
    expect(deps.tape).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "ES" }),
      saturday.getTime() / 1000 - 2 * FLOW_TAPE_REREAD_SECONDS
    );
  });

  describe("look-back limit", () => {
    const SKIPPED = "; older minutes skipped (look-back limit 10 min)";

    it("starts at most 600 s before the present minute after a long outage and says so", async () => {
      expect(FLOW_TAPE_LOOKBACK_SECONDS).toBe(600);
      const deps = tapeDeps({}, 3 * 3600);
      const { run } = await collect(deps, { symbols: ["ES"] });
      expect(deps.tape).toHaveBeenCalledTimes(1);
      expect(deps.tape).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: "ES" }),
        NOW_S - 600
      );
      expect(run("ES", "ticks")).toMatchObject({
        items: 1,
        message: `streamed tape ESZ6: 2 prints in 1 complete minutes, 60 of 540 s covered; 0 deep trades, 0 new; 0 prints signed by the tick rule, 0 without a side${SKIPPED}`,
        status: "ok",
      });
    });

    it("keeps the cursor of a last ok sample inside the limit, without the note", async () => {
      // 2 minutes ago: one minute before the minute of the sample.
      const recent = tapeDeps({}, 120);
      const first = await collect(recent, { symbols: ["ES"] });
      expect(recent.tape).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: "ES" }),
        NOW_S - 180
      );
      expect(first.run("ES", "ticks").message).toBe(
        "streamed tape ESZ6: 2 prints in 1 complete minutes, 60 of 120 s covered; 0 deep trades, 0 new; 0 prints signed by the tick rule, 0 without a side"
      );
      // 9 minutes ago: the wanted start equals the limit, so no minute is skipped.
      const atLimit = tapeDeps({}, 540);
      const second = await collect(atLimit, { symbols: ["ES"] });
      expect(atLimit.tape).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: "ES" }),
        NOW_S - 600
      );
      expect(second.run("ES", "ticks").message).not.toContain("skipped");
      // One minute more: the limit cuts the read.
      const cut = tapeDeps({}, 600);
      const third = await collect(cut, { symbols: ["ES"] });
      expect(cut.tape).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: "ES" }),
        NOW_S - 600
      );
      expect(third.run("ES", "ticks").message).toMatch(/10 min\)$/);
    });

    it("adds the note to the empty and the stream messages, inside 300 characters", async () => {
      const empty = tapeDeps(
        { tape: vi.fn(async () => tapeOutput({ covered: [], trades: [] })) },
        3 * 3600
      );
      expect(
        (await collect(empty, { symbols: ["ES"] })).run("ES", "ticks")
      ).toMatchObject({
        message: `streamed tape ESZ6: no print and no covered second in the complete minutes${SKIPPED}`,
        status: "empty",
      });
      const down = tapeDeps(
        {
          tape: vi.fn(async () =>
            tapeOutput({
              covered: [],
              stream: { error: "x".repeat(400), state: "down" },
              trades: [],
            })
          ),
        },
        3 * 3600
      );
      const { message, status } = (
        await collect(down, { symbols: ["ES"] })
      ).run("ES", "ticks");
      expect(status).toBe("unavailable");
      expect(message).toHaveLength(300);
      expect(message).toMatch(
        /^tape stream down: x+; older minutes skipped \(look-back limit 10 min\)$/
      );
      expect(recorded(down)).toContain("ES:ticks:unavailable");
    });
  });

  describe("a stream that stopped", () => {
    // M is the minute before OPEN. The stream dies at second 20 of M.
    const M = NOW_S - 60;
    const died = { error: "connection closed", state: "down" } as const;
    const LATER = new Date(OPEN.getTime() + 60_000);
    /** The run one minute after OPEN: it reads M again and the minute after M, which holds nothing. */
    const laterDeps = (
      stream: MarketTape["stream"],
      overrides: Partial<Deps> = {}
    ) =>
      depsWith({
        now: LATER,
        repository: fakeRepository([], undefined, undefined, [
          sample("ES", "ticks", 60, LATER),
        ]),
        tape: vi.fn(async () =>
          tapeOutput({
            covered: [[M, M + 20]],
            since: M,
            stream,
            // The print at second 15 reached the ring after the first read of M.
            trades: [
              [M + 10, 6000.25, 2, 6000, 6000.25],
              [M + 15, 6000.25, 45, 6000, 6000.25],
            ],
            until: NOW_S + 62,
          })
        ),
        ...overrides,
      });

    it("is ok in the run after the minute in which it died", async () => {
      const deps = tapeDeps({
        tape: vi.fn(async () =>
          tapeOutput({
            covered: [[M - 60, M + 20]],
            stream: died,
            trades: [
              [M - 50, 6000, 3, 6000, 6000.25],
              [M + 10, 6000.25, 2, 6000, 6000.25],
            ],
            until: NOW_S + 2,
          })
        ),
      });
      const { run } = await collect(deps, { symbols: ["ES"] });
      expect(run("ES", "ticks")).toMatchObject({ items: 2, status: "ok" });
      expect(
        storedMinutes(deps).map((row) => [row.minute, row.coveredSeconds])
      ).toEqual([
        [minuteOf(M - 60), 60],
        [minuteOf(M), 21],
      ]);
    });

    it("is unavailable in the next run and still stores the minute that was read again", async () => {
      const deps = laterDeps(died);
      const { run } = await collect(deps, { symbols: ["ES"] });
      expect(deps.tape).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: "ES" }),
        M
      );
      expect(run("ES", "ticks")).toMatchObject({
        items: 1,
        message: "tape stream down: connection closed",
        status: "unavailable",
      });
      expect(recorded(deps)).toContain("ES:ticks:unavailable");
      expect(storedMinutes(deps)).toEqual([
        expect.objectContaining({
          coveredSeconds: 21,
          minute: minuteOf(M),
          trades: 2,
          volume: 47,
        }),
      ]);
      const input = tickSample(deps);
      expect(input.trades).toEqual([
        expect.objectContaining({ capture: "streamed", size: 45 }),
      ]);
      expect(run("ES", "ticks").events).toBe(input.events.length);
    });

    it("only counts the minute that was read again on a dry run", async () => {
      const deps = laterDeps({ error: null, state: "off" });
      const { run } = await collect(deps, { dryRun: true, symbols: ["ES"] });
      expect(run("ES", "ticks")).toMatchObject({
        items: 1,
        message: "tape stream off: no tick",
        status: "unavailable",
      });
      expect(deps.repository.upsertMinutes).not.toHaveBeenCalled();
      expect(deps.repository.insertTickSample).not.toHaveBeenCalled();
    });

    it("is empty for a feed that says live but gave nothing in the newest complete minute, and stores the minute that was read again", async () => {
      const deps = laterDeps({ error: null, state: "live" });
      const { run } = await collect(deps, { symbols: ["ES"] });
      expect(run("ES", "ticks")).toMatchObject({
        items: 1,
        message:
          "streamed tape ESZ6: no print and no covered second in the newest complete minute",
        status: "empty",
      });
      expect(recorded(deps)).toContain("ES:ticks:empty");
      expect(storedMinutes(deps)).toEqual([
        expect.objectContaining({
          coveredSeconds: 21,
          minute: minuteOf(M),
          trades: 2,
        }),
      ]);
      const input = tickSample(deps);
      expect(input.trades).toEqual([
        expect.objectContaining({ capture: "streamed", size: 45 }),
      ]);
      expect(run("ES", "ticks").events).toBe(input.events.length);
      // A dry run only counts the minute that was read again.
      const dry = laterDeps({ error: null, state: "live" });
      expect(
        (await collect(dry, { dryRun: true, symbols: ["ES"] })).run(
          "ES",
          "ticks"
        )
      ).toMatchObject({ items: 1, status: "empty" });
      expect(dry.repository.upsertMinutes).not.toHaveBeenCalled();
      expect(dry.repository.insertTickSample).not.toHaveBeenCalled();
    });

    it("stays ok for a live feed whose newest complete minute is covered and has no print", async () => {
      const live = { error: null, state: "live" } as const;
      const deps = laterDeps(live, {
        tape: vi.fn(async () =>
          tapeOutput({
            covered: [[M, NOW_S + 59]],
            since: M,
            stream: live,
            trades: [[M + 10, 6000.25, 2, 6000, 6000.25]],
            until: NOW_S + 62,
          })
        ),
      });
      const { run } = await collect(deps, { symbols: ["ES"] });
      expect(run("ES", "ticks")).toMatchObject({
        items: 1,
        message:
          "streamed tape ESZ6: 1 prints in 1 complete minutes, 120 of 120 s covered; 0 deep trades, 0 new; 0 prints signed by the tick rule, 0 without a side",
        status: "ok",
      });
    });

    it("stays ok when the newest minute holds a print without a covered second", async () => {
      const deps = laterDeps(died, {
        tape: vi.fn(async () =>
          tapeOutput({
            covered: [[M, M + 20]],
            since: M,
            stream: died,
            // The first print after a new subscription: its second is not covered.
            trades: [[NOW_S + 30, 6000.25, 2, 6000, 6000.25]],
            until: NOW_S + 62,
          })
        ),
      });
      const { run } = await collect(deps, { symbols: ["ES"] });
      expect(run("ES", "ticks").status).toBe("ok");
      expect(storedMinutes(deps)).toEqual([
        expect.objectContaining({ coveredSeconds: 0, minute: minuteOf(NOW_S) }),
      ]);
    });
  });

  describe("the price of the run", () => {
    // The newest complete minute closes at 6010; the book mid of this run is 6000; SPX is 5990.
    const tape = vi.fn(async () =>
      tapeOutput({ trades: [[SINCE + 5, 6010, 1, 6009.75, 6010]] })
    );
    const basisOf = (deps: Deps) => {
      const rows = deps.repository.insertGex.mock.calls.flatMap(
        ([stored]) => stored as readonly { basis: number }[]
      );
      return rows.map((row) => row.basis);
    };

    it("keeps the book mid that depth set in the same run", async () => {
      const deps = tapeDeps({ tape });
      const { run } = await collect(deps, { symbols: ["ES"] });
      expect(run("ES", "depth").status).toBe("ok");
      expect(run("ES", "ticks").status).toBe("ok");
      expect(basisOf(deps)).toEqual([10]);
    });

    it("gives the close of the newest complete minute when the run has no price yet", async () => {
      const deps = tapeDeps({
        depth: vi.fn(async () => {
          throw new Error("no depth");
        }),
        tape,
      });
      const { run } = await collect(deps, { symbols: ["ES"] });
      expect(run("ES", "depth").status).toBe("unavailable");
      expect(basisOf(deps)).toEqual([20]);
    });

    it("gives no price from a minute before the newest complete minute", async () => {
      // The answer ends in the present minute: the range holds two complete minutes, and only
      // the first one has a print (a feed that stopped keeps old prints in its ring).
      const deps = tapeDeps({
        depth: vi.fn(async () => {
          throw new Error("no depth");
        }),
        tape: vi.fn(async () =>
          tapeOutput({
            trades: [[SINCE + 5, 6010, 1, 6009.75, 6010]],
            until: NOW_S + 2,
          })
        ),
      });
      const { run } = await collect(deps, { symbols: ["ES"] });
      expect(run("ES", "ticks")).toMatchObject({ items: 1, status: "ok" });
      expect(storedMinutes(deps)).toEqual([
        expect.objectContaining({ minute: minuteOf(SINCE) }),
      ]);
      expect(run("ES", "gex").message).toBe(
        "positive gamma; basis not computed: no ES price in this run"
      );
    });
  });

  describe("tape speed counts (flow_tape_seconds)", () => {
    const NOTE = "; per-second counts not stored (PostgresError 42501)";
    const storedSeconds = (deps: Deps) =>
      deps.repository.upsertTapeSeconds.mock.calls.flatMap(([rows]) => rows);
    const noGrant = () =>
      Object.assign(
        new Error("permission denied for table flow_tape_seconds"),
        { code: "42501", name: "PostgresError" }
      );
    const zeros = () => new Array<number>(60).fill(0);

    it("stores one row per complete minute with the prints and the contracts of each second", async () => {
      const deps = tapeDeps();
      await collect(deps, { symbols: ["ES"] });
      expect(deps.repository.upsertTapeSeconds).toHaveBeenCalledTimes(1);
      const trades = zeros();
      trades[10] = 1;
      trades[30] = 1;
      const contracts = zeros();
      contracts[10] = 2;
      contracts[30] = 3;
      expect(storedSeconds(deps)).toEqual([
        {
          contract: "ESZ6",
          contracts,
          covered: "1".repeat(60),
          minute: minuteOf(SINCE),
          symbol: "ES",
          totalTrades: 2,
          trades,
        },
      ]);
    });

    it("stores a covered minute without a print, which has no minute row", async () => {
      // The sample is 65 s old, so the read starts one minute earlier; that minute is covered and
      // holds no print.
      const deps = tapeDeps(
        {
          tape: vi.fn(async () =>
            tapeOutput({
              covered: [[SINCE - 60, NOW_S - 3]],
              since: SINCE - 60,
            })
          ),
        },
        65
      );
      await collect(deps, { symbols: ["ES"] });
      expect(storedMinutes(deps).map((row) => row.minute)).toEqual([
        minuteOf(SINCE),
      ]);
      expect(
        storedSeconds(deps).map((row) => [row.minute, row.totalTrades])
      ).toEqual([
        [minuteOf(SINCE - 60), 0],
        [minuteOf(SINCE), 2],
      ]);
      expect(storedSeconds(deps)[0]?.covered).toBe("1".repeat(60));
    });

    it("keeps the mask and the total of a minute equal to its minute row", async () => {
      const deps = tapeDeps({
        tape: vi.fn(async () =>
          tapeOutput({
            covered: [
              [SINCE + 5, SINCE + 24],
              [SINCE + 40, NOW_S - 3],
            ],
          })
        ),
      });
      await collect(deps, { symbols: ["ES"] });
      const [minute] = deps.repository.upsertMinutes.mock.calls.flatMap(
        ([rows]) =>
          rows as readonly { coveredSeconds: number; trades: number }[]
      );
      const [seconds] = storedSeconds(deps);
      expect(minute?.coveredSeconds).toBe(40);
      expect(seconds?.covered.replaceAll("0", "")).toHaveLength(40);
      expect(seconds?.covered).toBe(
        "0".repeat(5) + "1".repeat(20) + "0".repeat(15) + "1".repeat(20)
      );
      expect(seconds?.totalTrades).toBe(minute?.trades);
    });

    it("stores no per-second row on a dry run", async () => {
      const deps = tapeDeps();
      const { run } = await collect(deps, { dryRun: true, symbols: ["ES"] });
      expect(run("ES", "ticks")).toMatchObject({ items: 1, status: "ok" });
      expect(deps.repository.upsertTapeSeconds).not.toHaveBeenCalled();
    });

    it("runs no per-second write for a read without a complete minute", async () => {
      const deps = tapeDeps({
        tape: vi.fn(async () => tapeOutput({ covered: [], trades: [] })),
      });
      const { run } = await collect(deps, { symbols: ["ES"] });
      expect(run("ES", "ticks").status).toBe("empty");
      expect(deps.repository.upsertTapeSeconds).not.toHaveBeenCalled();
    });

    it("a failed per-second write changes only the message: status, items, events and the other writes stay", async () => {
      const good = tapeDeps();
      const baseline = (await collect(good, { symbols: ["ES"] })).run(
        "ES",
        "ticks"
      );
      const faulty = tapeDeps();
      faulty.repository.upsertTapeSeconds.mockRejectedValue(noGrant());
      const { run } = await collect(faulty, { symbols: ["ES"] });
      expect(baseline.status).toBe("ok");
      expect(run("ES", "ticks")).toEqual({
        ...baseline,
        message: `${baseline.message}${NOTE}`,
      });
      expect(faulty.repository.upsertMinutes.mock.calls).toEqual(
        good.repository.upsertMinutes.mock.calls
      );
      expect(faulty.repository.insertTickSample.mock.calls).toEqual(
        good.repository.insertTickSample.mock.calls
      );
      expect(recorded(faulty)).toContain("ES:ticks:ok");
      // The sources after the tape still run.
      expect(run("ES", "depth").status).toBe("ok");
    });

    it("puts the note before the skip note and keeps the message inside 300 characters", async () => {
      // A feed that is down, with a print in an earlier minute and nothing in the newest complete
      // minute; the last ok sample is 3 h old, so the look-back limit cuts the read.
      const deps = tapeDeps(
        {
          tape: vi.fn(async () =>
            tapeOutput({
              covered: [[NOW_S - 600, NOW_S - 580]],
              since: NOW_S - 600,
              stream: { error: "x".repeat(400), state: "down" },
              trades: [[NOW_S - 590, 6000, 1, 6000, 6000.25]],
            })
          ),
        },
        3 * 3600
      );
      deps.repository.upsertTapeSeconds.mockRejectedValue(noGrant());
      const { message, status, items } = (
        await collect(deps, { symbols: ["ES"] })
      ).run("ES", "ticks");
      expect(status).toBe("unavailable");
      expect(items).toBe(1);
      expect(message).toHaveLength(300);
      expect(message).toMatch(
        /^tape stream down: x+; per-second counts not stored \(PostgresError 42501\); older minutes skipped \(look-back limit 10 min\)$/
      );
    });

    it("carries the note in the empty message of a live feed that gave nothing in the newest complete minute", async () => {
      const deps = tapeDeps(
        {
          tape: vi.fn(async () =>
            tapeOutput({
              covered: [[SINCE - 60, SINCE - 41]],
              since: SINCE - 60,
              trades: [[SINCE - 50, 6000, 1, 6000, 6000.25]],
            })
          ),
        },
        65
      );
      deps.repository.upsertTapeSeconds.mockRejectedValue(noGrant());
      const { run } = await collect(deps, { symbols: ["ES"] });
      expect(run("ES", "ticks")).toMatchObject({
        items: 1,
        message: `streamed tape ESZ6: no print and no covered second in the newest complete minute${NOTE}`,
        status: "empty",
      });
      expect(deps.repository.upsertMinutes).toHaveBeenCalledTimes(1);
    });
  });
});

describe("runFlowCollect dual-mode L2 book snapshots", () => {
  it("stores streamed snapshots from depthHistory without calling one-shot depth, and isolates snapshot write failures", async () => {
    const depthHistory = vi.fn(async () => ({
      contract: {
        conId: 42,
        currency: "USD",
        exchange: "CME",
        lastTradeDateOrContractMonth: "20261218",
        localSymbol: "ESZ6",
        longName: "E-mini S&P 500",
        matches: 1,
        multiplier: "50",
        secType: "CONTFUT",
        timeZoneId: "America/Chicago",
      },
      fetchedAt: OPEN.toISOString(),
      minTick: 0.25,
      receivedAt: OPEN.toISOString(),
      rows: 10,
      sampleSeconds: 5,
      since: Math.floor(OPEN.getTime() / 1000) - 120,
      snapshots: [
        {
          asks: [[6000.25, 30]] as [number, number][],
          bestAsk: 6000.25,
          bestBid: 6000,
          bids: [[6000, 25]] as [number, number][],
          t: Math.floor(OPEN.getTime() / 1000) - 5,
        },
        {
          asks: [[0, 0]] as [number, number][],
          bestAsk: null,
          bestBid: null,
          bids: [] as [number, number][],
          t: Math.floor(OPEN.getTime() / 1000),
        },
      ],
      source: "ibkr-gateway" as const,
      stream: { error: null, state: "live" as const },
      symbol: "ES" as const,
    }));
    const deps = depsWith({ depthHistory });
    const { output } = await collect(deps, { symbols: ["ES"] });
    const depthRun = output.runs.find((r) => r.source === "depth");
    expect(depthRun?.status).toBe("ok");
    expect(depthRun?.message).toContain("streamed depth ESZ6: 1 snapshots");
    expect(deps.depth).not.toHaveBeenCalled();
    expect(deps.repository.upsertBookSnapshots).toHaveBeenCalledTimes(1);

    // Snapshot write failure does not break flow_book insert or ok status
    const faulty = depsWith({ depthHistory });
    faulty.repository.upsertBookSnapshots.mockRejectedValue(
      new Error("permission denied")
    );
    const { output: out2 } = await collect(faulty, { symbols: ["ES"] });
    const depthRun2 = out2.runs.find((r) => r.source === "depth");
    expect(depthRun2?.status).toBe("ok");
    expect(depthRun2?.message).toContain("book snapshots not stored");
  });

  it("skips one-shot depth fallback when depthHistory reports halted (error 309 cap)", async () => {
    const deps = depsWith({
      depthHistory: vi.fn(async () => ({
        contract: null,
        fetchedAt: OPEN.toISOString(),
        minTick: null,
        receivedAt: OPEN.toISOString(),
        rows: 10,
        sampleSeconds: 5,
        since: 0,
        snapshots: [],
        source: "ibkr-gateway" as const,
        stream: {
          error: "depth subscription cap reached",
          state: "halted" as const,
        },
        symbol: "ES" as const,
      })),
    });
    const { output } = await collect(deps, { symbols: ["ES"] });
    const depthRun = output.runs.find((r) => r.source === "depth");
    expect(depthRun?.status).toBe("unavailable");
    expect(depthRun?.message).toContain("depth stream halted");
    expect(deps.depth).not.toHaveBeenCalled();
  });

  it("does not fall back to one-shot depth when depthHistory is starting or live with no valid snapshots", async () => {
    const baseHistory = {
      contract: null,
      fetchedAt: OPEN.toISOString(),
      minTick: null,
      receivedAt: OPEN.toISOString(),
      rows: 10,
      sampleSeconds: 5,
      since: 0,
      snapshots: [] as {
        asks: [number, number][];
        bestAsk: number | null;
        bestBid: number | null;
        bids: [number, number][];
        t: number;
      }[],
      source: "ibkr-gateway" as const,
      symbol: "ES" as const,
    };
    const depsStarting = depsWith({
      depthHistory: vi.fn(async () => ({
        ...baseHistory,
        stream: { error: null, state: "starting" as const },
      })),
    });
    const resStarting = await collect(depsStarting, { symbols: ["ES"] });
    const runStarting = resStarting.output.runs.find(
      (r) => r.source === "depth"
    );
    expect(runStarting?.status).toBe("empty");
    expect(runStarting?.message).toContain("waiting for settled book");
    expect(depsStarting.depth).not.toHaveBeenCalled();

    const depsLiveEmpty = depsWith({
      depthHistory: vi.fn(async () => ({
        ...baseHistory,
        stream: { error: null, state: "live" as const },
      })),
    });
    const resLiveEmpty = await collect(depsLiveEmpty, { symbols: ["ES"] });
    const runLiveEmpty = resLiveEmpty.output.runs.find(
      (r) => r.source === "depth"
    );
    expect(runLiveEmpty?.status).toBe("empty");
    expect(runLiveEmpty?.message).toContain("no new snapshot");
    expect(depsLiveEmpty.depth).not.toHaveBeenCalled();

    const depsLiveInvalid = depsWith({
      depthHistory: vi.fn(async () => ({
        ...baseHistory,
        snapshots: [
          {
            asks: [],
            bestAsk: null,
            bestBid: null,
            bids: [[0, 0] as [number, number]],
            t: Math.floor(OPEN.getTime() / 1000) - 5,
          },
        ],
        stream: { error: null, state: "live" as const },
      })),
    });
    const resLiveInvalid = await collect(depsLiveInvalid, { symbols: ["ES"] });
    const runLiveInvalid = resLiveInvalid.output.runs.find(
      (r) => r.source === "depth"
    );
    expect(runLiveInvalid?.status).toBe("empty");
    expect(runLiveInvalid?.message).toContain("no valid positive depth levels");
    expect(depsLiveInvalid.depth).not.toHaveBeenCalled();
  });

  it("falls back to one-shot depth and stores a sampled snapshot when depthHistory fails or is off", async () => {
    const deps = depsWith({
      depthHistory: vi.fn(async () => {
        throw new Error("404 not found");
      }),
    });
    const { output } = await collect(deps, { symbols: ["ES"] });
    const depthRun = output.runs.find((r) => r.source === "depth");
    expect(depthRun?.status).toBe("ok");
    expect(deps.depth).toHaveBeenCalledTimes(1);
    expect(deps.repository.upsertBookSnapshots).toHaveBeenCalledTimes(1);
    const stored = deps.repository.upsertBookSnapshots.mock.calls[0]?.[0]?.[0];
    expect(stored?.capture).toBe("sampled");
    expect(stored?.symbol).toBe("ES");

    // Non-live depthHistory with snapshots empty also falls back to sampled depth
    const depsOff = depsWith({
      depthHistory: vi.fn(async () => ({
        contract: null,
        fetchedAt: OPEN.toISOString(),
        minTick: null,
        receivedAt: OPEN.toISOString(),
        rows: 10,
        sampleSeconds: 5,
        since: 0,
        snapshots: [],
        source: "ibkr-gateway" as const,
        stream: { error: "switched off", state: "off" as const },
        symbol: "ES" as const,
      })),
    });
    const { output: outOff } = await collect(depsOff, { symbols: ["ES"] });
    expect(outOff.runs.find((r) => r.source === "depth")?.status).toBe("ok");
    expect(depsOff.depth).toHaveBeenCalledTimes(1);
  });

  it("covers streamed depth edge cases: cursor from lastOk, null error on halt, null minTick, empty sanitized rows, one-sided book, storage error variants, and sampled edge cases", async () => {
    // 1. Halted with null error uses fallback text
    const depsHaltedNull = depsWith({
      depthHistory: vi.fn(async () => ({
        contract: null,
        fetchedAt: OPEN.toISOString(),
        minTick: null,
        receivedAt: OPEN.toISOString(),
        rows: 10,
        sampleSeconds: 5,
        since: 0,
        snapshots: [],
        source: "ibkr-gateway" as const,
        stream: { error: null, state: "halted" as const },
        symbol: "ES" as const,
      })),
    });
    const haltedRes = await collect(depsHaltedNull, { symbols: ["ES"] });
    expect(
      haltedRes.output.runs.find((r) => r.source === "depth")?.message
    ).toContain("cap reached");

    // 2. Live with lastOk cursor, blank contract, null minTick, one-sided book (no ask), and plain Error from upsertBookSnapshots
    const prevOk = new Date(OPEN.getTime() - 90_000);
    const depsStreamEdge = depsWith({
      depthHistory: vi.fn(async () => ({
        contract: {
          conId: 42,
          currency: "USD",
          exchange: "CME",
          lastTradeDateOrContractMonth: "20261218",
          localSymbol: "   ",
          longName: "E-mini S&P 500",
          matches: 1,
          multiplier: "50",
          secType: "CONTFUT",
          timeZoneId: "America/Chicago",
        },
        fetchedAt: OPEN.toISOString(),
        minTick: null,
        receivedAt: OPEN.toISOString(),
        rows: 10,
        sampleSeconds: 5,
        since: Math.floor(prevOk.getTime() / 1000) - 60,
        snapshots: [
          // Invalid snapshot (all zeros) skipped
          {
            asks: [[0, 10] as [number, number]],
            bestAsk: null,
            bestBid: null,
            bids: [[6000, 0] as [number, number]],
            t: Math.floor(OPEN.getTime() / 1000) - 10,
          },
          // One-sided valid snapshot (bids only)
          {
            asks: [],
            bestAsk: null,
            bestBid: 6000,
            bids: [[6000, 20] as [number, number]],
            t: Math.floor(OPEN.getTime() / 1000) - 5,
          },
        ],
        source: "ibkr-gateway" as const,
        stream: { error: null, state: "live" as const },
        symbol: "ES" as const,
      })),
    });
    const prevSample = {
      at: prevOk,
      items: 5,
      message: "ok",
      source: "depth" as const,
      status: "ok" as const,
      symbol: "ES" as const,
    };
    depsStreamEdge.repository.latestSamples = vi.fn(async () => ({
      latest: [prevSample],
      latestOk: [prevSample],
    }));
    depsStreamEdge.repository.upsertBookSnapshots = vi.fn(async () => {
      throw new Error("boom");
    });
    const edgeRes = await collect(depsStreamEdge, { symbols: ["ES"] });
    const edgeDepthRun = edgeRes.output.runs.find((r) => r.source === "depth");
    expect(edgeDepthRun?.status).toBe("ok");
    expect(edgeDepthRun?.items).toBe(1);
    expect(edgeDepthRun?.message).toContain("streamed depth ES:");
    expect(edgeDepthRun?.message).toContain(
      "book snapshots not stored (Error)"
    );

    // 3. Down depthHistory falls back to sampled depth; non-Error throw on upsertBookSnapshots + null minTick + long contract
    const depsFallback = depsWith({
      depth: vi.fn(async () => ({
        ...depthOutput(),
        asks: [{ price: 6000.25, size: 10, venue: null }],
        bids: [],
        contract: {
          ...depthOutput().contract,
          localSymbol: "THIS_CONTRACT_NAME_IS_WAY_TOO_LONG",
        },
        minTick: null,
      })),
      depthHistory: vi.fn(async () => ({
        contract: null,
        fetchedAt: OPEN.toISOString(),
        minTick: null,
        receivedAt: OPEN.toISOString(),
        rows: 10,
        sampleSeconds: 5,
        since: 0,
        snapshots: [],
        source: "ibkr-gateway" as const,
        stream: { error: "gateway disconnected", state: "down" as const },
        symbol: "ES" as const,
      })),
    });
    depsFallback.repository.upsertBookSnapshots = vi.fn(async () => {
      throw "string-boom";
    });
    const fbRes = await collect(depsFallback, { symbols: ["ES"] });
    expect(
      fbRes.output.runs.find((r) => r.source === "depth")?.message
    ).toContain("book snapshots not stored (string)");

    // 4. Sampled depth with only zero-price level: buildBook has levels=1 (!empty) but sanitizeDepthSide yields empty -> skips upsertBookSnapshots
    const depsZeroLevel = depsWith({
      depth: vi.fn(async () => ({
        ...depthOutput(),
        asks: [],
        bids: [{ price: 0, size: 5, venue: null }],
        minTick: 0.25,
      })),
    });
    const zeroRes = await collect(depsZeroLevel, { symbols: ["ES"] });
    expect(zeroRes.output.runs.find((r) => r.source === "depth")?.status).toBe(
      "ok"
    );
    expect(depsZeroLevel.repository.upsertBookSnapshots).not.toHaveBeenCalled();
  });
});

describe("runFlowCollect option parity and option-only tickers (PR 4)", () => {
  it("runs SPY, SPX and IWM on even minutes and QQQ, NDX and NVDA on odd minutes with zero IBKR calls for IWM/NVDA", async () => {
    const evenDeps = depsWith({ now: OPEN });
    const evenOut = await collect(evenDeps, {
      symbols: ["SPY", "ES", "QQQ", "NQ", "IWM", "NVDA"],
    });
    expect(evenOut.run("SPY", "options").status).toBe("ok");
    expect(evenOut.run("ES", "options").status).toBe("empty");
    expect(evenOut.run("IWM", "options").status).toBe("empty");
    expect(evenOut.run("QQQ", "options")).toMatchObject({
      message: "staggered: QQQ options runs on odd minutes",
      status: "skipped",
    });
    expect(evenOut.run("NQ", "options")).toMatchObject({
      message: "staggered: NDX options runs on odd minutes",
      status: "skipped",
    });
    expect(evenOut.run("NVDA", "options")).toMatchObject({
      message: "staggered: NVDA options runs on odd minutes",
      status: "skipped",
    });

    const oddDeps = depsWith({ now: new Date(OPEN.getTime() + 60_000) });
    const oddOut = await collect(oddDeps, {
      symbols: ["IWM", "NVDA"],
    });
    expect(oddOut.output.runs.map((r) => `${r.symbol}:${r.source}`)).toEqual([
      "IWM:options",
      "NVDA:options",
    ]);
    expect(oddOut.run("IWM", "options")).toMatchObject({
      message: "staggered: IWM options runs on even minutes",
      status: "skipped",
    });
    expect(oddOut.run("NVDA", "options").status).toBe("ok");
    expect(oddDeps.ticks).not.toHaveBeenCalled();
    expect(oddDeps.tape).not.toHaveBeenCalled();
    expect(oddDeps.depth).not.toHaveBeenCalled();
    expect(oddDeps.analytics).not.toHaveBeenCalled();
  });

  it("bypasses parity on seed runs and closes NVDA at 16:00 ET while IWM stays open until 16:15 ET", async () => {
    // Monday 2026-11-09 16:05 ET = 21:05Z (odd minute: 21*60+5 = 1265, odd!)
    const et1605 = new Date("2026-11-09T21:05:00.000Z");
    const deps = depsWith({ now: et1605 });
    const { run } = await collect(deps, { symbols: ["NVDA"] });
    expect(run("NVDA", "options")).toMatchObject({
      message: "market closed",
      status: "skipped",
    });

    const seedDeps = depsWith({ now: OPEN });
    const seedOut = await collect(seedDeps, {
      seed: true,
      symbols: ["NVDA"],
    });
    expect(seedOut.run("NVDA", "options").status).toBe("ok");

    // Recent attempt within FLOW_DUE_SECONDS.options (50 s) skips even on matching parity minute
    const recentDeps = depsWith({ now: OPEN });
    recentDeps.repository.latestSamples.mockResolvedValue({
      latest: [
        {
          at: new Date(OPEN.getTime() - 20_000),
          items: 1,
          message: "ok",
          source: "options",
          status: "ok",
          symbol: "IWM",
        },
      ],
      latestOk: [],
    });
    const recentOut = await collect(recentDeps, { symbols: ["IWM"] });
    expect(recentOut.run("IWM", "options")).toMatchObject({
      message: "not due (last attempt 20 s ago)",
      status: "skipped",
    });
  });

  it("enforces parity during post-close gap draining so NVDA cannot stack onto even-minute live streams", async () => {
    // Monday 2026-11-09 16:04 ET = 21:04Z (even minute: NVDA closed at 16:00 ET, parity is odd)
    const et1604 = new Date("2026-11-09T21:04:00.000Z");
    const gap: FlowOptionGapRecord = {
      createdAt: new Date("2026-11-09T20:55:00.000Z"),
      endTime: new Date("2026-11-09T20:55:00.000Z"),
      startTime: new Date("2026-11-09T20:50:00.000Z"),
      symbol: "NVDA",
    };
    const evenGaps = gapStore([gap]);
    const evenDeps = depsWith({
      now: et1604,
      repository: fakeRepository([], undefined, evenGaps),
    });
    const evenOut = await collect(evenDeps, { symbols: ["NVDA"] });
    expect(evenOut.run("NVDA", "options")).toMatchObject({
      message: "staggered: NVDA options runs on odd minutes",
      status: "skipped",
    });
    expect(evenDeps.quantData?.pages).not.toHaveBeenCalled();

    // Next minute 16:05 ET = 21:05Z (odd minute): NVDA drains its stored gap.
    const et1605 = new Date("2026-11-09T21:05:00.000Z");
    const oddDeps = depsWith({
      now: et1605,
      repository: fakeRepository([], undefined, evenGaps),
    });
    const oddOut = await collect(oddDeps, { symbols: ["NVDA"] });
    expect(oddOut.run("NVDA", "options").status).toBe("ok");
    expect(oddDeps.quantData?.pages).toHaveBeenCalled();
  });
});
