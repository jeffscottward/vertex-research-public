import {
  type AgentApiKeyService,
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  type AutopilotCampaignRecord,
  type AutopilotCandidateRecord,
  type AutopilotRepository,
  type BacktestRunCreateInput,
  type BacktestRunsRepository,
  DatabaseConflictError,
  DeploymentRequestStateError,
  type DeploymentRequestsRepository,
  InvalidRepositoryInputError,
  type MarketBarSeries,
  type MarketBarsRepository,
  type Repositories,
  type StrategyDefinitionsRepository,
  type StrategyLibraryRepository,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { call } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

import {
  evaluateGate,
  evaluateInSample,
  type InSampleResult,
  neighbourCheck,
} from "./autopilot-gate.ts";
import {
  type AutopilotGenome,
  genomeDefinition,
  genomeKey,
  genomeNeighbours,
} from "./autopilot-genome.ts";
import { AUTOPILOT_LIBRARY_SECTION } from "./autopilot-handoff.ts";
import { createApiClient } from "./client.ts";
import { ENGINE_COMPARISON_GATE_RUNS_MAX } from "./contracts/engine-comparison.ts";
import {
  AUTOPILOT_SESSION_REQUIRED_MESSAGE,
  autopilotRouter,
} from "./server/autopilot.ts";
import { queueGateComparisons } from "./server/autopilot-comparison.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import { clearInstantBacktestCacheForTesting } from "./server/instant-backtest.ts";
import { StrategyDefinitionSchema } from "./strategy-dsl.ts";

// Test controls: force the gate verdict (to reach the refine step) or stall breeding.
const control = vi.hoisted(() => ({ forcePass: false, stall: false }));
vi.mock("./autopilot-gate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./autopilot-gate.ts")>();
  return {
    ...actual,
    evaluateGate: (input: Parameters<typeof actual.evaluateGate>[0]) => {
      const report = actual.evaluateGate(input);
      return control.forcePass
        ? {
            ...report,
            checks: report.checks.map((check) => ({ ...check, passed: true })),
            passed: true,
          }
        : report;
    },
  };
});
vi.mock("./autopilot-breeding.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./autopilot-breeding.ts")>();
  return {
    ...actual,
    breedGeneration: (input: Parameters<typeof actual.breedGeneration>[0]) =>
      control.stall ? [] : actual.breedGeneration(input),
  };
});

const at = new Date("2026-10-30T12:00:00.000Z");
const PLAINTEXT = `vrk_${"D".repeat(64)}`;
const DAY_MS = 86_400_000;

// Rising series with a short cycle: momentum candidates hold up in and out of sample.
const bars = (size: number) => {
  const c = Float64Array.from(
    { length: size },
    (_, index) => 100 * Math.exp(0.0008 * index) + 4 * Math.sin(index / 6.4)
  );
  const o = Float64Array.from(c, (close, index) =>
    index === 0 ? close : (c[index - 1] as number)
  );
  return {
    c,
    h: Float64Array.from(
      c,
      (close, index) => Math.max(close, o[index] as number) + 0.3
    ),
    l: Float64Array.from(
      c,
      (close, index) => Math.min(close, o[index] as number) - 0.3
    ),
    o,
    t: Float64Array.from(
      { length: size },
      (_, index) => Date.UTC(2015, 0, 1) + index * DAY_MS
    ),
  };
};

const series = (symbol: string, barCount: number): MarketBarSeries => ({
  barCount,
  firstT: Date.UTC(2015, 0, 1),
  id: `${symbol}-1d`,
  importedAt: at,
  lastT: Date.UTC(2015, 0, 1) + (barCount - 1) * DAY_MS,
  source: "synthetic",
  sourceSha256: "a".repeat(64),
  symbol,
  timeframe: "1d",
});

const marketBars = (): MarketBarsRepository => ({
  getSeries: async (symbol) =>
    symbol === "TEST"
      ? series("TEST", 900)
      : symbol === "TINY"
        ? series("TINY", 50)
        : symbol === "SHORT"
          ? series("SHORT", 900)
          : symbol === "FLAT"
            ? series("FLAT", 900)
            : null,
  listSeries: async () => [],
  // SHORT claims 900 bars but holds 450 (a series replaced after the campaign started).
  // FLAT has no time order: bad stored data.
  loadColumns: async (id) =>
    id === "FLAT-1d"
      ? { ...bars(900), t: new Float64Array(900) }
      : bars(id === "SHORT-1d" ? 450 : 900),
  replaceSeries: async () => {
    throw new Error("not used");
  },
});

type Candidate = AutopilotCandidateRecord;
type StoredGate = Readonly<{
  checks: readonly Readonly<{ id: string; passed: boolean; detail: string }>[];
  neighbours: readonly Readonly<{ id: string }>[];
  passed: boolean;
}>;
const gateOf = (row: Candidate): StoredGate =>
  row.gate as unknown as StoredGate;

// In-memory repository with the same rules as the Postgres one.
const memoryAutopilot = () => {
  const campaigns = new Map<string, AutopilotCampaignRecord>();
  const candidates: Candidate[] = [];
  let next = 0;
  const sources: Record<string, readonly string[]> = {
    completed: ["running"],
    failed: ["running"],
    running: ["stopped"],
    stopped: ["running"],
  };
  const summary = (row: Candidate) => {
    const gate = row.gate === null ? null : { ...row.gate };
    if (gate !== null) delete gate["curve"];
    return { ...row, gate };
  };
  const byFitness = (left: Candidate, right: Candidate) =>
    (right.fitness ?? Number.NEGATIVE_INFINITY) -
      (left.fitness ?? Number.NEGATIVE_INFINITY) ||
    left.id.localeCompare(right.id);
  const repository: AutopilotRepository = {
    campaignKeys: async (id) =>
      candidates
        .filter((row) => row.campaignId === id)
        .map((row) => row.genomeKey),
    children: async (id) =>
      candidates.filter((row) => row.parentIds.includes(id)).map(summary),
    createCampaign: async (input) => {
      next += 1;
      const row: AutopilotCampaignRecord = {
        bestCandidateId: null,
        bestFitness: null,
        candidateCount: 0,
        config: input.config,
        cpuMs: 0,
        createdAt: at,
        createdBy: input.createdBy,
        finishedAt: null,
        gatedCount: 0,
        generation: 0,
        id: `camp-${next}`,
        name: input.name,
        note: null,
        startedAt: at,
        status: "running",
        symbol: input.symbol,
        tickedAt: null,
        timeframe: input.timeframe,
        updatedAt: at,
        verifiedCount: 0,
        version: 0,
      };
      campaigns.set(row.id, row);
      return row;
    },
    dueCampaigns: async () =>
      [...campaigns.values()].filter((row) => row.status === "running"),
    getCampaign: async (id) => campaigns.get(id) ?? null,
    getCandidate: async (id) => candidates.find((row) => row.id === id) ?? null,
    getCandidates: async (ids) =>
      candidates.filter((row) => ids.includes(row.id)).map(summary),
    insertCandidates: async (rows) => {
      const inserted: string[] = [];
      for (const row of rows) {
        if (
          candidates.some(
            (other) =>
              other.campaignId === row.campaignId &&
              other.genomeKey === row.genomeKey
          )
        )
          continue;
        candidates.push({
          ...row,
          createdAt: at,
          deploymentRequestId: null,
          gate: null,
          gatedAt: null,
          oosSharpe: null,
          parentIds: [...row.parentIds],
          status: "evaluated",
          strategyId: null,
        });
        inserted.push(row.id);
      }
      return inserted;
    },
    ledger: async (input) => {
      const rows = candidates.filter((row) => row.series === input.series);
      return {
        others: rows
          .filter((row) => row.id !== input.excludeId && row.returnsStd > 0)
          .slice(-input.sample)
          .map((row) => ({
            firstT: row.firstT,
            id: row.id,
            lastT: row.lastT,
            meanReturn: row.returnsMean,
            returns: row.returnsCount,
            stdReturn: row.returnsStd,
          })),
        total: rows.length,
      };
    },
    listCampaigns: async () => [...campaigns.values()],
    listCandidates: async (filters) =>
      candidates
        .filter(
          (row) =>
            row.campaignId === filters.campaignId &&
            (filters.status === undefined || row.status === filters.status)
        )
        .sort(byFitness)
        .slice(0, filters.limit)
        .map(summary),
    population: async (id, limit) =>
      candidates
        .filter(
          (row) =>
            row.campaignId === id &&
            row.fitness !== null &&
            row.origin !== "neighbour"
        )
        .sort(byFitness)
        .slice(0, limit)
        .map((row) => ({
          fitness: row.fitness as number,
          genome: row.genome,
          genomeKey: row.genomeKey,
          id: row.id,
        })),
    recordGate: async (input) => {
      const row = candidates.find(
        (other) => other.id === input.id && other.status === "evaluated"
      );
      if (row === undefined) return null;
      Object.assign(row, {
        gate: input.gate,
        gatedAt: at,
        oosSharpe: input.oosSharpe,
        status: input.status,
      });
      return row;
    },
    recordHandoff: async (input) => {
      const row = candidates.find(
        (other) =>
          other.id === input.id &&
          other.status === "verified" &&
          other.deploymentRequestId === null
      );
      if (row === undefined) return null;
      Object.assign(row, {
        deploymentRequestId: input.deploymentRequestId,
        strategyId: input.strategyId,
      });
      return row;
    },
    recordProgress: async (input) => {
      const row = campaigns.get(input.id);
      if (
        row === undefined ||
        row.version !== input.version ||
        row.status !== "running"
      )
        return null;
      const own = candidates.filter((other) => other.campaignId === input.id);
      const best = [...own].sort(byFitness)[0];
      const saved: AutopilotCampaignRecord = {
        ...row,
        bestCandidateId: best?.id ?? null,
        bestFitness: best?.fitness ?? null,
        candidateCount: own.length,
        cpuMs: row.cpuMs + Math.round(input.cpuMs),
        gatedCount: own.filter((other) => other.status !== "evaluated").length,
        generation: input.generation,
        note: input.note,
        status: input.status,
        verifiedCount: own.filter((other) => other.status === "verified")
          .length,
        version: row.version + 1,
      };
      campaigns.set(row.id, saved);
      return saved;
    },
    transitionCampaign: async (input) => {
      const row = campaigns.get(input.id);
      if (row === undefined || !(sources[input.to] ?? []).includes(row.status))
        return null;
      const saved = {
        ...row,
        note: input.note ?? row.note,
        status: input.to,
        version: row.version + 1,
      };
      campaigns.set(row.id, saved);
      return saved;
    },
    ungated: async (id, limit) =>
      candidates
        .filter(
          (row) =>
            row.campaignId === id &&
            row.status === "evaluated" &&
            row.origin !== "neighbour" &&
            (row.fitness ?? 0) > 0
        )
        .sort(byFitness)
        .slice(0, limit),
  };
  return { campaigns, candidates, repository };
};

const handoffRepositories = () => {
  const definitions = {
    insert: vi.fn(async () => null),
  } as unknown as StrategyDefinitionsRepository;
  const library = {
    create: vi.fn(async (input: { name: string; section: string }) => ({
      id: "strategy-1",
      ...input,
    })),
  } as unknown as StrategyLibraryRepository;
  const requests = {
    create: vi.fn(async () => ({ id: "request-1", status: "draft" })),
    transition: vi.fn(async () => ({ id: "request-1", status: "requested" })),
  } as unknown as DeploymentRequestsRepository;
  return { definitions, library, requests };
};

// Marks one evaluated candidate verified with a real gate report computed as if it were the only
// trial, so the tearsheet and hand-off paths can be checked on a verified row.
const verifyOne = async (
  memory: ReturnType<typeof memoryAutopilot>
): Promise<Candidate> => {
  const parentIds = new Set(memory.candidates.flatMap((row) => row.parentIds));
  const row = memory.candidates.find(
    (other) => other.status === "evaluated" && parentIds.has(other.id)
  ) as Candidate;
  const report = evaluateGate({
    bars: bars(900),
    costBps: 5,
    definition: StrategyDefinitionSchema.parse(row.definition),
    inSample: row.inSample as unknown as InSampleResult,
    ledger: { key: "TEST/1d", others: [], total: 1 },
    seed: row.id,
  });
  await memory.repository.recordGate({
    gate: JSON.parse(
      JSON.stringify({
        ...report,
        checks: [...report.checks, neighbourCheck(1, [1, 1])],
        neighbours: [],
        passed: true,
      })
    ) as Record<string, unknown>,
    id: row.id,
    oosSharpe: report.oos.sharpe,
    status: "verified",
  });
  return row;
};

const session: SafeAuthSession = {
  principal: { role: "member", status: "active", userId: "user-a" },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-11-01T00:00:00.000Z"),
    id: "session-a",
    ipAddress: null,
    updatedAt: at,
    userAgent: null,
    userId: "user-a",
  },
  user: {
    createdAt: at,
    email: "operator@domain.test",
    emailVerified: true,
    id: "user-a",
    image: null,
    name: "user-a",
    role: "member",
    status: "active",
    updatedAt: at,
  },
};

type Harness = Readonly<{
  autopilot?: AutopilotRepository;
  apiKeyAccess?: "read" | "write";
  handoff?: ReturnType<typeof handoffRepositories>;
  withMarketBars?: boolean;
  sectorRotation?: Repositories["sectorRotation"];
  /** Engine comparison on, with this run storage. */
  comparisonRuns?: Pick<BacktestRunsRepository, "enqueueGroup">;
}>;

const clientFor = (options: Harness = {}) => {
  const denied = () =>
    new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
  const repositories: Repositories = {
    addresses: {} as Repositories["addresses"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    featureItems: {} as Repositories["featureItems"],
    profiles: {} as Repositories["profiles"],
    userPreferences: {} as Repositories["userPreferences"],
    ...(options.autopilot === undefined
      ? {}
      : { autopilot: options.autopilot }),
    ...(options.withMarketBars === false ? {} : { marketBars: marketBars() }),
    ...(options.sectorRotation === undefined
      ? {}
      : { sectorRotation: options.sectorRotation }),
    ...(options.comparisonRuns === undefined
      ? {}
      : {
          backtestRuns: options.comparisonRuns as unknown as NonNullable<
            Repositories["backtestRuns"]
          >,
        }),
    ...(options.handoff === undefined
      ? {}
      : {
          deploymentRequests: options.handoff.requests,
          strategyDefinitions: options.handoff.definitions,
          strategyLibrary: options.handoff.library,
        }),
  };
  const keys = {
    authenticate: vi.fn(async () => ({
      access: options.apiKeyAccess ?? "read",
      apiKeyId: "key-1",
      email: "operator@domain.test",
      emailVerified: true,
      role: "member" as const,
      status: "active" as const,
      userId: "user-a",
    })),
  } as unknown as AgentApiKeyService;
  return createApiClient({
    baseUrl: "https://darkfactory.localhost",
    fetch: async (request) => {
      if (options.apiKeyAccess !== undefined)
        request.headers.set("x-api-key", PLAINTEXT);
      const context = createApiContext(request, {
        agentApiKeys: keys,
        capabilities: {
          ai: false,
          analytics: false,
          emailDelivery: false,
          telemetryExport: false,
        },
        operatorEmails: ["operator@domain.test"],
        repositories,
        ...(options.comparisonRuns === undefined
          ? {}
          : { engineComparison: "on" as const, hostLabel: "QuantVPS web" }),
        requestId: "request-1",
        requireRole: async () => {
          throw denied();
        },
        requireSession: async () => session,
      });
      return handleApiRequest(request, context);
    },
  });
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  message?: string
) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, unknown>).code).toBe(code);
  if (message !== undefined)
    expect((error as Error).message).toContain(message);
};

const budget = {
  gatePerGeneration: 2,
  maxCandidates: 60,
  maxCpuMinutes: 60,
  populationSize: 20,
  tickSeconds: 30,
};

describe("autopilot procedures", () => {
  it("creates a campaign only for a stored series with enough bars", async () => {
    const memory = memoryAutopilot();
    const client = clientFor({ autopilot: memory.repository });
    await expectCode(
      client.autopilot.campaigns.create({
        name: "x",
        symbol: "NONE",
        timeframe: "1d",
      }),
      "VALIDATION_ERROR",
      "found 0"
    );
    await expectCode(
      client.autopilot.campaigns.create({
        name: "x",
        symbol: "TINY",
        timeframe: "1d",
      }),
      "VALIDATION_ERROR",
      "found 50"
    );
    const campaign = await client.autopilot.campaigns.create({
      name: "Test",
      symbol: "TEST",
      timeframe: "1d",
    });
    expect(campaign.status).toBe("running");
    expect(campaign.config.budget.populationSize).toBe(40);
    expect(campaign.config.gateVersion).toBe("autopilot-gate-v1");
    expect(campaign.config.seed).toBeGreaterThanOrEqual(0);
    const seeded = await client.autopilot.campaigns.create({
      budget,
      name: "Seeded",
      seed: 42,
      symbol: "TEST",
      timeframe: "1d",
    });
    expect(seeded.config.seed).toBe(42);
    expect((await client.autopilot.campaigns.list({})).campaigns).toHaveLength(
      2
    );
    await expectCode(
      clientFor({
        autopilot: memory.repository,
        withMarketBars: false,
      }).autopilot.campaigns.create({
        name: "x",
        symbol: "TEST",
        timeframe: "1d",
      }),
      "STORAGE_ERROR"
    );
    await expectCode(clientFor().autopilot.campaigns.list({}), "STORAGE_ERROR");
  });

  it("breeds, gates and reports a campaign, counting every candidate as a trial", async () => {
    clearInstantBacktestCacheForTesting();
    const memory = memoryAutopilot();
    const client = clientFor({ autopilot: memory.repository });
    const campaign = await client.autopilot.campaigns.create({
      budget,
      name: "Run",
      seed: 7,
      symbol: "TEST",
      timeframe: "1d",
    });
    const { results } = await client.autopilot.campaigns.tick({});
    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result?.status).toBe("completed");
    expect(result?.note).toContain("budget");
    expect(result?.generation).toBeGreaterThanOrEqual(3);
    expect(result?.gated).toBeGreaterThan(0);
    const detail = await client.autopilot.campaigns.get({ id: campaign.id });
    expect(detail.campaign.candidateCount).toBe(memory.candidates.length);
    expect(detail.seriesTrials).toBe(memory.candidates.length);
    expect(detail.leaderboard[0]?.fitness).toBe(detail.campaign.bestFitness);
    expect(detail.gated.length).toBe(detail.campaign.gatedCount);
    const gated = memory.candidates.filter((row) => row.status !== "evaluated");
    for (const row of gated) {
      const checks = (
        (row.gate?.["checks"] as { id: string }[] | undefined) ?? []
      ).map((check) => check.id);
      expect(checks).toEqual([
        "oosSharpe",
        "forwardFolds",
        "monteCarlo",
        "deflatedSharpe",
        "fdr",
        "minTrades",
        "costs",
        "neighbours",
      ]);
    }
    expect(
      memory.candidates.filter((row) => row.status === "verified").length
    ).toBe(detail.campaign.verifiedCount);
    // On this series many bred candidates have high Sharpe ratios, so the deflated Sharpe ratio
    // over all trials rejects the best of them: the multiple-testing guard at work.
    expect(
      gated.some((row) =>
        gateOf(row).checks.some(
          (check) => check.id === "deflatedSharpe" && !check.passed
        )
      )
    ).toBe(true);
    // API keys reach only the tick, and only with write access.
    const reader = clientFor({
      apiKeyAccess: "read",
      autopilot: memory.repository,
    });
    await expectCode(
      reader.autopilot.campaigns.get({ id: campaign.id }),
      "FORBIDDEN",
      "API keys may call only"
    );
    await expectCode(
      reader.autopilot.campaigns.tick({}),
      "FORBIDDEN",
      "read-only"
    );
    const writer = clientFor({
      apiKeyAccess: "write",
      autopilot: memory.repository,
    });
    expect((await writer.autopilot.campaigns.tick({})).results).toEqual([]);
    await expectCode(
      writer.autopilot.campaigns.create({
        name: "x",
        symbol: "TEST",
        timeframe: "1d",
      }),
      "FORBIDDEN",
      "API keys may call only"
    );
  });

  it("starts, stops and refuses moves the lifecycle does not allow", async () => {
    const memory = memoryAutopilot();
    const client = clientFor({ autopilot: memory.repository });
    const campaign = await client.autopilot.campaigns.create({
      budget,
      name: "Life",
      symbol: "TEST",
      timeframe: "1d",
    });
    const stopped = await client.autopilot.campaigns.setStatus({
      action: "stop",
      id: campaign.id,
    });
    expect(stopped.status).toBe("stopped");
    expect(stopped.note).toBe("Stopped by an operator.");
    await expectCode(
      client.autopilot.campaigns.tick({ id: campaign.id }),
      "CONFLICT",
      "stopped"
    );
    await expectCode(
      client.autopilot.campaigns.setStatus({ action: "stop", id: campaign.id }),
      "CONFLICT",
      "cannot stop"
    );
    expect(
      (
        await client.autopilot.campaigns.setStatus({
          action: "start",
          id: campaign.id,
        })
      ).status
    ).toBe("running");
    await expectCode(
      client.autopilot.campaigns.setStatus({ action: "start", id: "missing" }),
      "NOT_FOUND"
    );
    await expectCode(
      client.autopilot.campaigns.tick({ id: "missing" }),
      "NOT_FOUND"
    );
    await expectCode(
      client.autopilot.campaigns.get({ id: "missing" }),
      "NOT_FOUND"
    );
    await expectCode(
      clientFor({
        autopilot: memory.repository,
        withMarketBars: false,
      }).autopilot.campaigns.tick({}),
      "STORAGE_ERROR"
    );
  });

  it("applies campaign sector filters to every candidate and waits for missing data", async () => {
    clearInstantBacktestCacheForTesting();
    const filter = {
      quadrants: ["leading", "improving"] as ("leading" | "improving")[],
      sector: "XLK",
      type: "sectorQuadrant" as const,
    };
    const filters = [filter];
    // One point before the first bar: every bar sees that quadrant.
    const sectorRotation = (quadrant: "leading" | "lagging") => {
      const listPoints = vi.fn(async () => [
        {
          benchmark: "SPY",
          computedAt: at,
          date: "2014-12-31",
          momentum: 100,
          quadrant,
          ratio: 100,
          symbol: "XLK",
          timeframe: "weekly" as const,
        },
      ]);
      return {
        listPoints,
        repository: { listPoints } as unknown as Repositories["sectorRotation"],
      };
    };
    const campaignFor = async (quadrant: "leading" | "lagging") => {
      const memory = memoryAutopilot();
      const source = sectorRotation(quadrant);
      const client = clientFor({
        autopilot: memory.repository,
        sectorRotation: source.repository,
      });
      const campaign = await client.autopilot.campaigns.create({
        budget: { ...budget, maxCandidates: 20 },
        filters: [...filters],
        name: "Filtered",
        seed: 7,
        symbol: "TEST",
        timeframe: "1d",
      });
      await client.autopilot.campaigns.tick({ id: campaign.id });
      return { campaign, listPoints: source.listPoints, memory };
    };
    const tradesOf = (row: Candidate) => Number(row.inSample["trades"]);

    const allowed = await campaignFor("leading");
    expect(allowed.campaign.config.filters).toEqual([
      {
        ...filter,
        quadrants: ["leading", "improving"],
        timeframe: "weekly",
      },
    ]);
    expect(allowed.listPoints).toHaveBeenCalledWith({
      fromDate: "2014-12-01",
      symbols: ["XLK"],
      timeframe: "weekly",
    });
    expect(allowed.memory.candidates.length).toBeGreaterThan(0);
    for (const row of allowed.memory.candidates)
      expect(row.definition["filters"]).toEqual(
        allowed.campaign.config.filters
      );
    expect(allowed.memory.candidates.some((row) => tradesOf(row) > 0)).toBe(
      true
    );

    const blocked = await campaignFor("lagging");
    expect(blocked.memory.candidates.length).toBeGreaterThan(0);
    expect(blocked.memory.candidates.every((row) => tradesOf(row) === 0)).toBe(
      true
    );

    // No sector repository: the campaign keeps running and retries on the next tick.
    const memory = memoryAutopilot();
    const client = clientFor({ autopilot: memory.repository });
    const waiting = await client.autopilot.campaigns.create({
      budget,
      filters: [...filters],
      name: "Waiting",
      symbol: "TEST",
      timeframe: "1d",
    });
    expect(
      (await client.autopilot.campaigns.tick({ id: waiting.id })).results[0]
    ).toMatchObject({
      note: "Sector quadrant data is not available for XLK (weekly); the next tick retries.",
      status: "running",
    });
    expect(memory.candidates).toHaveLength(0);
    await expectCode(
      client.autopilot.campaigns.create({
        filters: [{ ...filter, quadrants: [], sector: "AAPL" }],
        name: "Bad",
        symbol: "TEST",
        timeframe: "1d",
      }),
      "BAD_REQUEST"
    );
  });

  it("fails a campaign whose series or configuration is gone", async () => {
    const memory = memoryAutopilot();
    const client = clientFor({ autopilot: memory.repository });
    const base = {
      config: {},
      createdBy: "user-a",
      name: "x",
      symbol: "GONE",
      timeframe: "1d",
    };
    const invalid = await memory.repository.createCampaign(base);
    const ticked = await client.autopilot.campaigns.tick({ id: invalid.id });
    expect(ticked.results[0]).toMatchObject({
      note: "The campaign configuration is invalid.",
      status: "failed",
    });
    const config = {
      budget,
      costBps: 5,
      gateVersion: "autopilot-gate-v1",
      seed: 1,
    };
    const gone = await memory.repository.createCampaign({ ...base, config });
    expect(
      (await client.autopilot.campaigns.tick({ id: gone.id })).results[0]
    ).toMatchObject({
      note: "No stored 1d bars for GONE.",
      status: "failed",
    });
    const minutes = await memory.repository.createCampaign({
      ...base,
      config,
      timeframe: "5m",
    });
    expect(
      (await client.autopilot.campaigns.tick({ id: minutes.id })).results[0]
        ?.status
    ).toBe("failed");
  });

  it("shows a candidate tearsheet and hands a verified candidate to paper once", async () => {
    clearInstantBacktestCacheForTesting();
    const memory = memoryAutopilot();
    const handoff = handoffRepositories();
    const client = clientFor({ autopilot: memory.repository, handoff });
    await client.autopilot.campaigns.create({
      budget,
      name: "Paper",
      seed: 7,
      symbol: "TEST",
      timeframe: "1d",
    });
    await client.autopilot.campaigns.tick({});
    const verified = await verifyOne(memory);
    const rejected = memory.candidates.find(
      (row) => row.status === "rejected"
    ) as Candidate;
    const evaluated = memory.candidates.find(
      (row) => row.status === "evaluated" && row.parentIds.length > 0
    ) as Candidate;

    const detail = await client.autopilot.candidates.get({ id: verified.id });
    expect(detail.candidate.gate?.passed).toBe(true);
    expect(detail.curve.length).toBeGreaterThan(10);
    expect(detail.nautilus).toMatchObject({
      armed: false,
      format: "vertex-nautilus-dsl-strategy-v1",
      mode: "paper",
    });
    expect(detail.nautilus?.strategy.definitionSha256).toMatch(
      /^[0-9a-f]{64}$/u
    );
    expect(detail.liveReadiness.allowed).toBe(false);
    expect(detail.liveReadiness.checks.map((check) => check.status)).toEqual([
      "pass",
      "conflict",
      "conflict",
      "conflict",
    ]);
    expect(detail.children.length).toBeGreaterThan(0);
    expect(
      (await client.autopilot.candidates.get({ id: rejected.id })).nautilus
    ).toBeNull();
    const plain = await client.autopilot.candidates.get({ id: evaluated.id });
    expect(plain.curve).toEqual([]);
    expect(plain.candidate.gate).toBeNull();
    expect(plain.parents.length).toBeGreaterThan(0);
    await expectCode(
      client.autopilot.candidates.get({ id: "missing" }),
      "NOT_FOUND"
    );

    const limits = {
      dailyLossLimit: 500,
      maxOrderSize: 10,
      maxOrdersPerMinute: 2,
      maxPosition: 10,
    };
    // Defense in depth: the procedure itself refuses a key even if the handler scope list changed.
    const keyed = createApiContext(
      new Request("https://darkfactory.localhost/api/orpc", {
        headers: { "x-api-key": PLAINTEXT },
      }),
      {
        capabilities: {
          ai: false,
          analytics: false,
          emailDelivery: false,
          telemetryExport: false,
        },
        operatorEmails: ["operator@domain.test"],
        repositories: {} as Repositories,
        requestId: "request-2",
        requireRole: async () => session,
        requireSession: async () => session,
      }
    );
    await expect(
      call(
        autopilotRouter.candidates.sendToPaper,
        { id: verified.id, limits },
        { context: keyed }
      )
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: AUTOPILOT_SESSION_REQUIRED_MESSAGE,
    });
    await expectCode(
      client.autopilot.candidates.sendToPaper({ id: rejected.id, limits }),
      "CONFLICT",
      "verified"
    );
    await expectCode(
      client.autopilot.candidates.sendToPaper({ id: "missing", limits }),
      "NOT_FOUND"
    );
    await expectCode(
      clientFor({
        autopilot: memory.repository,
      }).autopilot.candidates.sendToPaper({ id: verified.id, limits }),
      "STORAGE_ERROR"
    );

    const sent = await client.autopilot.candidates.sendToPaper({
      id: verified.id,
      limits,
    });
    expect(sent.request).toEqual({
      brokerSubmissionAllowed: false,
      executionAuthorized: false,
      id: "request-1",
      mode: "paper",
      status: "requested",
      strategyId: "strategy-1",
    });
    expect(sent.candidate.deploymentRequestId).toBe("request-1");
    expect(handoff.library.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "external",
        section: AUTOPILOT_LIBRARY_SECTION,
        status: "paper",
      })
    );
    expect(handoff.requests.transition).toHaveBeenCalledWith(
      expect.objectContaining({ action: "submit", id: "request-1" })
    );
    await expectCode(
      client.autopilot.candidates.sendToPaper({ id: verified.id, limits }),
      "CONFLICT",
      "already has paper request"
    );
    expect(
      (await client.autopilot.candidates.get({ id: verified.id })).liveReadiness
        .checks[1]?.detail
    ).toContain("request-1");
  });

  it("maps hand-off failures", async () => {
    clearInstantBacktestCacheForTesting();
    const memory = memoryAutopilot();
    const client = clientFor({ autopilot: memory.repository });
    await client.autopilot.campaigns.create({
      budget,
      name: "Fail",
      seed: 7,
      symbol: "TEST",
      timeframe: "1d",
    });
    await client.autopilot.campaigns.tick({});
    const verified = [await verifyOne(memory)];
    const limits = {
      dailyLossLimit: 500,
      maxOrderSize: 10,
      maxOrdersPerMinute: 2,
      maxPosition: 10,
    };
    const invalid = handoffRepositories();
    vi.mocked(invalid.library.create).mockRejectedValueOnce(
      new InvalidRepositoryInputError("name taken")
    );
    await expectCode(
      clientFor({
        autopilot: memory.repository,
        handoff: invalid,
      }).autopilot.candidates.sendToPaper({
        id: (verified[0] as Candidate).id,
        limits,
      }),
      "VALIDATION_ERROR",
      "name taken"
    );
    const broken = handoffRepositories();
    vi.mocked(broken.library.create).mockRejectedValueOnce(new Error("disk"));
    await expectCode(
      clientFor({
        autopilot: memory.repository,
        handoff: broken,
      }).autopilot.candidates.sendToPaper({
        id: (verified[0] as Candidate).id,
        limits,
      }),
      "INTERNAL_SERVER_ERROR"
    );
    const missing = handoffRepositories();
    vi.mocked(missing.requests.create).mockResolvedValueOnce(null);
    await expectCode(
      clientFor({
        autopilot: memory.repository,
        handoff: missing,
      }).autopilot.candidates.sendToPaper({
        id: (verified[0] as Candidate).id,
        limits,
      }),
      "CONFLICT",
      "removed"
    );
    const raced = handoffRepositories();
    vi.mocked(raced.requests.transition).mockResolvedValueOnce(null);
    const racing = { ...memory.repository, recordHandoff: async () => null };
    await expectCode(
      clientFor({
        autopilot: racing,
        handoff: raced,
      }).autopilot.candidates.sendToPaper({
        id: (verified[0] as Candidate).id,
        limits,
      }),
      "CONFLICT",
      "finished first"
    );
    const orphan = memoryAutopilot();
    orphan.candidates.push({
      ...(verified[0] as Candidate),
      campaignId: "gone",
    });
    await expectCode(
      clientFor({
        autopilot: orphan.repository,
        handoff: handoffRepositories(),
      }).autopilot.candidates.sendToPaper({
        id: (verified[0] as Candidate).id,
        limits,
      }),
      "NOT_FOUND",
      "Campaign"
    );
    await expectCode(
      clientFor({ autopilot: orphan.repository }).autopilot.candidates.get({
        id: (verified[0] as Candidate).id,
      }),
      "NOT_FOUND",
      "Campaign"
    );
    // Owner rule: a Core 7 future is research only; the refusal names the ETF twin and writes
    // nothing.
    const futuresCampaign = memory.campaigns.get(
      (verified[0] as Candidate).campaignId
    );
    if (futuresCampaign === undefined) throw new Error("campaign missing");
    memory.campaigns.set(futuresCampaign.id, {
      ...futuresCampaign,
      symbol: "ES=F",
    });
    const futures = handoffRepositories();
    await expectCode(
      clientFor({
        autopilot: memory.repository,
        handoff: futures,
      }).autopilot.candidates.sendToPaper({
        id: (verified[0] as Candidate).id,
        limits,
      }),
      "VALIDATION_ERROR",
      "options on its ETF twin SPY"
    );
    expect(futures.library.create).not.toHaveBeenCalled();
    expect(futures.requests.create).not.toHaveBeenCalled();
    memory.campaigns.set(futuresCampaign.id, {
      ...futuresCampaign,
      symbol: "ZB=F",
    });
    await expectCode(
      clientFor({
        autopilot: memory.repository,
        handoff: futures,
      }).autopilot.candidates.sendToPaper({
        id: (verified[0] as Candidate).id,
        limits,
      }),
      "VALIDATION_ERROR",
      "options on an ETF"
    );
    expect(futures.library.create).not.toHaveBeenCalled();
  });

  it("refines a candidate that passes the gate and stores its neighbours as trials", async () => {
    clearInstantBacktestCacheForTesting();
    control.forcePass = true;
    try {
      const memory = memoryAutopilot();
      const client = clientFor({ autopilot: memory.repository });
      const campaign = await client.autopilot.campaigns.create({
        budget: { ...budget, maxCandidates: 40 },
        name: "Refine",
        seed: 3,
        symbol: "TEST",
        timeframe: "1d",
      });
      // A seeded best candidate whose first neighbour is already stored.
      const seed: AutopilotGenome = {
        entry: [{ block: "trendEma", params: [20] }],
        exit: [{ block: "exitBelowSma", params: [5] }],
        stop: null,
        target: null,
      };
      const row = (
        genome: AutopilotGenome,
        id: string,
        fitness: number | null
      ) => {
        const definition = genomeDefinition(genome, id);
        const inSample = evaluateInSample(bars(900), definition, 5);
        return {
          campaignId: campaign.id,
          definition: JSON.parse(JSON.stringify(definition)) as Record<
            string,
            unknown
          >,
          firstT: new Date(String(inSample.summary.firstT)),
          fitness,
          generation: 0,
          genome: JSON.parse(JSON.stringify(genome)) as Record<string, unknown>,
          genomeKey: genomeKey(genome),
          id,
          inSample: JSON.parse(JSON.stringify(inSample)) as Record<
            string,
            unknown
          >,
          label: id,
          lastT: new Date(String(inSample.summary.lastT)),
          origin: "random" as const,
          parentIds: [],
          returnsCount: inSample.summary.returns,
          returnsMean: Number(inSample.summary.meanReturn),
          returnsStd: Number(inSample.summary.stdReturn),
          series: "TEST/1d",
        };
      };
      await memory.repository.insertCandidates([
        row(seed, "seeded", 999),
        row(
          genomeNeighbours(seed)[0] as AutopilotGenome,
          "known-neighbour",
          null
        ),
      ]);
      const [result] = (await client.autopilot.campaigns.tick({})).results;
      expect(result?.gated).toBeGreaterThan(0);
      const gated = memory.candidates.filter(
        (row) => row.status !== "evaluated"
      );
      for (const row of gated) {
        const neighbours = gateOf(row).neighbours;
        expect(neighbours.length).toBeGreaterThan(0);
        const check = gateOf(row).checks.at(-1);
        expect(check?.id).toBe("neighbours");
        expect(check?.detail).toMatch(/of \d+ neighbours hold up/u);
        expect(row.status).toBe(
          row.gate?.["passed"] === true ? "verified" : "rejected"
        );
      }
      expect(memory.candidates.some((row) => row.origin === "neighbour")).toBe(
        true
      );
      // A neighbour already stored (a duplicate genome) is listed without an id.
      expect(
        gated.some((row) =>
          gateOf(row).neighbours.some((neighbour) => neighbour.id === "")
        )
      ).toBe(true);
    } finally {
      control.forcePass = false;
    }
  });

  it("completes a campaign when breeding stalls or the CPU budget is used", async () => {
    const memory = memoryAutopilot();
    const client = clientFor({ autopilot: memory.repository });
    const stalled = await client.autopilot.campaigns.create({
      budget,
      name: "Stall",
      symbol: "TEST",
      timeframe: "1d",
    });
    control.stall = true;
    try {
      const [result] = (
        await client.autopilot.campaigns.tick({ id: stalled.id })
      ).results;
      expect(result).toMatchObject({ evaluated: 0, status: "completed" });
      expect(result?.note).toContain("no new genomes");
    } finally {
      control.stall = false;
    }
    const spent = await client.autopilot.campaigns.create({
      budget,
      name: "Spent",
      symbol: "TEST",
      timeframe: "1d",
    });
    memory.campaigns.set(spent.id, {
      ...(memory.campaigns.get(spent.id) as AutopilotCampaignRecord),
      cpuMs: budget.maxCpuMinutes * 60_000,
    });
    const [done] = (await client.autopilot.campaigns.tick({ id: spent.id }))
      .results;
    expect(done).toMatchObject({ evaluated: 0, status: "completed" });
    expect(done?.note).toContain("CPU budget");
  });

  it("reports a campaign that changed during the tick", async () => {
    const memory = memoryAutopilot();
    const racing = { ...memory.repository, recordProgress: async () => null };
    const client = clientFor({ autopilot: racing });
    const campaign = await client.autopilot.campaigns.create({
      budget: { ...budget, maxCandidates: 20, tickSeconds: 2 },
      name: "Race",
      symbol: "TEST",
      timeframe: "1d",
    });
    const [result] = (
      await client.autopilot.campaigns.tick({ id: campaign.id })
    ).results;
    // The tick reports the stored status it re-reads.
    expect(result).toMatchObject({
      note: "The campaign was stopped or changed during the tick.",
      status: "running",
    });
    const vanished = {
      ...racing,
      dueCampaigns: async () => [
        memory.campaigns.get(campaign.id) as AutopilotCampaignRecord,
      ],
      getCampaign: async () => null,
    };
    const [gone] = (
      await clientFor({ autopilot: vanished }).autopilot.campaigns.tick({})
    ).results;
    expect(gone?.status).toBe("stopped");
  });

  it("retries after a tick error and fails campaigns with bad or short stored bars", async () => {
    const memory = memoryAutopilot();
    const broken = {
      ...memory.repository,
      population: async () => {
        throw new Error("population query failed");
      },
    };
    const client = clientFor({ autopilot: broken });
    const first = await client.autopilot.campaigns.create({
      budget,
      name: "Broken",
      symbol: "TEST",
      timeframe: "1d",
    });
    const second = await client.autopilot.campaigns.create({
      budget,
      name: "Short",
      symbol: "SHORT",
      timeframe: "1d",
    });
    const { results } = await client.autopilot.campaigns.tick({});
    expect(results.map((result) => [result.campaignId, result.status])).toEqual(
      [
        [first.id, "running"],
        [second.id, "failed"],
      ]
    );
    expect(results[0]?.note).toBe("Tick error; the next tick retries.");
    expect(memory.campaigns.get(first.id)?.note).toBe(results[0]?.note);
    expect(results[1]?.note).toBe(
      "The stored series has 450 bars; Autopilot needs at least 500."
    );
    const healthy = clientFor({ autopilot: memory.repository });
    const third = await healthy.autopilot.campaigns.create({
      budget,
      name: "Flat",
      symbol: "FLAT",
      timeframe: "1d",
    });
    const [flat] = (await healthy.autopilot.campaigns.tick({ id: third.id }))
      .results;
    expect(flat).toMatchObject({
      note: "Tick failed: Bar times must increase",
      status: "failed",
    });
    const thrown = {
      ...memory.repository,
      population: async () => {
        throw "plain";
      },
      recordProgress: async () => null,
    };
    const [plain] = (
      await clientFor({ autopilot: thrown }).autopilot.campaigns.tick({
        id: first.id,
      })
    ).results;
    expect(plain).toMatchObject({
      note: "Tick error; the next tick retries.",
      status: "running",
    });
  });

  it("counts a verified candidate only when this tick stored the verdict", async () => {
    clearInstantBacktestCacheForTesting();
    control.forcePass = true;
    try {
      const memory = memoryAutopilot();
      const late = { ...memory.repository, recordGate: async () => null };
      const client = clientFor({ autopilot: late });
      await client.autopilot.campaigns.create({
        budget: { ...budget, maxCandidates: 20 },
        name: "Late",
        seed: 5,
        symbol: "TEST",
        timeframe: "1d",
      });
      const [result] = (await client.autopilot.campaigns.tick({})).results;
      expect(result?.gated).toBeGreaterThan(0);
      expect(result?.verified).toBe(0);
    } finally {
      control.forcePass = false;
    }
  });

  it("checks the limits before any hand-off write and maps a repeated hand-off", async () => {
    clearInstantBacktestCacheForTesting();
    const memory = memoryAutopilot();
    const handoff = handoffRepositories();
    const client = clientFor({ autopilot: memory.repository, handoff });
    await client.autopilot.campaigns.create({
      budget,
      name: "Limits",
      seed: 7,
      symbol: "TEST",
      timeframe: "1d",
    });
    await client.autopilot.campaigns.tick({});
    const verified = await verifyOne(memory);
    await expectCode(
      client.autopilot.candidates.sendToPaper({
        id: verified.id,
        limits: {
          dailyLossLimit: 500,
          maxOrderSize: 20,
          maxOrdersPerMinute: 2,
          maxPosition: 10,
        },
      }),
      "VALIDATION_ERROR",
      "maxOrderSize must not exceed"
    );
    expect(handoff.definitions.insert).not.toHaveBeenCalled();
    expect(handoff.library.create).not.toHaveBeenCalled();
    const limits = {
      dailyLossLimit: 500,
      maxOrderSize: 10,
      maxOrdersPerMinute: 2,
      maxPosition: 10,
    };
    // A symbol the paper flow refuses is caught before any write too.
    const stored = memory.campaigns.get(
      verified.campaignId
    ) as AutopilotCampaignRecord;
    memory.campaigns.set(stored.id, { ...stored, symbol: "^GSPC" });
    await expectCode(
      client.autopilot.candidates.sendToPaper({ id: verified.id, limits }),
      "VALIDATION_ERROR",
      "symbol"
    );
    expect(handoff.definitions.insert).not.toHaveBeenCalled();
    memory.campaigns.set(stored.id, stored);
    vi.mocked(handoff.library.create).mockRejectedValueOnce(
      new DatabaseConflictError("slug taken")
    );
    await expectCode(
      client.autopilot.candidates.sendToPaper({ id: verified.id, limits }),
      "CONFLICT",
      "already started"
    );
    vi.mocked(handoff.requests.transition).mockRejectedValueOnce(
      new DeploymentRequestStateError("not a draft")
    );
    await expectCode(
      client.autopilot.candidates.sendToPaper({ id: verified.id, limits }),
      "CONFLICT",
      "already started"
    );
  });

  it("keeps the draft status when the submit transition finds no request", async () => {
    clearInstantBacktestCacheForTesting();
    const memory = memoryAutopilot();
    const handoff = handoffRepositories();
    vi.mocked(handoff.requests.transition).mockResolvedValueOnce(null);
    const client = clientFor({ autopilot: memory.repository, handoff });
    await client.autopilot.campaigns.create({
      budget,
      name: "Draft",
      seed: 7,
      symbol: "TEST",
      timeframe: "1d",
    });
    await client.autopilot.campaigns.tick({});
    const verified = await verifyOne(memory);
    const sent = await client.autopilot.candidates.sendToPaper({
      id: verified.id,
      limits: {
        dailyLossLimit: 500,
        maxOrderSize: 10,
        maxOrdersPerMinute: 2,
        maxPosition: 10,
      },
    });
    expect(sent.request.status).toBe("draft");
  });

  it("keeps a campaign running when the time slice ends before a budget", async () => {
    const memory = memoryAutopilot();
    const client = clientFor({ autopilot: memory.repository });
    const campaign = await client.autopilot.campaigns.create({
      budget: {
        ...budget,
        maxCandidates: 50_000,
        populationSize: 10,
        tickSeconds: 2,
      },
      name: "Slice",
      symbol: "TEST",
      timeframe: "1d",
    });
    const [result] = (
      await client.autopilot.campaigns.tick({ id: campaign.id })
    ).results;
    expect(result).toMatchObject({ note: null, status: "running" });
    expect(result?.cpuMs).toBeGreaterThanOrEqual(2000);
  });

  it("reports the stored status when a failing campaign was changed meanwhile", async () => {
    const memory = memoryAutopilot();
    const racing = {
      ...memory.repository,
      transitionCampaign: async () => null,
    };
    const invalid = await memory.repository.createCampaign({
      config: {},
      createdBy: "user-a",
      name: "x",
      symbol: "TEST",
      timeframe: "1d",
    });
    const [result] = (
      await clientFor({ autopilot: racing }).autopilot.campaigns.tick({
        id: invalid.id,
      })
    ).results;
    expect(result?.status).toBe("running");
  });
});

describe("autopilot gate engine comparison", () => {
  it("queues the gate's in-sample and full runs on Nautilus, at most 20 per tick", async () => {
    clearInstantBacktestCacheForTesting();
    const memory = memoryAutopilot();
    const created: BacktestRunCreateInput[] = [];
    const enqueueGroup = vi.fn(
      async (input: Parameters<BacktestRunsRepository["enqueueGroup"]>[0]) => {
        created.push(...input.runs);
        return { created: input.runs.length, reused: false, superseded: 0 };
      }
    );
    const client = clientFor({
      autopilot: memory.repository,
      comparisonRuns: { enqueueGroup },
    });
    const campaign = await client.autopilot.campaigns.create({
      budget,
      name: "Run",
      seed: 7,
      symbol: "TEST",
      timeframe: "1d",
    });
    const [result] = (await client.autopilot.campaigns.tick({})).results;
    const gatedRuns = (result?.gated ?? 0) * 2;
    expect(gatedRuns).toBeGreaterThan(0);
    expect(result?.comparison).toEqual({
      dropped: Math.max(0, gatedRuns - ENGINE_COMPARISON_GATE_RUNS_MAX),
      queued: Math.min(gatedRuns, ENGINE_COMPARISON_GATE_RUNS_MAX),
    });
    expect(enqueueGroup).toHaveBeenCalledTimes(1);
    // The campaign group takes every tick's runs: no reuse and no superseding.
    expect(enqueueGroup.mock.calls[0]?.[0]).not.toHaveProperty("reuseSince");
    expect(enqueueGroup.mock.calls[0]?.[0]).not.toHaveProperty("supersede");
    const [inSample, full] = created;
    expect(inSample?.spec).toMatchObject({
      comparison: {
        feature: "autopilotGate",
        groupId: `autopilot:${campaign.id}`,
        typescript: { host: "QuantVPS web" },
      },
      costBps: 5,
      from: "2015-01-01",
      rule: { kind: "dsl" },
      symbol: "TEST",
      timeframe: "1d",
    });
    const comparisonOf = (input?: BacktestRunCreateInput) =>
      (input?.spec.comparison ?? {}) as { label?: string; key?: string };
    const label = (input?: BacktestRunCreateInput) => comparisonOf(input).label;
    expect(label(inSample)).toMatch(/: in-sample$/u);
    expect(label(full)).toMatch(
      /: full run \(out-of-sample from \d{4}-\d{2}-\d{2}\)$/u
    );
    expect(comparisonOf(inSample).key).toBe(comparisonOf(full).key);
    expect(full?.spec.from).toBe("2015-01-01");
    expect((inSample?.spec.to ?? "") < (full?.spec.to ?? "")).toBe(true);
  });

  it("keeps the tick when the comparison queue fails", async () => {
    clearInstantBacktestCacheForTesting();
    const memory = memoryAutopilot();
    const client = clientFor({
      autopilot: memory.repository,
      comparisonRuns: {
        enqueueGroup: vi.fn(async () => Promise.reject(new Error("db"))),
      },
    });
    await client.autopilot.campaigns.create({
      budget,
      name: "Run",
      seed: 7,
      symbol: "TEST",
      timeframe: "1d",
    });
    const [result] = (await client.autopilot.campaigns.tick({})).results;
    expect(result?.comparison).toMatchObject({
      error: "Nautilus gate comparison could not be queued",
      queued: 0,
    });
    expect(result?.gated).toBeGreaterThan(0);
  });

  it("queues nothing for a tick without gated candidates", async () => {
    const createMany = vi.fn();
    const close = Float64Array.from({ length: 300 }, (_, index) => 100 + index);
    const result = await queueGateComparisons({
      bars: {
        c: close,
        h: close,
        l: close,
        o: close,
        t: close.map((_, i) => i * DAY_MS),
      },
      campaign: {
        id: "c-1",
        symbol: "TEST",
        timeframe: "1d",
      } as AutopilotCampaignRecord,
      candidates: [],
      clock: () => 0,
      costBps: 0,
      queue: { enqueue: createMany, host: "h" },
      sectorQuadrants: undefined,
    });
    expect(result).toEqual({ dropped: 0, queued: 0 });
    expect(createMany).not.toHaveBeenCalled();
  });
});
