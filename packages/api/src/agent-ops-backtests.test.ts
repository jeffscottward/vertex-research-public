import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  normalizeBacktestResult,
  InvalidRepositoryInputError,
  type AddResearchPaperInput,
  type AgentOpsRepository,
  type BacktestResultsRepository,
  type MarketBarsRepository,
  type BacktestTrialLedger,
  type BacktestResultSummary,
  type Repositories,
  type ResearchPapersRepository,
} from "@darkfactory/db/server";
import type {
  AgentTask,
  BacktestResult,
  ResearchPaper,
} from "@darkfactory/db/schema";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  BacktestRecordInputSchema,
  PapersAddFromArxivInputSchema,
} from "./contracts/agent-ops.ts";
import { setArxivFetchOptionsForTesting } from "./server/agent-ops.ts";
import { clearInstantBacktestCacheForTesting } from "./server/instant-backtest.ts";
import {
  ArxivInputError,
  ArxivUpstreamError,
  parseArxivAtom,
  parseArxivReference,
} from "./server/arxiv.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";

const at = new Date("2026-01-02T03:04:05.000Z");

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  id: "task-1",
  kind: "backtest",
  agent: "omp",
  title: "Backtest jump model",
  summary: null,
  status: "running",
  metrics: {},
  links: [],
  paperId: null,
  createdAt: at,
  updatedAt: at,
  startedAt: at,
  finishedAt: null,
  ...overrides,
});

const paper = (overrides: Partial<ResearchPaper> = {}): ResearchPaper => ({
  id: "paper-1",
  title: "Paper",
  authors: null,
  year: null,
  sourceUrl: null,
  identifier: null,
  kind: "paper",
  stage: "queued",
  verdict: "pending",
  blockers: null,
  notes: null,
  reportedMetrics: {},
  reproducedMetrics: {},
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

const memoryAgentOps = (tasks: AgentTask[]): AgentOpsRepository =>
  ({
    summary: vi.fn(),
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => {
      const found = tasks.find((row) => row.id === id);
      return found === undefined ? null : { task: found, events: [] };
    }),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    appendEvent: vi.fn(),
  }) as unknown as AgentOpsRepository;

// Uses the real normalizer so derived drawdown and ordering rules are exercised end to end.
const memoryBacktests = (
  taskIds: readonly string[]
): BacktestResultsRepository & { rows: BacktestResult[] } => {
  const rows: BacktestResult[] = [];
  return {
    rows,
    record: vi.fn(async (input) => {
      let normalized: ReturnType<typeof normalizeBacktestResult>;
      try {
        normalized = normalizeBacktestResult(input);
      } catch (error) {
        throw new InvalidRepositoryInputError((error as Error).message);
      }
      if (!taskIds.includes(normalized.taskId))
        throw new InvalidRepositoryInputError(
          "backtest result references a missing record"
        );
      const row: BacktestResult = {
        id: `bt-${rows.length + 1}`,
        ...normalized,
        createdAt: at,
      };
      rows.push(row);
      return row;
    }),
    list: vi.fn(async () => {
      return rows.map(
        ({
          equity,
          drawdown,
          trades,
          folds,
          ...rest
        }): BacktestResultSummary => ({
          ...rest,
          pointCount: equity.length,
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

const memoryPapers = (
  initial: ResearchPaper[] = []
): ResearchPapersRepository & { rows: ResearchPaper[] } => {
  const rows = [...initial];
  return {
    rows,
    list: vi.fn(async () => rows),
    add: vi.fn(async (input: AddResearchPaperInput) => {
      const created = paper({
        id: `paper-${rows.length + 1}`,
        title: input.title,
        sourceUrl: input.sourceUrl ?? null,
        authors: input.authors ?? null,
        year: input.year ?? null,
        identifier: input.identifier ?? null,
        stage: input.stage ?? "queued",
        notes: input.notes ?? null,
      });
      rows.push(created);
      return created;
    }),
    update: vi.fn(),
    findByArxivId: vi.fn(async (baseId: string) => {
      return rows.filter(
        (row) =>
          row.identifier === `arXiv:${baseId}` ||
          new RegExp(`^arXiv:${baseId.replaceAll(".", "\\.")}v\\d+$`).test(
            row.identifier ?? ""
          )
      );
    }),
  } as unknown as ResearchPapersRepository & { rows: ResearchPaper[] };
};

const session = (userId: string): SafeAuthSession => ({
  user: {
    id: userId,
    name: userId,
    email: `${userId}@domain.test`,
    emailVerified: true,
    image: null,
    createdAt: at,
    updatedAt: at,
    role: "member",
    status: "active",
  },
  session: {
    id: `session-${userId}`,
    userId,
    expiresAt: new Date("2026-01-03T03:04:05.000Z"),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId, role: "member", status: "active" },
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  parts: Readonly<{
    agentOps?: AgentOpsRepository;
    researchPapers?: ResearchPapersRepository;
    backtestResults?: BacktestResultsRepository;
    marketBars?: MarketBarsRepository;
  }>
) => {
  const repositories: Repositories = {
    profiles: {} as Repositories["profiles"],
    addresses: {} as Repositories["addresses"],
    userPreferences: {} as Repositories["userPreferences"],
    featureItems: {} as Repositories["featureItems"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    ...parts,
  };
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
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
    });
    return handleApiRequest(request, context);
  };
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code, status });
  }
};

const validRecord = () => ({
  taskId: "task-1",
  strategy: "jump-model v1",
  instruments: "SPY",
  periodStart: "2020-01-01",
  periodEnd: "2020-01-05",
  dataSource: "synthetic fixture",
  metrics: { sharpe: 0.61, cagr: 0.08 },
  equity: [
    { t: "2020-01-01", equity: 100 },
    { t: "2020-01-02", equity: 110 },
    { t: "2020-01-03", equity: 99 },
    { t: "2020-01-04", equity: 121 },
  ],
  trades: [
    {
      entry_t: "2020-01-01",
      exit_t: "2020-01-03",
      side: "long" as const,
      qty: 10,
      entry_px: 100,
      exit_px: 99,
      pnl: -10,
    },
  ],
  folds: [
    {
      label: "f1",
      train_start: "2019-01-01",
      train_end: "2019-12-31",
      test_start: "2020-01-01",
      test_end: "2020-01-05",
      metrics: { sharpe: 0.5 },
    },
  ],
  isSplit: {
    in_sample: { start: "2019-01-01", end: "2019-12-31" },
    out_of_sample: {
      start: "2020-01-01",
      end: "2020-01-05",
      metrics: { sharpe: 0.4 },
    },
  },
});

describe("backtest record schema", () => {
  it("accepts a bounded chronological result", () =>
    expect(BacktestRecordInputSchema.safeParse(validRecord()).success).toBe(
      true
    ));

  it("rejects client drawdown, non-finite numbers, disorder and overflow", () => {
    expect(
      BacktestRecordInputSchema.safeParse({ ...validRecord(), drawdown: [] })
        .success
    ).toBe(false);
    expect(
      BacktestRecordInputSchema.safeParse({
        ...validRecord(),
        metrics: { sharpe: Number.NaN },
      }).success
    ).toBe(false);
    expect(
      BacktestRecordInputSchema.safeParse({
        ...validRecord(),
        equity: [
          { t: "2020-01-02", equity: 1 },
          { t: "2020-01-01", equity: 1 },
        ],
      }).success
    ).toBe(false);
    expect(
      BacktestRecordInputSchema.safeParse({
        ...validRecord(),
        equity: [
          { t: "2020-01-02", equity: 1 },
          { t: "2020-01-02", equity: 1 },
        ],
      }).success
    ).toBe(false);
    expect(
      BacktestRecordInputSchema.safeParse({
        ...validRecord(),
        equity: [{ t: "2020-01-02", equity: 0 }],
      }).success
    ).toBe(false);
    expect(
      BacktestRecordInputSchema.safeParse({
        ...validRecord(),
        equity: Array.from({ length: 5001 }, (_, i) => ({
          t: new Date(Date.UTC(2000, 0, 1) + i * 86_400_000).toISOString(),
          equity: 1,
        })),
      }).success
    ).toBe(false);
    expect(
      BacktestRecordInputSchema.safeParse({
        ...validRecord(),
        periodEnd: "2019-12-31",
      }).success
    ).toBe(false);
    expect(
      BacktestRecordInputSchema.safeParse({
        ...validRecord(),
        trades: [{ ...validRecord().trades[0]!, exit_t: "2019-12-31" }],
      }).success
    ).toBe(false);
    expect(
      BacktestRecordInputSchema.safeParse({
        ...validRecord(),
        folds: [{ ...validRecord().folds[0]!, test_start: "2019-06-01" }],
      }).success
    ).toBe(false);
    expect(
      BacktestRecordInputSchema.safeParse({
        ...validRecord(),
        isSplit: {
          in_sample: { start: "2019-01-01", end: "2020-02-01" },
          out_of_sample: { start: "2020-01-01", end: "2020-03-01" },
        },
      }).success
    ).toBe(false);
    return expect(
      BacktestRecordInputSchema.safeParse({
        ...validRecord(),
        equity: [{ t: "2020-01-01T00:00:00", equity: 1 }],
      }).success
    ).toBe(false);
  });

  it("accepts a rating series with defaults and rejects malformed ones", () => {
    const ratingSeries = {
      symbol: "SPY",
      decisions: [
        { date: "2020-01-02", rating: "buy", runId: "run-1" },
        { date: "2020-01-03", rating: null },
      ],
    };
    const parsed = BacktestRecordInputSchema.parse({
      ...validRecord(),
      ratingSeries,
    });
    expect(parsed.ratingSeries).toMatchObject({ timeframe: "1d", costBps: 10 });
    const rejects = (series: Record<string, unknown>) =>
      expect(
        BacktestRecordInputSchema.safeParse({
          ...validRecord(),
          ratingSeries: { ...ratingSeries, ...series },
        }).success
      ).toBe(false);
    rejects({ timeframe: "1m" });
    rejects({ costBps: 501 });
    rejects({ order: "buy" });
    rejects({ decisions: ratingSeries.decisions.slice(0, 1) });
    rejects({ decisions: [...ratingSeries.decisions].reverse() });
    rejects({
      decisions: [
        { date: "2020-01-02", rating: "strong buy" },
        { date: "2020-01-03", rating: "sell" },
      ],
    });
    rejects({
      decisions: [
        { date: "2020-01-02", rating: "buy", runId: "run 1" },
        { date: "2020-01-03", rating: "sell" },
      ],
    });
    rejects({
      decisions: Array.from({ length: 521 }, (_, index) => ({
        date: new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10),
        rating: "hold",
      })),
    });
  });
});

describe("backtest normalizer", () => {
  it("derives drawdown from equity against the running peak", () => {
    const normalized = normalizeBacktestResult(validRecord());
    expect(normalized.drawdown.map((point) => point.drawdown)).toEqual([
      0,
      0,
      99 / 110 - 1,
      0,
    ]);
    expect(normalized.maxDrawdown).toBeCloseTo(-0.1, 10);
    return expect(normalized.tradeCount).toBe(1);
  });

  it("rejects impossible calendar dates and unknown fields", () => {
    expect(() =>
      normalizeBacktestResult({ ...validRecord(), periodStart: "2020-02-31" })
    ).toThrow(/calendar/);
    return expect(() =>
      normalizeBacktestResult({
        ...validRecord(),
        equity: [{ t: "2020-01-01", equity: 1, drawdown: 0 }],
      })
    ).toThrow(/not a recognized field/);
  });
});

describe("agentOps.backtests procedures", () => {
  it("requires an operator session", async () => {
    const client = clientFor(null, {
      agentOps: memoryAgentOps([task()]),
      backtestResults: memoryBacktests(["task-1"]),
    });
    await expectCode(client.agentOps.backtests.list({}), "UNAUTHORIZED", 401);
    const outsider = clientFor(session("outsider"), {
      agentOps: memoryAgentOps([task()]),
      backtestResults: memoryBacktests(["task-1"]),
    });
    return await expectCode(
      outsider.agentOps.backtests.record(validRecord()),
      "FORBIDDEN",
      403
    );
  });

  it("records, lists with task titles and reads detail with server-derived drawdown", async () => {
    const backtests = memoryBacktests(["task-1"]);
    const client = clientFor(session("operator"), {
      agentOps: memoryAgentOps([task()]),
      backtestResults: backtests,
    });
    const recorded = await client.agentOps.backtests.record(validRecord());
    expect(recorded.maxDrawdown).toBeCloseTo(-0.1, 10);
    expect(recorded.drawdown).toHaveLength(4);
    const listed = await client.agentOps.backtests.list({});
    expect(listed.backtests[0]).toMatchObject({
      id: recorded.id,
      taskTitle: "Backtest jump model",
      pointCount: 4,
      foldCount: 1,
      tradeCount: 1,
      dataSource: "synthetic fixture",
    });
    expect(listed.backtests[0]).not.toHaveProperty("equity");
    const detail = await client.agentOps.backtests.get({ id: recorded.id });
    expect(detail.task?.id).toBe("task-1");
    expect(detail.backtest.folds[0]?.label).toBe("f1");
    expect(detail.backtest.analytics.multipleTesting?.ledger).toMatchObject({
      scope: "task",
      key: "task-1",
      trials: 1,
    });
    expect(
      detail.backtest.analytics.multipleTesting?.deflatedSharpe
        ?.expectedMaxSharpe
    ).toBe(0);
    expect(recorded.analytics.multipleTesting).toBeNull();
    return await expectCode(
      client.agentOps.backtests.get({ id: "missing" }),
      "NOT_FOUND",
      404
    );
  });

  it("maps a missing task to VALIDATION_ERROR", async () => {
    const client = clientFor(session("operator"), {
      agentOps: memoryAgentOps([]),
      backtestResults: memoryBacktests([]),
    });
    return await expectCode(
      client.agentOps.backtests.record(validRecord()),
      "VALIDATION_ERROR",
      422
    );
  });
});

describe("agentOps.backtests rating evaluation", () => {
  afterEach(() => {
    clearInstantBacktestCacheForTesting();
  });

  // 20 daily bars from 2020-01-01 (UTC midnight), rising one point a day from 100.
  const BAR_COUNT = 20;
  const day = (index: number) => Date.UTC(2020, 0, 1 + index);
  const marketBars = (
    overrides: Partial<MarketBarsRepository> = {}
  ): MarketBarsRepository => {
    const prices = Float64Array.from({ length: BAR_COUNT }, (_, i) => 100 + i);
    return {
      listSeries: vi.fn(),
      replaceSeries: vi.fn(),
      getSeries: vi.fn(async (symbol: string) =>
        symbol === "SPY"
          ? {
              id: "series-spy",
              symbol: "SPY",
              timeframe: "1d" as const,
              source: "fixture",
              sourceSha256: "a".repeat(64),
              barCount: BAR_COUNT,
              firstT: day(0),
              lastT: day(BAR_COUNT - 1),
              importedAt: at,
            }
          : null
      ),
      loadColumns: vi.fn(async () => ({
        t: Float64Array.from({ length: BAR_COUNT }, (_, i) => day(i)),
        o: prices,
        h: prices,
        l: prices,
        c: prices,
      })),
      ...overrides,
    };
  };
  const withRatings = (symbol = "spy") => ({
    ...validRecord(),
    ratingSeries: {
      symbol,
      costBps: 0,
      decisions: [
        { date: "2020-01-02", rating: "buy" as const },
        { date: "2020-01-10", rating: null },
        { date: "2020-01-15", rating: "sell" as const },
      ],
    },
  });

  it("evaluates the stored rating series on record and get", async () => {
    const bars = marketBars();
    const client = clientFor(session("operator"), {
      agentOps: memoryAgentOps([task()]),
      backtestResults: memoryBacktests(["task-1"]),
      marketBars: bars,
    });
    const recorded = await client.agentOps.backtests.record(withRatings());
    expect(recorded.ratingSeries).toEqual({
      symbol: "spy",
      timeframe: "1d",
      costBps: 0,
      decisions: [
        { date: "2020-01-02", rating: "buy" },
        { date: "2020-01-10", rating: null },
        { date: "2020-01-15", rating: "sell" },
      ],
    });
    expect(bars.getSeries).toHaveBeenCalledWith("SPY", "1d");
    expect(recorded.ratingEvaluation).toMatchObject({
      status: "ready",
      symbol: "spy",
      startDate: "2020-01-02",
      endDate: "2020-01-20",
      failedDecisions: 1,
      placebo: { sims: 6, exhaustive: true },
    });
    const detail = await client.agentOps.backtests.get({ id: recorded.id });
    expect(detail.backtest.ratingEvaluation).toEqual(recorded.ratingEvaluation);
    const plain = await client.agentOps.backtests.record(validRecord());
    expect(plain.ratingSeries).toBeNull();
    expect(plain.ratingEvaluation).toBeNull();
  });

  it("reports missing or unreadable bars as unavailable without failing the call", async () => {
    const evaluationFor = async (
      bars: MarketBarsRepository | undefined,
      symbol?: string
    ) => {
      const client = clientFor(session("operator"), {
        agentOps: memoryAgentOps([task()]),
        backtestResults: memoryBacktests(["task-1"]),
        ...(bars === undefined ? {} : { marketBars: bars }),
      });
      const recorded = await client.agentOps.backtests.record(
        withRatings(symbol)
      );
      return (await client.agentOps.backtests.get({ id: recorded.id })).backtest
        .ratingEvaluation;
    };
    const unavailable = (reason: string) => ({ status: "unavailable", reason });
    expect(await evaluationFor(undefined)).toEqual(unavailable("no_bars"));
    expect(await evaluationFor(marketBars(), "QQQ")).toEqual(
      unavailable("no_bars")
    );
    expect(
      await evaluationFor(
        marketBars({
          getSeries: vi.fn(async () => {
            throw new Error("database down");
          }),
        })
      )
    ).toEqual(unavailable("storage_error"));
    expect(
      await evaluationFor(
        marketBars({
          loadColumns: vi.fn(async () => {
            throw new Error("database down");
          }),
        })
      )
    ).toEqual(unavailable("storage_error"));
    const zero = Float64Array.from({ length: BAR_COUNT }, () => 0);
    expect(
      await evaluationFor(
        marketBars({
          loadColumns: vi.fn(async () => ({
            t: Float64Array.from({ length: BAR_COUNT }, (_, i) => day(i)),
            o: zero,
            h: zero,
            l: zero,
            c: zero,
          })),
        })
      )
    ).toEqual(unavailable("bad_bars"));
  });

  it("reports a failed evaluation as unavailable on record and get, after the row is stored", async () => {
    const backtests = memoryBacktests(["task-1"]);
    // A stored row written outside the contract: 521 decisions make the replay throw.
    const outsideContract: BacktestResultsRepository = {
      ...backtests,
      record: vi.fn(async (input) => {
        const row = await backtests.record(input);
        row.ratingSeries = {
          symbol: "SPY",
          timeframe: "1d",
          costBps: 0,
          decisions: Array.from({ length: 521 }, (_, index) => ({
            date: new Date(day(index)).toISOString().slice(0, 10),
            rating: "hold" as const,
          })),
        };
        return row;
      }),
    };
    const client = clientFor(session("operator"), {
      agentOps: memoryAgentOps([task()]),
      backtestResults: outsideContract,
      marketBars: marketBars(),
    });
    const recorded = await client.agentOps.backtests.record(withRatings());
    expect(recorded.ratingEvaluation).toEqual({
      status: "unavailable",
      reason: "evaluation_error",
    });
    expect(backtests.rows).toHaveLength(1);
    const detail = await client.agentOps.backtests.get({ id: recorded.id });
    expect(detail.backtest.ratingEvaluation).toEqual({
      status: "unavailable",
      reason: "evaluation_error",
    });
  });
});

const atom = (entry: string) => {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">\n  <title>arXiv Query</title>\n${entry}\n</feed>\n`;
};

const jumpEntry = atom(`  <entry>
    <id>http://arxiv.org/abs/2402.05272v3</id>
    <updated>2024-06-01T00:00:00Z</updated>
    <published>2024-02-07T21:02:38Z</published>
    <title>Downside Risk Reduction Using Regime-Switching Signals: A Statistical
  Jump Model Approach</title>
    <summary>  We propose &amp; test a jump model &lt;JM&gt; with 20&#37; less drawdown.
    </summary>
    <author><name>Yizhan Shu</name></author>
    <author><name>Chenyu Yu</name></author>
    <author><name>John M. Mulvey</name></author>
  </entry>`);

const atomResponse = (
  body: string,
  init: Partial<ResponseInit> & { contentType?: string } = {}
) => {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      "content-type": init.contentType ?? "application/atom+xml; charset=utf-8",
    },
  });
};

describe("arXiv reference and Atom parsing", () => {
  it("accepts ids, prefixed ids and arxiv.org URLs only", () => {
    expect(parseArxivReference("2402.05272")).toEqual({
      baseId: "2402.05272",
      version: null,
    });
    expect(parseArxivReference("arXiv:2402.05272v3")).toEqual({
      baseId: "2402.05272",
      version: 3,
    });
    expect(parseArxivReference("https://arxiv.org/abs/2402.05272v2")).toEqual({
      baseId: "2402.05272",
      version: 2,
    });
    expect(
      parseArxivReference("https://arxiv.org/pdf/2402.05272v2.pdf")
    ).toEqual({ baseId: "2402.05272", version: 2 });
    expect(parseArxivReference("hep-th/9901001")).toEqual({
      baseId: "hep-th/9901001",
      version: null,
    });
    for (const bad of [
      "",
      "https://evil.test/abs/2402.05272",
      "2402.0527",
      "10.1057/s41260-024-00376-x",
      "https://papers.ssrn.com/abstract=1",
      "2402.05272v0",
    ]) {
      expect(() => parseArxivReference(bad)).toThrow(ArxivInputError);
    }
    return expect(
      PapersAddFromArxivInputSchema.safeParse({ arxiv: "2402.05272", extra: 1 })
        .success
    ).toBe(false);
  });

  it("parses one entry strictly and decodes only XML entities", () => {
    const parsed = parseArxivAtom(jumpEntry, {
      baseId: "2402.05272",
      version: null,
    });
    expect(parsed).toMatchObject({
      title:
        "Downside Risk Reduction Using Regime-Switching Signals: A Statistical Jump Model Approach",
      authors: "Yizhan Shu; Chenyu Yu; John M. Mulvey",
      year: 2024,
      identifier: "arXiv:2402.05272v3",
      sourceUrl: "https://arxiv.org/abs/2402.05272v3",
      abstract: "We propose & test a jump model <JM> with 20% less drawdown.",
    });
    expect(() =>
      parseArxivAtom(jumpEntry.replace("&amp;", "&nbsp;"), {
        baseId: "2402.05272",
        version: null,
      })
    ).toThrow(ArxivUpstreamError);
    expect(() =>
      parseArxivAtom(`<!DOCTYPE x [<!ENTITY a "b">]>${jumpEntry}`, {
        baseId: "2402.05272",
        version: null,
      })
    ).toThrow(ArxivUpstreamError);
    expect(() =>
      parseArxivAtom(jumpEntry, { baseId: "2402.05273", version: null })
    ).toThrow(ArxivUpstreamError);
    expect(() =>
      parseArxivAtom(jumpEntry, { baseId: "2402.05272", version: 2 })
    ).toThrow(ArxivUpstreamError);
    return expect(() =>
      parseArxivAtom("<html></html>", { baseId: "2402.05272", version: null })
    ).toThrow(ArxivUpstreamError);
  });
});

describe("papers.addFromArxiv", () => {
  afterEach(() => setArxivFetchOptionsForTesting({}));

  it("fetches the official API once, stores an ingested row, then returns the existing row", async () => {
    const calls: string[] = [];
    setArxivFetchOptionsForTesting({
      fetch: async (url, init) => {
        calls.push(url);
        expect(init.redirect).toBe("manual");
        return atomResponse(jumpEntry);
      },
    });
    const papers = memoryPapers();
    const client = clientFor(session("operator"), { researchPapers: papers });
    const first = await client.papers.addFromArxiv({
      arxiv: "https://arxiv.org/abs/2402.05272",
    });
    expect(first.created).toBe(true);
    expect(first.paper).toMatchObject({
      identifier: "arXiv:2402.05272v3",
      stage: "ingested",
      year: 2024,
      sourceUrl: "https://arxiv.org/abs/2402.05272v3",
    });
    expect(first.paper.notes).toMatch(/^Abstract \(arXiv API\): We propose/);
    expect(calls).toEqual([
      "https://export.arxiv.org/api/query?id_list=2402.05272&max_results=1",
    ]);
    const second = await client.papers.addFromArxiv({
      arxiv: "arXiv:2402.05272v3",
    });
    expect(second).toMatchObject({
      created: false,
      paper: { id: first.paper.id },
    });
    return expect(calls).toHaveLength(1);
  });

  it("maps an empty feed to NOT_FOUND and upstream faults to UPSTREAM_ERROR", async () => {
    const client = clientFor(session("operator"), {
      researchPapers: memoryPapers(),
    });
    setArxivFetchOptionsForTesting({
      fetch: async () => atomResponse(atom("")),
    });
    await expectCode(
      client.papers.addFromArxiv({ arxiv: "2402.05272" }),
      "NOT_FOUND",
      404
    );
    setArxivFetchOptionsForTesting({
      fetch: async () => atomResponse("x", { status: 503 }),
    });
    await expectCode(
      client.papers.addFromArxiv({ arxiv: "2402.05272" }),
      "UPSTREAM_ERROR",
      502
    );
    setArxivFetchOptionsForTesting({
      fetch: async () => atomResponse(jumpEntry, { contentType: "text/html" }),
    });
    await expectCode(
      client.papers.addFromArxiv({ arxiv: "2402.05272" }),
      "UPSTREAM_ERROR",
      502
    );
    setArxivFetchOptionsForTesting({
      maxBytes: 64,
      fetch: async () => atomResponse(jumpEntry),
    });
    await expectCode(
      client.papers.addFromArxiv({ arxiv: "2402.05272" }),
      "UPSTREAM_ERROR",
      502
    );
    setArxivFetchOptionsForTesting({
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          return init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        }),
    });
    return await expectCode(
      client.papers.addFromArxiv({ arxiv: "2402.05272" }),
      "UPSTREAM_ERROR",
      502
    );
  });

  it("rejects non-arXiv input before any network call", async () => {
    const fetch = vi.fn();
    setArxivFetchOptionsForTesting({ fetch });
    const client = clientFor(session("operator"), {
      researchPapers: memoryPapers(),
    });
    await expectCode(
      client.papers.addFromArxiv({
        arxiv: "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1",
      }),
      "VALIDATION_ERROR",
      422
    );
    return expect(fetch).not.toHaveBeenCalled();
  });

  it("returns an existing versioned row for a bare id without fetching", async () => {
    const fetch = vi.fn();
    setArxivFetchOptionsForTesting({ fetch });
    const client = clientFor(session("operator"), {
      researchPapers: memoryPapers([
        paper({ id: "paper-jump", identifier: "arXiv:2402.05272v3" }),
      ]),
    });
    expect(
      await client.papers.addFromArxiv({ arxiv: "2402.05272" })
    ).toMatchObject({ created: false, paper: { id: "paper-jump" } });
    return expect(fetch).not.toHaveBeenCalled();
  });
});
