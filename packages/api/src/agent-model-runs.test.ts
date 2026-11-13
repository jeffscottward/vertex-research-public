import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  AGENT_MODEL_RUN_FACETS,
  AgentModelRunClosedError,
  AgentModelRunEventLimitError,
  type AgentModelRunEventRecord,
  AgentModelRunSearchTimeoutError,
  AgentModelRunSeqError,
  type AgentModelRunFacets,
  AgentModelRunInputError,
  type AgentModelRunsRepository,
  AgentModelRunStateError,
  AgentModelRunStorageError,
  type MarketBarSeries,
  type MarketBarsRepository,
  type Repositories,
} from "@darkfactory/db/server";
import type { AgentModelRun } from "@darkfactory/db/schema";
import { scrubSecretText } from "@darkfactory/observability";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import {
  csvCell,
  MODEL_RUN_CSV_COLUMNS,
  modelRunsCsv,
  modelRunsCsvFilename,
} from "./agent-model-runs-csv.ts";
import { createApiClient } from "./client.ts";
import {
  AgentModelRunListInputSchema,
  AgentModelRunRecordInputSchema,
  AgentModelRunUpdateInputSchema,
} from "./contracts/agent-model-runs.ts";
import {
  highlightSegments,
  toAgentModelRunOutput,
} from "./server/agent-model-runs.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import { AGENT_API_KEY_READ_PROCEDURES } from "./server/operator-access.ts";

const at = new Date("2026-10-01T12:00:00.000Z");

const run = (overrides: Partial<AgentModelRun> = {}): AgentModelRun => ({
  analysts: ["market"],
  batch: null,
  costUsd: 0.5,
  createdAt: at,
  dataSource: null,
  decisionDate: "2026-09-01",
  durationMs: null,
  entryPrice: 190,
  error: null,
  finishedAt: null,
  flags: ["rerun"],
  framework: "tradingagents",
  frameworkVersion: "0.2.0+abc123",
  horizon: "2-4 weeks",
  id: "run-1",
  inputTokens: 100,
  llmCalls: 3,
  memory: false,
  model: "gpt-4o-mini",
  modelsServed: [{ requested: "gpt-4o-mini", served: "gpt-4o-mini-2024" }],
  outputTokens: 50,
  provider: "openai",
  purpose: "live",
  rating: "buy",
  ratingSource: "stated",
  runKey: "key-1",
  startedAt: null,
  status: "queued",
  stopPrice: 180,
  targetPrice: 210,
  taskId: null,
  ticker: "AAPL",
  toolCalls: 2,
  updatedAt: at,
  variant: null,
  ...overrides,
});

const emptyFacets = Object.fromEntries(
  AGENT_MODEL_RUN_FACETS.map((facet) => [facet, []])
) as unknown as AgentModelRunFacets;

const event = (
  seq: number,
  overrides: Partial<AgentModelRunEventRecord> = {}
): AgentModelRunEventRecord => ({
  agent: "Market Analyst",
  at,
  body: null,
  costUsd: null,
  durationMs: null,
  id: `event-${seq}`,
  inputTokens: null,
  kind: "reasoning",
  model: null,
  outputTokens: null,
  runId: "run-1",
  seq,
  title: "Reads the chart",
  toolName: null,
  ...overrides,
});

const repositoryDouble = (
  overrides: Partial<AgentModelRunsRepository> = {}
): AgentModelRunsRepository => ({
  appendEvents: vi.fn(async (runId: string) =>
    runId === "run-1" ? { appended: 1, lastSeq: 0 } : null
  ),
  events: vi.fn(async () => [event(0), event(1)]),
  search: vi.fn(async () => []),
  breakdown: vi.fn(async () => []),
  facets: vi.fn(async () => emptyFacets),
  get: vi.fn(async (id: string) => (id === "run-1" ? run() : null)),
  list: vi.fn(async () => ({ nextCursor: null, runs: [run()] })),
  record: vi.fn(async () => ({ created: true, run: run() })),
  update: vi.fn(async () => run({ status: "running" })),
  ...overrides,
});

const session = (userId: string, email: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-10-02T12:00:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: at,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: at,
    email,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: at,
  },
});

const OPERATOR = session("operator", "operator@domain.test");

const clientFor = (
  requestSession: SafeAuthSession | null,
  agentModelRuns: AgentModelRunsRepository | undefined,
  marketBars?: MarketBarsRepository
) => {
  const repositories: Repositories = {
    addresses: {} as Repositories["addresses"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    featureItems: {} as Repositories["featureItems"],
    profiles: {} as Repositories["profiles"],
    userPreferences: {} as Repositories["userPreferences"],
    ...(agentModelRuns === undefined ? {} : { agentModelRuns }),
    ...(marketBars === undefined ? {} : { marketBars }),
  };
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
      requireRole: async () => {
        throw denied();
      },
      requireSession: async () => {
        if (requestSession === null) throw denied();
        return requestSession;
      },
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
  const error = await promise.then(
    () => new Error("Expected the oRPC call to fail"),
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(ORPCError);
  expect(error).toMatchObject({ code, status });
};

const recordInput = {
  decisionDate: "2026-09-01",
  framework: "tradingagents",
  model: "gpt-4o-mini",
  provider: "openai",
  runKey: "key-1",
  ticker: "aapl",
};

describe("agentModelRuns contract", () => {
  it("validates the record fields at the boundary", () => {
    expect(AgentModelRunRecordInputSchema.parse(recordInput).ticker).toBe(
      "AAPL"
    );
    for (const bad of [
      { framework: "Trading Agents" },
      { ticker: "aapl inc" },
      { runKey: "has space" },
      { decisionDate: "2026-02-30" },
      { entryPrice: 0 },
      { costUsd: -1 },
      { inputTokens: 1.5 },
      { flags: ["Not A Slug"] },
      { analysts: Array.from({ length: 17 }, (_, index) => `a${index}`) },
      { rating: "strong_buy" },
      { startedAt: "yesterday" },
      { extra: true },
    ])
      expect(
        AgentModelRunRecordInputSchema.safeParse({ ...recordInput, ...bad })
          .success
      ).toBe(false);
    expect(
      AgentModelRunRecordInputSchema.parse({
        ...recordInput,
        startedAt: "2026-09-01T10:00:00+02:00",
      }).startedAt
    ).toEqual(new Date("2026-09-01T08:00:00.000Z"));
  });

  it("requires a change on update and ordered dates on list", () => {
    expect(
      AgentModelRunUpdateInputSchema.safeParse({ id: "run-1" }).success
    ).toBe(false);
    expect(
      AgentModelRunListInputSchema.safeParse({
        decisionFrom: "2026-09-02",
        decisionTo: "2026-09-01",
      }).success
    ).toBe(false);
    expect(
      AgentModelRunListInputSchema.parse({ rating: ["unrated", "hold"] })
    ).toEqual({ rating: ["unrated", "hold"] });
  });

  it("lets read keys list, get, break down and export, and nothing else", () => {
    for (const name of ["list", "get", "breakdown", "exportCsv"])
      expect(AGENT_API_KEY_READ_PROCEDURES.has(`agentModelRuns.${name}`)).toBe(
        true
      );
    for (const name of ["record", "update"])
      expect(AGENT_API_KEY_READ_PROCEDURES.has(`agentModelRuns.${name}`)).toBe(
        false
      );
  });
});

describe("agentModelRuns service", () => {
  it("is operator-only", async () => {
    const repository = repositoryDouble();
    await expectCode(
      clientFor(null, repository).agentModelRuns.list({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(
        session("member", "member@domain.test"),
        repository
      ).agentModelRuns.get({ id: "run-1" }),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor(OPERATOR, undefined).agentModelRuns.get({ id: "run-1" }),
      "STORAGE_ERROR",
      503
    );
    expect(repository.get).not.toHaveBeenCalled();
  });

  it("records a run and scrubs secrets from the error text", async () => {
    const repository = repositoryDouble();
    const client = clientFor(OPERATOR, repository);
    const created = await client.agentModelRuns.record({
      ...recordInput,
      error: "provider said Authorization: Bearer sk-live-secret",
      flags: ["rerun"],
      rating: "buy",
    });
    expect(created).toMatchObject({
      horizonBucket: "weeks",
      id: "run-1",
      ticker: "AAPL",
    });
    expect(repository.record).toHaveBeenCalledWith({
      ...recordInput,
      error: "provider said Authorization: [REDACTED]",
      flags: ["rerun"],
      rating: "buy",
      ticker: "AAPL",
    });
    await client.agentModelRuns.record({ ...recordInput, error: "" });
    expect(repository.record).toHaveBeenLastCalledWith({
      ...recordInput,
      error: null,
      ticker: "AAPL",
    });
    await client.agentModelRuns.record({ ...recordInput, error: null });
    expect(repository.record).toHaveBeenLastCalledWith({
      ...recordInput,
      error: null,
      ticker: "AAPL",
    });
  });

  it("maps repository errors to typed errors", async () => {
    const failing = (error: Error) =>
      clientFor(
        OPERATOR,
        repositoryDouble({
          record: vi.fn(async () => {
            throw error;
          }),
          update: vi.fn(async () => {
            throw error;
          }),
        })
      ).agentModelRuns;
    await expectCode(
      failing(new AgentModelRunInputError("taskId does not match")).record(
        recordInput
      ),
      "VALIDATION_ERROR",
      422
    );
    await expectCode(
      failing(new AgentModelRunStateError("succeeded", "running")).update({
        id: "run-1",
        status: "running",
      }),
      "CONFLICT",
      409
    );
    await expectCode(
      failing(new AgentModelRunStorageError("update")).update({
        costUsd: 1,
        id: "run-1",
      }),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      failing(new TypeError("bug")).record(recordInput),
      "INTERNAL_SERVER_ERROR",
      500
    );
  });

  it("updates a run or reports it missing", async () => {
    const repository = repositoryDouble({
      update: vi.fn(async (input) =>
        input.id === "run-1" ? run({ status: "running" }) : null
      ),
    });
    const client = clientFor(OPERATOR, repository);
    await expect(
      client.agentModelRuns.update({
        error: "slow",
        id: "run-1",
        status: "running",
      })
    ).resolves.toMatchObject({ status: "running" });
    expect(repository.update).toHaveBeenCalledWith({
      error: "slow",
      id: "run-1",
      status: "running",
    });
    await expectCode(
      client.agentModelRuns.update({ id: "missing", status: "running" }),
      "NOT_FOUND",
      404
    );
  });

  it("lists a page with facets and passes only the active filters", async () => {
    const repository = repositoryDouble({
      list: vi.fn(async () => ({ nextCursor: "next", runs: [run()] })),
    });
    const client = clientFor(OPERATOR, repository);
    const page = await client.agentModelRuns.list({
      cursor: "abc",
      includeFacets: true,
      decisionFrom: "2026-09-01",
      rating: ["unrated"],
      ticker: ["msft"],
    });
    expect(page.nextCursor).toBe("next");
    expect(page.runs[0]?.id).toBe("run-1");
    expect(page.facets).toEqual(emptyFacets);
    const filters = {
      decisionFrom: "2026-09-01",
      rating: ["unrated"],
      ticker: ["MSFT"],
    };
    expect(repository.list).toHaveBeenCalledWith({
      cursor: "abc",
      filters,
      limit: 50,
    });
    expect(repository.facets).toHaveBeenCalledWith(filters);
    await client.agentModelRuns.list({ limit: 10 });
    expect(repository.list).toHaveBeenLastCalledWith({
      filters: {},
      limit: 10,
    });
    await expectCode(
      clientFor(
        OPERATOR,
        repositoryDouble({
          list: vi.fn(async () => {
            throw new AgentModelRunInputError("cursor is not valid");
          }),
        })
      ).agentModelRuns.list({ cursor: "bad" }),
      "VALIDATION_ERROR",
      422
    );
  });

  it("breaks the filtered runs down by one field", async () => {
    const rows = [
      {
        avgCostUsd: 0.5,
        failed: 0,
        holdShare: 0.5,
        key: "gpt-4o-mini",
        rated: 2,
        runs: 2,
        totalCostUsd: 1,
      },
    ];
    const repository = repositoryDouble({ breakdown: vi.fn(async () => rows) });
    await expect(
      clientFor(OPERATOR, repository).agentModelRuns.breakdown({
        groupBy: "model",
        purpose: ["benchmark"],
      })
    ).resolves.toEqual({ groupBy: "model", rows });
    expect(repository.breakdown).toHaveBeenCalledWith(
      { purpose: ["benchmark"] },
      "model"
    );
    await expectCode(
      clientFor(
        OPERATOR,
        repositoryDouble({
          breakdown: vi.fn(async () => {
            throw new AgentModelRunStorageError("breakdown");
          }),
        })
      ).agentModelRuns.breakdown({ groupBy: "ticker" }),
      "STORAGE_ERROR",
      503
    );
  });

  it("exports the filtered runs as CSV and says when the export is cut", async () => {
    const repository = repositoryDouble();
    const client = clientFor(OPERATOR, repository);
    const exported = await client.agentModelRuns.exportCsv({ batch: "grid-1" });
    expect(exported.rowCount).toBe(1);
    expect(exported.truncated).toBe(false);
    expect(exported.filename).toMatch(/^agent-model-runs-\d{8}-\d{6}\.csv$/u);
    expect(exported.csv.split("\r\n")[0]).toBe(MODEL_RUN_CSV_COLUMNS.join(","));
    expect(repository.list).toHaveBeenCalledWith({
      filters: { batch: "grid-1" },
      limit: 5000,
    });
    const cut = await clientFor(
      OPERATOR,
      repositoryDouble({
        list: vi.fn(async () => ({ nextCursor: "more", runs: [] })),
      })
    ).agentModelRuns.exportCsv({});
    expect(cut).toMatchObject({ rowCount: 0, truncated: true });
    await expectCode(
      clientFor(
        OPERATOR,
        repositoryDouble({
          list: vi.fn(async () => {
            throw new AgentModelRunStorageError("list");
          }),
        })
      ).agentModelRuns.exportCsv({}),
      "STORAGE_ERROR",
      503
    );
  });

  it("gets one run or reports it missing", async () => {
    const client = clientFor(OPERATOR, repositoryDouble());
    await expect(client.agentModelRuns.get({ id: "run-1" })).resolves.toEqual({
      done: false,
      events: [event(0), event(1)],
      nextSeq: 1,
      run: toAgentModelRunOutput(run()),
    });
    await expectCode(
      client.agentModelRuns.get({ id: "missing" }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      clientFor(
        OPERATOR,
        repositoryDouble({
          get: vi.fn(async () => {
            throw new AgentModelRunStorageError("get");
          }),
        })
      ).agentModelRuns.get({ id: "run-1" }),
      "STORAGE_ERROR",
      503
    );
  });
});

describe("model run CSV", () => {
  it("quotes per RFC 4180 and guards formula cells", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(12.5)).toBe("12.5");
    expect(csvCell(false)).toBe("false");
    expect(csvCell(at)).toBe("2026-10-01T12:00:00.000Z");
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", then\nstop')).toBe('"say ""hi"", then\nstop"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM")).toBe("'@SUM");
    expect(csvCell("=A1,B1")).toBe(`"'=A1,B1"`);
  });

  it("writes a fixed header and one CRLF row per run", () => {
    const csv = modelRunsCsv([toAgentModelRunOutput(run())]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    const header = lines[0]?.split(",") ?? [];
    const row = lines[1]?.split(",") ?? [];
    expect(header).toHaveLength(MODEL_RUN_CSV_COLUMNS.length);
    const cell = (name: string) => row[header.indexOf(name)];
    expect(cell("served_models")).toBe("gpt-4o-mini-2024");
    expect(cell("horizon_bucket")).toBe("weeks");
    expect(cell("rating")).toBe("buy");
    expect(cell("started_at")).toBe("");
    expect(cell("created_at")).toBe("2026-10-01T12:00:00.000Z");
    expect(modelRunsCsv([])).toBe(`${MODEL_RUN_CSV_COLUMNS.join(",")}\r\n`);
    expect(modelRunsCsvFilename(at)).toBe(
      "agent-model-runs-20261001-120000.csv"
    );
  });
});

describe("model run events service", () => {
  const append = (overrides: Record<string, unknown> = {}) => ({
    events: [
      {
        agent: "Market Analyst",
        kind: "reasoning" as const,
        seq: 0,
        title: "Reads the chart",
        ...overrides,
      },
    ],
    runId: "run-1",
  });

  it("stores scrubbed text, reports redacted seqs and refuses only credentials", async () => {
    const repository = repositoryDouble();
    const client = clientFor(OPERATOR, repository).agentModelRuns;
    await expect(
      client.appendEvents(
        append({
          at: "2026-10-01T12:00:00Z",
          body: "RSI is oversold.",
          toolName: null,
        })
      )
    ).resolves.toEqual({ appended: 1, lastSeq: 0, redactedSeqs: [] });
    expect(repository.appendEvents).toHaveBeenCalledWith("run-1", [
      {
        agent: "Market Analyst",
        at,
        body: "RSI is oversold.",
        kind: "reasoning",
        redacted: false,
        seq: 0,
        title: "Reads the chart",
        toolName: null,
      },
    ]);
    await expect(
      client.appendEvents({
        events: [
          {
            agent: "News Analyst",
            body: "System prompt: you are a market analyst. Mail analyst@domain.test",
            kind: "llm_call",
            model: "gpt-4o-mini",
            seq: 1,
            title: "input_tokens: 10",
          },
          { agent: "a", kind: "status", seq: 2, title: "plain" },
        ],
        runId: "run-1",
      })
    ).resolves.toMatchObject({ redactedSeqs: [1] });
    expect(repository.appendEvents).toHaveBeenLastCalledWith("run-1", [
      {
        agent: "News Analyst",
        body: scrubSecretText(
          "System prompt: you are a market analyst. Mail analyst@domain.test"
        ),
        kind: "llm_call",
        model: "gpt-4o-mini",
        redacted: true,
        seq: 1,
        title: scrubSecretText("input_tokens: 10"),
      },
      { agent: "a", kind: "status", redacted: false, seq: 2, title: "plain" },
    ]);
    await expectCode(
      client.appendEvents(
        append({
          body: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        })
      ),
      "VALIDATION_ERROR",
      422
    );
    await expectCode(
      client.appendEvents(append({ toolName: "Bearer abcdef123456" })),
      "VALIDATION_ERROR",
      422
    );
    expect(repository.appendEvents).toHaveBeenCalledTimes(2);
    await expectCode(
      client.appendEvents({ ...append(), runId: "missing" }),
      "NOT_FOUND",
      404
    );
  });

  it("validates event batches at the boundary", async () => {
    const client = clientFor(OPERATOR, repositoryDouble()).agentModelRuns;
    await expectCode(
      client.appendEvents({
        events: [
          { agent: "a", kind: "status", seq: 1, title: "x" },
          { agent: "a", kind: "status", seq: 1, title: "y" },
        ],
        runId: "run-1",
      }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      client.appendEvents(append({ kind: "flag", title: "Not a slug" })),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      client.appendEvents({ events: [], runId: "run-1" }),
      "BAD_REQUEST",
      400
    );
  });

  it("maps closed runs and the event limit", async () => {
    const failing = (error: Error) =>
      clientFor(
        OPERATOR,
        repositoryDouble({
          appendEvents: vi.fn(async () => {
            throw error;
          }),
        })
      ).agentModelRuns.appendEvents(append());
    await expectCode(
      failing(new AgentModelRunClosedError()),
      "RUN_CLOSED",
      409
    );
    await expectCode(
      failing(new AgentModelRunSeqError(7)),
      "SEQ_CONFLICT",
      409
    );
    await expectCode(
      failing(new AgentModelRunEventLimitError()),
      "EVENT_LIMIT",
      409
    );
  });

  it("pages events after a seq and says when polling can stop", async () => {
    const repository = repositoryDouble({
      events: vi.fn(async () => [event(5)]),
      get: vi.fn(async () => run({ status: "succeeded" })),
    });
    const client = clientFor(OPERATOR, repository).agentModelRuns;
    await expect(
      client.events({ afterSeq: 4, runId: "run-1" })
    ).resolves.toMatchObject({ done: true, nextSeq: 5 });
    expect(repository.events).toHaveBeenCalledWith("run-1", 4, 200);
    await expect(
      client.events({ limit: 1, runId: "run-1" })
    ).resolves.toMatchObject({ done: false, nextSeq: 5 });
    expect(repository.events).toHaveBeenLastCalledWith("run-1", -1, 1);
    const empty = clientFor(
      OPERATOR,
      repositoryDouble({ events: vi.fn(async () => []) })
    ).agentModelRuns;
    await expect(
      empty.events({ afterSeq: 7, runId: "run-1" })
    ).resolves.toMatchObject({ done: false, events: [], nextSeq: 7 });
    await expectCode(empty.events({ runId: "missing" }), "NOT_FOUND", 404);
    await expectCode(
      clientFor(
        OPERATOR,
        repositoryDouble({
          get: vi.fn(async () => {
            throw new AgentModelRunStorageError("get");
          }),
        })
      ).agentModelRuns.events({ runId: "run-1" }),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor(
        OPERATOR,
        repositoryDouble({
          events: vi.fn(async () => {
            throw new AgentModelRunStorageError("events");
          }),
        })
      ).agentModelRuns.get({ id: "run-1" }),
      "STORAGE_ERROR",
      503
    );
  });

  it("searches event text and returns highlighted segments", async () => {
    const repository = repositoryDouble({
      search: vi.fn(async () => [
        {
          rank: 0.4,
          run: run(),
          snippets: [
            {
              agent: "News Analyst",
              kind: "reasoning" as const,
              seq: 3,
              text: "price held \uE000support\uE001 today",
            },
          ],
        },
      ]),
    });
    const client = clientFor(OPERATOR, repository).agentModelRuns;
    await expect(
      client.search({ query: "support", ticker: ["aapl"] })
    ).resolves.toEqual({
      results: [
        {
          rank: 0.4,
          run: toAgentModelRunOutput(run()),
          snippets: [
            {
              agent: "News Analyst",
              kind: "reasoning",
              segments: [
                { match: false, text: "price held " },
                { match: true, text: "support" },
                { match: false, text: " today" },
              ],
              seq: 3,
            },
          ],
        },
      ],
    });
    expect(repository.search).toHaveBeenCalledWith("support", {
      ticker: ["AAPL"],
    });
    await expectCode(
      clientFor(
        OPERATOR,
        repositoryDouble({
          search: vi.fn(async () => {
            throw new AgentModelRunStorageError("search");
          }),
        })
      ).agentModelRuns.search({ query: "x" }),
      "STORAGE_ERROR",
      503
    );
  });

  it("splits highlights without losing text", () => {
    expect(highlightSegments("")).toEqual([]);
    expect(highlightSegments("\uE000all\uE001")).toEqual([
      { match: true, text: "all" },
    ]);
    expect(highlightSegments("a \uE000open")).toEqual([
      { match: false, text: "a " },
      { match: true, text: "open" },
    ]);
    expect(highlightSegments("\uE000\uE001rest")).toEqual([
      { match: false, text: "rest" },
    ]);
  });

  it("lets read keys poll events and search", () => {
    for (const name of ["events", "search"])
      expect(AGENT_API_KEY_READ_PROCEDURES.has(`agentModelRuns.${name}`)).toBe(
        true
      );
    expect(
      AGENT_API_KEY_READ_PROCEDURES.has("agentModelRuns.appendEvents")
    ).toBe(false);
  });
});

describe("model run review fixes", () => {
  it("refuses start or finish times in the future", async () => {
    const repository = repositoryDouble();
    const client = clientFor(OPERATOR, repository).agentModelRuns;
    const later = new Date(Date.now() + 5 * 60_000).toISOString();
    await expectCode(
      client.record({ ...recordInput, finishedAt: later }),
      "VALIDATION_ERROR",
      422
    );
    await expectCode(
      client.update({ id: "run-1", startedAt: later }),
      "VALIDATION_ERROR",
      422
    );
    await client.update({
      finishedAt: new Date().toISOString(),
      id: "run-1",
      startedAt: null,
    });
    expect(repository.update).toHaveBeenCalledTimes(1);
  });

  it("skips facet queries on cursor pages unless asked", async () => {
    const repository = repositoryDouble();
    const client = clientFor(OPERATOR, repository).agentModelRuns;
    const next = await client.list({ cursor: "abc" });
    expect(next.facets.ticker).toEqual([]);
    expect(repository.facets).not.toHaveBeenCalled();
    await client.list({ cursor: "abc", includeFacets: true });
    await client.list({ includeFacets: false });
    expect(repository.facets).toHaveBeenCalledTimes(1);
  });

  it("guards formula cells after white space and in fullwidth form", () => {
    expect(csvCell(" =HYPERLINK(1)")).toBe("' =HYPERLINK(1)");
    expect(csvCell("\uFF1DSUM(1)")).toBe("'\uFF1DSUM(1)");
    expect(csvCell("\uFF20x")).toBe("'\uFF20x");
    expect(csvCell("a=b")).toBe("a=b");
  });
});

describe("late events and search limits", () => {
  it("keeps polling open while a finished run can still get late events", async () => {
    const client = clientFor(
      OPERATOR,
      repositoryDouble({
        events: vi.fn(async () => []),
        get: vi.fn(async () =>
          run({
            finishedAt: new Date(),
            status: "succeeded",
            updatedAt: new Date(),
          })
        ),
      })
    ).agentModelRuns;
    await expect(client.events({ runId: "run-1" })).resolves.toMatchObject({
      done: false,
    });
  });

  it("maps a slow search to a typed error", async () => {
    await expectCode(
      clientFor(
        OPERATOR,
        repositoryDouble({
          search: vi.fn(async () => {
            throw new AgentModelRunSearchTimeoutError();
          }),
        })
      ).agentModelRuns.search({ query: "x" }),
      "SEARCH_TIMEOUT",
      503
    );
  });
});

describe("model run benchmark service", () => {
  const DAY_MS = 86_400_000;
  const start = Date.parse("2026-09-01T00:00:00.000Z");
  const series = (symbol: string): MarketBarSeries => ({
    barCount: 10,
    firstT: start,
    id: `benchmark-${symbol}:1d`,
    importedAt: at,
    lastT: start + 9 * DAY_MS,
    source: "Test daily bars",
    sourceSha256: "c".repeat(64),
    symbol,
    timeframe: "1d",
  });
  // AAPL rises every day; MSFT has no bars; NVDA fails to load.
  const marketBars = (): MarketBarsRepository => ({
    getSeries: vi.fn(async (symbol: string) => {
      if (symbol === "NVDA") throw new Error("storage down");
      return symbol === "AAPL" ? series(symbol) : null;
    }),
    listSeries: vi.fn(async () => []),
    loadColumns: vi.fn(async () => {
      const close = Float64Array.from({ length: 10 }, (_, i) => 100 + i);
      return {
        c: close,
        h: close,
        l: close,
        o: close,
        t: Float64Array.from({ length: 10 }, (_, i) => start + i * DAY_MS),
      };
    }),
    replaceSeries: vi.fn(),
  });
  const runs = [
    run({ id: "a1", model: "A", rating: "sell", status: "succeeded" }),
    run({ id: "b1", model: "B", rating: "buy", status: "succeeded" }),
    run({
      id: "a2",
      model: "A",
      rating: "buy",
      status: "succeeded",
      ticker: "MSFT",
    }),
    run({
      id: "b2",
      model: "B",
      rating: "buy",
      status: "succeeded",
      ticker: "MSFT",
    }),
    run({
      id: "a3",
      model: "A",
      rating: "buy",
      status: "succeeded",
      ticker: "NVDA",
    }),
    run({
      id: "b3",
      model: "B",
      rating: "sell",
      status: "succeeded",
      ticker: "NVDA",
    }),
  ];

  it("compares arms over the filtered runs and loads bars for the pair", async () => {
    const repository = repositoryDouble({
      list: vi.fn(async () => ({ nextCursor: "more", runs })),
    });
    const bars = marketBars();
    const output = await clientFor(
      OPERATOR,
      repository,
      bars
    ).agentModelRuns.benchmark({
      armBy: "model",
      baselineArm: "A",
      batch: "grid-1",
      pair: { control: "A", treatment: "B" },
    });
    expect(repository.list).toHaveBeenCalledWith({
      filters: { batch: "grid-1" },
      limit: 5000,
    });
    expect(bars.getSeries).toHaveBeenCalledTimes(3);
    expect(output).toMatchObject({
      armBy: "model",
      baselineArm: "A",
      cells: 3,
      runCount: 6,
      truncated: true,
    });
    expect(output.pair).toMatchObject({
      compared: 1,
      excludedNoBars: 2,
      losses: 0,
      tickersWithoutBars: ["MSFT", "NVDA"],
      wins: 1,
    });
  });

  it("works without market bars and maps storage errors", async () => {
    const repository = repositoryDouble({
      list: vi.fn(async () => ({ nextCursor: null, runs })),
    });
    const output = await clientFor(
      OPERATOR,
      repository
    ).agentModelRuns.benchmark({
      armBy: "model",
      pair: { control: "A", treatment: "B" },
    });
    expect(output.pair).toMatchObject({ compared: 0, excludedNoBars: 3 });
    await expectCode(
      clientFor(
        OPERATOR,
        repositoryDouble({
          list: vi.fn(async () => {
            throw new AgentModelRunStorageError("list");
          }),
        })
      ).agentModelRuns.benchmark({ armBy: "framework" }),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor(OPERATOR, repositoryDouble()).agentModelRuns.benchmark({
        armBy: "model",
        pair: { control: "A", treatment: "A" },
      }),
      "BAD_REQUEST",
      400
    );
    expect(AGENT_API_KEY_READ_PROCEDURES.has("agentModelRuns.benchmark")).toBe(
      true
    );
  });
});

describe("model run frameworks service", () => {
  it("serves the framework reference sheets to operators and read keys", async () => {
    const output = await clientFor(
      OPERATOR,
      undefined
    ).agentModelRuns.frameworks({});
    expect(output.frameworks.map((framework) => framework.id)).toEqual([
      "tradingagents",
      "ai_hedge_fund",
      "vibe_trading",
      "langalpha",
    ]);
    await expectCode(
      clientFor(
        session("member", "member@domain.test"),
        repositoryDouble()
      ).agentModelRuns.frameworks({}),
      "FORBIDDEN",
      403
    );
    expect(AGENT_API_KEY_READ_PROCEDURES.has("agentModelRuns.frameworks")).toBe(
      true
    );
  });
});
