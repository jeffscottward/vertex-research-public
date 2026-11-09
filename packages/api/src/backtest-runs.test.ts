import { readFileSync } from "node:fs";

import {
  type AgentApiKeyService,
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
  MarketDailyColumns,
  MarketDailySeriesRepository,
  Repositories,
  StrategyLibraryRepository,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COST_PROFILE_PRESETS, ZERO_COST_PROFILE } from "./backtest-costs.ts";
import { sliceColumnsByDate } from "./bar-slice.ts";
import { canonicalJson, sha256Hex } from "./canonical-json.ts";
import { createApiClient } from "./client.ts";
import {
  BACKTEST_RUN_DEFAULT_CAPITAL,
  BACKTEST_RUN_ENGINE_BARS_MAX,
  BACKTEST_RUN_ENGINE_VERSION,
  BACKTEST_RUN_NAUTILUS_ENGINE,
  BACKTEST_RUN_TRADES_MAX,
  BacktestRunEngineOptionsResultSchema,
  BacktestRunEngineResultSchema,
  BacktestRunOptionsReportSchema,
  BacktestRunReportSchema,
  type BacktestRunSubmitInput,
  BacktestRunSubmitInputSchema,
  OPTIONS_NAUTILUS_PARITY_TOLERANCE,
} from "./contracts/backtest-runs.ts";
import {
  ENGINE_COMPARISON_SUPERSEDED_ERROR,
  ENGINE_COMPARISON_SWEEP_CELLS_MAX,
  EngineComparisonSpecSchema,
  NAUTILUS_GPU_NOTE,
  TIMER_FROZEN_NOTE,
} from "./contracts/engine-comparison.ts";
import {
  barsInPositionOf,
  runInstantBacktest,
  summarize,
} from "./instant-backtest-engine.ts";
import {
  optionsDatasetFromRows,
  optionsRunMetrics,
  runOptionsDefinition,
} from "./options-engine/portfolio.ts";
import { settledForwardTrades } from "./paper-forward.ts";
import {
  ENGINE_CLAIM_ATTEMPTS,
  ENGINE_STATS_TOLERANCE,
} from "./server/backtest-run-engine.ts";
import { runParamsForSpec } from "./server/backtest-run-params.ts";
import {
  BACKTEST_RUN_STORAGE_ERROR,
  executeBacktestRun,
  NAUTILUS_UNCLAIMED_ERROR,
  optionsRunBars,
  runOptionsBacktest,
} from "./server/backtest-runs.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import {
  COMPARISON_QUEUE_ERROR,
  clearInstantBacktestCacheForTesting,
} from "./server/instant-backtest.ts";
import { AGENT_API_KEY_READ_PROCEDURES } from "./server/operator-access.ts";
import type { SectorQuadrantSource } from "./server/sector-quadrant-series.ts";
import {
  runInputsSha256,
  strategySeriesInput,
  strategySeriesRowsSha256,
} from "./server/strategy-series.ts";
import {
  STRATEGY_TEMPLATES,
  StrategyDefinitionSchema,
} from "./strategy-dsl.ts";
import { runStrategyDefinition } from "./strategy-dsl-compile.ts";

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
  const groupOf = (row: BacktestRunRecord): unknown =>
    (row.spec.comparison as { groupId?: unknown } | undefined)?.groupId;
  const repository: BacktestRunsRepository & {
    rows: Map<string, BacktestRunRecord>;
  } = {
    claim: async (id) =>
      update(id, ["queued"], { startedAt: new Date(), status: "running" }),
    claimBatch: async (engineVersion, max) => {
      const first = await repository.claimNext(engineVersion);
      if (first === null) return [];
      const group = groupOf(first);
      if (group === undefined) return [first];
      const rest = [...rows.values()]
        .filter(
          (row) =>
            row.status === "queued" &&
            row.engineVersion === engineVersion &&
            groupOf(row) === group
        )
        .slice(0, max - 1)
        .map(
          (row) =>
            update(row.id, ["queued"], {
              startedAt: new Date(),
              status: "running",
            }) as BacktestRunRecord
        );
      return [first, ...rest];
    },
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
    enqueueGroup: async (input) => {
      const featureOf = (row: BacktestRunRecord): unknown =>
        (row.spec.comparison as { feature?: unknown } | undefined)?.feature;
      const { reuseSince } = input;
      const live =
        reuseSince !== undefined &&
        [...rows.values()].some(
          (row) =>
            groupOf(row) === input.groupId &&
            row.createdAt >= reuseSince &&
            row.status !== "failed"
        );
      if (!live) for (const run of input.runs) await repository.create(run);
      let superseded = 0;
      const { supersede } = input;
      if (supersede !== undefined)
        for (const row of [...rows.values()])
          if (
            row.status === "queued" &&
            row.engineVersion === supersede.engineVersion &&
            row.requestedBy === supersede.requestedBy &&
            featureOf(row) === supersede.feature &&
            groupOf(row) !== input.groupId
          ) {
            update(row.id, ["queued"], {
              error: input.supersededError,
              finishedAt: at,
              status: "failed",
            });
            superseded += 1;
          }
      return {
        created: live ? 0 : input.runs.length,
        reused: live,
        superseded,
      };
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
    failIfUnclaimed: async (id, engineVersion, before, error) => {
      const row = rows.get(id);
      const workerActive = [...rows.values()].some(
        (other) =>
          other.engineVersion === engineVersion &&
          other.startedAt !== null &&
          other.startedAt >= before
      );
      if (row === undefined || row.createdAt >= before || workerActive)
        return false;
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
            row.spec.comparison === undefined &&
            (filter.strategyId === undefined ||
              row.strategyId === filter.strategyId)
        )
        .slice(0, filter.limit),
    listComparisons: async (filter) =>
      [...rows.values()]
        .filter((row) => {
          const comparison = row.spec.comparison as
            | { feature?: unknown; groupId?: unknown }
            | undefined;
          return (
            comparison !== undefined &&
            (filter.feature === undefined ||
              comparison.feature === filter.feature) &&
            (filter.groupId === undefined ||
              comparison.groupId === filter.groupId)
          );
        })
        .slice(0, filter.limit)
        .map(({ report, ...row }) => ({
          ...row,
          differences:
            (report?.["differences"] as Record<string, unknown> | undefined) ??
            null,
          engineRun:
            (report?.["engineRun"] as Record<string, unknown> | undefined) ??
            null,
        })),
    rows,
  };
  return repository;
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
  dailySeries?: MarketDailySeriesRepository;
  engine?: "typescript" | "nautilus";
  comparison?: "off" | "on";
  /** Calls with an x-api-key of this access instead of the session. */
  apiKeyAccess?: "read" | "write";
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
    marketDailySeries: harness.dailySeries,
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
    const { apiKeyAccess } = harness;
    if (apiKeyAccess !== undefined) request.headers.set("x-api-key", "key");
    const context = createApiContext(request, {
      ...(apiKeyAccess === undefined
        ? {}
        : {
            agentApiKeys: {
              authenticate: async () => ({
                access: apiKeyAccess,
                apiKeyId: "key-1",
                email: "operator@domain.test",
                emailVerified: true,
                role: "member" as const,
                status: "active" as const,
                userId: "user-key",
              }),
            } as unknown as AgentApiKeyService,
          }),
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
      ...(harness.comparison === undefined
        ? {}
        : {
            engineComparison: harness.comparison,
            hostLabel: "QuantVPS web (in-request)",
          }),
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

  it("refuses an options block on intraday bars at submit, before queueing", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    await expect(
      client.backtestRuns.submit({
        ...submitInput,
        costBps: 0,
        rule: {
          definition: StrategyDefinitionSchema.parse({
            ...STRATEGY_TEMPLATES.smaCross,
            options: {
              dte: { min: 21, target: 45 },
              maxLossPct: 2,
              structure: "putCreditVertical",
              widthSigma: 0.5,
            },
          }),
          kind: "dsl",
        },
        timeframe: "1m",
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining(
        "STRATEGY_OPTIONS_TIMEFRAME_UNSUPPORTED"
      ),
      status: 422,
    });
    // calendarWindow counts trading days: refused on intraday timeframes, allowed on daily.
    await expect(
      client.backtestRuns.submit({
        ...submitInput,
        rule: {
          definition: StrategyDefinitionSchema.parse({
            ...STRATEGY_TEMPLATES.smaCross,
            filters: [{ type: "calendarWindow", window: "opexWeek" }],
          }),
          kind: "dsl",
        },
        timeframe: "1m",
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining(
        "STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED"
      ),
      status: 422,
    });
    expect(runs.rows.size).toBe(0);
    const calendar = await client.backtestRuns.submit({
      ...submitInput,
      rule: {
        definition: StrategyDefinitionSchema.parse({
          ...STRATEGY_TEMPLATES.smaCross,
          filters: [{ months: [1], type: "calendarWindow", window: "months" }],
        }),
        kind: "dsl",
      },
    });
    expect(calendar.status).toBe("succeeded");
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

  it("fails a queued calendarWindow run on intraday bars with the typed refusal", async () => {
    const runs = memoryRuns();
    const run = await queue(runs, {
      rule: {
        definition: StrategyDefinitionSchema.parse({
          ...STRATEGY_TEMPLATES.smaCross,
          filters: [{ type: "calendarWindow", window: "opexWeek" }],
        }),
        kind: "dsl",
      },
      timeframe: "1m",
    });
    await executeBacktestRun({ marketBars: fakeBars(), runs }, run.id);
    expect(runs.rows.get(run.id)?.error).toContain(
      "STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED"
    );
  });

  it("fails a queued options run with run-level costs and a series run without the series store", async () => {
    const runs = memoryRuns();
    const queued = async (extra: Record<string, unknown>) =>
      await queue(runs, {
        rule: {
          definition: StrategyDefinitionSchema.parse({
            ...STRATEGY_TEMPLATES.smaCross,
            ...extra,
          }),
          kind: "dsl",
        },
      });
    const options = await queued({
      options: {
        dte: { min: 20, target: 30 },
        maxLossPct: 1,
        structure: "callDebitVertical",
        widthSigma: 1,
      },
    });
    const series = await queued({
      filters: [
        {
          condition: {
            left: { field: "close", type: "price" },
            op: ">",
            right: { type: "const", value: 0 },
          },
          series: "GC=F",
          type: "series",
        },
      ],
    });
    for (const run of [options, series])
      await executeBacktestRun({ marketBars: fakeBars(), runs }, run.id);
    expect(runs.rows.get(options.id)?.status).toBe("failed");
    expect(runs.rows.get(options.id)?.error).toBe(
      "Options definitions charge the options book costs; set costBps to 0 and leave out costProfile."
    );
    expect(runs.rows.get(series.id)?.error).toBe(
      "The daily series store is not available on this server (needed for GC=F)"
    );
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

  it("keeps the backlog queued while a worker is busy", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    await queue(runs, { startedAt: new Date(), status: "running" });
    const waiting = await queue(runs);
    expect((await client.backtestRuns.get({ id: waiting.id })).status).toBe(
      "queued"
    );
    // A TypeScript run that started recently is not Nautilus worker activity.
    const idle = memoryRuns();
    await idle.create({
      engineVersion: BACKTEST_RUN_ENGINE_VERSION,
      requestedBy: "operator",
      spec,
      strategyId: null,
      strategyRevision: null,
      strategySnapshot: null,
    });
    idle.rows.set("run-1", {
      ...(idle.rows.get("run-1") as BacktestRunRecord),
      startedAt: new Date(),
      status: "running",
    });
    const stuck = await queue(idle);
    expect(
      (
        await clientFor({ bars: fakeBars(), runs: idle }).backtestRuns.get({
          id: stuck.id,
        })
      ).error
    ).toBe(NAUTILUS_UNCLAIMED_ERROR);
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

  it("fails options runs with run-level costs and series runs without the store at claim", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const refused = (extra: Record<string, unknown>) =>
      queue(runs, {
        spec: {
          ...spec,
          rule: {
            definition: StrategyDefinitionSchema.parse({
              ...STRATEGY_TEMPLATES.smaCross,
              ...extra,
            }),
            kind: "dsl",
          },
        },
      });
    const options = await refused({
      options: {
        dte: { min: 21, target: 45 },
        maxLossPct: 2,
        structure: "callCreditVertical",
        widthSigma: 0.5,
      },
    });
    const term = await refused({
      filters: [{ maxRatio: 1, type: "vixTermStructure" }],
    });
    const good = await queue(runs);
    expect((await client.backtestRuns.engine.claim({ engine })).run?.id).toBe(
      good.id
    );
    expect(runs.rows.get(options.id)?.error).toContain(
      "Options definitions charge the options book costs"
    );
    expect(runs.rows.get(term.id)?.error).toBe(
      "The daily series store is not available on this server (needed for VIX, VIX3M)"
    );
  });

  it("fails refused runs inside a batch claim (max N) and claims the next batch", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const refusedSpec = (extra: Record<string, unknown>) => ({
      spec: {
        ...spec,
        rule: {
          definition: StrategyDefinitionSchema.parse({
            ...STRATEGY_TEMPLATES.smaCross,
            ...extra,
          }),
          kind: "dsl" as const,
        },
      },
    });
    const options = await queue(
      runs,
      refusedSpec({
        options: {
          dte: { min: 20, target: 30 },
          maxLossPct: 2,
          structure: "putDebitVertical",
          widthSigma: 1,
        },
      })
    );
    const rank = await queue(
      runs,
      refusedSpec({ filters: [{ min: 50, type: "ivRank" }] })
    );
    const good = await queue(runs);
    const { batch } = await client.backtestRuns.engine.claim({
      engine,
      max: 5,
    });
    expect(batch?.runs.map((entry) => entry.id)).toEqual([good.id]);
    expect(runs.rows.get(options.id)?.error).toContain(
      "Options definitions charge the options book costs"
    );
    expect(runs.rows.get(rank.id)?.error).toBe(
      "The daily series store is not available on this server (needed for VIX)"
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

  it("recomputes the same stats from the equity and the trades of every exit kind", () => {
    const columns = waveColumns(1000);
    // A rising series stays in its position to the last bar (exit reason "end").
    const close = Float64Array.from({ length: 50 }, (_, index) => 100 + index);
    const rising = {
      c: close,
      h: close.map((value) => value + 1),
      l: close.map((value) => value - 1),
      o: close,
      t: Float64Array.from({ length: 50 }, (_, index) => index * DAY_MS),
    };
    const results = [
      runInstantBacktest(columns, {
        costBps: 5,
        rule: { fast: 5, kind: "smaCross", slow: 30 },
        stopLossPct: 2,
        takeProfitPct: 4,
      }),
      runInstantBacktest(columns, {
        costBps: 0,
        costs: {
          capital: 50_000,
          profile: COST_PROFILE_PRESETS["ibkr-pro-fixed-us-stock"],
        },
        rule: {
          entryLookback: 20,
          exitLookback: 10,
          kind: "breakout",
          trendSma: 0,
        },
        stopLossPct: 0,
        takeProfitPct: 0,
      }),
      runInstantBacktest(rising, {
        costBps: 0,
        rule: { fast: 2, kind: "smaCross", slow: 5 },
        stopLossPct: 0,
        takeProfitPct: 0,
      }),
      runInstantBacktest(columns, {
        costBps: 1,
        rule: { fast: 5, kind: "smaCross", slow: 30 },
        stopLossPct: 0,
        takeProfitPct: 0,
      }),
    ];
    const reasons = new Set<string>();
    for (const [index, result] of results.entries()) {
      const bars = index === 2 ? rising : columns;
      for (const trade of result.trades) reasons.add(trade.exitReason);
      expect(
        summarize(
          bars,
          result.equity,
          result.trades,
          barsInPositionOf(result.trades)
        )
      ).toEqual(result.stats);
    }
    expect([...reasons].sort()).toEqual(["end", "signal", "stop", "target"]);
  });

  it("refuses a result whose stats differ from its equity and trades", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), runs });
    const complete = async (
      change: (
        result: ReturnType<typeof workerResult>
      ) => ReturnType<typeof workerResult>
    ) => {
      const run = await queue(runs);
      const claimed = (await client.backtestRuns.engine.claim({ engine }))
        .run as Claimed;
      return {
        outcome: client.backtestRuns.engine.complete({
          engine,
          id: run.id,
          result: change(workerResult(claimed)),
          seriesSha256: claimed.seriesSha256,
        }),
        run,
      };
    };
    for (const [change, key] of [
      [
        (result: ReturnType<typeof workerResult>) => ({
          ...result,
          stats: {
            ...result.stats,
            sharpe: (result.stats.sharpe ?? 0) * 1.000_001,
          },
        }),
        "sharpe",
      ],
      [
        (result: ReturnType<typeof workerResult>) => ({
          ...result,
          stats: { ...result.stats, profitFactor: null },
        }),
        "profitFactor",
      ],
    ] as const) {
      const { outcome, run } = await complete(change);
      await expectCode(outcome, "BAD_REQUEST", 400);
      expect(runs.rows.get(run.id)).toMatchObject({
        error: `The engine stats do not match its equity and trades (${key})`,
        status: "failed",
      });
    }
    // Within the tolerance the API stores its own stats.
    const close = await complete((result) => ({
      ...result,
      stats: {
        ...result.stats,
        totalReturn:
          result.stats.totalReturn * (1 + ENGINE_STATS_TOLERANCE / 10),
      },
    }));
    await expect(close.outcome).resolves.toMatchObject({ status: "succeeded" });
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
      { ...valid, equity: [1, 0] },
      { ...valid, equity: [1, -0.5] },
      {
        ...valid,
        stats: { ...valid.stats, trades: 1 },
        trades: [{ ...trade, units: 0 }],
      },
      {
        ...valid,
        stats: { ...valid.stats, trades: 1 },
        trades: [{ ...trade, pnl: Number.NaN }],
      },
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
    await queue(runs);
    const racing = clientFor({
      bars: fakeBars(),
      runs: { ...runs, complete: async () => null, fail: async () => null },
    });
    await expectCode(
      racing.backtestRuns.engine.fail({ engine, error: "boom", id: raced.id }),
      "CONFLICT",
      409
    );
    const claimed = (await client.backtestRuns.engine.claim({ engine }))
      .run as Claimed;
    await expectCode(
      racing.backtestRuns.engine.complete({
        engine,
        id: raced.id,
        result: workerResult(claimed),
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

describe("engine comparison (dual run)", () => {
  const engine = BACKTEST_RUN_NAUTILUS_ENGINE;
  const host = "QuantVPS web (in-request)";
  const instantInput = {
    costBps: 5,
    rule: { fast: 5, kind: "smaCross" as const, slow: 30 },
    stopLossPct: 0,
    symbol: "SPY",
    takeProfitPct: 0,
    timeframe: "1d" as const,
  };
  const sweepInput = {
    dimensions: [
      { from: 2, param: "fast" as const, step: 1, to: 12 },
      { from: 20, param: "slow" as const, step: 1, to: 30 },
    ],
    from: "1970-01-01",
    rule: { fast: 5, kind: "smaCross" as const, slow: 30 },
    symbol: "SPY",
    timeframe: "1d" as const,
    to: "1971-12-31",
  };
  const comparisonRuns = (runs: ReturnType<typeof memoryRuns>) =>
    [...runs.rows.values()].filter((row) => row.spec.comparison !== undefined);
  const comparisonOf = (row: BacktestRunRecord) =>
    EngineComparisonSpecSchema.parse(row.spec.comparison);

  type Batch = NonNullable<
    Awaited<
      ReturnType<
        ReturnType<typeof clientFor>["backtestRuns"]["engine"]["claim"]
      >
    >["batch"]
  >;

  /** The TypeScript result of one batch run, in the JSON shape the worker posts. */
  const batchResult = (batch: Batch, index: number) => {
    const run = batch.runs[index] as Batch["runs"][number];
    const column = (values: readonly (number | null)[]) =>
      Float64Array.from(
        values.slice(run.first, run.end),
        (value) => value ?? Number.NaN
      );
    const result = runInstantBacktest(
      {
        c: column(batch.bars.c),
        h: column(batch.bars.h),
        l: column(batch.bars.l),
        o: column(batch.bars.o),
        t: column(batch.bars.t),
      },
      runParamsForSpec(run.spec as BacktestRunRecord["spec"])
    );
    return {
      equity: Array.from(result.equity),
      stats: result.stats,
      trades: [...result.trades],
    };
  };

  const engineRun = {
    cpuMs: 120,
    gpu: NAUTILUS_GPU_NOTE,
    host: "rig",
    processCases: 3,
    processes: 2,
    processWallMs: 900,
    wallMs: 310,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queues an instant backtest on Nautilus with its TypeScript result when on", async () => {
    const runs = memoryRuns();
    const off = await clientFor({ bars: fakeBars(), runs }).instantBacktest.run(
      instantInput
    );
    expect(off).not.toHaveProperty("comparison");
    expect(runs.rows.size).toBe(0);

    const client = clientFor({ bars: fakeBars(), comparison: "on", runs });
    const answer = await client.instantBacktest.run(instantInput);
    expect(answer.comparison).toMatchObject({
      groupId: expect.any(String),
      host,
    });
    const [row] = comparisonRuns(runs);
    expect(row).toMatchObject({
      engineVersion: engine,
      requestedBy: "operator",
      spec: {
        costBps: 5,
        from: "1970-01-01",
        initialCapital: BACKTEST_RUN_DEFAULT_CAPITAL,
        rule: instantInput.rule,
        symbol: "SPY",
        timeframe: "1d",
        to: "1972-09-26",
      },
      status: "queued",
    });
    const comparison = comparisonOf(row as BacktestRunRecord);
    expect(comparison).toMatchObject({
      feature: "instant",
      groupId: answer.comparison?.groupId,
      label: "SPY 1d smaCross",
    });
    expect(comparison.typescript.stats).toEqual(answer.stats);
    expect(comparison.typescript.host).toBe(host);
    expect(comparison.typescript.tradeCount).toBe(answer.stats.trades);
    // Comparison runs stay out of the backtest run list.
    expect((await client.backtestRuns.list({})).runs).toEqual([]);
  });

  it("queues sweep comparison runs only for a write caller, never for a read key", async () => {
    // backtestRuns.sweep is a read procedure; queueing Nautilus runs is a write.
    const sweep = {
      ...sweepInput,
      dimensions: [{ from: 5, param: "fast" as const, step: 5, to: 10 }],
    };
    const runs = memoryRuns();
    const read = clientFor({
      apiKeyAccess: "read",
      bars: fakeBars(),
      comparison: "on",
      runs,
    });
    const answer = await read.backtestRuns.sweep(sweep);
    expect(answer.comparison).toBeUndefined();
    expect(answer.cells.length).toBeGreaterThan(0);
    expect(comparisonRuns(runs)).toHaveLength(0);
    const write = clientFor({
      apiKeyAccess: "write",
      bars: fakeBars(),
      comparison: "on",
      runs,
    });
    const queued = await write.backtestRuns.sweep(sweep);
    expect(queued.comparison).toMatchObject({ queued: 2 });
    expect(comparisonRuns(runs).map((row) => row.requestedBy)).toEqual([
      "user-key",
      "user-key",
    ]);
  });

  it("reuses an identical request's group and supersedes older queued runs of the same feature", async () => {
    // The memory repository dates every run at `at`; the queue reuses groups from the last 24 h.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(at.getTime() + 60 * 60 * 1000));
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), comparison: "on", runs });
    const first = await client.instantBacktest.run(instantInput);
    expect(first.comparison).toMatchObject({ reused: false, superseded: 0 });
    const again = await client.instantBacktest.run(instantInput);
    expect(again.comparison).toMatchObject({
      groupId: first.comparison?.groupId,
      reused: true,
      superseded: 0,
    });
    expect(comparisonRuns(runs)).toHaveLength(1);
    // Another cost setting is another group: the older queued instant run is superseded.
    const changed = await client.instantBacktest.run({
      ...instantInput,
      costBps: 9,
    });
    expect(changed.comparison?.groupId).not.toBe(first.comparison?.groupId);
    expect(changed.comparison).toMatchObject({ reused: false, superseded: 1 });
    const older = comparisonRuns(runs).find(
      (row) => comparisonOf(row).groupId === first.comparison?.groupId
    );
    expect(older).toMatchObject({
      error: ENGINE_COMPARISON_SUPERSEDED_ERROR,
      status: "failed",
    });
    // Asking for the first request again queues it again (its run was superseded).
    const back = await client.instantBacktest.run(instantInput);
    expect(back.comparison).toMatchObject({
      groupId: first.comparison?.groupId,
      reused: false,
      superseded: 1,
    });
    // Sweeps: an identical sweep reuses its group, a changed one supersedes it; instant runs stay.
    const sweep = {
      ...sweepInput,
      dimensions: [{ from: 5, param: "fast" as const, step: 5, to: 10 }],
    };
    const s1 = await client.backtestRuns.sweep(sweep);
    const s2 = await client.backtestRuns.sweep(sweep);
    expect(s2.comparison).toMatchObject({
      groupId: s1.comparison?.groupId,
      reused: true,
    });
    const s3 = await client.backtestRuns.sweep({ ...sweep, to: "1971-06-30" });
    expect(s3.comparison).toMatchObject({ reused: false, superseded: 2 });
    expect(
      comparisonRuns(runs).filter(
        (row) =>
          row.status === "queued" && comparisonOf(row).feature === "instant"
      )
    ).toHaveLength(1);
    vi.useRealTimers();
  });

  it("records a frozen Worker clock as no time, and a failed queue as an error only", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const runs = memoryRuns();
    const frozen = await clientFor({
      bars: fakeBars(),
      comparison: "on",
      runs,
    }).instantBacktest.run(instantInput);
    expect(frozen.comparison).toMatchObject({
      wallMs: null,
      wallNote: TIMER_FROZEN_NOTE,
    });
    expect(
      comparisonOf(comparisonRuns(runs)[0] as BacktestRunRecord)
    ).toMatchObject({
      typescript: { wallMs: null, wallNote: TIMER_FROZEN_NOTE },
    });
    vi.restoreAllMocks();
    const broken = clientFor({
      bars: fakeBars(),
      comparison: "on",
      runs: {
        ...memoryRuns(),
        enqueueGroup: async () => Promise.reject(new Error("db")),
      },
    });
    const answer = await broken.instantBacktest.run(instantInput);
    expect(answer.comparison).toMatchObject({
      error: COMPARISON_QUEUE_ERROR,
      groupId: null,
    });
    expect(answer.stats.trades).toBeGreaterThan(0);
    // Without run storage nothing is queued and the answer has no comparison.
    const noStorage = await clientFor({
      bars: fakeBars(),
      comparison: "on",
    }).instantBacktest.run(instantInput);
    expect(noStorage).not.toHaveProperty("comparison");
  });

  it("queues at most the cap of sweep cells, one run per cell with its parameters", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), comparison: "on", runs });
    // Each clock read moves 1 ms: every cell takes 1 ms, so the total counts all 121 cells,
    // while only the first 100 cells keep their full results.
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      now += 1;
      return now;
    });
    const sweep = await client.backtestRuns.sweep(sweepInput);
    vi.restoreAllMocks();
    expect(sweep.comparison?.wallMs).toBe(121);
    expect(sweep.cells).toHaveLength(121);
    expect(sweep.comparison).toMatchObject({
      dropped: 21,
      groupId: expect.any(String),
      host,
      queued: ENGINE_COMPARISON_SWEEP_CELLS_MAX,
    });
    const queued = comparisonRuns(runs).map(comparisonOf);
    expect(queued).toHaveLength(ENGINE_COMPARISON_SWEEP_CELLS_MAX);
    expect(queued[0]).toMatchObject({
      dropped: 21,
      feature: "sweep",
      key: "0",
      label: "fast=2, slow=20",
    });
    expect(queued[0]?.typescript.stats.totalReturn).toBe(
      sweep.cells[0]?.metrics.totalReturn
    );
    const first = comparisonRuns(runs)[0] as BacktestRunRecord;
    expect(first.spec).toMatchObject({
      from: "1970-01-01",
      rule: { fast: 2, kind: "smaCross", slow: 20 },
      to: "1971-12-31",
    });
  });

  it("leaves engine error cells out and reports frozen clocks and queue failures", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), comparison: "on", runs });
    // fast >= slow makes the engine refuse the cell.
    const mixed = await client.backtestRuns.sweep({
      ...sweepInput,
      dimensions: [{ from: 25, param: "fast", step: 5, to: 40 }],
    });
    expect(mixed.cells.filter((cell) => cell.error !== null)).toHaveLength(3);
    expect(mixed.comparison).toMatchObject({ dropped: 0, queued: 1 });
    const none = await client.backtestRuns.sweep({
      ...sweepInput,
      dimensions: [{ from: 30, param: "fast", step: 5, to: 40 }],
    });
    expect(none.comparison).toEqual({
      dropped: 0,
      groupId: null,
      host,
      queued: 0,
      wallMs: 0,
    });
    vi.spyOn(performance, "now").mockReturnValue(5);
    const frozen = await client.backtestRuns.sweep({
      ...sweepInput,
      dimensions: [{ from: 5, param: "fast", step: 5, to: 10 }],
    });
    expect(frozen.comparison).toMatchObject({
      queued: 2,
      wallMs: null,
      wallNote: TIMER_FROZEN_NOTE,
    });
    vi.restoreAllMocks();
    const broken = await clientFor({
      bars: fakeBars(),
      comparison: "on",
      runs: {
        ...memoryRuns(),
        enqueueGroup: async () => Promise.reject(new Error("db")),
      },
    }).backtestRuns.sweep({
      ...sweepInput,
      dimensions: [{ from: 5, param: "fast", step: 5, to: 10 }],
    });
    expect(broken.comparison).toMatchObject({
      error: COMPARISON_QUEUE_ERROR,
      groupId: null,
      queued: 0,
    });
    const off = await clientFor({ bars: fakeBars(), runs }).backtestRuns.sweep(
      sweepInput
    );
    expect(off).not.toHaveProperty("comparison");
  });

  it("claims a comparison group as one batch on shared bars with each run's range", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), comparison: "on", runs });
    await expect(
      client.backtestRuns.engine.claim({ engine, max: 50 })
    ).resolves.toEqual({ batch: null, run: null });
    const typescript = {
      host,
      stats: {
        bars: 2,
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
      },
      tradeCount: 0,
      trades: [],
      wallMs: 1,
    };
    const base = BacktestRunSubmitInputSchema.parse(
      submitInput
    ) as BacktestRunRecord["spec"];
    const make = (spec: Partial<BacktestRunRecord["spec"]>, groupId = "g-1") =>
      runs.create({
        engineVersion: engine,
        requestedBy: "operator",
        spec: {
          ...base,
          ...spec,
          comparison: { feature: "sweep", groupId, label: "x", typescript },
        },
        strategyId: null,
        strategyRevision: null,
        strategySnapshot: null,
      });
    const wide = await make({ from: "1970-01-01", to: "1970-12-31" });
    const late = await make({ from: "1970-03-01", to: "1971-01-31" });
    const otherSymbol = await make({ symbol: "QQQ" });
    const empty = await make({ from: "1990-01-01", to: "1990-12-31" });
    const otherGroup = await make({}, "g-2");
    const { batch, run } = await client.backtestRuns.engine.claim({
      engine,
      max: 50,
    });
    expect(run).toBeNull();
    expect(batch?.runs.map((entry) => entry.id)).toEqual([wide.id, late.id]);
    expect(batch?.seriesSha256).toBe("b".repeat(64));
    // Shared bars from the earliest from (1970-01-01) to the latest to (1971-01-31).
    expect(batch?.bars.t).toHaveLength(396);
    expect(batch?.runs[0]).toMatchObject({ end: 365, first: 0 });
    expect(batch?.runs[1]).toMatchObject({ end: 396, first: 59 });
    expect(runs.rows.get(otherSymbol.id)?.error).toBe(
      "The comparison batch mixes bar series; submit the run again"
    );
    expect(runs.rows.get(empty.id)?.error).toBe(
      "Fewer than 2 bars for SPY between 1990-01-01 and 1990-12-31"
    );
    expect(runs.rows.get(otherGroup.id)?.status).toBe("queued");
    // A run without a group comes alone; without max the old single answer stays.
    const lone = await runs.create({
      engineVersion: engine,
      requestedBy: "operator",
      spec: base,
      strategyId: null,
      strategyRevision: null,
      strategySnapshot: null,
    });
    runs.rows.delete(otherGroup.id);
    const single = await client.backtestRuns.engine.claim({ engine, max: 50 });
    expect(single.batch?.runs.map((entry) => entry.id)).toEqual([lone.id]);
  });

  it("stops after the claim attempts when every claimed batch fails its inputs", async () => {
    const runs = memoryRuns();
    const client = clientFor({
      bars: fakeBars({ getSeries: vi.fn(async () => null) }),
      runs,
    });
    const base = BacktestRunSubmitInputSchema.parse(
      submitInput
    ) as BacktestRunRecord["spec"];
    for (let index = 0; index < ENGINE_CLAIM_ATTEMPTS + 1; index += 1)
      await runs.create({
        engineVersion: engine,
        requestedBy: "operator",
        spec: base,
        strategyId: null,
        strategyRevision: null,
        strategySnapshot: null,
      });
    await expect(
      client.backtestRuns.engine.claim({ engine, max: 10 })
    ).resolves.toEqual({ batch: null, run: null });
    expect(
      [...runs.rows.values()].filter((row) => row.status === "failed")
    ).toHaveLength(ENGINE_CLAIM_ATTEMPTS);
  });

  it("stores a batch in one request with differences, engine runs and one outcome per item", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), comparison: "on", runs });
    await client.backtestRuns.sweep({
      ...sweepInput,
      dimensions: [{ from: 5, param: "fast", step: 5, to: 15 }],
    });
    const { batch } = await client.backtestRuns.engine.claim({
      engine,
      max: 50,
    });
    const claimed = batch as Batch;
    expect(claimed.runs).toHaveLength(3);
    const [first, second, third] = claimed.runs;
    const shifted = batchResult(claimed, 1);
    const queuedRun = await runs.create({
      engineVersion: engine,
      requestedBy: "operator",
      spec: claimed.runs[0]?.spec as BacktestRunRecord["spec"],
      strategyId: null,
      strategyRevision: null,
      strategySnapshot: null,
    });
    const { outcomes } = await client.backtestRuns.engine.completeMany({
      engine,
      items: [
        {
          engineRun,
          id: first?.id as string,
          result: batchResult(claimed, 0),
          seriesSha256: claimed.seriesSha256,
        },
        {
          id: second?.id as string,
          result: {
            ...shifted,
            equity: shifted.equity.slice(1),
            stats: {
              ...shifted.stats,
              bars: shifted.equity.length - 1,
              trades: 0,
            },
            trades: [],
          },
          seriesSha256: claimed.seriesSha256,
        },
        { error: "At least 2 bars needed", id: third?.id as string },
        { error: "boom", id: "missing" },
        { error: "boom", id: queuedRun.id },
        { error: "boom", id: third?.id as string },
      ],
    });
    expect(outcomes).toEqual([
      { id: first?.id, status: "succeeded" },
      {
        error: "BAD_REQUEST",
        id: second?.id,
        message: `The engine result has ${shifted.equity.length - 1} bars; the date range has ${shifted.equity.length}`,
        status: null,
      },
      { id: third?.id, status: "failed" },
      {
        error: "NOT_FOUND",
        id: "missing",
        message: "Backtest run not found",
        status: null,
      },
      { error: "CONFLICT", id: queuedRun.id, status: null },
      { error: "CONFLICT", id: third?.id, status: null },
    ]);
    const report = runs.rows.get(first?.id as string)?.report;
    expect(report?.["engineRun"]).toEqual(engineRun);
    expect(report?.["differences"]).toEqual({ items: [], ok: true });
    expect(runs.rows.get(third?.id as string)?.error).toBe(
      "At least 2 bars needed"
    );
  });

  it("flags differences, an unreadable stored comparison, and stores engineRun on complete", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), comparison: "on", runs });
    await client.instantBacktest.run(instantInput);
    const [stored] = comparisonRuns(runs);
    const typescript = comparisonOf(stored as BacktestRunRecord).typescript;
    runs.rows.set((stored as BacktestRunRecord).id, {
      ...(stored as BacktestRunRecord),
      spec: {
        ...(stored as BacktestRunRecord).spec,
        comparison: {
          ...(stored?.spec.comparison as Record<string, unknown>),
          typescript: { ...typescript, tradeCount: typescript.tradeCount + 1 },
        },
      },
    });
    const claimed = (await client.backtestRuns.engine.claim({ engine, max: 1 }))
      .batch as Batch;
    const outcome = await client.backtestRuns.engine.complete({
      engine,
      engineRun,
      id: claimed.runs[0]?.id as string,
      result: batchResult(claimed, 0),
      seriesSha256: claimed.seriesSha256,
    });
    expect(outcome.status).toBe("succeeded");
    const report = runs.rows.get(outcome.id)?.report;
    expect(report?.["engineRun"]).toEqual(engineRun);
    expect(report?.["differences"]).toMatchObject({
      items: [{ field: "tradeCount" }],
      ok: false,
    });

    await client.instantBacktest.run(instantInput);
    const broken = comparisonRuns(runs).find((row) => row.status === "queued");
    runs.rows.set((broken as BacktestRunRecord).id, {
      ...(broken as BacktestRunRecord),
      spec: {
        ...(broken as BacktestRunRecord).spec,
        comparison: { feature: "instant" },
      },
    });
    const again = (await client.backtestRuns.engine.claim({ engine, max: 1 }))
      .batch as Batch;
    await client.backtestRuns.engine.completeMany({
      engine,
      items: [
        {
          id: again.runs[0]?.id as string,
          result: batchResult(again, 0),
          seriesSha256: again.seriesSha256,
        },
      ],
    });
    const unreadable = runs.rows.get(again.runs[0]?.id as string)?.report;
    expect(unreadable?.["differences"]).toMatchObject({
      items: [{ field: "comparison" }],
      ok: false,
    });
    expect(unreadable).not.toHaveProperty("engineRun");
  });

  it("lists comparison runs with timing and differences, by feature and group", async () => {
    const runs = memoryRuns();
    const client = clientFor({ bars: fakeBars(), comparison: "on", runs });
    const instant = await client.instantBacktest.run(instantInput);
    await client.backtestRuns.sweep({
      ...sweepInput,
      dimensions: [{ from: 5, param: "fast", step: 5, to: 10 }],
    });
    const listed = await client.backtestRuns.comparisons.list({});
    expect(listed.runs).toHaveLength(3);
    const group = await client.backtestRuns.comparisons.list({
      groupId: instant.comparison?.groupId as string,
    });
    expect(group.runs).toEqual([
      expect.objectContaining({
        differences: null,
        engineRun: null,
        engineVersion: engine,
        from: "1970-01-01",
        queueWaitMs: null,
        status: "queued",
        symbol: "SPY",
        timeframe: "1d",
        to: "1972-09-26",
      }),
    ]);
    const sweeps = await client.backtestRuns.comparisons.list({
      feature: "sweep",
      limit: 1,
    });
    expect(sweeps.runs).toHaveLength(1);
    // Claimed and completed: the queue wait, the engine run and the differences appear.
    const claimed = (await client.backtestRuns.engine.claim({ engine, max: 1 }))
      .batch as Batch;
    const id = claimed.runs[0]?.id as string;
    const row = runs.rows.get(id) as BacktestRunRecord;
    runs.rows.set(id, { ...row, startedAt: new Date(at.getTime() + 4000) });
    await client.backtestRuns.engine.complete({
      engine,
      engineRun,
      id,
      result: batchResult(claimed, 0),
      seriesSha256: claimed.seriesSha256,
    });
    const done = (await client.backtestRuns.comparisons.list({})).runs.find(
      (entry) => entry.id === id
    );
    expect(done).toMatchObject({
      differences: { ok: true },
      engineRun,
      queueWaitMs: 4000,
      status: "succeeded",
    });
    // A run whose comparison part is unreadable is left out.
    runs.rows.set(id, {
      ...(runs.rows.get(id) as BacktestRunRecord),
      spec: { ...row.spec, comparison: { feature: "instant" } },
    });
    expect((await client.backtestRuns.comparisons.list({})).runs).toHaveLength(
      2
    );
    await expectCode(
      clientFor({ bars: fakeBars() }).backtestRuns.comparisons.list({}),
      "STORAGE_ERROR",
      503
    );
    expect(
      AGENT_API_KEY_READ_PROCEDURES.has("backtestRuns.comparisons.list")
    ).toBe(true);
    expect(
      AGENT_API_KEY_READ_PROCEDURES.has("backtestRuns.engine.completeMany")
    ).toBe(false);
  });
});

describe("daily series and options runs", () => {
  const engine = BACKTEST_RUN_NAUTILUS_ENGINE;
  const barsSha = seriesRow.sourceSha256;
  // 640 weekdays from 1970-01-01 to 1972-06-14: synthetic store rows of SPY, QQQ and indices.
  const DATES: string[] = [];
  for (let day = 0; DATES.length < 640; day += 1) {
    const date = new Date(day * DAY_MS);
    if (date.getUTCDay() % 6 !== 0) DATES.push(date.toISOString().slice(0, 10));
  }
  const nulls = DATES.map(() => null);
  const etf = (base: number): MarketDailyColumns => {
    const close = DATES.map(
      (_, index) => base + index * 0.05 + 4 * Math.sin(index / 9)
    );
    return {
      adjClose: close.map((value) => value * 1.01),
      close,
      dates: DATES,
      high: close.map((value) => value + 1),
      low: close.map((value) => value - 1),
      open: close,
    };
  };
  const level = (base: number): MarketDailyColumns => ({
    adjClose: nulls,
    close: DATES.map((_, index) => base + 3 * Math.sin(index / 13)),
    dates: DATES,
    high: nulls,
    low: nulls,
    open: nulls,
  });
  const ROWS: Record<string, MarketDailyColumns> = {
    IRX: level(5),
    QQQ: etf(80),
    SPY: etf(100),
    VIX: level(18),
    VIX3M: level(20),
  };
  const cut = (columns: MarketDailyColumns, to?: string) => {
    const keep = columns.dates.filter(
      (date) => to === undefined || date <= to
    ).length;
    return {
      adjClose: columns.adjClose.slice(0, keep),
      close: columns.close.slice(0, keep),
      dates: columns.dates.slice(0, keep),
      high: columns.high.slice(0, keep),
      low: columns.low.slice(0, keep),
      open: columns.open.slice(0, keep),
    };
  };
  const dailySeries = (
    rows: Record<string, MarketDailyColumns> = { ...ROWS }
  ): MarketDailySeriesRepository & { rows: typeof rows } => ({
    listSeries: vi.fn(),
    loadSeries: vi.fn(
      async (ids: readonly string[], range?: { to?: string }) =>
        new Map(
          ids.flatMap((id) => {
            const columns = rows[id];
            return columns === undefined ? [] : [[id, cut(columns, range?.to)]];
          })
        )
    ),
    replaceSeries: vi.fn(),
    rows,
  });
  const optionsBlock = {
    dte: { min: 20, target: 30 },
    maxLossPct: 2,
    profitTakePct: 50,
    structure: "putCreditVertical",
    widthSigma: 0.5,
  };
  const optionsDefinition = StrategyDefinitionSchema.parse({
    ...STRATEGY_TEMPLATES.smaCross,
    options: optionsBlock,
  });
  const rankDefinition = StrategyDefinitionSchema.parse({
    ...STRATEGY_TEMPLATES.smaCross,
    filters: [{ length: 60, max: 90, type: "ivRank" }],
  });
  const optionsInput: BacktestRunSubmitInput = {
    costBps: 0,
    from: "1970-03-02",
    initialCapital: 50_000,
    rule: { definition: optionsDefinition, kind: "dsl" },
    symbol: "SPY",
    timeframe: "1d",
    to: "1972-06-30",
  };
  const optionsSpec = BacktestRunSubmitInputSchema.parse(
    optionsInput
  ) as BacktestRunRecord["spec"];
  const rankSpec = BacktestRunSubmitInputSchema.parse({
    ...submitInput,
    rule: { definition: rankDefinition, kind: "dsl" },
  }) as BacktestRunRecord["spec"];
  const rowsOf = (ids: readonly string[], to: string) =>
    new Map(ids.map((id) => [id, cut(ROWS[id] as MarketDailyColumns, to)]));
  /** The TypeScript options run of the spec, as the Python worker sends it (run_spec_json). */
  const optionsOutcome = () =>
    runOptionsDefinition(
      optionsDefinition,
      optionsDatasetFromRows(
        Object.fromEntries(rowsOf(["SPY", "VIX", "IRX"], optionsSpec.to))
      ),
      {
        capital: optionsSpec.initialCapital,
        end: optionsSpec.to,
        start: optionsSpec.from,
        symbol: "SPY",
      }
    );
  const optionsResult = () => {
    const outcome = optionsOutcome();
    const { result } = outcome;
    return BacktestRunEngineOptionsResultSchema.parse({
      bookSkipped: outcome.bookSkipped,
      capital: result.capital,
      dates: [...result.dates],
      equity: [...result.equity],
      kind: "options" as const,
      metrics: optionsRunMetrics(outcome),
      nautilusGap: 2e-12,
      openPositions: [...result.openPositions],
      signals: outcome.signals,
      skipped: [...result.skipped],
      trades: result.trades.map((trade) => ({
        ...trade,
        maxLoss: outcome.priced.find((priced) => priced.tradeId === trade.id)
          ?.maxLoss,
      })),
    });
  };
  const queueRun = async (
    runs: ReturnType<typeof memoryRuns>,
    spec: BacktestRunRecord["spec"],
    engineVersion: string = engine
  ) =>
    await runs.create({
      engineVersion,
      requestedBy: "operator",
      spec,
      strategyId: null,
      strategyRevision: null,
      strategySnapshot: null,
    });

  it("runs an options definition on the series store rows and reports the options book", async () => {
    const runs = memoryRuns();
    const store = dailySeries();
    // No market bars: an options run reads the series store only.
    const bars = fakeBars({ getSeries: vi.fn(async () => null) });
    const client = clientFor({ bars, dailySeries: store, runs });
    const run = await client.backtestRuns.submit(optionsInput);
    expect(run.status).toBe("succeeded");
    expect(bars.getSeries).not.toHaveBeenCalled();
    expect(store.loadSeries).toHaveBeenCalledWith(["SPY", "VIX", "IRX"], {
      to: "1972-06-30",
    });
    const report = BacktestRunReportSchema.parse(run.report);
    const outcome = optionsOutcome();
    const ledger = outcome.result;
    expect(report.options).toEqual({
      capital: 50_000,
      metrics: optionsRunMetrics(outcome),
      nautilusGap: null,
      signals: outcome.signals,
      symbols: ["SPY"],
      trades: ledger.trades,
      tradesTruncated: false,
    });
    expect(ledger.trades.length).toBeGreaterThan(5);
    expect(report.bars).toBe(ledger.dates.length);
    expect(report.firstT).toBe(Date.parse("1970-03-02T00:00:00Z"));
    expect(report.equity.at(-1)?.equity).toBe(ledger.equity.at(-1));
    expect(report.metrics.finalEquity).toBe(ledger.equity.at(-1));
    expect(report.metrics.totalTrades).toBe(ledger.trades.length);
    expect(report.metrics.sharpe).toBe(report.options?.metrics.sharpe);
    expect(report.metrics.exposure).toBe(report.options?.metrics.exposure);
    const [first] = ledger.trades;
    if (first === undefined) throw new Error("expected a trade");
    expect(report.trades[0]).toEqual({
      balanceAfter:
        ledger.equity[ledger.dates.indexOf(first.exitDate)] ?? Number.NaN,
      entryPrice: first.entryPrice,
      entryT: Date.parse(`${first.entryDate}T00:00:00Z`),
      exitPrice: first.exitPrice,
      exitReason: first.exitReason,
      exitT: Date.parse(`${first.exitDate}T00:00:00Z`),
      n: 1,
      netReturn: first.returnOnRisk,
      pnl: first.pnl,
      units: first.contracts,
    });
    // Prices are the run symbol's store row on the ledger dates.
    const spy = ROWS["SPY"] as MarketDailyColumns;
    const from = spy.dates.indexOf("1970-03-02");
    expect(report.prices).toHaveLength(ledger.dates.length);
    expect(report.prices[0]).toEqual({
      c: spy.close[from],
      h: spy.high[from],
      l: spy.low[from],
      o: spy.open[from],
      t: report.firstT,
    });
    expect(report.seriesSha256).toBe(
      await strategySeriesRowsSha256(
        rowsOf(["SPY", "VIX", "IRX"], "1972-06-30")
      )
    );
  });

  it("refuses an options submit with run-level costs, stops or a symbol it does not trade", async () => {
    const runs = memoryRuns();
    const client = clientFor({
      bars: fakeBars(),
      dailySeries: dailySeries(),
      runs,
    });
    const refused = async (
      overrides: Partial<BacktestRunSubmitInput>,
      message: string
    ) =>
      await expect(
        client.backtestRuns.submit({ ...optionsInput, ...overrides })
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message,
        status: 422,
      });
    const costs =
      "Options definitions charge the options book costs; set costBps to 0 and leave out costProfile.";
    await refused({ costBps: 5 }, costs);
    await refused({ costProfile: "ibkr-pro-fixed-us-stock" }, costs);
    const exits =
      "Options definitions exit by the options block; set stopLossPct and takeProfitPct to 0.";
    await refused({ stopLossPct: 5 }, exits);
    await refused({ takeProfitPct: 5 }, exits);
    await refused(
      { symbol: "AAPL" },
      "Options definitions trade DIA, GLD, IWM, QQQ, SLV, SPY, USO; AAPL has no IV index."
    );
    await refused(
      {
        rule: {
          definition: StrategyDefinitionSchema.parse({
            ...STRATEGY_TEMPLATES.smaCross,
            options: optionsBlock,
            portfolio: {
              cadence: "daily",
              policy: "flat",
              symbols: ["QQQ", "GLD"],
            },
          }),
          kind: "dsl",
        },
      },
      "The run symbol SPY is not in the portfolio symbols (QQQ, GLD)."
    );
    expect(runs.rows.size).toBe(0);
  });

  it("fails an options run whose series is missing or whose range has under two run days", async () => {
    const runs = memoryRuns();
    const { VIX: _vix, ...withoutVix } = ROWS;
    const missing = await queueRun(
      runs,
      optionsSpec,
      BACKTEST_RUN_ENGINE_VERSION
    );
    await executeBacktestRun(
      {
        marketBars: fakeBars(),
        marketDailySeries: dailySeries(withoutVix),
        runs,
      },
      missing.id
    );
    expect(runs.rows.get(missing.id)?.error).toBe(
      "Series data is not available for VIX"
    );
    const short = await queueRun(
      runs,
      { ...optionsSpec, from: "1972-06-14" },
      BACKTEST_RUN_ENGINE_VERSION
    );
    await executeBacktestRun(
      { marketBars: fakeBars(), marketDailySeries: dailySeries(), runs },
      short.id
    );
    expect(runs.rows.get(short.id)?.error).toBe(
      "Fewer than 2 daily series bars for SPY between 1972-06-14 and 1972-06-30"
    );
    // A runner error (here: the IV index the book prices with is not in the rows) is the run's.
    const spy = new Map([["SPY", ROWS["SPY"] as MarketDailyColumns]]);
    expect(() =>
      runOptionsBacktest(
        optionsSpec,
        optionsDefinition,
        optionsRunBars(ROWS["SPY"] as MarketDailyColumns, optionsSpec),
        { ids: ["SPY"], rows: spy, sha256: "c".repeat(64) }
      )
    ).toThrow(/^Options run failed: /u);
  });

  it("runs an equity definition that reads daily series with the store rows", async () => {
    const runs = memoryRuns();
    const client = clientFor({
      bars: fakeBars(),
      dailySeries: dailySeries(),
      runs,
    });
    const run = await client.backtestRuns.submit({
      ...submitInput,
      rule: { definition: rankDefinition, kind: "dsl" },
    });
    expect(run.status).toBe("succeeded");
    const bars = sliceColumnsByDate(
      waveColumns(1000),
      rankSpec.from,
      rankSpec.to
    );
    const rows = rowsOf(["VIX"], rankSpec.to);
    const expected = runStrategyDefinition(
      bars,
      rankDefinition,
      rankSpec.costBps,
      undefined,
      undefined,
      "1d",
      { series: true },
      strategySeriesInput(rankDefinition, "SPY", rows)
    );
    const report = BacktestRunReportSchema.parse(run.report);
    expect(report.metrics.totalTrades).toBe(expected.trades.length);
    expect(report.metrics.totalReturn).toBe(expected.stats.totalReturn);
    expect(report.seriesSha256).toBe(
      await runInputsSha256(barsSha, await strategySeriesRowsSha256(rows))
    );
    // The filter changes the trades: without it the same rule trades differently.
    const unfiltered = runStrategyDefinition(
      bars,
      StrategyDefinitionSchema.parse(STRATEGY_TEMPLATES.smaCross),
      rankSpec.costBps
    );
    expect(unfiltered.trades.length).not.toBe(expected.trades.length);
  });

  it("claims a series run with its rows and a hash of bars and rows, and checks it at complete", async () => {
    const runs = memoryRuns();
    const store = dailySeries();
    const client = clientFor({ bars: fakeBars(), dailySeries: store, runs });
    const plain = await queueRun(
      runs,
      BacktestRunSubmitInputSchema.parse(
        submitInput
      ) as BacktestRunRecord["spec"]
    );
    const rank = await queueRun(runs, rankSpec);
    const first = (await client.backtestRuns.engine.claim({ engine })).run;
    expect(first).toMatchObject({
      id: plain.id,
      series: null,
      seriesSha256: barsSha,
    });
    const claimed = (await client.backtestRuns.engine.claim({ engine })).run;
    if (claimed === null) throw new Error("expected a claimed run");
    const rows = rowsOf(["VIX"], rankSpec.to);
    expect(claimed.id).toBe(rank.id);
    expect(claimed.series).toEqual(Object.fromEntries(rows));
    const sha = await runInputsSha256(
      barsSha,
      await strategySeriesRowsSha256(rows)
    );
    expect(claimed.seriesSha256).toBe(sha);
    const bars = sliceColumnsByDate(
      waveColumns(1000),
      rankSpec.from,
      rankSpec.to
    );
    const result = runStrategyDefinition(
      bars,
      rankDefinition,
      rankSpec.costBps,
      undefined,
      undefined,
      "1d",
      { series: true },
      strategySeriesInput(rankDefinition, "SPY", rows)
    );
    const posted = {
      equity: Array.from(result.equity),
      stats: result.stats,
      trades: [...result.trades],
    };
    // The bar hash alone does not do for a run that reads series.
    await expectCode(
      client.backtestRuns.engine.complete({
        engine,
        id: rank.id,
        result: posted,
        seriesSha256: barsSha,
      }),
      "BAD_REQUEST",
      400
    );
    expect(runs.rows.get(rank.id)?.error).toBe(
      "The stored bars or daily series changed while the backtest was running"
    );
    // A claimed run whose rows are unchanged completes with the combined hash.
    const again = await queueRun(runs, rankSpec);
    await client.backtestRuns.engine.claim({ engine });
    await expect(
      client.backtestRuns.engine.complete({
        engine,
        id: again.id,
        result: posted,
        seriesSha256: sha,
      })
    ).resolves.toEqual({ id: again.id, status: "succeeded" });
    expect(runs.rows.get(again.id)?.report?.["seriesSha256"]).toBe(sha);
    // A series that disappeared before complete fails the run with the loader message.
    const gone = await queueRun(runs, rankSpec);
    await client.backtestRuns.engine.claim({ engine });
    delete store.rows["VIX"];
    const many = await client.backtestRuns.engine.completeMany({
      engine,
      items: [{ id: gone.id, result: posted, seriesSha256: sha }],
    });
    expect(many.outcomes[0]).toMatchObject({
      error: "BAD_REQUEST",
      message: "Series data is not available for VIX",
    });
    // A store error at complete is not the run's fault: the request fails, the run stays.
    const broken = await queueRun(runs, rankSpec);
    store.rows["VIX"] = ROWS["VIX"] as MarketDailyColumns;
    await client.backtestRuns.engine.claim({ engine });
    vi.mocked(store.loadSeries).mockRejectedValueOnce(new Error("db down"));
    await expectCode(
      client.backtestRuns.engine.complete({
        engine,
        id: broken.id,
        result: posted,
        seriesSha256: sha,
      }),
      "INTERNAL_SERVER_ERROR",
      500
    );
    expect(runs.rows.get(broken.id)?.status).toBe("running");
  });

  it("sends a batch the rows of its series runs, each run with its own hash, and runs an options run alone", async () => {
    const runs = memoryRuns();
    const store = dailySeries();
    const client = clientFor({ bars: fakeBars(), dailySeries: store, runs });
    const typescript = {
      host: "test",
      stats: {
        bars: 2,
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
      },
      tradeCount: 0,
      trades: [],
      wallMs: 1,
    };
    const comparison = {
      feature: "sweep" as const,
      groupId: "g-1",
      label: "x",
      typescript,
    };
    const termDefinition = StrategyDefinitionSchema.parse({
      ...STRATEGY_TEMPLATES.smaCross,
      filters: [{ maxRatio: 1.2, type: "vixTermStructure" }],
    });
    const early = await queueRun(runs, {
      ...rankSpec,
      comparison,
      to: "1971-06-30",
    });
    const plain = await queueRun(runs, {
      ...(BacktestRunSubmitInputSchema.parse(
        submitInput
      ) as BacktestRunRecord["spec"]),
      comparison,
    });
    const late = await queueRun(runs, {
      ...rankSpec,
      comparison,
      rule: { definition: termDefinition, kind: "dsl" },
    });
    const shorter = await queueRun(runs, {
      ...rankSpec,
      comparison,
      to: "1971-01-29",
    });
    const options = await queueRun(runs, { ...optionsSpec, comparison });
    const { batch } = await client.backtestRuns.engine.claim({
      engine,
      max: 10,
    });
    expect(batch?.runs.map((entry) => entry.id)).toEqual([
      early.id,
      plain.id,
      late.id,
      shorter.id,
    ]);
    expect(runs.rows.get(options.id)?.error).toBe(
      "An options run runs alone, not in a comparison batch; submit the run again"
    );
    // One store load for the batch: every id its runs read, up to the latest `to`.
    expect(store.loadSeries).toHaveBeenCalledTimes(1);
    expect(store.loadSeries).toHaveBeenCalledWith(["VIX", "VIX3M"], {
      to: "1972-06-30",
    });
    // VIX as the longest load (the latest `to` of its runs), VIX3M from the second run.
    expect(batch?.series).toEqual({
      VIX: cut(ROWS["VIX"] as MarketDailyColumns, "1972-06-30"),
      VIX3M: cut(ROWS["VIX3M"] as MarketDailyColumns, "1972-06-30"),
    });
    expect(batch?.seriesSha256).toBe(barsSha);
    expect(batch?.runs[0]?.seriesSha256).toBe(
      await runInputsSha256(
        barsSha,
        await strategySeriesRowsSha256(rowsOf(["VIX"], "1971-06-30"))
      )
    );
    expect(batch?.runs[1]).not.toHaveProperty("seriesSha256");
    expect(batch?.runs[2]?.seriesSha256).toBe(
      await runInputsSha256(
        barsSha,
        await strategySeriesRowsSha256(rowsOf(["VIX", "VIX3M"], "1972-06-30"))
      )
    );
    // A batch of runs without series has no rows.
    await queueRun(runs, {
      ...(BacktestRunSubmitInputSchema.parse(
        submitInput
      ) as BacktestRunRecord["spec"]),
      comparison: { ...comparison, groupId: "g-2" },
    });
    const next = await client.backtestRuns.engine.claim({ engine, max: 10 });
    expect(next.batch?.series).toBeNull();
    // An options run outside a group is claimed alone, with its rows.
    const lone = await queueRun(runs, optionsSpec);
    const alone = await client.backtestRuns.engine.claim({ engine, max: 10 });
    expect(alone.batch?.runs.map((entry) => entry.id)).toEqual([lone.id]);
    expect(Object.keys(alone.batch?.series ?? {})).toEqual([
      "SPY",
      "VIX",
      "IRX",
    ]);
    // Its bars are its own store bars; the batch hash is the rows hash.
    expect(alone.batch?.bars.t[0]).toBe(Date.parse("1970-03-02T00:00:00Z"));
    expect(alone.batch?.seriesSha256).toBe(
      await strategySeriesRowsSha256(
        rowsOf(["SPY", "VIX", "IRX"], optionsSpec.to)
      )
    );
    expect(alone.batch?.runs[0]).not.toHaveProperty("seriesSha256");
  });

  it("fails runs whose daily series rows are over the claim limit", {
    timeout: 30_000,
  }, async () => {
    const runs = memoryRuns();
    // About 26 MB of JSON per series (one padded date): one run alone fits, two series of one
    // batch do not.
    const big = (base: number, size = 26_000_000): MarketDailyColumns => ({
      adjClose: [null],
      close: [base],
      dates: [`1970-01-02${" ".repeat(size)}`],
      high: [null],
      low: [null],
      open: [null],
    });
    // The store answers as is, so the rows keep their size.
    const asIs = (rows: Record<string, MarketDailyColumns>) => ({
      listSeries: vi.fn(),
      loadSeries: vi.fn(
        async (ids: readonly string[]) =>
          new Map(ids.map((id) => [id, rows[id] as MarketDailyColumns]))
      ),
      replaceSeries: vi.fn(),
    });
    const client = clientFor({
      bars: fakeBars(),
      dailySeries: asIs({ IRX: big(200), VIX: big(100) }),
      runs,
    });
    const typescript = {
      host: "test",
      stats: {
        bars: 2,
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
      },
      tradeCount: 0,
      trades: [],
      wallMs: 1,
    };
    const comparison = {
      feature: "sweep" as const,
      groupId: "g-big",
      label: "x",
      typescript,
    };
    const irx = StrategyDefinitionSchema.parse({
      ...STRATEGY_TEMPLATES.smaCross,
      filters: [
        {
          condition: {
            left: { field: "close", type: "price" },
            op: ">",
            right: { type: "const", value: 0 },
          },
          series: "IRX",
          type: "series",
        },
      ],
    });
    const rank = await queueRun(runs, { ...rankSpec, comparison });
    const rate = await queueRun(runs, {
      ...rankSpec,
      comparison,
      rule: { definition: irx, kind: "dsl" },
    });
    const plain = await queueRun(runs, {
      ...(BacktestRunSubmitInputSchema.parse(
        submitInput
      ) as BacktestRunRecord["spec"]),
      comparison,
    });
    const { batch } = await client.backtestRuns.engine.claim({
      engine,
      max: 10,
    });
    expect(batch?.runs.map((entry) => entry.id)).toEqual([plain.id]);
    expect(batch?.series).toBeNull();
    const tooLarge = expect.stringMatching(
      /^The daily series rows are \d+\.\d MB; the Nautilus worker takes at most 40 MB$/u
    );
    expect(runs.rows.get(rank.id)?.error).toEqual(tooLarge);
    expect(runs.rows.get(rate.id)?.error).toEqual(tooLarge);
    // A batch of only oversized runs claims nothing.
    const onlyBig = await queueRun(runs, {
      ...rankSpec,
      comparison: { ...comparison, groupId: "g-big-2" },
    });
    await queueRun(runs, {
      ...rankSpec,
      comparison: { ...comparison, groupId: "g-big-2" },
      rule: { definition: irx, kind: "dsl" },
    });
    expect(
      (await client.backtestRuns.engine.claim({ engine, max: 10 })).batch
    ).toBeNull();
    expect(runs.rows.get(onlyBig.id)?.status).toBe("failed");
    // A single run over the limit fails at claim.
    const huge = await queueRun(runs, rankSpec);
    const store = asIs({
      VIX: big(100, 52_000_000),
    });
    const single = clientFor({ bars: fakeBars(), dailySeries: store, runs });
    expect((await single.backtestRuns.engine.claim({ engine })).run).toBeNull();
    expect(runs.rows.get(huge.id)?.error).toEqual(tooLarge);
  });

  it("completes an options run from the worker's options result and recomputes its metrics", async () => {
    const runs = memoryRuns();
    const bars = fakeBars({ getSeries: vi.fn(async () => null) });
    const client = clientFor({ bars, dailySeries: dailySeries(), runs });
    const run = await queueRun(runs, optionsSpec);
    const claimed = (await client.backtestRuns.engine.claim({ engine })).run;
    expect(claimed?.series && Object.keys(claimed.series)).toEqual([
      "SPY",
      "VIX",
      "IRX",
    ]);
    // The claim bars are the SPY store row from `from` to `to`, without volume.
    const spy = ROWS["SPY"] as MarketDailyColumns;
    const first = spy.dates.indexOf(optionsSpec.from);
    expect(claimed?.bars.t).toHaveLength(spy.dates.length - first);
    expect(claimed?.bars.t[0]).toBe(Date.parse("1970-03-02T00:00:00Z"));
    expect(claimed?.bars.c[0]).toBe(spy.close[first]);
    expect(claimed?.bars).not.toHaveProperty("v");
    expect(bars.getSeries).not.toHaveBeenCalled();
    const sha = claimed?.seriesSha256 as string;
    expect(sha).toBe(
      await strategySeriesRowsSha256(
        rowsOf(["SPY", "VIX", "IRX"], optionsSpec.to)
      )
    );
    const result = optionsResult();
    await expect(
      client.backtestRuns.engine.complete({
        engine,
        id: run.id,
        result,
        seriesSha256: sha,
      })
    ).resolves.toEqual({ id: run.id, status: "succeeded" });
    const report = BacktestRunReportSchema.parse(runs.rows.get(run.id)?.report);
    expect(report.options?.nautilusGap).toBe(2e-12);
    expect(report.options?.metrics).toEqual(result.metrics);
    expect(report.trades).toHaveLength(result.trades.length);
    expect(report.seriesSha256).toBe(sha);
    // The same report as the TypeScript engine, except the Nautilus gap.
    const typescript = await clientFor({
      bars: fakeBars(),
      dailySeries: dailySeries(),
      runs: memoryRuns(),
    }).backtestRuns.submit(optionsInput);
    const own = BacktestRunReportSchema.parse(typescript.report);
    expect({
      ...report,
      options: { ...report.options, nautilusGap: null },
    }).toEqual(own);
  });

  it("refuses an options result that is not the options run of the stored series", async () => {
    const runs = memoryRuns();
    const client = clientFor({
      bars: fakeBars(),
      dailySeries: dailySeries(),
      runs,
    });
    const sha = await strategySeriesRowsSha256(
      rowsOf(["SPY", "VIX", "IRX"], optionsSpec.to)
    );
    const differs =
      "The options result does not match the options run of the stored series: ";
    const rejected = async (
      result: Record<string, unknown>,
      message: string,
      spec: BacktestRunRecord["spec"] = optionsSpec,
      seriesSha256 = sha
    ) => {
      const run = await queueRun(runs, spec);
      await client.backtestRuns.engine.claim({ engine });
      const many = await client.backtestRuns.engine.completeMany({
        engine,
        items: [{ id: run.id, result: result as never, seriesSha256 }],
      });
      expect(many.outcomes[0]).toMatchObject({ error: "BAD_REQUEST", message });
      expect(runs.rows.get(run.id)).toMatchObject({
        error: message,
        status: "failed",
      });
    };
    const good = optionsResult();
    const [first, second] = good.trades;
    if (first === undefined || second === undefined)
      throw new Error("expected two trades");
    const metric = (key: string, value: unknown) => ({
      ...good,
      metrics: { ...good.metrics, [key]: value },
    });
    await rejected(
      metric("sharpe", (good.metrics.sharpe as number) * (1 + 1e-6)),
      `${differs}metrics (sharpe)`
    );
    await rejected(
      metric("worstMonth", "1970-06"),
      `${differs}metrics (worstMonth)`
    );
    await rejected(
      metric("maxOpenRisk", good.metrics.maxOpenRisk * 1.001),
      `${differs}metrics (maxOpenRisk)`
    );
    // Within the tolerance the worker's numbers stand; the report is the API's own run.
    const near = await queueRun(runs, optionsSpec);
    await client.backtestRuns.engine.claim({ engine });
    await expect(
      client.backtestRuns.engine.complete({
        engine,
        id: near.id,
        result: {
          ...metric("cagr", (good.metrics.cagr as number) * (1 + 1e-12)),
          equity: good.equity.map((value) => value * (1 + 1e-13)),
        },
        seriesSha256: sha,
      })
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(
      BacktestRunReportSchema.parse(runs.rows.get(near.id)?.report).options
        ?.metrics
    ).toEqual(optionsRunMetrics(optionsOutcome()));
    // A price one ulp off and a cent-rounding difference stand too.
    const ulp = await queueRun(runs, optionsSpec);
    await client.backtestRuns.engine.claim({ engine });
    const nextUp = (value: number) => {
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, value);
      view.setBigUint64(0, view.getBigUint64(0) + 1n);
      return view.getFloat64(0);
    };
    expect(nextUp(first.entryPrice)).not.toBe(first.entryPrice);
    await expect(
      client.backtestRuns.engine.complete({
        engine,
        id: ulp.id,
        result: {
          ...good,
          trades: [
            {
              ...first,
              entryFee: first.entryFee + 0.01,
              entryPrice: nextUp(first.entryPrice),
              pnl: first.pnl - 0.01,
            },
            ...good.trades.slice(1),
          ],
        },
        seriesSha256: sha,
      })
    ).resolves.toMatchObject({ status: "succeeded" });
    await rejected(
      {
        ...good,
        trades: [
          { ...first, exitPrice: first.exitPrice * (1 + 1e-6) },
          ...good.trades.slice(1),
        ],
      },
      `${differs}trade 1 exitPrice`
    );
    await rejected(
      {
        ...good,
        trades: [
          { ...first, exitFee: first.exitFee + 0.02 },
          ...good.trades.slice(1),
        ],
      },
      `${differs}trade 1 exitFee`
    );
    await rejected(
      {
        ...good,
        trades: [{ ...first, expiry: "1999-01-15" }, ...good.trades.slice(1)],
      },
      `${differs}trade 1 expiry`
    );
    // A tampered max loss, with or without metrics that agree with it.
    const tampered = good.trades.map((trade, index) =>
      index === 0 ? { ...trade, maxLoss: trade.maxLoss * 2 } : trade
    );
    await rejected({ ...good, trades: tampered }, `${differs}trade 1 maxLoss`);
    await rejected(
      {
        ...metric("maxOpenRisk", good.metrics.maxOpenRisk * 2),
        trades: tampered,
      },
      `${differs}trade 1 maxLoss`
    );
    // Ledgers that do not add up: equity against the trades, trades, skips, signals.
    const lastDay = good.dates.at(-1);
    await rejected(
      {
        ...good,
        equity: [
          ...good.equity.slice(0, -1),
          (good.equity.at(-1) as number) + 5,
        ],
      },
      `${differs}equity on ${lastDay}`
    );
    await rejected(
      {
        ...good,
        trades: [
          first,
          { ...second, pnl: second.pnl + 1 },
          ...good.trades.slice(2),
        ],
      },
      `${differs}trade 2 pnl`
    );
    await rejected(
      {
        ...good,
        trades: [
          { ...first, returnOnRisk: first.returnOnRisk + 1e-6 },
          ...good.trades.slice(1),
        ],
      },
      `${differs}trade 1 returnOnRisk`
    );
    await rejected(
      { ...good, trades: good.trades.slice(0, -1) },
      `${differs}${good.trades.length - 1} trades; the run has ${good.trades.length}`
    );
    await rejected(
      {
        ...good,
        openPositions: good.openPositions.map((count) => count + 1),
      },
      `${differs}open positions`
    );
    await rejected({ ...good, bookSkipped: 1 }, `${differs}skipped trades`);
    await rejected({ ...good, signals: { SPY: 999 } }, `${differs}signals`);
    await rejected(
      { ...good, capital: 60_000 },
      `${differs}capital 60000 is not the run capital 50000`
    );
    await rejected(
      {
        ...good,
        dates: good.dates.slice(1),
        equity: good.equity.slice(1),
        openPositions: good.openPositions.slice(1),
      },
      `${differs}the run days are not the SPY calendar of the date range`
    );
    await rejected(
      { ...good, dates: ["1970-02-27", ...good.dates.slice(1)] },
      `${differs}the run days are not the SPY calendar of the date range`
    );
    // A result for other rows (the hash differs) is refused before any recomputation.
    await rejected(
      good,
      "The stored bars or daily series changed while the backtest was running",
      optionsSpec,
      "f".repeat(64)
    );
    const equity = {
      equity: [1, 1],
      stats: {
        bars: 2,
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
      },
      trades: [],
    };
    await rejected(equity, "An options run needs the options runner result");
    await rejected(
      good,
      "The options runner result is for options definitions only",
      rankSpec,
      await runInputsSha256(
        barsSha,
        await strategySeriesRowsSha256(rowsOf(["VIX"], rankSpec.to))
      )
    );
  });

  it("fails the run when the API's own options run cannot book the stored rows", async () => {
    const runs = memoryRuns();
    // SPY (the ledger calendar) ends before the run starts; QQQ has the run's bars.
    const spy = ROWS["SPY"] as MarketDailyColumns;
    const end = spy.dates.indexOf("1972-01-03");
    const shortSpy = {
      adjClose: spy.adjClose.slice(0, end),
      close: spy.close.slice(0, end),
      dates: spy.dates.slice(0, end),
      high: spy.high.slice(0, end),
      low: spy.low.slice(0, end),
      open: spy.open.slice(0, end),
    };
    const client = clientFor({
      bars: fakeBars(),
      dailySeries: dailySeries({
        ...ROWS,
        SPY: shortSpy,
        VXN: ROWS["VIX"] as MarketDailyColumns,
      }),
      runs,
    });
    const spec = { ...optionsSpec, from: "1972-02-01", symbol: "QQQ" };
    const run = await queueRun(runs, spec);
    const claimed = (await client.backtestRuns.engine.claim({ engine })).run;
    expect(claimed?.id).toBe(run.id);
    const many = await client.backtestRuns.engine.completeMany({
      engine,
      items: [
        {
          id: run.id,
          result: optionsResult(),
          seriesSha256: claimed?.seriesSha256 as string,
        },
      ],
    });
    expect(many.outcomes[0]).toMatchObject({
      error: "BAD_REQUEST",
      message: expect.stringMatching(/^Options run failed: /u),
    });
    expect(runs.rows.get(run.id)?.status).toBe("failed");
  });

  it("keeps a code error of the options runner a server error, on both engines", async () => {
    // An IRX row without closes makes the runner fail with a TypeError (a code path, not data).
    const broken = () => {
      const store = dailySeries();
      return {
        ...store,
        loadSeries: vi.fn(
          async (ids: readonly string[], range?: { to?: string }) => {
            const loaded = await store.loadSeries(ids, range);
            const { close: _close, ...noClose } = loaded.get(
              "IRX"
            ) as MarketDailyColumns;
            loaded.set("IRX", noClose as unknown as MarketDailyColumns);
            return loaded;
          }
        ),
      };
    };
    const runs = memoryRuns();
    const typescript = await clientFor({
      bars: fakeBars(),
      dailySeries: broken(),
      runs,
    }).backtestRuns.submit(optionsInput);
    expect(typescript).toMatchObject({
      error: BACKTEST_RUN_STORAGE_ERROR,
      status: "failed",
    });
    // The claim sends whole rows; the rows break before complete, which hashes what it reloads.
    const run = await queueRun(runs, optionsSpec);
    await clientFor({
      bars: fakeBars(),
      dailySeries: dailySeries(),
      runs,
    }).backtestRuns.engine.claim({ engine });
    const store = broken();
    const reloaded = await store.loadSeries(["SPY", "VIX", "IRX"], {
      to: optionsSpec.to,
    });
    const client = clientFor({ bars: fakeBars(), dailySeries: store, runs });
    await expectCode(
      client.backtestRuns.engine.complete({
        engine,
        id: run.id,
        result: optionsResult(),
        seriesSha256: await strategySeriesRowsSha256(reloaded),
      }),
      "INTERNAL_SERVER_ERROR",
      500
    );
    expect(runs.rows.get(run.id)?.status).toBe("running");
  });

  it("validates the options result shape strictly", () => {
    const good = optionsResult();
    expect(BacktestRunEngineOptionsResultSchema.safeParse(good).success).toBe(
      true
    );
    const issues = (value: Record<string, unknown>) => {
      const parsed = BacktestRunEngineOptionsResultSchema.safeParse({
        ...good,
        ...value,
      });
      return parsed.success
        ? []
        : parsed.error.issues.map((issue) => issue.message);
    };
    expect(issues({ equity: good.equity.slice(1) })).toEqual([
      "equity must have one value per date",
    ]);
    expect(issues({ openPositions: [] })).toEqual([
      "openPositions must have one value per date",
    ]);
    expect(
      issues({ dates: [good.dates[1], good.dates[0], ...good.dates.slice(2)] })
    ).toContain("dates must be strictly increasing");
    const [trade] = good.trades;
    if (trade === undefined) throw new Error("expected a trade");
    const onDates =
      "A trade must enter and exit on run dates, the exit on or after the entry";
    expect(issues({ trades: [{ ...trade, exitDate: "1999-01-01" }] })).toEqual([
      onDates,
    ]);
    expect(issues({ trades: [{ ...trade, entryDate: "1972-06-14" }] })).toEqual(
      [onDates]
    );
    // An entry on a day that is not a run day (a Saturday).
    expect(issues({ trades: [{ ...trade, entryDate: "1970-03-07" }] })).toEqual(
      [onDates]
    );
    expect(issues({ trades: [trade, trade] })).toEqual([
      "Trade ids must be unique",
    ]);
    expect(issues({ signals: { AAPL: 1 } })).toEqual([
      "Signals are counted per options symbol",
    ]);
    expect(issues({ nautilusGap: null })).toHaveLength(1);
    expect(issues({ nautilusGap: -1e-12 })).toHaveLength(1);
    expect(
      issues({ nautilusGap: OPTIONS_NAUTILUS_PARITY_TOLERANCE * 1.5 })
    ).toHaveLength(1);
    expect(issues({ nautilusGap: OPTIONS_NAUTILUS_PARITY_TOLERANCE })).toEqual(
      []
    );
    expect(issues({ trades: [{ ...trade, maxLoss: 0 }] })).toHaveLength(1);
    expect(issues({ extra: 1 })).toHaveLength(1);
    expect(issues({ metrics: { ...good.metrics, extra: 1 } })).toHaveLength(1);
  });

  it("bounds the stored options report like the worker result", () => {
    const report = {
      capital: 1,
      metrics: optionsResult().metrics,
      nautilusGap: null,
      signals: { SPY: 1 },
      symbols: ["SPY"],
      trades: [],
      tradesTruncated: false,
    };
    const ok = (value: Record<string, unknown>) =>
      BacktestRunOptionsReportSchema.safeParse({ ...report, ...value }).success;
    expect(ok({})).toBe(true);
    expect(ok({ nautilusGap: 0 })).toBe(true);
    expect(ok({ nautilusGap: -1 })).toBe(false);
    expect(ok({ nautilusGap: 1e-3 })).toBe(false);
    expect(ok({ signals: { AAPL: 1 } })).toBe(false);
    expect(ok({ tradesTruncated: undefined })).toBe(false);
    const [spread] = optionsResult().trades;
    const spreads = Array.from(
      { length: BACKTEST_RUN_TRADES_MAX + 1 },
      () => spread
    );
    expect(ok({ trades: spreads.slice(1), tradesTruncated: true })).toBe(true);
    expect(ok({ trades: spreads, tradesTruncated: true })).toBe(false);
  });

  it("uses the Python Nautilus parity tolerance", () => {
    const python = readFileSync(
      new URL(
        "../../../services/research/strategies/qc_ports/portfolio.py",
        import.meta.url
      ),
      "utf8"
    );
    expect(python).toContain(
      `PARITY_REL_TOL = ${OPTIONS_NAUTILUS_PARITY_TOLERANCE.toExponential()}`
    );
  });
});
