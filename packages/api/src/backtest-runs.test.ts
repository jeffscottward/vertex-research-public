import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  BacktestRunRecord,
  BacktestRunsRepository,
  ForwardDriftAlertRecord,
  ForwardDriftMonitorRecord,
  ForwardDriftRepository,
  MarketBarColumns,
  MarketBarSeries,
  MarketBarsRepository,
  Repositories,
  StrategyLibraryRepository,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COST_PROFILE_PRESETS, ZERO_COST_PROFILE } from "./backtest-costs.ts";
import { createApiClient } from "./client.ts";
import {
  BACKTEST_RUN_ENGINE_BARS_MAX,
  BACKTEST_RUN_ENGINE_VERSION,
  BACKTEST_RUN_NAUTILUS_ENGINE,
  BacktestRunEngineResultSchema,
  type BacktestRunSubmitInput,
  BacktestRunSubmitInputSchema,
} from "./contracts/backtest-runs.ts";
import { runInstantBacktest } from "./instant-backtest-engine.ts";
import { settledForwardTrades } from "./paper-forward.ts";
import { ENGINE_CLAIM_ATTEMPTS } from "./server/backtest-run-engine.ts";
import { runParamsForSpec } from "./server/backtest-run-params.ts";
import {
  BACKTEST_RUN_STORAGE_ERROR,
  canonicalJson,
  executeBacktestRun,
  NAUTILUS_UNCLAIMED_ERROR,
  sha256Hex,
  sliceColumnsByDate,
} from "./server/backtest-runs.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import { clearInstantBacktestCacheForTesting } from "./server/instant-backtest.ts";
import { AGENT_API_KEY_READ_PROCEDURES } from "./server/operator-access.ts";
import type { SectorQuadrantSource } from "./server/sector-quadrant-series.ts";
import {
  STRATEGY_TEMPLATES,
  StrategyDefinitionSchema,
} from "./strategy-dsl.ts";

const at = new Date("2026-10-23T12:00:00.000Z");
const DAY_MS = 86_400_000;

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-10-24T12:00:00.000Z"),
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

const seriesRow: MarketBarSeries = {
  barCount: 1000,
  firstT: 0,
  id: "SPY:1d",
  importedAt: at,
  lastT: 999 * DAY_MS,
  source: "Test daily bars",
  sourceSha256: "b".repeat(64),
  symbol: "SPY",
  timeframe: "1d",
};

const waveColumns = (size: number): MarketBarColumns => {
  const close = Float64Array.from(
    { length: size },
    (_, index) => 100 + index * 0.05 + 10 * Math.sin(index / 20)
  );
  return {
    c: close,
    h: close.map((value) => value + 1),
    l: close.map((value) => value - 1),
    o: close.map((value, index) =>
      index === 0 ? value : (close[index - 1] as number)
    ),
    t: Float64Array.from({ length: size }, (_, index) => index * DAY_MS),
  };
};

const fakeBars = (
  overrides: Partial<MarketBarsRepository> = {}
): MarketBarsRepository => ({
  getSeries: vi.fn(async () => seriesRow),
  listSeries: vi.fn(async () => [seriesRow]),
  loadColumns: vi.fn(async () => waveColumns(1000)),
  replaceSeries: vi.fn(),
  ...overrides,
});

/** In-memory runs repository with the same transition rules as the Drizzle one. */
const memoryRuns = (): BacktestRunsRepository & {
  rows: Map<string, BacktestRunRecord>;
} => {
  const rows = new Map<string, BacktestRunRecord>();
  let next = 0;
  const update = (
    id: string,
    allowed: readonly string[],
    patch: Partial<BacktestRunRecord>
  ) => {
    const row = rows.get(id);
    if (row === undefined || !allowed.includes(row.status)) return null;
    const updated = { ...row, ...patch };
    rows.set(id, updated);
    return updated;
  };
  return {
    claim: async (id) =>
      update(id, ["queued"], { startedAt: new Date(), status: "running" }),
    claimNext: async (engineVersion) => {
      const [oldest] = [...rows.values()]
        .filter(
          (row) =>
            row.status === "queued" && row.engineVersion === engineVersion
        )
        .sort(
          (left, right) => left.createdAt.getTime() - right.createdAt.getTime()
        );
      return oldest === undefined
        ? null
        : update(oldest.id, ["queued"], {
            startedAt: new Date(),
            status: "running",
          });
    },
    complete: async (id, report) =>
      update(id, ["running"], { finishedAt: at, report, status: "succeeded" }),
    create: async (input) => {
      next += 1;
      const row: BacktestRunRecord = {
        ...input,
        createdAt: at,
        error: null,
        finishedAt: null,
        id: `run-${next}`,
        report: null,
        startedAt: null,
        status: "queued",
      };
      rows.set(row.id, row);
      return row;
    },
    fail: async (id, error) =>
      update(id, ["queued", "running"], {
        error,
        finishedAt: at,
        status: "failed",
      }),
    failIfStale: async (id, startedBefore, error) => {
      const row = rows.get(id);
      if (
        row === undefined ||
        row.startedAt === null ||
        row.startedAt >= startedBefore
      )
        return false;
      return update(id, ["running"], { error, status: "failed" }) !== null;
    },
    failIfUnclaimed: async (id, createdBefore, error) => {
      const row = rows.get(id);
      if (row === undefined || row.createdAt >= createdBefore) return false;
      return (
        update(id, ["queued"], { error, finishedAt: at, status: "failed" }) !==
        null
      );
    },
    get: async (id) => rows.get(id) ?? null,
    list: async (filter) =>
      [...rows.values()]
        .filter(
          (row) =>
            filter.strategyId === undefined ||
            row.strategyId === filter.strategyId
        )
        .slice(0, filter.limit),
    rows,
  };
};

/** In-memory drift repository with the version lock and acknowledge-once rules. */
const memoryDrift = (): ForwardDriftRepository & {
  monitors: Map<string, ForwardDriftMonitorRecord>;
  alerts: ForwardDriftAlertRecord[];
} => {
  const monitors = new Map<string, ForwardDriftMonitorRecord>();
  const alerts: ForwardDriftAlertRecord[] = [];
  let next = 0;
  const nextId = (prefix: string) => {
    next += 1;
    return `${prefix}-${next}`;
  };
  return {
    acknowledgeAlert: async (id, by) => {
      const index = alerts.findIndex(
        (alert) => alert.id === id && alert.acknowledgedAt === null
      );
      if (index < 0) return null;
      const updated = {
        ...(alerts[index] as ForwardDriftAlertRecord),
        acknowledgedAt: at,
        acknowledgedBy: by,
      };
      alerts[index] = updated;
      return updated;
    },
    alerts,
    create: async (input) => {
      const row: ForwardDriftMonitorRecord = {
        ...input,
        createdAt: at,
        id: nextId("monitor"),
        level: "insufficient",
        levels: {},
        paperNote: null,
        paperStatus: "off",
        paperTickedAt: null,
        points: [],
        trades: [],
        updatedAt: at,
        version: 0,
      };
      monitors.set(row.id, row);
      return row;
    },
    get: async (id) => monitors.get(id) ?? null,
    list: async (limit) =>
      [...monitors.values()]
        .slice(0, limit)
        .map(({ points, trades, ...rest }) => ({
          ...rest,
          pointCount: points.length,
          tradeCount: trades.length,
        })),
    listAlerts: async (filter) =>
      alerts
        .filter(
          (alert) =>
            (filter.monitorId === undefined ||
              alert.monitorId === filter.monitorId) &&
            (!filter.openOnly || alert.acknowledgedAt === null)
        )
        .slice(0, filter.limit),
    listRunningPaper: async (limit) =>
      [...monitors.values()]
        .filter((monitor) => monitor.paperStatus === "running")
        .sort(
          (left, right) =>
            (left.paperTickedAt?.getTime() ?? -1) -
            (right.paperTickedAt?.getTime() ?? -1)
        )
        .slice(0, limit)
        .map((monitor) => monitor.id),
    monitors,
    notePaperTick: async (id, note) => {
      const row = monitors.get(id);
      if (row !== undefined)
        monitors.set(id, { ...row, paperNote: note, paperTickedAt: at });
    },
    saveEvaluation: async (input) => {
      const row = monitors.get(input.id);
      if (row === undefined || row.version !== input.expectedVersion)
        return null;
      const monitor = {
        ...row,
        level: input.level,
        levels: input.levels,
        points: input.points,
        trades: input.trades,
        version: row.version + 1,
      };
      monitors.set(row.id, monitor);
      const raised = input.alerts.map((alert) => ({
        ...alert,
        acknowledgedAt: null,
        acknowledgedBy: null,
        createdAt: at,
        id: nextId("alert"),
        monitorId: row.id,
      }));
      alerts.unshift(...raised);
      return { alerts: raised, monitor };
    },
    setPaperStatus: async (id, status) => {
      const row = monitors.get(id);
      if (row === undefined) return null;
      const updated = { ...row, paperStatus: status };
      monitors.set(id, updated);
      return updated;
    },
  };
};

const strategy = {
  createdAt: at,
  description: null,
  favorite: false,
  id: "strategy-1",
  kind: "native",
  name: "SMA cross",
  params: [{ default: 10, name: "fast", title: "Fast", type: "integer" }],
  section: null,
  slug: "sma-cross",
  sourceRef: null,
  status: "idea",
  tags: [],
  updatedAt: at,
};

const strategyLibrary = {
  get: vi.fn(async (id: string) =>
    id === strategy.id ? { presets: [], strategy } : null
  ),
} as unknown as StrategyLibraryRepository;

type Harness = Readonly<{
  session?: SafeAuthSession | null;
  runs?: BacktestRunsRepository;
  bars?: MarketBarsRepository;
  scheduled?: Promise<unknown>[];
  library?: StrategyLibraryRepository | undefined;
  drift?: ForwardDriftRepository | undefined;
  sectorRotation?: SectorQuadrantSource;
  engine?: "typescript" | "nautilus";
}>;

const clientFor = (harness: Harness) => {
  const repositories = {
    addresses: {},
    adminUsers: {},
    backtestRuns: harness.runs,
    dashboard: {},
    featureItems: {},
    forwardDrift: "drift" in harness ? harness.drift : memoryDrift(),
    marketBars: harness.bars,
    profiles: {},
    sectorRotation: harness.sectorRotation,
    strategyLibrary: "library" in harness ? harness.library : strategyLibrary,
    userPreferences: {},
  } as unknown as Repositories;
  const requestSession =
    harness.session === undefined ? session("operator") : harness.session;
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    const context = createApiContext(request, {
      capabilities: {
        ai: false,
        analytics: false,
        emailDelivery: false,
        telemetryExport: false,
      },
      operatorEmails: ["operator@domain.test"],
      repositories,
      requestId: "request-1",
      ...(harness.engine === undefined
        ? {}
        : { backtestRunsEngine: harness.engine }),
      requireRole: async () => {
        throw denied();
      },
      requireSession: async () => {
        if (requestSession === null) throw denied();
        return requestSession;
      },
      ...(harness.scheduled === undefined
        ? {}
        : {
            scheduleDatabaseTask: (task: Promise<unknown>) => {
              harness.scheduled?.push(task);
            },
          }),
    });
    return handleApiRequest(request, context);
  };
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number
) => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code, status });
  }
};

const submitInput: BacktestRunSubmitInput = {
  costBps: 5,
  from: "1970-01-01",
  initialCapital: 50_000,
  rule: { fast: 5, kind: "smaCross", slow: 30 },
  symbol: "SPY",
  timeframe: "1d",
  to: "1972-06-30",
};

afterEach(() => {
  clearInstantBacktestCacheForTesting();
});

describe("BacktestRunSubmitInputSchema", () => {
  it("applies defaults and rejects reversed or invalid dates", () => {
    expect(
      BacktestRunSubmitInputSchema.parse({
        ...submitInput,
        costBps: undefined,
        initialCapital: undefined,
      })
    ).toMatchObject({
      costBps: 0,
      initialCapital: 10_000,
      stopLossPct: 0,
      takeProfitPct: 0,
    });
    expect(
      BacktestRunSubmitInputSchema.safeParse({
        ...submitInput,
        from: "1972-01-01",
        to: "1971-01-01",
      }).success
    ).toBe(false);
    expect(
      BacktestRunSubmitInputSchema.safeParse({
        ...submitInput,
        from: "2024-02-31",
      }).success
    ).toBe(false);
    for (const from of ["2024-13-01", "2024-01-32", "2024-00-10"]) {
      expect(
        BacktestRunSubmitInputSchema.safeParse({ ...submitInput, from }).success
      ).toBe(false);
    }
  });
});

describe("helpers", () => {
  it("serializes canonical JSON with sorted keys and hashes it", async () => {
    expect(
      canonicalJson(JSON.parse('{"b":[1,{"d":2,"c":null}],"a":"x"}'))
    ).toBe('{"a":"x","b":[1,{"c":null,"d":2}]}');
    expect(canonicalJson(JSON.parse('{"c":1,"a":1,"b":1}'))).toBe(
      '{"a":1,"b":1,"c":1}'
    );
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("slices columns to whole UTC days inclusive", () => {
    const sliced = sliceColumnsByDate(
      waveColumns(10),
      "1970-01-03",
      "1970-01-05"
    );
    expect(Array.from(sliced.t)).toEqual([2, 3, 4].map((d) => d * DAY_MS));
    expect(sliced.c).toHaveLength(3);
    expect(sliced).not.toHaveProperty("v");
    const withVolume = sliceColumnsByDate(
      { ...waveColumns(10), v: Float64Array.from({ length: 10 }, (_, i) => i) },
      "1970-01-03",
      "1970-01-05"
    );
    expect(Array.from(withVolume.v ?? [])).toEqual([2, 3, 4]);
  });
});

describe("backtestRuns procedures", () => {
  it("runs a submitted backtest inline and stores the report", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const run = await client.backtestRuns.submit(submitInput);
    expect(run).toMatchObject({
      engineVersion: BACKTEST_RUN_ENGINE_VERSION,
      error: null,
      status: "succeeded",
      strategyId: null,
      strategyRevision: null,
    });
    expect(run.spec).toMatchObject({ costBps: 5, initialCapital: 50_000 });
    expect(run.report?.seriesSha256).toBe("b".repeat(64));
    expect(run.report?.metrics.initialDeposit).toBe(50_000);
    expect(run.report?.metrics.totalTrades).toBeGreaterThan(0);
    expect(run.report?.lastT).toBeLessThan(Date.parse("1972-07-01"));
    expect(runs.rows.get(run.id)?.requestedBy).toBe("operator");

    const listed = await client.backtestRuns.list({});
    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0]).not.toHaveProperty("report");
  });

  it("stores the resolved preset cost profile and reports gross and net", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const run = await client.backtestRuns.submit({
      ...submitInput,
      costProfile: "ibkr-pro-fixed-us-stock",
    });
    expect(run.spec.costProfile).toEqual(
      COST_PROFILE_PRESETS["ibkr-pro-fixed-us-stock"]
    );
    const costs = run.report?.costs;
    expect(costs?.profileId).toBe("ibkr-pro-fixed-us-stock");
    expect(costs?.commission).toBeGreaterThan(0);
    expect(costs?.netProfitBeforeCosts).toBeCloseTo(
      (run.report?.metrics.netProfit ?? 0) + (costs?.total ?? 0),
      6
    );

    const custom = await client.backtestRuns.submit({
      ...submitInput,
      costProfile: { ...ZERO_COST_PROFILE, id: "mine", label: "Mine" },
    });
    expect(custom.spec.costProfile?.id).toBe("mine");
    expect(custom.report?.costs?.commission).toBe(0);

    const plain = await client.backtestRuns.submit(submitInput);
    expect(plain.spec).not.toHaveProperty("costProfile");
    expect(plain.report).not.toHaveProperty("costs");
  });

  it("applies a cost profile to a definition run", async () => {
    const client = clientFor({ bars: fakeBars(), runs: memoryRuns() });
    const run = await client.backtestRuns.submit({
      ...submitInput,
      costProfile: "ibkr-pro-fixed-us-stock",
      rule: {
        definition: StrategyDefinitionSchema.parse(STRATEGY_TEMPLATES.smaCross),
        kind: "dsl",
      },
    });
    expect(run.report?.costs?.commission).toBeGreaterThan(0);
  });

  it("runs an rvol definition on stored bars with volume", async () => {
    const volumeColumns = async (): Promise<MarketBarColumns> => ({
      ...waveColumns(1000),
      v: Float64Array.from({ length: 1000 }, (_, i) => 100 + (i % 7) * 20),
    });
    const client = clientFor({
      bars: fakeBars({ loadColumns: vi.fn(volumeColumns) }),
      runs: memoryRuns(),
    });
    const run = await client.backtestRuns.submit({
      ...submitInput,
      rule: {
        definition: StrategyDefinitionSchema.parse({
          entry: {
            all: [
              {
                left: { length: 5, name: "rvol", type: "indicator" },
                op: ">",
                right: { type: "const", value: 1.2 },
              },
            ],
          },
          exit: {
            any: [
              {
                left: { length: 5, name: "rvol", type: "indicator" },
                op: "<",
                right: { type: "const", value: 0.9 },
              },
            ],
          },
          name: "RVOL",
          version: 1,
        }),
        kind: "dsl",
      },
    });
    expect(run.status).toBe("succeeded");
    expect(run.report?.trades.length).toBeGreaterThan(0);
  });

  it("sector quadrant filter allows entries only in leading or improving weeks", async () => {
    // Entry and exit conditions hold on every bar, so only the filter decides when entries happen.
    const definition = StrategyDefinitionSchema.parse({
      entry: {
        all: [
          {
            left: { field: "close", type: "price" },
            op: ">",
            right: { type: "const", value: 0 },
          },
        ],
      },
      exit: {
        any: [
          {
            left: { field: "close", type: "price" },
            op: ">",
            right: { type: "const", value: 0 },
          },
        ],
      },
      filters: [
        {
          quadrants: ["leading", "improving"],
          sector: "XLK",
          type: "sectorQuadrant",
        },
      ],
      name: "Sector filter",
      version: 1,
    });
    const listPoints = vi.fn(async () => [
      {
        benchmark: "SPY",
        computedAt: at,
        date: "1970-01-02",
        momentum: 99,
        quadrant: "lagging" as const,
        ratio: 99,
        symbol: "XLK",
        timeframe: "weekly" as const,
      },
      {
        benchmark: "SPY",
        computedAt: at,
        date: "1970-03-06",
        momentum: 101,
        quadrant: "improving" as const,
        ratio: 99,
        symbol: "XLK",
        timeframe: "weekly" as const,
      },
      {
        benchmark: "SPY",
        computedAt: at,
        date: "1970-03-13",
        momentum: 101,
        quadrant: "leading" as const,
        ratio: 101,
        symbol: "XLK",
        timeframe: "weekly" as const,
      },
      {
        benchmark: "SPY",
        computedAt: at,
        date: "1970-03-20",
        momentum: 99,
        quadrant: "weakening" as const,
        ratio: 101,
        symbol: "XLK",
        timeframe: "weekly" as const,
      },
    ]);
    const client = clientFor({
      bars: fakeBars(),
      runs: memoryRuns(),
      sectorRotation: { listPoints },
    });
    const run = await client.backtestRuns.submit({
      ...submitInput,
      rule: { definition, kind: "dsl" },
    });
    expect(run.status).toBe("succeeded");
    expect(listPoints).toHaveBeenCalledWith({
      fromDate: "1969-12-01",
      symbols: ["XLK"],
      timeframe: "weekly",
    });
    const trades = run.report?.trades ?? [];
    expect(trades.length).toBeGreaterThan(0);
    const first = Date.parse("1970-03-06T00:00:00Z");
    const last = Date.parse("1970-03-20T00:00:00Z");
    for (const trade of trades) {
      // Signal on bars dated 1970-03-06 to 1970-03-19, fill on the next bar.
      expect(trade.entryT).toBeGreaterThan(first);
      expect(trade.entryT).toBeLessThanOrEqual(last);
    }
  });

  it("fails a filtered definition run when no sector data is wired", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const definition = StrategyDefinitionSchema.parse({
      ...STRATEGY_TEMPLATES.smaCross,
      filters: [
        { quadrants: ["leading"], sector: "XLK", type: "sectorQuadrant" },
      ],
    });
    const run = await client.backtestRuns.submit({
      ...submitInput,
      rule: { definition, kind: "dsl" },
    });
    expect(run.status).toBe("failed");
    expect(run.error).toBe(
      "Sector quadrant data is not available for XLK (weekly)"
    );
  });

  it("gives a definition run no fixed-rule engine parameters", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const run = await client.backtestRuns.submit({
      ...submitInput,
      rule: {
        definition: StrategyDefinitionSchema.parse(STRATEGY_TEMPLATES.smaCross),
        kind: "dsl",
      },
    });
    const spec = (runs.rows.get(run.id) as BacktestRunRecord).spec;
    expect(() => runParamsForSpec(spec)).toThrow(
      "A strategy definition run has no fixed-rule parameters"
    );
  });

  it("runs a strategy definition and versions it by its content", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const definition = StrategyDefinitionSchema.parse(
      STRATEGY_TEMPLATES.smaCross
    );
    const input = {
      ...submitInput,
      rule: { definition, kind: "dsl" as const },
    };
    const run = await client.backtestRuns.submit(input);
    expect(run.status).toBe("succeeded");
    expect(run.strategyId).toBeNull();
    expect(run.strategySnapshot).toMatchObject({
      kind: "dsl",
      name: "SMA cross",
      params: [definition],
      sourceRef: null,
    });
    expect(run.strategyRevision).toBe(
      await sha256Hex(canonicalJson(run.strategySnapshot))
    );
    const again = await client.backtestRuns.submit(input);
    expect(again.strategyRevision).toBe(run.strategyRevision);
    const changed = await client.backtestRuns.submit({
      ...input,
      rule: { definition: { ...definition, name: "Other" }, kind: "dsl" },
    });
    expect(changed.strategyRevision).not.toBe(run.strategyRevision);

    // The definition run equals the golden 20/50 cross over the same bars.
    const golden = await client.backtestRuns.submit({
      ...submitInput,
      rule: { fast: 20, kind: "smaCross", slow: 50 },
    });
    expect(run.report?.metrics).toEqual(golden.report?.metrics);
    expect(run.report?.trades).toEqual(golden.report?.trades);
  });

  it("keeps a library strategy revision for a definition run", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const run = await client.backtestRuns.submit({
      ...submitInput,
      rule: {
        definition: StrategyDefinitionSchema.parse(STRATEGY_TEMPLATES.smaCross),
        kind: "dsl",
      },
      strategyId: "strategy-1",
    });
    expect(run.strategyId).toBe("strategy-1");
    expect(run.strategySnapshot?.kind).toBe("native");
  });

  it("rejects an invalid strategy definition", async () => {
    const client = clientFor({ bars: fakeBars(), runs: memoryRuns() });
    await expectCode(
      client.backtestRuns.submit({
        ...submitInput,
        rule: {
          definition: { ...STRATEGY_TEMPLATES.smaCross, version: 2 },
          kind: "dsl",
        } as unknown as BacktestRunSubmitInput["rule"],
      }),
      "BAD_REQUEST",
      400
    );
  });

  it("ties a run to a SHA-256 revision of the strategy snapshot", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const run = await client.backtestRuns.submit({
      ...submitInput,
      strategyId: "strategy-1",
    });
    expect(run.strategySnapshot).toEqual({
      id: "strategy-1",
      kind: "native",
      name: "SMA cross",
      params: strategy.params,
      slug: "sma-cross",
      sourceRef: null,
      updatedAt: at.toISOString(),
    });
    expect(run.strategyRevision).toBe(
      await sha256Hex(canonicalJson(run.strategySnapshot))
    );
    const filtered = await client.backtestRuns.list({
      strategyId: "strategy-1",
    });
    expect(filtered.runs.map((entry) => entry.id)).toEqual([run.id]);
    await expectCode(
      client.backtestRuns.submit({ ...submitInput, strategyId: "missing" }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      clientFor({
        bars: fakeBars(),
        library: undefined,
        runs,
      }).backtestRuns.submit({ ...submitInput, strategyId: "strategy-1" }),
      "STORAGE_ERROR",
      503
    );
  });

  it("returns a queued run and executes it on the tracked scheduler", async () => {
    const runs = memoryRuns();
    const scheduled: Promise<unknown>[] = [];
    const client = clientFor({ bars: fakeBars(), runs, scheduled });
    const run = await client.backtestRuns.submit(submitInput);
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    const read = await client.backtestRuns.get({ id: run.id });
    expect(read.status).toBe("succeeded");
    expect(read.report?.trades.length).toBeGreaterThan(0);
    expect(scheduled).toHaveLength(1);
  });

  it("re-schedules a queued run on read and fails stale running runs", async () => {
    const runs = memoryRuns();
    const queued = await runs.create({
      engineVersion: BACKTEST_RUN_ENGINE_VERSION,
      requestedBy: "operator",
      spec: BacktestRunSubmitInputSchema.parse(submitInput) as never,
      strategyId: null,
      strategyRevision: null,
      strategySnapshot: null,
    });
    const scheduled: Promise<unknown>[] = [];
    const client = clientFor({ bars: fakeBars(), runs, scheduled });
    expect((await client.backtestRuns.get({ id: queued.id })).status).toBe(
      "queued"
    );
    await Promise.all(scheduled);
    expect(runs.rows.get(queued.id)?.status).toBe("succeeded");

    const stale = await runs.create({ ...queued });
    runs.rows.set(stale.id, {
      ...stale,
      startedAt: new Date(Date.now() - 11 * 60 * 1000),
      status: "running",
    });
    const read = await client.backtestRuns.get({ id: stale.id });
    expect(read).toMatchObject({
      error: "Backtest stopped before it finished",
      status: "failed",
    });
    await expectCode(
      client.backtestRuns.get({ id: "missing" }),
      "NOT_FOUND",
      404
    );
  });

  it("returns the created run when the re-read finds nothing", async () => {
    const runs = memoryRuns();
    const client = clientFor({
      bars: fakeBars(),
      runs: { ...runs, get: async () => null },
      scheduled: [],
    });
    expect((await client.backtestRuns.submit(submitInput)).status).toBe(
      "queued"
    );
  });

  it("swallows scheduled task failures so the request never rejects", async () => {
    const runs = memoryRuns();
    const scheduled: Promise<unknown>[] = [];
    const client = clientFor({
      bars: fakeBars(),
      runs: { ...runs, claim: async () => Promise.reject(new Error("db")) },
      scheduled,
    });
    await client.backtestRuns.submit(submitInput);
    await expect(Promise.all(scheduled)).resolves.toEqual([undefined]);
  });

  it("requires storage and an operator session", async () => {
    await expectCode(
      clientFor({ bars: fakeBars() }).backtestRuns.list({}),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor({ runs: memoryRuns() }).backtestRuns.list({}),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor({
        bars: fakeBars(),
        runs: memoryRuns(),
        session: null,
      }).backtestRuns.list({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor({
        bars: fakeBars(),
        runs: memoryRuns(),
        session: session("member"),
      }).backtestRuns.list({}),
      "FORBIDDEN",
      403
    );
  });
});

describe("backtestRuns.sweep procedure", () => {
  const sweepInput = {
    dimensions: [
      { from: 5, param: "fast" as const, step: 5, to: 15 },
      { from: 20, param: "slow" as const, step: 10, to: 30 },
    ],
    from: "1970-01-01",
    rule: { fast: 5, kind: "smaCross" as const, slow: 30 },
    symbol: "SPY",
    timeframe: "1d" as const,
    to: "1972-06-30",
  };

  it("runs the grid over the date range and ranks every cell", async () => {
    const output = await clientFor({ bars: fakeBars() }).backtestRuns.sweep(
      sweepInput
    );
    const expectedBars = sliceColumnsByDate(
      waveColumns(1000),
      sweepInput.from,
      sweepInput.to
    ).t.length;
    expect(output).toMatchObject({
      bars: expectedBars,
      engineVersion: BACKTEST_RUN_ENGINE_VERSION,
      firstT: 0,
      lastT: (expectedBars - 1) * DAY_MS,
      metric: "totalReturn",
      seriesSha256: "b".repeat(64),
      spikeRatio: 0.5,
      symbol: "SPY",
    });
    expect(output.dimensions).toEqual([
      { param: "fast", values: [5, 10, 15] },
      { param: "slow", values: [20, 30] },
    ]);
    expect(output.cells).toHaveLength(6);
    expect([...output.ranking].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    return expect(output.computeMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects a sweep over the cells x bars budget before running it", async () => {
    const size = 25_000;
    const loadColumns = vi.fn(async () => waveColumns(size));
    await expect(
      clientFor({ bars: fakeBars({ loadColumns }) }).backtestRuns.sweep({
        ...sweepInput,
        dimensions: [
          { from: 1, param: "fast", step: 1, to: 20 },
          { from: 100, param: "slow", step: 1, to: 149 },
        ],
        to: "2040-01-01",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: `The sweep needs 1000 cells x ${size} bars; the limit is 20,000,000 bar steps. Narrow the date range or the grid.`,
      status: 400,
    });
  });

  it("rejects invalid grids, empty ranges and missing series", async () => {
    await expectCode(
      clientFor({ bars: fakeBars() }).backtestRuns.sweep({
        ...sweepInput,
        dimensions: [{ from: 5, param: "trendSma", step: 5, to: 15 }],
      }),
      "BAD_REQUEST",
      400
    );
    await expect(
      clientFor({ bars: fakeBars() }).backtestRuns.sweep({
        ...sweepInput,
        from: "2030-01-01",
        to: "2030-01-02",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Fewer than 2 bars for SPY between 2030-01-01 and 2030-01-02",
    });
    await expectCode(
      clientFor({
        bars: fakeBars({ getSeries: vi.fn(async () => null) }),
      }).backtestRuns.sweep(sweepInput),
      "NOT_FOUND",
      404
    );
  });

  it("maps storage failures and requires an operator", async () => {
    await expectCode(
      clientFor({}).backtestRuns.sweep(sweepInput),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor({
        bars: fakeBars({
          getSeries: vi.fn(async () => Promise.reject(new Error("db"))),
        }),
      }).backtestRuns.sweep(sweepInput),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor({
        bars: fakeBars({
          loadColumns: vi.fn(async () => Promise.reject(new Error("db"))),
        }),
      }).backtestRuns.sweep(sweepInput),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor({
        bars: fakeBars(),
        session: session("member"),
      }).backtestRuns.sweep(sweepInput),
      "FORBIDDEN",
      403
    );
    return expect(AGENT_API_KEY_READ_PROCEDURES.has("backtestRuns.sweep")).toBe(
      true
    );
  });
});

describe("executeBacktestRun", () => {
  const queue = async (
    runs: BacktestRunsRepository,
    overrides: Partial<BacktestRunSubmitInput> = {}
  ) =>
    await runs.create({
      engineVersion: BACKTEST_RUN_ENGINE_VERSION,
      requestedBy: "operator",
      spec: BacktestRunSubmitInputSchema.parse({
        ...submitInput,
        ...overrides,
      }) as never,
      strategyId: null,
      strategyRevision: null,
      strategySnapshot: null,
    });

  it("fails when the series is missing or the range has under 2 bars", async () => {
    const runs = memoryRuns();
    const missing = await queue(runs);
    await executeBacktestRun(
      { marketBars: fakeBars({ getSeries: async () => null }), runs },
      missing.id
    );
    expect(runs.rows.get(missing.id)?.error).toBe("No stored 1d bars for SPY");
    const empty = await queue(runs, { from: "2030-01-01", to: "2030-12-31" });
    await executeBacktestRun({ marketBars: fakeBars(), runs }, empty.id);
    expect(runs.rows.get(empty.id)?.error).toBe(
      "Fewer than 2 bars for SPY between 2030-01-01 and 2030-12-31"
    );
  });

  it("stores engine input errors and hides other failures", async () => {
    const runs = memoryRuns();
    const tooSlow = await queue(runs, {
      rule: { fast: 5, kind: "smaCross", slow: 5000 },
    });
    await executeBacktestRun({ marketBars: fakeBars(), runs }, tooSlow.id);
    expect(runs.rows.get(tooSlow.id)?.status).toBe("failed");
    expect(runs.rows.get(tooSlow.id)?.error).not.toContain(
      "bar storage or engine error"
    );

    clearInstantBacktestCacheForTesting();
    const broken = await queue(runs);
    await executeBacktestRun(
      {
        marketBars: fakeBars({
          loadColumns: async () => Promise.reject(new Error("secret dsn")),
        }),
        runs,
      },
      broken.id
    );
    expect(runs.rows.get(broken.id)?.error).toBe(
      "Backtest failed: bar storage or engine error"
    );
  });

  it("does nothing when the claim is lost", async () => {
    const runs = memoryRuns();
    const bars = fakeBars();
    const claimed = await queue(runs);
    await runs.claim(claimed.id);
    await executeBacktestRun({ marketBars: bars, runs }, claimed.id);
    expect(runs.rows.get(claimed.id)?.status).toBe("running");
    expect(bars.getSeries).not.toHaveBeenCalled();
  });
});

describe("backtestRuns.combine", () => {
  const prepared = async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const first = await client.backtestRuns.submit({
      ...submitInput,
      strategyId: "strategy-1",
    });
    const second = await client.backtestRuns.submit({
      ...submitInput,
      rule: {
        entryLookback: 20,
        exitLookback: 10,
        kind: "breakout",
        trendSma: 0,
      },
    });
    return { client, first, runs, second };
  };

  it("combines finished runs and reconciles with slot P&L", async () => {
    const { client, first, second } = await prepared();
    const result = await client.backtestRuns.combine({
      deposit: 100_000,
      slots: [
        {
          expectedRevision: first.strategyRevision,
          runId: first.id,
          weight: 0.6,
        },
        { runId: second.id, weight: 0.4 },
      ],
    });
    expect(result.slots.map((slot) => slot.runId)).toEqual([
      first.id,
      second.id,
    ]);
    expect(result.slots[0]?.label).toContain("SMA cross");
    expect(result.slots[1]?.label).toContain("SPY 1d breakout");
    expect(result.slots[0]?.strategyRevision).toBe(first.strategyRevision);
    expect(result.slots[0]?.seriesSha256).toBe("b".repeat(64));
    const pnl = result.slots.reduce((sum, slot) => sum + slot.pnl, 0);
    expect(result.finalEquity).toBeCloseTo(100_000 + pnl, 6);
    expect(result.correlation).toHaveLength(2);
  });

  it("rejects unknown, unfinished, unpinned and duplicate runs", async () => {
    const { client, first, runs } = await prepared();
    await expectCode(
      client.backtestRuns.combine({
        deposit: 1,
        slots: [{ runId: "nope", weight: 1 }],
      }),
      "NOT_FOUND",
      404
    );
    const queued = await runs.create({
      engineVersion: BACKTEST_RUN_ENGINE_VERSION,
      requestedBy: "operator",
      spec: {
        ...submitInput,
        costBps: 0,
        initialCapital: 1,
        stopLossPct: 0,
        takeProfitPct: 0,
      },
      strategyId: null,
      strategyRevision: null,
      strategySnapshot: null,
    } as Parameters<typeof runs.create>[0]);
    await expectCode(
      client.backtestRuns.combine({
        deposit: 1,
        slots: [{ runId: queued.id, weight: 1 }],
      }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      client.backtestRuns.combine({
        deposit: 1,
        slots: [
          { expectedRevision: "0".repeat(64), runId: first.id, weight: 1 },
        ],
      }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      client.backtestRuns.combine({
        deposit: 1,
        slots: [
          { runId: first.id, weight: 0.5 },
          { runId: first.id, weight: 0.5 },
        ],
      }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      client.backtestRuns.combine({
        deposit: 1,
        slots: [
          { runId: first.id, weight: 0.5 },
          { runId: "x", weight: 0.6 },
        ],
      }),
      "BAD_REQUEST",
      400
    );
  });

  it("maps engine input errors and rethrows other failures", async () => {
    const { first, runs } = await prepared();
    const row = runs.rows.get(first.id) as BacktestRunRecord;
    runs.rows.set(first.id, {
      ...row,
      report: {
        ...(row.report as Record<string, unknown>),
        equity: [{ drawdownPct: 0, equity: 1, t: 0 }],
      },
    });
    const client = clientFor({ bars: fakeBars(), runs });
    await expectCode(
      client.backtestRuns.combine({
        deposit: 1,
        slots: [{ runId: first.id, weight: 1 }],
      }),
      "BAD_REQUEST",
      400
    );
    runs.rows.set(first.id, {
      ...row,
      report: { ...(row.report as Record<string, unknown>), equity: null },
    });
    await expectCode(
      client.backtestRuns.combine({
        deposit: 1,
        slots: [{ runId: first.id, weight: 1 }],
      }),
      "INTERNAL_SERVER_ERROR",
      500
    );
  });

  it("is operator-only", async () => {
    const input = { deposit: 1, slots: [{ runId: "run-1", weight: 1 }] };
    for (const [requestSession, code, status] of [
      [null, "UNAUTHORIZED", 401],
      [session("member"), "FORBIDDEN", 403],
    ] as const) {
      await expectCode(
        clientFor({
          bars: fakeBars(),
          runs: memoryRuns(),
          session: requestSession,
        }).backtestRuns.combine(input),
        code,
        status
      );
    }
  });
});

describe("backtestRuns.drift", () => {
  const prepared = async (drift = memoryDrift()) => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), drift, runs });
    const run = await client.backtestRuns.submit({
      ...submitInput,
      strategyId: "strategy-1",
    });
    const monitor = await client.backtestRuns.drift.create({
      baselineRunId: run.id,
      expectedRevision: run.strategyRevision,
      label: "SMA cross paper",
    });
    return { client, drift, monitor, run, runs };
  };

  /** Two equity points with a fall of `ratio` x the baseline drawdown (floor 1%). */
  const fallOf = (baselineDrawdown: number, ratio: number, start = 0) => [
    { equity: 100, t: start },
    {
      equity: 100 * (1 - ratio * Math.max(baselineDrawdown, 0.01)),
      t: start + DAY_MS,
    },
  ];

  it("creates a monitor pinned to the run's revision with default thresholds", async () => {
    const { monitor, run } = await prepared();
    expect(monitor.baselineRunId).toBe(run.id);
    expect(monitor.strategyRevision).toBe(run.strategyRevision);
    expect(monitor.level).toBe("insufficient");
    expect(monitor.checks.map((check) => check.level)).toEqual(
      Array.from({ length: 5 }, () => "insufficient")
    );
    expect(monitor.thresholds.drawdown).toEqual({ alert: 1.5, warn: 1 });
    expect(monitor.baseline.label).toContain("SMA cross");
    expect(monitor.baseline.seriesSha256).toBe("b".repeat(64));
    expect(monitor.alerts).toEqual([]);
  });

  it("raises an in-app alert once per escalation and lists it until acknowledged", async () => {
    const { client, monitor, run } = await prepared();
    const drawdown = run.report?.metrics.maxDrawdownPct ?? 0;
    const warned = await client.backtestRuns.drift.record({
      id: monitor.id,
      points: fallOf(drawdown, 1.1),
      source: "paper",
    });
    expect(warned.raised.map((alert) => [alert.check, alert.level])).toEqual([
      ["drawdown", "warn"],
    ]);
    expect(warned.monitor.level).toBe("warn");
    expect(warned.raised[0]?.message).toContain("Max drawdown warn");

    const same = await client.backtestRuns.drift.record({
      id: monitor.id,
      points: [
        { equity: 100 * (1 - 1.1 * Math.max(drawdown, 0.01)), t: 3 * DAY_MS },
      ],
      source: "paper",
    });
    expect(same.raised).toEqual([]);

    const alerted = await client.backtestRuns.drift.record({
      id: monitor.id,
      points: [
        { equity: 100 * (1 - 1.6 * Math.max(drawdown, 0.01)), t: 4 * DAY_MS },
      ],
      source: "paper",
      trades: Array.from({ length: 12 }, (_, index) => ({
        pnl: -1,
        t: index,
      })),
    });
    expect(
      alerted.raised.map((alert) => [alert.check, alert.level]).sort()
    ).toEqual([
      ["drawdown", "alert"],
      ["losingStreak", "alert"],
      ["profitFactor", "alert"],
      ["winRate", "alert"],
    ]);
    expect(alerted.monitor.pointCount).toBe(4);
    expect(alerted.monitor.alerts).toHaveLength(5);

    const listed = await client.backtestRuns.drift.list({});
    expect(listed.monitors[0]).toMatchObject({
      id: monitor.id,
      level: "alert",
      pointCount: 4,
      tradeCount: 12,
    });
    expect(listed.openAlerts).toHaveLength(5);

    const first = listed.openAlerts[0];
    const acknowledged = await client.backtestRuns.drift.acknowledge({
      id: first?.id ?? "",
    });
    expect(acknowledged.acknowledgedAt).toEqual(at);
    await expectCode(
      client.backtestRuns.drift.acknowledge({ id: first?.id ?? "" }),
      "NOT_FOUND",
      404
    );
    expect((await client.backtestRuns.drift.list({})).openAlerts).toHaveLength(
      4
    );

    const read = await client.backtestRuns.drift.get({ id: monitor.id });
    expect(read.level).toBe("alert");
    expect(read.points).toHaveLength(4);
    expect(read.trades).toHaveLength(12);
  });

  it("applies threshold overrides and rejects invalid ones", async () => {
    const { client, run } = await prepared();
    const custom = await client.backtestRuns.drift.create({
      baselineRunId: run.id,
      expectedRevision: run.strategyRevision,
      label: "Loose",
      thresholds: { drawdown: { alert: 3, warn: 2 } },
    });
    expect(custom.thresholds.drawdown).toEqual({ alert: 3, warn: 2 });
    await expectCode(
      client.backtestRuns.drift.create({
        baselineRunId: run.id,
        expectedRevision: run.strategyRevision,
        label: "Bad",
        thresholds: { sharpe: { alert: 0.9, warn: 0.5 } },
      }),
      "BAD_REQUEST",
      400
    );
  });

  it("rejects unknown, unfinished and unpinned baselines", async () => {
    const { client, run, runs } = await prepared();
    await expectCode(
      client.backtestRuns.drift.create({
        baselineRunId: "nope",
        expectedRevision: null,
        label: "x",
      }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      client.backtestRuns.drift.create({
        baselineRunId: run.id,
        expectedRevision: "0".repeat(64),
        label: "x",
      }),
      "BAD_REQUEST",
      400
    );
    const queued = await runs.create({
      engineVersion: BACKTEST_RUN_ENGINE_VERSION,
      requestedBy: "operator",
      spec: run.spec,
      strategyId: null,
      strategyRevision: null,
      strategySnapshot: null,
    } as Parameters<typeof runs.create>[0]);
    await expectCode(
      client.backtestRuns.drift.create({
        baselineRunId: queued.id,
        expectedRevision: null,
        label: "x",
      }),
      "BAD_REQUEST",
      400
    );
  });

  it("accepts only data after the stored data, within the stored limit", async () => {
    const { client, monitor } = await prepared();
    await client.backtestRuns.drift.record({
      id: monitor.id,
      points: [{ equity: 100, t: 10 * DAY_MS }],
      source: "paper",
      trades: [{ pnl: 1, t: 10 * DAY_MS }],
    });
    await expectCode(
      client.backtestRuns.drift.record({
        id: monitor.id,
        points: [{ equity: 100, t: 10 * DAY_MS }],
        source: "paper",
      }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      client.backtestRuns.drift.record({
        id: monitor.id,
        source: "paper",
        trades: [{ pnl: 1, t: DAY_MS }],
      }),
      "BAD_REQUEST",
      400
    );
    // A resent trade-only request (same time as the last stored trade) is refused, not stored twice.
    await expectCode(
      client.backtestRuns.drift.record({
        id: monitor.id,
        source: "paper",
        trades: [{ pnl: 1, t: 10 * DAY_MS }],
      }),
      "BAD_REQUEST",
      400
    );
    expect(
      (await client.backtestRuns.drift.get({ id: monitor.id })).trades
    ).toHaveLength(1);
    const batch = (offset: number) =>
      Array.from({ length: 2000 }, (_, index) => ({
        equity: 100,
        t: (11 + offset + index) * DAY_MS,
      }));
    await client.backtestRuns.drift.record({
      id: monitor.id,
      points: batch(0),
      source: "paper",
    });
    await client.backtestRuns.drift.record({
      id: monitor.id,
      points: batch(2000),
      source: "paper",
    });
    await expectCode(
      client.backtestRuns.drift.record({
        id: monitor.id,
        points: batch(4000),
        source: "paper",
      }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      client.backtestRuns.drift.record({
        id: "missing",
        points: [{ equity: 1, t: 0 }],
        source: "paper",
      }),
      "NOT_FOUND",
      404
    );
  });

  it("rejects malformed recordings at the contract", async () => {
    const { client, monitor } = await prepared();
    for (const input of [
      { id: monitor.id, source: "paper" },
      {
        id: monitor.id,
        points: [
          { equity: 1, t: 2 },
          { equity: 1, t: 1 },
        ],
        source: "paper",
      },
      {
        id: monitor.id,
        source: "paper",
        trades: [
          { pnl: 1, t: 2 },
          { pnl: 1, t: 1 },
        ],
      },
      { id: monitor.id, points: [{ equity: 0, t: 1 }], source: "paper" },
      { id: monitor.id, points: [{ equity: 1, t: 1 }], source: "live" },
    ]) {
      await expectCode(
        client.backtestRuns.drift.record(
          input as Parameters<typeof client.backtestRuns.drift.record>[0]
        ),
        "BAD_REQUEST",
        400
      );
    }
  });

  it("returns CONFLICT when another recording changed the monitor first", async () => {
    const drift = memoryDrift();
    const { client, monitor } = await prepared({
      ...drift,
      saveEvaluation: async () => null,
    });
    await expectCode(
      client.backtestRuns.drift.record({
        id: monitor.id,
        points: [{ equity: 1, t: 0 }],
        source: "paper",
      }),
      "CONFLICT",
      409
    );
  });

  it("reads one monitor or NOT_FOUND", async () => {
    const { client, monitor } = await prepared();
    await expect(
      client.backtestRuns.drift.get({ id: monitor.id })
    ).resolves.toMatchObject({ id: monitor.id, points: [] });
    await expectCode(
      client.backtestRuns.drift.get({ id: "missing" }),
      "NOT_FOUND",
      404
    );
  });

  it("fails closed without storage and is operator-only", async () => {
    await expectCode(
      clientFor({
        bars: fakeBars(),
        drift: undefined,
        runs: memoryRuns(),
      }).backtestRuns.drift.list({}),
      "STORAGE_ERROR",
      503
    );
    for (const [requestSession, code, status] of [
      [null, "UNAUTHORIZED", 401],
      [session("member"), "FORBIDDEN", 403],
    ] as const) {
      await expectCode(
        clientFor({
          bars: fakeBars(),
          runs: memoryRuns(),
          session: requestSession,
        }).backtestRuns.drift.list({}),
        code,
        status
      );
    }
  });

  it("lets read keys list and get, never record, create or acknowledge", () => {
    expect(AGENT_API_KEY_READ_PROCEDURES.has("backtestRuns.drift.list")).toBe(
      true
    );
    expect(AGENT_API_KEY_READ_PROCEDURES.has("backtestRuns.drift.get")).toBe(
      true
    );
    for (const name of ["record", "create", "acknowledge"])
      expect(
        AGENT_API_KEY_READ_PROCEDURES.has(`backtestRuns.drift.${name}`)
      ).toBe(false);
  });
});

describe("backtestRuns.drift paper forward runner", () => {
  const prepared = async (
    options: Readonly<{
      bars?: MarketBarsRepository;
      drift?: ForwardDriftRepository;
      input?: Partial<BacktestRunSubmitInput>;
    }> = {}
  ) => {
    const runs = memoryRuns();
    const drift = options.drift ?? memoryDrift();
    const bars = options.bars ?? fakeBars();
    const client = clientFor({ bars, drift, runs });
    const run = await client.backtestRuns.submit({
      ...submitInput,
      ...options.input,
    });
    const monitor = await client.backtestRuns.drift.create({
      baselineRunId: run.id,
      expectedRevision: run.strategyRevision,
      label: "Paper runner",
    });
    return { bars, client, drift, monitor, run, runs };
  };

  it("starts and stops a runner, and ticks only running monitors", async () => {
    const { client, monitor } = await prepared();
    expect(monitor.paper).toEqual({
      note: null,
      status: "off",
      tickedAt: null,
    });
    expect((await client.backtestRuns.drift.paperTick({})).results).toEqual([]);
    const started = await client.backtestRuns.drift.paperSet({
      id: monitor.id,
      running: true,
    });
    expect(started.paper.status).toBe("running");
    const listed = await client.backtestRuns.drift.list({});
    expect(listed.monitors[0]?.paper.status).toBe("running");
    const first = await client.backtestRuns.drift.paperTick({});
    expect(first.results).toHaveLength(1);
    expect(first.results[0]?.newPoints).toBeGreaterThan(50);
    expect(first.results[0]?.note).toBeNull();
    const again = await client.backtestRuns.drift.paperTick({
      id: monitor.id,
    });
    expect(again.results[0]).toMatchObject({
      newPoints: 0,
      newTrades: 0,
      note: "No new settled bars after the forward start",
    });
    const stopped = await client.backtestRuns.drift.paperSet({
      id: monitor.id,
      running: false,
    });
    expect(stopped.paper).toMatchObject({
      note: "No new settled bars after the forward start",
      status: "off",
      tickedAt: at,
    });
    await expectCode(
      client.backtestRuns.drift.paperSet({ id: "missing", running: true }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      client.backtestRuns.drift.paperTick({ id: "missing" }),
      "NOT_FOUND",
      404
    );
  });

  it("records the same trades as a backtest over the same bars, one new bar at a time", async () => {
    let size = 912;
    const bars = fakeBars({
      loadColumns: vi.fn(async () => waveColumns(size)),
    });
    const {
      client,
      monitor,
      run,
      runs: repository,
    } = await prepared({
      bars,
      input: {
        costProfile: "ibkr-pro-fixed-us-stock",
        from: "1970-02-01",
        stopLossPct: 3,
        takeProfitPct: 5,
      },
    });
    for (; size <= 1000; size += 1)
      await client.backtestRuns.drift.paperTick({ id: monitor.id });
    const stored = await client.backtestRuns.drift.get({ id: monitor.id });
    const spec = (repository.rows.get(run.id) as BacktestRunRecord).spec;
    // The backtest over the same bars: the run start date to the newest stored bar.
    const full = sliceColumnsByDate(waveColumns(1000), spec.from, "2100-01-01");
    const forwardStartT = Date.parse(`${spec.to}T00:00:00Z`) + DAY_MS;
    const backtest = runInstantBacktest(full, runParamsForSpec(spec));
    const expected = settledForwardTrades(
      full,
      backtest.trades,
      forwardStartT
    ).map((trade) => ({
      pnl: spec.initialCapital * trade.pnl,
      t: full.t[trade.exitIndex] as number,
    }));
    expect(expected.length).toBeGreaterThan(0);
    expect(stored.trades).toEqual(expected);
    expect(stored.points.at(-1)?.t).toBe(full.t.at(-2));
    expect(stored.points[0]?.t).toBe(forwardStartT);
  });

  it("notes missing bars or a missing baseline instead of failing", async () => {
    const getSeries = vi.fn(
      async (): Promise<MarketBarSeries | null> => seriesRow
    );
    const {
      client,
      monitor,
      run,
      runs: repository,
    } = await prepared({
      bars: fakeBars({ getSeries }),
    });
    getSeries.mockResolvedValueOnce(null);
    expect(
      (await client.backtestRuns.drift.paperTick({ id: monitor.id })).results[0]
        ?.note
    ).toBe("No stored 1d bars for SPY");
    repository.rows.set(run.id, {
      ...(repository.rows.get(run.id) as BacktestRunRecord),
      status: "failed",
    });
    expect(
      (await client.backtestRuns.drift.paperTick({ id: monitor.id })).results[0]
        ?.note
    ).toBe("The baseline backtest run is not available");
  });

  it("records a long gap over several ticks and stops when storage is full", async () => {
    const bars = fakeBars({
      loadColumns: vi.fn(async () => waveColumns(7000)),
    });
    const drift = memoryDrift();
    const { client, monitor } = await prepared({ bars, drift });
    const first = await client.backtestRuns.drift.paperTick({ id: monitor.id });
    expect(first.results[0]).toMatchObject({
      newPoints: 2000,
      note: "Recorded part of the new bars; the next tick continues",
    });
    await client.backtestRuns.drift.paperSet({ id: monitor.id, running: true });
    await client.backtestRuns.drift.paperTick({ id: monitor.id });
    const third = await client.backtestRuns.drift.paperTick({ id: monitor.id });
    expect(third.results[0]?.note).toBe(
      "Stopped: A monitor stores at most 5000 points and 5000 trades"
    );
    expect(drift.monitors.get(monitor.id)?.paperStatus).toBe("off");
  });

  it("notes a version conflict and skips monitors removed before the tick", async () => {
    const base = memoryDrift();
    let saveResult: "normal" | "conflict" = "conflict";
    let running: string[] | null = null;
    let statusMissing = false;
    const drift: ForwardDriftRepository = {
      ...base,
      listRunningPaper: async (limit: number) =>
        running ?? base.listRunningPaper(limit),
      saveEvaluation: async (
        input: Parameters<ForwardDriftRepository["saveEvaluation"]>[0]
      ) => (saveResult === "conflict" ? null : base.saveEvaluation(input)),
      setPaperStatus: async (id, status) =>
        statusMissing ? null : base.setPaperStatus(id, status),
    };
    const { client, monitor } = await prepared({ drift });
    expect(
      (await client.backtestRuns.drift.paperTick({ id: monitor.id })).results[0]
        ?.note
    ).toBe("The monitor changed during the tick; the next tick retries");
    saveResult = "normal";
    running = ["ghost"];
    statusMissing = true;
    await expectCode(
      client.backtestRuns.drift.paperSet({ id: monitor.id, running: true }),
      "NOT_FOUND",
      404
    );
    expect((await client.backtestRuns.drift.paperTick({})).results).toEqual([]);
  });

  it("refuses manual recording while the runner owns the series", async () => {
    const { client, monitor } = await prepared();
    await client.backtestRuns.drift.paperSet({ id: monitor.id, running: true });
    await expectCode(
      client.backtestRuns.drift.record({
        id: monitor.id,
        points: [{ equity: 1, t: 4_000_000_000_000 }],
        source: "paper",
      }),
      "CONFLICT",
      409
    );
    await client.backtestRuns.drift.paperSet({
      id: monitor.id,
      running: false,
    });
    await expect(
      client.backtestRuns.drift.record({
        id: monitor.id,
        points: [{ equity: 1, t: 4_000_000_000_000 }],
        source: "paper",
      })
    ).resolves.toMatchObject({ raised: [] });
  });

  it("notes a failing monitor in a batch and keeps ticking the others", async () => {
    let mode: "ok" | "short" | "storage" = "ok";
    const bars = fakeBars({
      loadColumns: vi.fn(async () => {
        if (mode === "storage") throw new Error("connection reset");
        return waveColumns(mode === "short" ? 10 : 1000);
      }),
    });
    const base = memoryDrift();
    let noteFails = false;
    const drift: ForwardDriftRepository = {
      ...base,
      notePaperTick: async (id, note) => {
        if (noteFails) throw new Error("down");
        await base.notePaperTick(id, note);
      },
    };
    const { client, monitor } = await prepared({ bars, drift });
    await client.backtestRuns.drift.paperSet({ id: monitor.id, running: true });
    mode = "short";
    const short = await client.backtestRuns.drift.paperTick({});
    expect(short.results[0]?.note).toMatch(/^Tick failed: slow must be/u);
    expect(base.monitors.get(monitor.id)?.paperNote).toMatch(/^Tick failed/u);
    mode = "storage";
    noteFails = true;
    expect((await client.backtestRuns.drift.paperTick({})).results).toEqual([
      {
        monitorId: monitor.id,
        newPoints: 0,
        newTrades: 0,
        note: "Tick failed; the next tick retries",
        raised: 0,
      },
    ]);
    noteFails = false;
    await expect(
      client.backtestRuns.drift.paperTick({ id: monitor.id })
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it("fails closed without bar storage; read keys may not start or tick", async () => {
    const { monitor } = await prepared();
    await expectCode(
      clientFor({ runs: memoryRuns() }).backtestRuns.drift.paperTick({
        id: monitor.id,
      }),
      "STORAGE_ERROR",
      503
    );
    for (const name of ["paperSet", "paperTick"])
      expect(
        AGENT_API_KEY_READ_PROCEDURES.has(`backtestRuns.drift.${name}`)
      ).toBe(false);
  });
});

describe("backtest runs on the Nautilus engine", () => {
  const engine = BACKTEST_RUN_NAUTILUS_ENGINE;
  const spec = BacktestRunSubmitInputSchema.parse(
    submitInput
  ) as BacktestRunRecord["spec"];
  const rangeBars = sliceColumnsByDate(waveColumns(1000), spec.from, spec.to).t
    .length;
  const emptyStats = {
    bars: 0,
    buyHoldMaxDrawdown: 0,
    buyHoldReturn: 0,
    cagr: null,
    exposure: 0,
    maxDrawdown: 0,
    profitFactor: null,
    sharpe: null,
    sortino: null,
    totalReturn: 0,
    trades: 0,
    winRate: null,
  };
  const sectorDefinition = StrategyDefinitionSchema.parse({
    ...STRATEGY_TEMPLATES.smaCross,
    filters: [
      { quadrants: ["leading"], sector: "XLK", type: "sectorQuadrant" },
    ],
  });

  const queue = async (
    runs: ReturnType<typeof memoryRuns>,
    overrides: Partial<BacktestRunRecord> = {}
  ): Promise<BacktestRunRecord> => {
    const created = await runs.create({
      engineVersion: engine,
      requestedBy: "operator",
      spec,
      strategyId: null,
      strategyRevision: null,
      strategySnapshot: null,
    });
    const row = { ...created, ...overrides };
    runs.rows.set(row.id, row);
    return row;
  };

  type Claimed = NonNullable<
    Awaited<
      ReturnType<
        ReturnType<typeof clientFor>["backtestRuns"]["engine"]["claim"]
      >
    >["run"]
  >;

  /** The TypeScript engine result for a claimed run, in the JSON shape the worker posts. */
  const workerResult = (claimed: Claimed) => {
    const column = (values: readonly (number | null)[]) =>
      Float64Array.from(values, (value) => value ?? Number.NaN);
    const result = runInstantBacktest(
      {
        c: column(claimed.bars.c),
        h: column(claimed.bars.h),
        l: column(claimed.bars.l),
        o: column(claimed.bars.o),
        t: column(claimed.bars.t),
      },
      runParamsForSpec(claimed.spec as BacktestRunRecord["spec"])
    );
    return {
      equity: Array.from(result.equity),
      stats: result.stats,
      trades: [...result.trades],
    };
  };

  it("queues a submitted run for the worker and never runs it in the server", async () => {
    const runs = memoryRuns();
    const scheduled: Promise<unknown>[] = [];
    const bars = fakeBars();
    const client = clientFor({ bars, engine: "nautilus", runs, scheduled });
    const run = await client.backtestRuns.submit(submitInput);
    expect(run).toMatchObject({
      engineVersion: engine,
      report: null,
      status: "queued",
    });
    expect(scheduled).toHaveLength(0);
    // A fresh queued Nautilus run stays queued on read with either setting.
    runs.rows.set(run.id, {
      ...(runs.rows.get(run.id) as BacktestRunRecord),
      createdAt: new Date(),
    });
    expect((await client.backtestRuns.get({ id: run.id })).status).toBe(
      "queued"
    );
    const typescript = clientFor({ bars, runs, scheduled });
    expect((await typescript.backtestRuns.get({ id: run.id })).status).toBe(
      "queued"
    );
    expect(scheduled).toHaveLength(0);
    expect(bars.loadColumns).not.toHaveBeenCalled();

    // A stored TypeScript run keeps its engine under the Nautilus setting.
    const stored = await runs.create({
      engineVersion: BACKTEST_RUN_ENGINE_VERSION,
      requestedBy: "operator",
      spec,
      strategyId: null,
      strategyRevision: null,
      strategySnapshot: null,
    });
    expect((await client.backtestRuns.get({ id: stored.id })).status).toBe(
      "queued"
    );
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    expect(runs.rows.get(stored.id)?.status).toBe("succeeded");
  });

  it("fails a run that no worker claimed within the limit", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const old = await queue(runs);
    expect(await client.backtestRuns.get({ id: old.id })).toMatchObject({
      error: NAUTILUS_UNCLAIMED_ERROR,
      status: "failed",
    });

    // A worker claimed the run between the read and the conditional update.
    const raced = await queue(runs);
    const racing = clientFor({
      bars: fakeBars(),
      runs: { ...runs, failIfUnclaimed: async () => false },
    });
    expect((await racing.backtestRuns.get({ id: raced.id })).status).toBe(
      "queued"
    );

    // The re-read finds nothing: the first read is returned.
    const vanished = await queue(runs);
    let reads = 0;
    const vanishing = clientFor({
      bars: fakeBars(),
      runs: {
        ...runs,
        get: async (id) => {
          reads += 1;
          return reads === 1 ? (runs.rows.get(id) ?? null) : null;
        },
      },
    });
    expect((await vanishing.backtestRuns.get({ id: vanished.id })).id).toBe(
      vanished.id
    );
    expect(runs.rows.get(vanished.id)?.status).toBe("failed");
  });

  it("claims the oldest queued run of the engine with its bars and costs", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    await expect(client.backtestRuns.engine.claim({ engine })).resolves.toEqual(
      { run: null }
    );
    const typescript = await runs.create({
      engineVersion: BACKTEST_RUN_ENGINE_VERSION,
      requestedBy: "operator",
      spec,
      strategyId: null,
      strategyRevision: null,
      strategySnapshot: null,
    });
    const first = await queue(runs);
    const profile = COST_PROFILE_PRESETS["ibkr-pro-fixed-us-stock"];
    const second = await queue(runs, {
      spec: { ...spec, costProfile: profile },
    });

    const claimed = await client.backtestRuns.engine.claim({ engine });
    const expected = sliceColumnsByDate(waveColumns(1000), spec.from, spec.to);
    expect(claimed.run).toMatchObject({
      costs: null,
      id: first.id,
      sectorQuadrants: null,
      seriesSha256: "b".repeat(64),
      spec: { initialCapital: 50_000, symbol: "SPY" },
    });
    expect(claimed.run?.bars.t).toEqual(Array.from(expected.t));
    expect(claimed.run?.bars.c).toEqual(Array.from(expected.c));
    expect(claimed.run?.bars).not.toHaveProperty("v");
    expect(runs.rows.get(first.id)?.status).toBe("running");

    const withCosts = await client.backtestRuns.engine.claim({ engine });
    expect(withCosts.run).toMatchObject({
      costs: { capital: 50_000, profile },
      id: second.id,
    });
    await expect(client.backtestRuns.engine.claim({ engine })).resolves.toEqual(
      { run: null }
    );
    expect(runs.rows.get(typescript.id)?.status).toBe("queued");
  });

  it("sends sector rotation points and volume, with null for a missing value", async () => {
    const runs = memoryRuns();
    const columns = waveColumns(1000);
    const volume = Float64Array.from({ length: 1000 }, (_, index) =>
      index === 0 ? Number.NaN : 1000 + index
    );
    const listPoints = vi.fn(async () => [
      {
        benchmark: "SPY",
        computedAt: at,
        date: "1970-01-02",
        momentum: 101,
        quadrant: "leading" as const,
        ratio: 101,
        symbol: "XLK",
        timeframe: "weekly" as const,
      },
    ]);
    const client = clientFor({
      bars: fakeBars({
        loadColumns: vi.fn(async () => ({ ...columns, v: volume })),
      }),
      runs,
      sectorRotation: { listPoints },
    });
    await queue(runs, {
      spec: { ...spec, rule: { definition: sectorDefinition, kind: "dsl" } },
    });
    const claimed = await client.backtestRuns.engine.claim({ engine });
    expect(claimed.run?.sectorQuadrants).toEqual({
      "XLK:weekly": [{ date: "1970-01-02", quadrant: "leading" }],
    });
    expect(claimed.run?.bars.v?.slice(0, 2)).toEqual([null, 1001]);
  });

  it("fails runs whose inputs cannot be loaded and claims the next one", async () => {
    const runs = memoryRuns();
    const client = clientFor({
      bars: fakeBars({
        getSeries: vi.fn(async (symbol: string) =>
          symbol === "SPY" ? seriesRow : null
        ),
      }),
      runs,
    });
    const missing = await queue(runs, { spec: { ...spec, symbol: "QQQ" } });
    const empty = await queue(runs, {
      spec: { ...spec, from: "1990-01-01", to: "1990-12-31" },
    });
    const filtered = await queue(runs, {
      spec: { ...spec, rule: { definition: sectorDefinition, kind: "dsl" } },
    });
    const good = await queue(runs);
    expect((await client.backtestRuns.engine.claim({ engine })).run?.id).toBe(
      good.id
    );
    expect(runs.rows.get(missing.id)?.error).toBe("No stored 1d bars for QQQ");
    expect(runs.rows.get(empty.id)?.error).toBe(
      "Fewer than 2 bars for SPY between 1990-01-01 and 1990-12-31"
    );
    expect(runs.rows.get(filtered.id)?.error).toBe(
      "Sector quadrant data is not available for XLK (weekly)"
    );
  });

  it("stores a generic error for storage failures and stops after the attempt limit", async () => {
    const runs = memoryRuns();
    const client = clientFor({
      bars: fakeBars({
        loadColumns: vi.fn(async () => Promise.reject(new Error("db down"))),
      }),
      runs,
    });
    const queued = await Promise.all(
      Array.from({ length: ENGINE_CLAIM_ATTEMPTS + 1 }, () => queue(runs))
    );
    await expect(client.backtestRuns.engine.claim({ engine })).resolves.toEqual(
      { run: null }
    );
    const errors = queued.map((run) => runs.rows.get(run.id)?.error ?? null);
    expect(errors.slice(0, ENGINE_CLAIM_ATTEMPTS)).toEqual(
      Array.from(
        { length: ENGINE_CLAIM_ATTEMPTS },
        () => BACKTEST_RUN_STORAGE_ERROR
      )
    );
    expect(runs.rows.get(queued[ENGINE_CLAIM_ATTEMPTS]?.id ?? "")?.status).toBe(
      "queued"
    );
  });

  it("fails a run with more bars than the worker takes", async () => {
    const runs = memoryRuns();
    const size = BACKTEST_RUN_ENGINE_BARS_MAX + 1;
    const client = clientFor({
      bars: fakeBars({
        getSeries: vi.fn(async () => ({ ...seriesRow, barCount: size })),
        loadColumns: vi.fn(async () => {
          const t = Float64Array.from({ length: size }, (_, index) => index);
          return { c: t, h: t, l: t, o: t, t };
        }),
      }),
      runs,
    });
    const long = await queue(runs);
    await expect(client.backtestRuns.engine.claim({ engine })).resolves.toEqual(
      { run: null }
    );
    expect(runs.rows.get(long.id)?.error).toBe(
      `The date range has ${size} bars; the Nautilus worker takes at most ${BACKTEST_RUN_ENGINE_BARS_MAX}`
    );
  });

  it("builds the same report as the server engine from a worker result", async () => {
    const runs = memoryRuns();
    const profile = COST_PROFILE_PRESETS["ibkr-pro-fixed-us-stock"];
    const client = clientFor({ bars: fakeBars(), runs });
    const reference = await client.backtestRuns.submit({
      ...submitInput,
      costProfile: "ibkr-pro-fixed-us-stock",
    });
    const run = await queue(runs, { spec: { ...spec, costProfile: profile } });
    const claimed = (await client.backtestRuns.engine.claim({ engine }))
      .run as Claimed;
    const outcome = await client.backtestRuns.engine.complete({
      engine,
      id: run.id,
      result: workerResult(claimed),
      seriesSha256: claimed.seriesSha256,
    });
    expect(outcome).toEqual({ id: run.id, status: "succeeded" });
    const read = await client.backtestRuns.get({ id: run.id });
    expect(read.report).toEqual(reference.report);
    expect(read.report?.costs?.profileId).toBe("ibkr-pro-fixed-us-stock");
  });

  it("rejects a result for a run that is not running on the engine, without a change", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const queued = await queue(runs);
    const running = await queue(runs, {
      engineVersion: BACKTEST_RUN_ENGINE_VERSION,
      startedAt: at,
      status: "running",
    });
    const result = {
      equity: [1, 1],
      stats: { ...emptyStats, bars: 2 },
      trades: [],
    };
    const seriesSha256 = "b".repeat(64);
    for (const id of [queued.id, running.id]) {
      await expectCode(
        client.backtestRuns.engine.complete({
          engine,
          id,
          result,
          seriesSha256,
        }),
        "CONFLICT",
        409
      );
      await expectCode(
        client.backtestRuns.engine.fail({ engine, error: "boom", id }),
        "CONFLICT",
        409
      );
    }
    await expectCode(
      client.backtestRuns.engine.complete({
        engine,
        id: "missing",
        result,
        seriesSha256,
      }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      client.backtestRuns.engine.fail({ engine, error: "boom", id: "missing" }),
      "NOT_FOUND",
      404
    );
    expect(runs.rows.get(queued.id)?.status).toBe("queued");
    expect(runs.rows.get(running.id)?.status).toBe("running");
  });

  it("fails the run when the result does not fit the stored bars", async () => {
    const runs = memoryRuns();
    let symbol = "SPY";
    const client = clientFor({
      bars: fakeBars({
        getSeries: vi.fn(async () => (symbol === "SPY" ? seriesRow : null)),
      }),
      runs,
    });
    const reject = async (
      change: (claimed: Claimed) => Readonly<{
        result: ReturnType<typeof workerResult>;
        seriesSha256: string;
      }>,
      message: string
    ) => {
      const run = await queue(runs);
      symbol = "SPY";
      const claimed = (await client.backtestRuns.engine.claim({ engine }))
        .run as Claimed;
      const input = change(claimed);
      await expectCode(
        client.backtestRuns.engine.complete({ engine, id: run.id, ...input }),
        "BAD_REQUEST",
        400
      );
      expect(runs.rows.get(run.id)).toMatchObject({
        error: message,
        status: "failed",
      });
    };
    await reject(
      (claimed) => ({
        result: workerResult(claimed),
        seriesSha256: "c".repeat(64),
      }),
      "The stored bars changed while the backtest was running"
    );
    await reject(
      (claimed) => {
        const result = workerResult(claimed);
        const equity = result.equity.slice(1);
        return {
          result: {
            ...result,
            equity,
            stats: { ...result.stats, bars: equity.length, trades: 0 },
            trades: [],
          },
          seriesSha256: claimed.seriesSha256,
        };
      },
      `The engine result has ${rangeBars - 1} bars; the date range has ${rangeBars}`
    );
    await reject((claimed) => {
      symbol = "QQQ";
      return {
        result: workerResult(claimed),
        seriesSha256: claimed.seriesSha256,
      };
    }, "No stored 1d bars for SPY");
  });

  it("checks the result shape at the contract and leaves the run running", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const run = await queue(runs, { startedAt: at, status: "running" });
    const valid = {
      equity: [1, 1.01],
      stats: { ...emptyStats, bars: 2 },
      trades: [],
    };
    const trade = {
      entryIndex: 0,
      entryPrice: 100,
      exitIndex: 1,
      exitPrice: 101,
      exitReason: "signal" as const,
      netReturn: 0.01,
      pnl: 0.01,
      units: 0.01,
    };
    const invalid = [
      { ...valid, equity: [1] },
      { ...valid, stats: { ...valid.stats, bars: 3 } },
      { ...valid, trades: [trade] },
      {
        ...valid,
        stats: { ...valid.stats, trades: 1 },
        trades: [{ ...trade, exitIndex: 2 }],
      },
      {
        ...valid,
        stats: { ...valid.stats, trades: 1 },
        trades: [{ ...trade, entryIndex: 1, exitIndex: 0 }],
      },
      { ...valid, equity: [1, Number.POSITIVE_INFINITY] },
    ];
    for (const result of invalid) {
      expect(BacktestRunEngineResultSchema.safeParse(result).success).toBe(
        false
      );
      await expectCode(
        client.backtestRuns.engine.complete({
          engine,
          id: run.id,
          result,
          seriesSha256: "b".repeat(64),
        }),
        "BAD_REQUEST",
        400
      );
    }
    expect(
      BacktestRunEngineResultSchema.safeParse({
        ...valid,
        stats: { ...valid.stats, trades: 1 },
        trades: [trade],
      }).success
    ).toBe(true);
    expect(runs.rows.get(run.id)?.status).toBe("running");
  });

  it("stores a worker error and refuses a lost update", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const run = await queue(runs, { startedAt: at, status: "running" });
    await expect(
      client.backtestRuns.engine.fail({
        engine,
        error: " rvol needs bar volume ",
        id: run.id,
      })
    ).resolves.toEqual({ id: run.id, status: "failed" });
    expect(runs.rows.get(run.id)?.error).toBe("rvol needs bar volume");

    // Another caller finished the run between the read and the conditional update.
    const raced = await queue(runs, { startedAt: at, status: "running" });
    const racing = clientFor({
      bars: fakeBars(),
      runs: { ...runs, complete: async () => null, fail: async () => null },
    });
    await expectCode(
      racing.backtestRuns.engine.fail({ engine, error: "boom", id: raced.id }),
      "CONFLICT",
      409
    );
    const size = rangeBars;
    await expectCode(
      racing.backtestRuns.engine.complete({
        engine,
        id: raced.id,
        result: {
          equity: Array.from({ length: size }, () => 1),
          stats: { ...emptyStats, bars: size },
          trades: [],
        },
        seriesSha256: "b".repeat(64),
      }),
      "CONFLICT",
      409
    );
  });

  it("needs storage, an operator and a write key", async () => {
    await expectCode(
      clientFor({ bars: fakeBars() }).backtestRuns.engine.claim({ engine }),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor({
        bars: fakeBars(),
        runs: memoryRuns(),
        session: session("member"),
      }).backtestRuns.engine.claim({ engine }),
      "FORBIDDEN",
      403
    );
    for (const name of ["claim", "complete", "fail"])
      expect(
        AGENT_API_KEY_READ_PROCEDURES.has(`backtestRuns.engine.${name}`)
      ).toBe(false);
  });
});
