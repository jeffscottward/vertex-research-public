import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type AgentApiKeyService,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  InvalidRepositoryInputError,
  normalizeBacktestResult,
  type AgentOpsRepository,
  type BacktestResultsRepository,
  type BacktestTrialLedger,
  type BacktestResultSummary,
  type Repositories,
  type StrategyLibraryRepository,
  type StrategyListRow,
} from "@darkfactory/db/server";
import type {
  AgentTask,
  BacktestResult,
  StrategyPreset,
} from "@darkfactory/db/schema";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  MCP_TOOLS,
  callMcpTool,
  listMcpTools,
  type CallProcedure,
} from "./server/mcp.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import { latestBacktestStats, sortStrategies } from "./strategy-library.ts";

const at = new Date("2026-01-02T03:04:05.000Z");
const later = new Date("2026-01-03T03:04:05.000Z");
const PLAINTEXT = `vrk_${"B".repeat(64)}`;

const strategyRow = (
  overrides: Partial<StrategyListRow> = {}
): StrategyListRow => ({
  id: "s-hmm",
  slug: "hmm",
  name: "HMM forward filter",
  description: null,
  kind: "python",
  status: "researching",
  sourceRef: "services/research/strategies/hmm.py",
  tags: ["regime"],
  favorite: false,
  section: null,
  params: [],
  createdAt: at,
  updatedAt: at,
  presetCount: 0,
  backtestCount: 0,
  ...overrides,
});

const presetRow = (
  overrides: Partial<StrategyPreset> = {}
): StrategyPreset => ({
  id: "p-1",
  strategyId: "s-hmm",
  name: "fast",
  values: { lookback: 10 },
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

const task = (): AgentTask => ({
  id: "task-1",
  kind: "backtest",
  agent: "omp",
  title: "Backtest HMM",
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

// Rising equity (positive Sharpe) and falling equity (negative Sharpe), daily points.
const equity = (start: number, step: number) => {
  return Array.from({ length: 10 }, (_, index) => ({
    t: `2024-01-${String(index + 1).padStart(2, "0")}`,
    equity: start + step * index + (index % 2 === 0 ? 0 : step / 3),
  }));
};

const strategiesRepository = (
  rows: StrategyListRow[]
): StrategyLibraryRepository & {
  [K in keyof StrategyLibraryRepository]: ReturnType<typeof vi.fn>;
} => {
  return {
    list: vi.fn(async () => rows),
    get: vi.fn(async (id: string) => {
      const found = rows.find((row) => row.id === id);
      return found === undefined
        ? null
        : { strategy: found, presets: [presetRow()] };
    }),
    create: vi.fn(async (input) =>
      strategyRow({
        id: "s-new",
        name: input.name,
        kind: input.kind,
        slug: "new",
      })
    ),
    update: vi.fn(async (input) => {
      const found = rows.find((row) => row.id === input.id);
      return found === undefined
        ? null
        : {
            ...found,
            ...(input.favorite === undefined
              ? {}
              : { favorite: input.favorite }),
          };
    }),
    savePreset: vi.fn(async (input) => {
      if (input.strategyId === "missing") return null;
      if ((input.values as Record<string, unknown>)["lookback"] === 1)
        throw new InvalidRepositoryInputError(
          "values.lookback must be at least 5"
        );
      return presetRow({
        name: input.name,
        values: input.values as StrategyPreset["values"],
      });
    }),
    removePreset: vi.fn(async (input) => input.id === "p-1"),
    latestBacktests: vi.fn(async (ids: readonly string[]) => [
      ...(ids.includes("s-up")
        ? [
            {
              strategyId: "s-up",
              id: "bt-up",
              createdAt: later,
              maxDrawdown: -0.01,
              equity: equity(100, 2),
            },
          ]
        : []),
      ...(ids.includes("s-down")
        ? [
            {
              strategyId: "s-down",
              id: "bt-down",
              createdAt: later,
              maxDrawdown: -0.2,
              equity: equity(200, -3),
            },
          ]
        : []),
    ]),
  } as unknown as StrategyLibraryRepository & {
    [K in keyof StrategyLibraryRepository]: ReturnType<typeof vi.fn>;
  };
};

const memoryBacktests = (): BacktestResultsRepository & {
  rows: BacktestResult[];
} => {
  const rows: BacktestResult[] = [];
  return {
    rows,
    record: vi.fn(async (input) => {
      const row: BacktestResult = {
        id: `bt-${rows.length + 1}`,
        ...normalizeBacktestResult(input),
        createdAt: at,
      };
      rows.push(row);
      return row;
    }),
    list: vi.fn(async (filters = {}) => {
      return rows
        .filter(
          (row) =>
            filters.strategyId === undefined ||
            row.strategyId === filters.strategyId
        )
        .map(
          ({
            equity: points,
            drawdown,
            trades,
            folds,
            runConfig,
            benchmark,
            ...rest
          }): BacktestResultSummary => ({
            ...rest,
            pointCount: points.length,
            foldCount: folds.length,
          })
        );
    }),
    get: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
    // Ledger fake: counts results in scope; per-trial return stats are database-computed in production.
    trialLedger: vi.fn(
      async (
        backtest: Readonly<{ strategyId: string | null; taskId: string }>
      ): Promise<BacktestTrialLedger> => {
        const inScope = rows.filter((row) =>
          backtest.strategyId === null
            ? row.taskId === backtest.taskId
            : row.strategyId === backtest.strategyId
        );
        return {
          scope: backtest.strategyId === null ? "task" : "strategy",
          key: backtest.strategyId ?? backtest.taskId,
          total: inScope.length,
          others: [],
        };
      }
    ),
  };
};

const agentOps = (): AgentOpsRepository => {
  return {
    listTasks: vi.fn(async () => [task()]),
    getTask: vi.fn(async () => null),
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
  strategyLibrary?: StrategyLibraryRepository;
  backtestResults?: BacktestResultsRepository;
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
    ...(options.strategyLibrary === undefined
      ? {}
      : { strategyLibrary: options.strategyLibrary }),
    ...(options.backtestResults === undefined
      ? {}
      : { backtestResults: options.backtestResults }),
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

describe("strategy library rules", () => {
  it("derives latest-backtest statistics from equity, falling back to the stored drawdown", () => {
    const stats = latestBacktestStats({
      id: "bt",
      createdAt: at,
      maxDrawdown: -0.5,
      equity: equity(100, 2),
    });
    expect(stats.sharpe).toBeGreaterThan(0);
    expect(stats.totalReturn).toBeCloseTo((100 + 18 + 2 / 3) / 100 - 1, 10);
    return expect(
      latestBacktestStats({
        id: "bt",
        createdAt: at,
        maxDrawdown: -0.5,
        equity: [],
      })
    ).toEqual({
      id: "bt",
      createdAt: at,
      sharpe: null,
      totalReturn: null,
      cagr: null,
      maxDrawdown: -0.5,
    });
  });

  it("sorts by name, update time, or metric descending with missing values last", () => {
    const latest = (sharpe: number | null, totalReturn: number | null) => ({
      id: "b",
      createdAt: at,
      sharpe,
      totalReturn,
      cagr: null,
      maxDrawdown: null,
    });
    const rows = [
      { id: "a", name: "beta", updatedAt: at, latestBacktest: null },
      {
        id: "b",
        name: "Alpha",
        updatedAt: later,
        latestBacktest: latest(0.5, -0.1),
      },
      {
        id: "c",
        name: "gamma",
        updatedAt: at,
        latestBacktest: latest(1.2, 0.3),
      },
      {
        id: "d",
        name: "delta",
        updatedAt: at,
        latestBacktest: latest(null, null),
      },
    ];
    expect(sortStrategies(rows, "name").map((row) => row.id)).toEqual([
      "b",
      "a",
      "d",
      "c",
    ]);
    expect(sortStrategies(rows, "updated")[0]?.id).toBe("b");
    expect(sortStrategies(rows, "sharpe").map((row) => row.id)).toEqual([
      "c",
      "b",
      "a",
      "d",
    ]);
    return expect(sortStrategies(rows, "return").map((row) => row.id)).toEqual([
      "c",
      "b",
      "a",
      "d",
    ]);
  });
});

describe("strategyLibrary procedures", () => {
  it("requires an operator session", async () => {
    const repository = strategiesRepository([strategyRow()]);
    await expectCode(
      clientFor({
        requestSession: null,
        strategyLibrary: repository,
      }).strategyLibrary.list({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor({
        requestSession: session("outsider@domain.test"),
        strategyLibrary: repository,
      }).strategyLibrary.create({ name: "x", kind: "python" }),
      "FORBIDDEN",
      403
    );
    return expect(repository.create).not.toHaveBeenCalled();
  });

  it("lists with filters and sorts by the latest linked backtest's derived Sharpe", async () => {
    const rows = [
      strategyRow({ id: "s-none", name: "No backtests" }),
      strategyRow({ id: "s-down", name: "Falling", backtestCount: 1 }),
      strategyRow({ id: "s-up", name: "Rising", backtestCount: 2 }),
    ];
    const repository = strategiesRepository(rows);
    const client = clientFor({ strategyLibrary: repository });
    const result = await client.strategyLibrary.list({
      search: "regime",
      status: "researching",
      favorite: false,
      section: null,
      tag: " quantjourney ",
      sort: "sharpe",
    });
    expect(repository.list).toHaveBeenCalledWith({
      search: "regime",
      status: "researching",
      favorite: false,
      section: null,
      tag: "quantjourney",
    });
    expect(repository.latestBacktests).toHaveBeenCalledWith(["s-down", "s-up"]);
    expect(result.strategies.map((row) => row.id)).toEqual([
      "s-up",
      "s-down",
      "s-none",
    ]);
    expect(result.strategies[0]?.latestBacktest).toMatchObject({ id: "bt-up" });
    return expect(result.strategies[2]?.latestBacktest).toBeNull();
  });

  it("creates, updates, saves and removes presets, and maps failures", async () => {
    const repository = strategiesRepository([strategyRow()]);
    const client = clientFor({ strategyLibrary: repository });
    expect(
      await client.strategyLibrary.create({
        name: "New idea",
        kind: "native",
        section: " ",
      })
    ).toMatchObject({ id: "s-new", kind: "native" });
    expect(repository.create).toHaveBeenCalledWith({
      name: "New idea",
      kind: "native",
      section: null,
    });
    expect(
      await client.strategyLibrary.update({ id: "s-hmm", favorite: true })
    ).toMatchObject({ favorite: true });
    await expectCode(
      client.strategyLibrary.update({ id: "nope", favorite: true }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      client.strategyLibrary.update({ id: "s-hmm" }),
      "BAD_REQUEST",
      400
    );
    expect(
      await client.strategyLibrary.presets.save({
        strategyId: "s-hmm",
        name: "slow",
        values: { lookback: 50 },
      })
    ).toMatchObject({ name: "slow", values: { lookback: 50 } });
    await expectCode(
      client.strategyLibrary.presets.save({
        strategyId: "s-hmm",
        name: "x",
        values: { lookback: 1 },
      }),
      "VALIDATION_ERROR",
      422,
      "values.lookback must be at least 5"
    );
    await expectCode(
      client.strategyLibrary.presets.save({
        strategyId: "missing",
        name: "x",
        values: { lookback: 9 },
      }),
      "NOT_FOUND",
      404
    );
    expect(
      await client.strategyLibrary.presets.remove({
        strategyId: "s-hmm",
        id: "p-1",
      })
    ).toEqual({ removed: true });
    await expectCode(
      client.strategyLibrary.presets.remove({ strategyId: "s-hmm", id: "p-2" }),
      "NOT_FOUND",
      404
    );
    repository.create.mockRejectedValueOnce(
      new InvalidRepositoryInputError("params[0].default must be at most 250")
    );
    return await expectCode(
      client.strategyLibrary.create({
        name: "x",
        kind: "python",
        params: [{ name: "a" }],
      }),
      "VALIDATION_ERROR",
      422,
      "params[0].default must be at most 250"
    );
  });

  it("links recorded backtests to a strategy and returns them from get with task titles", async () => {
    const backtests = memoryBacktests();
    const repository = strategiesRepository([
      strategyRow({ backtestCount: 1 }),
    ]);
    const client = clientFor({
      strategyLibrary: repository,
      backtestResults: backtests,
    });
    const recorded = await client.agentOps.backtests.record({
      taskId: "task-1",
      strategyId: "s-hmm",
      strategy: "hmm v1",
      instruments: "SPY",
      periodStart: "2024-01-01",
      periodEnd: "2024-01-10",
      dataSource: "fixture",
    });
    expect(recorded.strategyId).toBe("s-hmm");
    expect(
      (await client.agentOps.backtests.list({ strategyId: "s-hmm" })).backtests
    ).toHaveLength(1);
    expect(backtests.list).toHaveBeenLastCalledWith({ strategyId: "s-hmm" });
    const detail = await client.strategyLibrary.get({ id: "s-hmm" });
    expect(detail.presets).toEqual([
      expect.objectContaining({ name: "fast", values: { lookback: 10 } }),
    ]);
    expect(detail.backtests).toEqual([
      expect.objectContaining({
        id: recorded.id,
        strategyId: "s-hmm",
        taskTitle: "Backtest HMM",
      }),
    ]);
    return await expectCode(
      client.strategyLibrary.get({ id: "missing" }),
      "NOT_FOUND",
      404
    );
  });

  it("lets a read key list and get but refuses every write; a write key may write", async () => {
    const repository = strategiesRepository([strategyRow()]);
    const reader = clientFor({
      requestSession: null,
      apiKeyAccess: "read",
      strategyLibrary: repository,
    });
    expect((await reader.strategyLibrary.list({})).strategies).toHaveLength(1);
    expect(
      (await reader.strategyLibrary.get({ id: "s-hmm" })).strategy.id
    ).toBe("s-hmm");
    await expectCode(
      reader.strategyLibrary.create({ name: "x", kind: "python" }),
      "FORBIDDEN",
      403,
      "This API key is read-only"
    );
    await expectCode(
      reader.strategyLibrary.update({ id: "s-hmm", favorite: true }),
      "FORBIDDEN",
      403,
      "This API key is read-only"
    );
    await expectCode(
      reader.strategyLibrary.presets.save({
        strategyId: "s-hmm",
        name: "x",
        values: { a: 1 },
      }),
      "FORBIDDEN",
      403,
      "This API key is read-only"
    );
    await expectCode(
      reader.strategyLibrary.presets.remove({ strategyId: "s-hmm", id: "p-1" }),
      "FORBIDDEN",
      403,
      "This API key is read-only"
    );
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    const writer = clientFor({
      requestSession: null,
      apiKeyAccess: "write",
      strategyLibrary: repository,
    });
    return expect(
      await writer.strategyLibrary.create({ name: "x", kind: "python" })
    ).toMatchObject({ id: "s-new" });
  });
});

describe("strategy MCP tools", () => {
  it("registers read and write strategy tools against strategyLibrary procedures", () => {
    const tools = new Map(
      listMcpTools().map((tool) => [tool["name"] as string, tool])
    );
    const expected = [
      ["strategies_list", "strategyLibrary/list", true],
      ["strategies_get", "strategyLibrary/get", true],
      ["strategies_create", "strategyLibrary/create", false],
      ["strategies_update", "strategyLibrary/update", false],
      ["strategy_presets_save", "strategyLibrary/presets/save", false],
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
    }
  });

  it("validates arguments, forwards them and surfaces read-key refusals", async () => {
    const call = vi.fn(async () => ({
      ok: true as const,
      value: { strategies: [] },
    }));
    expect(
      (
        await callMcpTool(
          "strategies_list",
          { sort: "best" },
          call as unknown as CallProcedure
        )
      )["isError"]
    ).toBe(true);
    expect(call).not.toHaveBeenCalled();
    await callMcpTool(
      "strategies_list",
      { sort: "sharpe", favorite: true },
      call as unknown as CallProcedure
    );
    expect(call).toHaveBeenCalledWith("strategyLibrary/list", {
      sort: "sharpe",
      favorite: true,
    });
    await callMcpTool(
      "strategy_presets_save",
      { strategyId: "s-hmm", name: "fast", values: { lookback: 10 } },
      call as unknown as CallProcedure
    );
    expect(call).toHaveBeenLastCalledWith("strategyLibrary/presets/save", {
      strategyId: "s-hmm",
      name: "fast",
      values: { lookback: 10 },
    });
    const refused: CallProcedure = async () => ({
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "This API key is read-only",
    });
    return expect(
      await callMcpTool(
        "strategies_update",
        { id: "s-hmm", favorite: true },
        refused
      )
    ).toMatchObject({
      isError: true,
      content: [{ text: "FORBIDDEN (403): This API key is read-only" }],
    });
  });
});
