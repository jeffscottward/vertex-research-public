import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type AgentApiKeyService,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  DatabasePersistenceError,
  InvalidRepositoryInputError,
  normalizeBacktestResult,
  type AgentOpsRepository,
  type BacktestResultsRepository,
  type BacktestTrialLedger,
  type BacktestResultSummary,
  type Repositories,
  type ResearchStudyRepository,
  type StrategyLibraryRepository,
  type StrategyListRow,
} from "@darkfactory/db/server";
import type {
  AgentTask,
  BacktestResult,
  StrategyPreset,
} from "@darkfactory/db/schema";
import type {
  SemanticEvent,
  SemanticEventPort,
  SpanHandle,
} from "@darkfactory/observability/port";
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
import {
  latestBacktestStats,
  sortStrategies,
  studyCandidateSlugs,
  studyVerdictsBySlug,
} from "./strategy-library.ts";

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
  priority: "normal",
  externalValidation: null,
  createdAt: at,
  updatedAt: at,
  presetCount: 0,
  backtestCount: 0,
  ...overrides,
});

// A third party's claim, in the shape migration 0065 stores for the volume spike breakout row.
const claim = {
  sourceUrl: "https://youtu.be/XLMG6-SATRk",
  sourceTitle: "I Backtested 10,000 Strategies",
  sourceAuthor: "Lil Fish, YouTube",
  publishedOn: "2026-09-24",
  claimedMethod: "10,500 strategies ranked by total net R.",
  claimedMetrics: [
    { label: "Rank", value: "1 of 10,500" },
    { label: "Win rate", value: "14%" },
  ],
};

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
        priority: input.priority ?? "normal",
        externalValidation: input.externalValidation ?? null,
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
            ...(input.priority === undefined
              ? {}
              : { priority: input.priority }),
            ...(input.externalValidation === undefined
              ? {}
              : { externalValidation: input.externalValidation }),
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
  researchStudies?: ResearchStudyRepository;
  semanticEvents?: SemanticEventPort;
  span?: SpanHandle;
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
    ...(options.researchStudies === undefined
      ? {}
      : { researchStudies: options.researchStudies }),
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
        ...(options.semanticEvents === undefined
          ? {}
          : { semanticEvents: options.semanticEvents }),
        ...(options.span === undefined ? {} : { span: options.span }),
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
    const normal = "normal" as const;
    const rows = [
      {
        id: "a",
        name: "beta",
        priority: normal,
        updatedAt: at,
        latestBacktest: null,
      },
      {
        id: "b",
        name: "Alpha",
        priority: normal,
        updatedAt: later,
        latestBacktest: latest(0.5, -0.1),
      },
      {
        id: "c",
        name: "gamma",
        priority: normal,
        updatedAt: at,
        latestBacktest: latest(1.2, 0.3),
      },
      {
        id: "d",
        name: "delta",
        priority: normal,
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

  return it("puts high-priority strategies first inside every sort", () => {
    const row = (
      id: string,
      priority: "normal" | "high",
      updatedAt: Date,
      sharpe: number | null
    ) => ({
      id,
      name: id,
      priority,
      updatedAt,
      latestBacktest:
        sharpe === null
          ? null
          : {
              id: `bt-${id}`,
              createdAt: at,
              sharpe,
              totalReturn: sharpe,
              cagr: null,
              maxDrawdown: null,
            },
    });
    // Without priority every sort would lead with "a": first by name, newest and best metric.
    const rows = [
      row("a", "normal", later, 2),
      row("y", "high", at, null),
      row("b", "normal", at, 1),
      row("z", "high", at, 0.1),
      row("x", "high", later, 0.4),
    ];
    const ids = (sort?: "updated" | "name" | "sharpe" | "return") =>
      sortStrategies(rows, sort).map((entry) => entry.id);
    expect(ids("name")).toEqual(["x", "y", "z", "a", "b"]);
    expect(ids("updated")).toEqual(["x", "z", "y", "a", "b"]);
    expect(ids()).toEqual(ids("updated"));
    expect(ids("sharpe")).toEqual(["x", "z", "y", "a", "b"]);
    expect(ids("return")).toEqual(["x", "z", "y", "a", "b"]);
    return expect(rows.map((entry) => entry.id)).toEqual([
      "a",
      "y",
      "b",
      "z",
      "x",
    ]);
  });
});

describe("strategy study verdicts", () => {
  const tagged = (slug: string, tags: string[]) => ({ slug, tags });

  it("picks only tagged rows whose slug is a valid study id", () => {
    expect(
      studyCandidateSlugs([
        tagged("triple-rsi", ["backtest-study", "failed"]),
        tagged("qc-port-one", ["quantconnect-idea"]),
        tagged("untagged", ["failed"]),
        { slug: "no-tags", tags: null },
        tagged(`long-${"a".repeat(70)}`, ["backtest-study"]),
      ])
    ).toEqual(["triple-rsi", "qc-port-one"]);
  });

  it("keeps a verdict only when it is valid for its kind and the row has that kind's tag", () => {
    const rows = [
      tagged("study-ok", ["backtest-study"]),
      tagged("port-ok", ["quantconnect-idea"]),
      tagged("both", ["quantconnect-idea", "backtest-study"]),
      tagged("wrong-kind", ["quantconnect-idea"]),
      tagged("filter", ["backtest-study"]),
      tagged("bad-verdict", ["backtest-study"]),
      { slug: "no-tags", tags: null },
    ];
    const verdicts = studyVerdictsBySlug(rows, [
      { id: "study-ok", kind: "strategy-backtest", verdict: "no-edge" },
      { id: "port-ok", kind: "qc-port", verdict: "FAIL" },
      { id: "both", kind: "strategy-backtest", verdict: "edge" },
      { id: "wrong-kind", kind: "strategy-backtest", verdict: "edge" },
      { id: "filter", kind: null, verdict: null },
      { id: "bad-verdict", kind: "strategy-backtest", verdict: "PASS" },
      { id: "no-tags", kind: "qc-port", verdict: "PASS" },
      { id: "unknown-slug", kind: "qc-port", verdict: "PASS" },
    ]);
    expect(Object.fromEntries(verdicts)).toEqual({
      both: { kind: "strategy-backtest", verdict: "edge" },
      "port-ok": { kind: "qc-port", verdict: "FAIL" },
      "study-ok": { kind: "strategy-backtest", verdict: "no-edge" },
    });
  });
});

const studiesRepository = (
  verdicts: ResearchStudyRepository["verdicts"]
): ResearchStudyRepository & {
  verdicts: ReturnType<typeof vi.fn>;
} => ({
  get: () => Promise.reject(new Error("not used")),
  upsert: () => Promise.reject(new Error("not used")),
  upsertMany: () => Promise.reject(new Error("not used")),
  verdicts: vi.fn(verdicts),
});

/** A structured event sink that keeps the strategy-library events; `fail` makes emit throw. */
const eventSink = (fail = false) => {
  const events: SemanticEvent[] = [];
  const port: SemanticEventPort = {
    emit: async (event) => {
      if (fail) throw new Error("sink down");
      if (event.name.startsWith("vertex.strategyLibrary.")) events.push(event);
      return {
        analytics: "skipped",
        span: "skipped",
        structuredEvent: "emitted",
      };
    },
  };
  return { events, port };
};

describe("strategyLibrary study verdicts", () => {
  const studyRows = () => [
    strategyRow({
      id: "s-triple",
      slug: "triple-rsi",
      tags: ["backtest-study", "failed"],
    }),
    strategyRow({ id: "s-hmm" }),
  ];

  it("adds the study verdict to list and get rows in one lookup of tagged slugs", async () => {
    const studies = studiesRepository(async () => [
      { id: "triple-rsi", kind: "strategy-backtest", verdict: "no-edge" },
    ]);
    const client = clientFor({
      strategyLibrary: strategiesRepository(studyRows()),
      researchStudies: studies,
    });
    const listed = await client.strategyLibrary.list({ sort: "name" });
    expect(
      Object.fromEntries(
        listed.strategies.map((row) => [row.slug, row.vertexStudy])
      )
    ).toEqual({
      hmm: null,
      "triple-rsi": { kind: "strategy-backtest", verdict: "no-edge" },
    });
    expect(studies.verdicts).toHaveBeenCalledTimes(1);
    expect(studies.verdicts).toHaveBeenCalledWith(["triple-rsi"]);
    const detail = await client.strategyLibrary.get({ id: "s-triple" });
    expect(detail.strategy.vertexStudy).toEqual({
      kind: "strategy-backtest",
      verdict: "no-edge",
    });
  });

  it("makes no lookup and sends no event when no row has a study tag", async () => {
    const studies = studiesRepository(async () => []);
    const sink = eventSink();
    const client = clientFor({
      strategyLibrary: strategiesRepository([strategyRow()]),
      researchStudies: studies,
      semanticEvents: sink.port,
    });
    const listed = await client.strategyLibrary.list({});
    expect(listed.strategies[0]?.vertexStudy).toBeNull();
    expect(studies.verdicts).not.toHaveBeenCalled();
    await expect(
      clientFor({
        strategyLibrary: strategiesRepository([strategyRow()]),
        semanticEvents: sink.port,
      }).strategyLibrary.list({})
    ).resolves.toMatchObject({ strategies: [{ vertexStudy: null }] });
    expect(sink.events).toEqual([]);
  });

  it("gives a read key the study verdict through list and get", async () => {
    const reader = clientFor({
      requestSession: null,
      apiKeyAccess: "read",
      strategyLibrary: strategiesRepository(studyRows()),
      researchStudies: studiesRepository(async () => [
        { id: "triple-rsi", kind: "strategy-backtest", verdict: "no-edge" },
      ]),
    });
    const verdict = { kind: "strategy-backtest", verdict: "no-edge" };
    expect(
      (await reader.strategyLibrary.list({})).strategies.find(
        (row) => row.slug === "triple-rsi"
      )?.vertexStudy
    ).toEqual(verdict);
    expect(
      (await reader.strategyLibrary.get({ id: "s-triple" })).strategy
        .vertexStudy
    ).toEqual(verdict);
  });

  it("still lists when the lookup fails and reports one storage-error event", async () => {
    const sink = eventSink();
    const client = clientFor({
      strategyLibrary: strategiesRepository(studyRows()),
      researchStudies: studiesRepository(() =>
        Promise.reject(new DatabasePersistenceError("research study read"))
      ),
      semanticEvents: sink.port,
    });
    const listed = await client.strategyLibrary.list({});
    expect(listed.strategies.map((row) => row.vertexStudy)).toEqual([
      null,
      null,
    ]);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      action: "studyVerdicts",
      attributes: { candidates: 1 },
      correlation: {
        procedure: "strategyLibrary.list",
        requestId: "request-1",
      },
      entityType: "research-study",
      errorCategory: "storage-error",
      name: "vertex.strategyLibrary.studyVerdicts",
      outcome: "failure",
      source: "api",
    });
  });

  it("reports a missing study store on get and still returns the strategy", async () => {
    const sink = eventSink();
    const span: SpanHandle = {
      addEvent: () => undefined,
      correlation: { requestId: "request-1", traceId: "trace-1" },
      recordMetric: () => undefined,
    };
    const client = clientFor({
      strategyLibrary: strategiesRepository(studyRows()),
      semanticEvents: sink.port,
      span,
    });
    const detail = await client.strategyLibrary.get({ id: "s-triple" });
    expect(detail.strategy.vertexStudy).toBeNull();
    expect(sink.events.map((event) => event.errorCategory)).toEqual([
      "repository-missing",
    ]);
    // The span's correlation stays next to the procedure and request id.
    expect(sink.events[0]?.correlation).toMatchObject({
      procedure: "strategyLibrary.get",
      requestId: "request-1",
      traceId: "trace-1",
    });
  });

  it("never fails the request when reporting fails or no event sink is set", async () => {
    const failing = () =>
      studiesRepository(() => Promise.reject(new Error("down")));
    for (const semanticEvents of [eventSink(true).port, undefined]) {
      const client = clientFor({
        strategyLibrary: strategiesRepository(studyRows()),
        researchStudies: failing(),
        ...(semanticEvents === undefined ? {} : { semanticEvents }),
      });
      expect((await client.strategyLibrary.list({})).strategies).toHaveLength(
        2
      );
    }
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

  it("returns the priority and the external claim and lists high priority first", async () => {
    const rows = [
      strategyRow({ id: "s-up", name: "Rising", backtestCount: 2 }),
      strategyRow({
        id: "s-claim",
        name: "Volume spike breakout",
        priority: "high",
        externalValidation: claim,
        updatedAt: at,
      }),
      strategyRow({ id: "s-new", name: "Newest", updatedAt: later }),
    ];
    const client = clientFor({ strategyLibrary: strategiesRepository(rows) });
    for (const sort of ["updated", "name", "sharpe", "return"] as const) {
      const listed = await client.strategyLibrary.list({ sort });
      expect(listed.strategies[0]?.id, sort).toBe("s-claim");
    }
    const { strategies } = await client.strategyLibrary.list({});
    expect(strategies.map((row) => row.id)).toEqual([
      "s-claim",
      "s-new",
      "s-up",
    ]);
    expect(strategies[0]).toMatchObject({
      priority: "high",
      externalValidation: claim,
    });
    expect(strategies[1]).toMatchObject({
      priority: "normal",
      externalValidation: null,
    });
    const found = await client.strategyLibrary.get({ id: "s-claim" });
    expect(found.strategy.priority).toBe("high");
    expect(found.strategy.externalValidation).toEqual(claim);
    // The output is a copy: it shares no reference with the repository row.
    expect(found.strategy.externalValidation).not.toBe(claim);
    const plain = await client.strategyLibrary.get({ id: "s-up" });
    expect(plain.strategy.priority).toBe("normal");
    return expect(plain.strategy.externalValidation).toBeNull();
  });

  it("reports missing tables or columns and invalid stored values as a typed storage error", async () => {
    const repository = strategiesRepository([strategyRow()]);
    const client = clientFor({ strategyLibrary: repository });
    const message =
      "Strategy library storage unavailable: its tables or columns are missing, or a stored value is invalid. Apply the pending strategy-library migrations (0019, 0065).";
    repository.list.mockRejectedValueOnce(
      new DatabasePersistenceError("strategies read")
    );
    await expectCode(
      client.strategyLibrary.list({}),
      "STORAGE_ERROR",
      503,
      message
    );
    repository.get.mockRejectedValueOnce(
      new DatabasePersistenceError(
        "strategy s-hmm read (stored priority must be one of normal, high)"
      )
    );
    return await expectCode(
      client.strategyLibrary.get({ id: "s-hmm" }),
      "STORAGE_ERROR",
      503,
      message
    );
  });

  it("accepts and rejects the priority and the external claim on create and update", async () => {
    const repository = strategiesRepository([
      strategyRow({ priority: "high", externalValidation: claim }),
    ]);
    const client = clientFor({ strategyLibrary: repository });
    expect(
      await client.strategyLibrary.create({ name: "Plain", kind: "python" })
    ).toMatchObject({ priority: "normal", externalValidation: null });
    expect(
      await client.strategyLibrary.create({
        name: "Claimed",
        kind: "python",
        priority: "high",
        externalValidation: claim,
      })
    ).toMatchObject({ priority: "high", externalValidation: claim });
    expect(repository.create).toHaveBeenLastCalledWith({
      name: "Claimed",
      kind: "python",
      priority: "high",
      externalValidation: claim,
    });
    expect(
      await client.strategyLibrary.update({
        id: "s-hmm",
        externalValidation: null,
      })
    ).toMatchObject({ priority: "high", externalValidation: null });
    expect(repository.update).toHaveBeenLastCalledWith({
      id: "s-hmm",
      externalValidation: null,
    });
    expect(
      await client.strategyLibrary.update({ id: "s-hmm", priority: "normal" })
    ).toMatchObject({ priority: "normal" });
    expect(repository.update).toHaveBeenLastCalledWith({
      id: "s-hmm",
      priority: "normal",
    });
    const metric = { label: "Rank", value: "1" };
    const invalid: Record<string, unknown>[] = [
      { priority: "urgent" },
      { externalValidation: { ...claim, sourceUrl: "http://youtu.be/x" } },
      { externalValidation: { ...claim, sourceUrl: "not a url" } },
      {
        externalValidation: {
          ...claim,
          sourceUrl: `https://x.test/${"a".repeat(300)}`,
        },
      },
      { externalValidation: { ...claim, sourceTitle: " " } },
      { externalValidation: { ...claim, sourceTitle: "t".repeat(201) } },
      { externalValidation: { ...claim, sourceAuthor: "a".repeat(121) } },
      { externalValidation: { ...claim, publishedOn: "24.09.2026" } },
      { externalValidation: { ...claim, publishedOn: "2026-02-30" } },
      { externalValidation: { ...claim, claimedMethod: "m".repeat(1001) } },
      { externalValidation: { ...claim, claimedMetrics: [] } },
      {
        externalValidation: {
          ...claim,
          claimedMetrics: Array.from({ length: 13 }, () => metric),
        },
      },
      {
        externalValidation: {
          ...claim,
          claimedMetrics: [{ ...metric, unit: "R" }],
        },
      },
      {
        externalValidation: {
          ...claim,
          claimedMetrics: [{ label: "l".repeat(61), value: "1" }],
        },
      },
      {
        externalValidation: {
          ...claim,
          claimedMetrics: [{ label: "Rank", value: "v".repeat(81) }],
        },
      },
      { externalValidation: { ...claim, validatedByVertex: true } },
      { externalValidation: { sourceUrl: claim.sourceUrl } },
    ];
    const calls = repository.create.mock.calls.length;
    for (const fields of invalid) {
      await expectCode(
        client.strategyLibrary.create({
          name: "x",
          kind: "python",
          ...fields,
        } as never),
        "BAD_REQUEST",
        400
      );
      await expectCode(
        client.strategyLibrary.update({ id: "s-hmm", ...fields } as never),
        "BAD_REQUEST",
        400
      );
    }
    expect(repository.create.mock.calls).toHaveLength(calls);
    repository.update.mockRejectedValueOnce(
      new InvalidRepositoryInputError(
        "externalValidation.claimedMethod must not contain control characters"
      )
    );
    return await expectCode(
      client.strategyLibrary.update({
        id: "s-hmm",
        externalValidation: { ...claim, claimedMethod: "line\nbreak" },
      }),
      "VALIDATION_ERROR",
      422,
      "externalValidation.claimedMethod must not contain control characters"
    );
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
    // Read keys see the study verdict field (owner decision 2026-11-13).
    expect(
      (await reader.strategyLibrary.list({})).strategies[0]
    ).toHaveProperty("vertexStudy", null);
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
