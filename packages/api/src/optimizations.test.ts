import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type AgentApiKeyService,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  InvalidRepositoryInputError,
  normalizeOptimizationRun,
  type AgentOpsRepository,
  type OptimizationRunDetail,
  type OptimizationRunsRepository,
  type OptimizationRunSummary,
  type Repositories,
} from "@darkfactory/db/server";
import type { AgentTask } from "@darkfactory/db/schema";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  OptimizationRecordInputSchema,
  type OptimizationRecordInput,
} from "./contracts/optimizations.ts";
import {
  computeOptimizationAnalytics,
  numericBins,
  populationVariance,
} from "./optimization-analytics.ts";
import {
  MCP_TOOLS,
  callMcpTool,
  listMcpTools,
  presentOptimization,
  type CallProcedure,
} from "./server/mcp.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";

const at = new Date("2026-01-02T03:04:05.000Z");
const PLAINTEXT = `vrk_${"C".repeat(64)}`;

const task = (): AgentTask => ({
  id: "task-1",
  kind: "optimization",
  agent: "omp",
  title: "Optimize jump model",
  summary: null,
  status: "running",
  metrics: {},
  links: [],
  paperId: null,
  createdAt: at,
  updatedAt: at,
  startedAt: at,
  finishedAt: null,
});

// Noise-free quadratic over a 3 x 3 grid: score = 10 - (a - 2)^2 - 0.1 * (b - 2)^2, so a matters more than b.
const quadratic = (a: number, b: number) =>
  10 - (a - 2) ** 2 - 0.1 * (b - 2) ** 2;
const gridTrials = () => {
  const rows: {
    index: number;
    params: Record<string, number | string>;
    score: number;
    status: "ok";
    metrics: Record<string, number>;
  }[] = [];
  for (const a of [1, 2, 3]) {
    for (const b of [1, 2, 3]) {
      const score = quadratic(a, b);
      rows.push({
        index: rows.length,
        params: { a, b, venue: "cme" },
        score,
        status: "ok",
        metrics: { sharpe: score },
      });
    }
  }
  return rows;
};

const validRecord = (): OptimizationRecordInput => ({
  taskId: "task-1",
  method: "grid",
  objectives: [{ metric: "sharpe", direction: "maximize" }],
  validation: { mode: "single", params: { nObservations: 300 } },
  markets: ["ES"],
  seed: 0,
  trialCount: 10,
  stopReason: "exhausted",
  best: {
    trialIndex: 4,
    params: { a: 2, b: 2, venue: "cme" },
    score: 10,
    metrics: { sharpe: 10 },
  },
  trials: [
    ...gridTrials(),
    {
      index: 9,
      params: { a: 3, b: 3, venue: "cme" },
      score: null,
      status: "failed",
      reason: "all markets failed",
    },
  ],
  diagnostics: {
    deflatedSharpe: null,
    deflatedSharpeReason: "metric 'sharpe' missing",
    pbo: null,
    pboReason: "no returns function supplied",
  },
});

describe("optimization analytics", () => {
  it("ranks importance by the variance of group mean scores, normalized to sum to 1", () => {
    const analytics = computeOptimizationAnalytics({
      method: "grid",
      objectives: [{ metric: "sharpe", direction: "maximize" }],
      trials: validRecord().trials! as never,
    });
    // Group means for a: {1: 9 - 0.2/3, 2: 10 - 0.2/3, 3: 9 - 0.2/3} -> variance 2/9; for b: offsets {-0.1, 0, -0.1} -> variance 0.02/9.
    const byName = Object.fromEntries(
      analytics.importance.map((entry) => [entry.name, entry])
    );
    expect(byName["a"]?.variance).toBeCloseTo(2 / 9, 12);
    expect(byName["b"]?.variance).toBeCloseTo(0.02 / 9, 12);
    expect(byName["a"]?.importance).toBeCloseTo(2 / 9 / (2 / 9 + 0.02 / 9), 12);
    expect(byName["venue"]).toMatchObject({
      kind: "categorical",
      groups: 1,
      variance: 0,
      importance: 0,
    });
    expect(analytics.importance.map((entry) => entry.name)).toEqual([
      "a",
      "b",
      "venue",
    ]);
    expect(
      analytics.importance.reduce((sum, entry) => sum + entry.importance, 0)
    ).toBeCloseTo(1, 12);
    expect(analytics.trials).toEqual({
      stored: 10,
      ok: 9,
      failed: 1,
      scored: 9,
    });
    return expect(analytics.scoreSource).toBe("score");
  });

  it("profiles numeric dimensions per distinct value and builds a heatmap of the two most important", () => {
    const analytics = computeOptimizationAnalytics({
      method: "grid",
      objectives: [{ metric: "sharpe", direction: "maximize" }],
      trials: gridTrials(),
    });
    const profileA = analytics.profiles.find(
      (profile) => profile.name === "a"
    )!;
    expect(profileA.binned).toBe(false);
    expect(profileA.bins.map((bin) => [bin.low, bin.count])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(profileA.bins[1]?.meanScore).toBeCloseTo(10 - 0.2 / 3, 12);
    expect(profileA.bins[1]?.bestScore).toBe(10);
    expect(analytics.profiles.map((profile) => profile.name)).toEqual([
      "a",
      "b",
    ]);
    expect(analytics.heatmap).toMatchObject({ x: "a", y: "b", filledCells: 9 });
    expect(analytics.heatmap?.meanScores[1]?.[1]).toBe(10);
    return expect(analytics.heatmap?.meanScores[0]?.[0]).toBeCloseTo(
      quadratic(1, 1),
      12
    );
  });

  it("bins many distinct values into equal-width groups and uses the minimum as best when minimizing", () => {
    const values = Array.from({ length: 21 }, (_, i) => i / 2);
    const { bins, binned, locate } = numericBins(values);
    expect(binned).toBe(true);
    expect(bins).toHaveLength(10);
    expect(bins[0]).toEqual({ low: 0, high: 1 });
    expect(bins[9]?.high).toBe(10);
    expect(locate(10)).toBe(9);
    expect(locate(0.99)).toBe(0);
    const trials = values.map((x) => ({
      params: { x },
      score: (x - 5) ** 2,
      status: "ok" as const,
    }));
    const analytics = computeOptimizationAnalytics({
      method: "random",
      objectives: [{ metric: "dd", direction: "minimize" }],
      trials,
    });
    expect(analytics.direction).toBe("minimize");
    expect(analytics.profiles[0]?.bins[5]?.bestScore).toBe(0);
    expect(analytics.heatmap).toBeNull();
    return expect(populationVariance([1])).toBe(0);
  });

  it("scores Pareto runs by the first objective and ignores failed or unscored trials", () => {
    const trials = [
      {
        params: { a: 1 },
        score: null,
        status: "ok" as const,
        metrics: { sharpe: 1, dd: 0.3 },
      },
      {
        params: { a: 2 },
        score: null,
        status: "ok" as const,
        metrics: { sharpe: 3, dd: 0.5 },
      },
      { params: { a: 3 }, score: null, status: "failed" as const },
    ];
    const analytics = computeOptimizationAnalytics({
      method: "pareto",
      objectives: [
        { metric: "sharpe", direction: "maximize" },
        { metric: "dd", direction: "minimize" },
      ],
      trials,
    });
    expect(analytics.scoreSource).toBe("objective:sharpe");
    expect(analytics.trials).toEqual({
      stored: 3,
      ok: 2,
      failed: 1,
      scored: 2,
    });
    expect(analytics.importance[0]).toMatchObject({
      name: "a",
      variance: 1,
      importance: 1,
      groups: 2,
    });
    return expect(
      computeOptimizationAnalytics({
        method: "grid",
        objectives: [{ metric: "s", direction: "maximize" }],
        trials: [],
      })
    ).toMatchObject({ importance: [], profiles: [], heatmap: null });
  });
});

describe("optimization record schema", () =>
  it("accepts the mapped optimizer shape and rejects extras, non-finite values and overflow", () => {
    expect(OptimizationRecordInputSchema.safeParse(validRecord()).success).toBe(
      true
    );
    expect(
      OptimizationRecordInputSchema.safeParse({
        ...validRecord(),
        importance: [],
      }).success
    ).toBe(false);
    expect(
      OptimizationRecordInputSchema.safeParse({
        ...validRecord(),
        method: "bayes",
      }).success
    ).toBe(false);
    expect(
      OptimizationRecordInputSchema.safeParse({
        ...validRecord(),
        best: { ...validRecord().best!, score: Number.POSITIVE_INFINITY },
      }).success
    ).toBe(false);
    expect(
      OptimizationRecordInputSchema.safeParse({
        ...validRecord(),
        markets: Array.from({ length: 41 }, (_, i) => `M${i}`),
      }).success
    ).toBe(false);
    return expect(
      OptimizationRecordInputSchema.safeParse({
        ...validRecord(),
        trials: Array.from({ length: 5001 }, (_, index) => ({
          index,
          params: {},
          score: 1,
          status: "ok",
        })),
      }).success
    ).toBe(false);
  }));

// Uses the real normalizer so the repository's cross-field rules are exercised end to end.
const memoryRuns = (
  taskIds: readonly string[]
): OptimizationRunsRepository & { rows: OptimizationRunDetail[] } & {
  [K in keyof OptimizationRunsRepository]: ReturnType<typeof vi.fn>;
} => {
  const rows: OptimizationRunDetail[] = [];
  return {
    rows,
    record: vi.fn(async (input) => {
      let normalized: ReturnType<typeof normalizeOptimizationRun>;
      try {
        normalized = normalizeOptimizationRun(input);
      } catch (error) {
        throw new InvalidRepositoryInputError((error as Error).message);
      }
      if (!taskIds.includes(normalized.taskId))
        throw new InvalidRepositoryInputError(
          "optimization run references a missing record"
        );
      const row: OptimizationRunDetail = {
        id: `opt-${rows.length + 1}`,
        ...normalized,
        createdAt: at,
        strategyName: null,
      };
      rows.push(row);
      return row;
    }),
    list: vi.fn(async () => {
      return rows.map(
        ({
          trials,
          folds,
          paretoFront,
          oos: _oos,
          marketRanking: _ranking,
          ...rest
        }): OptimizationRunSummary => ({
          ...rest,
          storedTrialCount: trials.length,
          foldCount: folds.length,
          paretoCount: paretoFront.length,
        })
      );
    }),
    get: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
  } as unknown as OptimizationRunsRepository & {
    rows: OptimizationRunDetail[];
  } & { [K in keyof OptimizationRunsRepository]: ReturnType<typeof vi.fn> };
};

const agentOps = (): AgentOpsRepository => {
  return {
    listTasks: vi.fn(async () => [task()]),
    getTask: vi.fn(async (id: string) =>
      id === "task-1" ? { task: task(), events: [] } : null
    ),
  } as unknown as AgentOpsRepository;
};

const session = (email = "operator@domain.test"): SafeAuthSession => ({
  user: {
    id: "user-a",
    name: "user-a",
    email,
    emailVerified: true,
    image: null,
    createdAt: at,
    updatedAt: at,
    role: "member",
    status: "active",
  },
  session: {
    id: "session-a",
    userId: "user-a",
    expiresAt: new Date("2026-01-03T03:04:05.000Z"),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId: "user-a", role: "member", status: "active" },
});

type Harness = Readonly<{
  requestSession?: SafeAuthSession | null;
  apiKeyAccess?: "read" | "write";
  optimizationRuns?: OptimizationRunsRepository;
}>;

const clientFor = (options: Harness = {}) => {
  const denied = () =>
    new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
  const repositories: Repositories = {
    profiles: {} as Repositories["profiles"],
    addresses: {} as Repositories["addresses"],
    userPreferences: {} as Repositories["userPreferences"],
    featureItems: {} as Repositories["featureItems"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    agentOps: agentOps(),
    ...(options.optimizationRuns === undefined
      ? {}
      : { optimizationRuns: options.optimizationRuns }),
  };
  const keys = {
    authenticate: vi.fn(async (headers: Headers) => {
      if (headers.get("x-api-key") !== PLAINTEXT) throw denied();
      return {
        userId: "user-a",
        role: "member" as const,
        status: "active" as const,
        apiKeyId: "key-1",
        access: options.apiKeyAccess ?? "read",
        email: "operator@domain.test",
        emailVerified: true,
      };
    }),
  } as unknown as AgentApiKeyService;
  return createApiClient({
    baseUrl: "https://darkfactory.localhost",
    fetch: async (request) => {
      if (options.apiKeyAccess !== undefined)
        request.headers.set("x-api-key", PLAINTEXT);
      const requestSession =
        options.requestSession === undefined
          ? session()
          : options.requestSession;
      const context = createApiContext(request, {
        repositories,
        requestId: "request-1",
        capabilities: {
          ai: false,
          emailDelivery: false,
          analytics: false,
          telemetryExport: false,
        },
        requireSession: async () => {
          if (requestSession === null) throw denied();
          return requestSession;
        },
        requireRole: async () => {
          throw denied();
        },
        operatorEmails: ["operator@domain.test"],
        agentApiKeys: keys,
      });
      return handleApiRequest(request, context);
    },
  });
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number,
  message?: string
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code,
      status,
      ...(message === undefined ? {} : { message }),
    });
  }
};

describe("agentOps.optimizations procedures", () => {
  it("requires an operator session", async () => {
    const runs = memoryRuns(["task-1"]);
    await expectCode(
      clientFor({
        requestSession: null,
        optimizationRuns: runs,
      }).agentOps.optimizations.list({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor({
        requestSession: session("outsider@domain.test"),
        optimizationRuns: runs,
      }).agentOps.optimizations.record(validRecord()),
      "FORBIDDEN",
      403
    );
    return expect(runs.record).not.toHaveBeenCalled();
  });

  it("records, lists with task titles and reads detail with derived analytics", async () => {
    const runs = memoryRuns(["task-1"]);
    const client = clientFor({ optimizationRuns: runs });
    const recorded = await client.agentOps.optimizations.record(validRecord());
    expect(recorded).toMatchObject({
      id: "opt-1",
      method: "grid",
      trialCount: 10,
      best: { score: 10 },
    });
    expect(recorded.analytics.importance[0]?.name).toBe("a");
    const listed = await client.agentOps.optimizations.list({
      strategyId: "s-1",
    });
    expect(runs.list).toHaveBeenLastCalledWith({ strategyId: "s-1" });
    expect(listed.optimizations[0]).toMatchObject({
      id: "opt-1",
      taskTitle: "Optimize jump model",
      storedTrialCount: 10,
      foldCount: 0,
      paretoCount: 0,
    });
    expect(listed.optimizations[0]).not.toHaveProperty("trials");
    const detail = await client.agentOps.optimizations.get({ id: "opt-1" });
    expect(detail.task?.id).toBe("task-1");
    expect(detail.optimization.trials).toHaveLength(10);
    expect(detail.optimization.analytics.heatmap).toMatchObject({
      x: "a",
      y: "b",
    });
    return await expectCode(
      client.agentOps.optimizations.get({ id: "missing" }),
      "NOT_FOUND",
      404
    );
  });

  it("maps normalizer and missing-task failures to VALIDATION_ERROR with the precise message", async () => {
    const client = clientFor({ optimizationRuns: memoryRuns(["task-1"]) });
    await expectCode(
      client.agentOps.optimizations.record({
        ...validRecord(),
        best: { ...validRecord().best!, trialIndex: 99 },
      }),
      "VALIDATION_ERROR",
      422,
      "best.trialIndex must be between 0 and 9"
    );
    await expectCode(
      client.agentOps.optimizations.record({
        ...validRecord(),
        taskId: "task-2",
      }),
      "VALIDATION_ERROR",
      422
    );
    return await expectCode(
      clientFor({}).agentOps.optimizations.list({}),
      "STORAGE_ERROR",
      503
    );
  });

  it("lets a read key list and get but refuses record; a write key may record", async () => {
    const runs = memoryRuns(["task-1"]);
    const writer = clientFor({
      requestSession: null,
      apiKeyAccess: "write",
      optimizationRuns: runs,
    });
    const recorded = await writer.agentOps.optimizations.record(validRecord());
    const reader = clientFor({
      requestSession: null,
      apiKeyAccess: "read",
      optimizationRuns: runs,
    });
    expect(
      (await reader.agentOps.optimizations.list({})).optimizations
    ).toHaveLength(1);
    expect(
      (await reader.agentOps.optimizations.get({ id: recorded.id }))
        .optimization.id
    ).toBe(recorded.id);
    await expectCode(
      reader.agentOps.optimizations.record(validRecord()),
      "FORBIDDEN",
      403,
      "This API key is read-only"
    );
    return expect(runs.record).toHaveBeenCalledTimes(1);
  });
});

describe("optimization MCP tools", () => {
  it("registers read and write tools against agentOps.optimizations procedures", () => {
    const tools = new Map(
      listMcpTools().map((tool) => [tool["name"] as string, tool])
    );
    const expected = [
      ["optimizations_list", "agentOps/optimizations/list", true],
      ["optimizations_get", "agentOps/optimizations/get", true],
      ["optimizations_record", "agentOps/optimizations/record", false],
    ] as const;

    for (const [name, procedure, readOnly] of expected) {
      expect(MCP_TOOLS.find((tool) => tool.name === name)).toMatchObject({
        procedure,
        readOnly,
      });
      expect(
        (tools.get(name)!["annotations"] as { readOnlyHint: boolean })
          .readOnlyHint
      ).toBe(readOnly);
      expect((tools.get(name)!["inputSchema"] as { type: string }).type).toBe(
        "object"
      );
    }
  });

  it("omits trial rows unless includeTrials and strips the flag before calling get", async () => {
    const value = {
      optimization: {
        id: "o",
        trials: [{}, {}, {}],
        analytics: { a: 1 },
        folds: [],
      },
      task: null,
    };
    expect(presentOptimization(value, false)).toEqual({
      optimization: {
        id: "o",
        analytics: { a: 1 },
        folds: [],
        trialsOmitted: { stored: 3 },
      },
      task: null,
    });
    expect(presentOptimization(value, true)).toBe(value);
    const call = vi.fn(async () => ({ ok: true as const, value }));
    const result = await callMcpTool(
      "optimizations_get",
      { id: "o" },
      call as unknown as CallProcedure
    );
    expect(call).toHaveBeenCalledWith("agentOps/optimizations/get", {
      id: "o",
    });
    expect(result["structuredContent"]).toMatchObject({
      optimization: { trialsOmitted: { stored: 3 } },
    });
    await callMcpTool(
      "optimizations_get",
      { id: "o", includeTrials: true },
      call as unknown as CallProcedure
    );
    return expect(call).toHaveBeenLastCalledWith("agentOps/optimizations/get", {
      id: "o",
    });
  });

  it("validates record arguments and surfaces read-key refusals", async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: {} }));
    expect(
      (
        await callMcpTool(
          "optimizations_record",
          { ...validRecord(), method: "bayes" },
          call as unknown as CallProcedure
        )
      )["isError"]
    ).toBe(true);
    expect(call).not.toHaveBeenCalled();
    await callMcpTool(
      "optimizations_list",
      { taskId: "task-1" },
      call as unknown as CallProcedure
    );
    expect(call).toHaveBeenCalledWith("agentOps/optimizations/list", {
      taskId: "task-1",
    });
    const refused: CallProcedure = async () => ({
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "This API key is read-only",
    });
    return expect(
      await callMcpTool("optimizations_record", validRecord(), refused)
    ).toMatchObject({
      isError: true,
      content: [{ text: "FORBIDDEN (403): This API key is read-only" }],
    });
  });
});
