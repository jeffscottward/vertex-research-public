import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  Repositories,
  SemanticAttributeResult,
  SemanticCatalog,
  SemanticLayerRepository,
  SemanticReader,
  SemanticRelationshipRow,
  SemanticSqlAttributeRow,
  SemanticTermRow,
} from "@darkfactory/db/server";
import { call } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PortfolioMonitorOutput } from "./contracts/portfolio-monitor.ts";
import {
  SEMANTIC_QUERY_MAX_ROWS,
  type SemanticParamSpec,
  type SemanticTermQueryInput,
} from "./contracts/semantic-terms.ts";
import { createApiContext } from "./server/context.ts";
import { PortfolioMonitorError } from "./server/portfolio-monitor.ts";
import {
  answerTerm,
  bindParams,
  catalogOutput,
  SEMANTIC_SQL_TIMEOUT_MS,
  SemanticParamsError,
  semanticTermsRouter,
  setSemanticTermsDependenciesForTesting,
  summarizeTerms,
} from "./server/semantic-terms.ts";

// Fictional identities and values only.
const at = new Date("2026-11-06T12:00:00.000Z");
const AS_OF = "2026-11-06T15:00:00.000Z";
const NOW = new Date(AS_OF);
const OPERATOR = "operator@domain.test";
const VIEWER = "agent-viewer@domain.test";
const STRANGER = "someone@domain.test";
const KEY = "fictional-agent-key";
const OPERATOR_SESSION_MESSAGE =
  "The semantic catalog is edited from a signed-in operator session; API keys are refused";

const certification = (certified: boolean) => ({
  certificationNote: certified ? "reviewed" : null,
  certified,
  certifiedAt: certified ? at : null,
  certifiedBy: certified ? OPERATOR : null,
  updatedAt: at,
  updatedBy: null,
});

const termRow = (
  over: Partial<SemanticTermRow> & Pick<SemanticTermRow, "id">
): SemanticTermRow => ({
  description: `Definition of ${over.id}.`,
  feedPath: null,
  label: over.id,
  mappedColumns: [],
  params: [],
  source: "postgres",
  synonyms: [],
  unit: "USD",
  ...certification(true),
  ...over,
});

const attributeRow = (
  over: Partial<SemanticSqlAttributeRow> &
    Pick<SemanticSqlAttributeRow, "termId">
): SemanticSqlAttributeRow => ({
  description: `SQL for ${over.termId}`,
  grain: "strategy",
  id: `${over.termId}_sql`,
  sql: "select 1",
  ...certification(true),
  ...over,
});

const relationshipRow: SemanticRelationshipRow = {
  cardinality: "many_to_one",
  description: "Each fill belongs to one order.",
  fromColumn: "order_id",
  fromTable: "fills",
  id: "fills_orders",
  toColumn: "id",
  toTable: "orders",
  ...certification(false),
};

const SYMBOL_PARAM = {
  description: "Ticker",
  name: "symbol",
  required: true,
  type: "text",
} satisfies SemanticParamSpec;
const WINDOW_PARAM = {
  description: "P&L window",
  name: "window",
  options: ["daily", "unrealized", "realized"],
  required: false,
  type: "text",
} satisfies SemanticParamSpec;

const tradesTerm = termRow({
  id: "trade_count",
  mappedColumns: ["trades.id"],
  params: [SYMBOL_PARAM],
  synonyms: ["trades"],
  unit: "trades",
});
const tradesAttribute = attributeRow({
  sql: "select count(*) as trades from trades where symbol = $1",
  termId: "trade_count",
});
const uncertifiedSqlTerm = termRow({ id: "fees_paid" });
const uncertifiedSqlAttribute = attributeRow({
  termId: "fees_paid",
  ...certification(false),
});
const draftTerm = termRow({ id: "draft_term", ...certification(false) });
const orphanPostgresTerm = termRow({ id: "orphan_term" });
const noneTerm = termRow({
  description: "Sharpe of the live account is not tracked.",
  id: "live_sharpe",
  source: "none",
  unit: "ratio",
});
const nlvTerm = termRow({
  feedPath: "summary.netLiquidation",
  id: "net_liquidation",
  source: "feed",
});
const pnlTerm = termRow({
  feedPath: "pnl",
  id: "pnl",
  params: [WINDOW_PARAM],
  source: "feed",
});
const positionTerm = termRow({
  feedPath: "positions",
  id: "position",
  params: [SYMBOL_PARAM],
  source: "feed",
});
const unbuiltFeedTerm = termRow({
  feedPath: "summary.buyingPower",
  id: "buying_power",
  source: "feed",
});

const TERMS = [
  tradesTerm,
  uncertifiedSqlTerm,
  draftTerm,
  orphanPostgresTerm,
  noneTerm,
  nlvTerm,
  pnlTerm,
  positionTerm,
  unbuiltFeedTerm,
];
const ATTRIBUTES = [tradesAttribute, uncertifiedSqlAttribute];
const CATALOG: SemanticCatalog = {
  attributes: ATTRIBUTES,
  relationships: [relationshipRow],
  terms: TERMS,
};

const okRun = (
  rows: Extract<SemanticAttributeResult, { status: "ok" }>["rows"],
  truncated = false
): SemanticAttributeResult => ({
  query: tradesAttribute.sql,
  rows,
  status: "ok",
  truncated,
});

const repositoryMock = () => {
  const repository = {
    catalog: vi.fn(async () => CATALOG),
    certify: vi.fn(
      async (): Promise<"certified" | "changed" | "not_found"> => "certified"
    ),
    runAttribute: vi.fn(async () => okRun([{ trades: 3 }])),
    term: vi.fn(async (id: string) => {
      const term = TERMS.find((row) => row.id === id);
      if (term === undefined) return null;
      return {
        attributes: ATTRIBUTES.filter((row) => row.termId === id),
        term,
      };
    }),
    updateAttribute: vi.fn(async () => tradesAttribute),
    updateRelationship: vi.fn(async () => relationshipRow),
    updateTerm: vi.fn(async () => tradesTerm),
  };
  return repository satisfies SemanticLayerRepository;
};
type RepositoryMock = ReturnType<typeof repositoryMock>;

// The reader the handler builds from context.semanticDatabaseUrl runs the mock's runAttribute.
let activeRun: RepositoryMock["runAttribute"] | null = null;
const runText: SemanticReader["run"] = (...args) =>
  (activeRun as unknown as SemanticReader["run"])(...args);
// One runAll call stands for one reader connection. As in the real reader, each text runs in order
// and a failed text ends the batch.
const runInOrder =
  (run: SemanticReader["run"]): SemanticReader["runAll"] =>
  async (attributes, params, options) => {
    const results: Awaited<ReturnType<SemanticReader["run"]>>[] = [];
    for (const attribute of attributes) {
      const result = await run(attribute, params, options);
      results.push(result);
      if (result.status === "failed") break;
    }
    return results;
  };
const runAll = vi.fn<SemanticReader["runAll"]>(runInOrder(runText));
const fakeReader = vi.fn(
  (_url: string | null): SemanticReader => ({ run: runText, runAll })
);
const seam = (
  options: Parameters<typeof setSemanticTermsDependenciesForTesting>[0] = {}
) => setSemanticTermsDependenciesForTesting({ reader: fakeReader, ...options });

const snapshot = (
  over: Readonly<{
    status?: Partial<PortfolioMonitorOutput["status"]>;
    netLiquidation?: number | null;
    positions?: PortfolioMonitorOutput["positions"];
  }> = {}
): PortfolioMonitorOutput =>
  ({
    account: { count: 1, mode: "live" },
    completed: [],
    executions: [],
    messages: [],
    orders: [],
    pnl: { daily: 10, realized: 20, unrealized: 30 },
    positions: over.positions ?? [],
    readOnly: true,
    source: "ibkr-gateway",
    status: {
      clientId: 78,
      connected: true,
      dataAsOf: AS_OF,
      gateway: "live",
      generatedAt: AS_OF,
      lastError: null,
      ordersAsOf: AS_OF,
      receivedAt: AS_OF,
      ...over.status,
    },
    summary: {
      netLiquidation:
        over.netLiquidation === undefined ? 250_000 : over.netLiquidation,
    },
  }) as unknown as PortfolioMonitorOutput;

const session = (email: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId: `user-${email}` },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-11-07T12:00:00.000Z"),
    id: `session-${email}`,
    ipAddress: null,
    updatedAt: at,
    userAgent: null,
    userId: `user-${email}`,
  },
  user: {
    createdAt: at,
    email,
    emailVerified: true,
    id: `user-${email}`,
    image: null,
    name: email,
    role: "member",
    status: "active",
    updatedAt: at,
  },
});

type Caller =
  | Readonly<{ kind: "session"; email: string | null }>
  | Readonly<{ kind: "key"; access: "read" | "write" }>;

const contextFor = (
  caller: Caller,
  repository: RepositoryMock | null,
  portfolioMonitor: { url: string; token: string } | null = null,
  semanticDatabaseUrl: string | null = null
) => {
  const headers = new Headers();
  if (caller.kind === "key") headers.set("x-api-key", KEY);
  const request = new Request("https://darkfactory.localhost/api/orpc", {
    headers,
  });
  return createApiContext(request, {
    agentApiKeys: {
      authenticate: vi.fn(async () => ({
        access: caller.kind === "key" ? caller.access : "read",
        apiKeyId: "key-1",
        email: OPERATOR,
        emailVerified: true,
        role: "member" as const,
        status: "active" as const,
        userId: "user-key",
      })),
    } as unknown as NonNullable<
      Parameters<typeof createApiContext>[1]["agentApiKeys"]
    >,
    agentViewerEmails: [VIEWER],
    capabilities: {
      ai: false,
      analytics: false,
      emailDelivery: false,
      telemetryExport: false,
    },
    operatorEmails: [OPERATOR],
    portfolioMonitor,
    repositories: (repository === null
      ? {}
      : { semanticLayer: repository }) as unknown as Repositories,
    requestId: "request-1",
    ...(semanticDatabaseUrl === null ? {} : { semanticDatabaseUrl }),
    requireRole: async () => {
      throw new AuthAuthorizationError(
        AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
        401
      );
    },
    requireSession: async () => {
      if (caller.kind !== "session" || caller.email === null) {
        throw new AuthAuthorizationError(
          AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
          401
        );
      }
      return session(caller.email);
    },
  });
};

const operator: Caller = { email: OPERATOR, kind: "session" };
const viewer: Caller = { email: VIEWER, kind: "session" };
const stranger: Caller = { email: STRANGER, kind: "session" };
const anonymous: Caller = { email: null, kind: "session" };
const readKey: Caller = { access: "read", kind: "key" };
const writeKey: Caller = { access: "write", kind: "key" };

type Procedure = keyof typeof semanticTermsRouter;
const run = (
  procedure: Procedure,
  input: unknown,
  caller: Caller,
  // null: no semantic layer repository is wired.
  repository: RepositoryMock | null = repositoryMock(),
  portfolioMonitor: { url: string; token: string } | null = null,
  semanticDatabaseUrl: string | null = null
) => {
  activeRun = repository?.runAttribute ?? null;
  return call(semanticTermsRouter[procedure] as never, input as never, {
    context: contextFor(
      caller,
      repository,
      portfolioMonitor,
      semanticDatabaseUrl
    ),
    path: ["semanticTerms", procedure],
  }) as Promise<unknown>;
};

// The same reader stand-in as the handler's: runAll (a spy) runs the repository mock's runAttribute.
const queryContext = (
  repository: RepositoryMock,
  readFeed: () => Promise<PortfolioMonitorOutput> = async () => snapshot()
) => {
  activeRun = repository.runAttribute;
  return { now: NOW, reader: { run: runText, runAll }, readFeed, repository };
};

const answer = (
  input: SemanticTermQueryInput,
  repository = repositoryMock(),
  readFeed?: () => Promise<PortfolioMonitorOutput>
) => answerTerm(input, queryContext(repository, readFeed));

afterEach(() => {
  seam();
});

// Runs first, before any test seam is set: the module's own clock answers the query.
describe("semanticTerms.query before any test seam", () => {
  it("runs SQL through the real reader, which is unavailable without a URL", async () => {
    const repository = repositoryMock();
    const result = await run(
      "query",
      { params: { symbol: "SPY" }, term: "trade_count" },
      operator,
      repository
    );
    expect(result).toMatchObject({
      answer: expect.stringMatching(/^Unknown: .+ No value is given\.$/),
      status: "unknown",
    });
    expect(repository.runAttribute).not.toHaveBeenCalled();
    // Resetting the seams restores the real reader.
    setSemanticTermsDependenciesForTesting({});
    await expect(
      run(
        "query",
        { params: { symbol: "SPY" }, term: "trade_count" },
        operator,
        repository
      )
    ).resolves.toMatchObject({ status: "unknown" });
    expect(fakeReader).not.toHaveBeenCalled();
  });
});

describe("semanticTerms.list", () => {
  it("lists every term with its effective certification for an operator, a viewer and a read key", async () => {
    for (const caller of [operator, viewer, readKey, writeKey]) {
      const repository = repositoryMock();
      const result = (await run("list", {}, caller, repository)) as {
        terms: { id: string; certified: boolean }[];
      };
      expect(result.terms.map((term) => [term.id, term.certified])).toEqual([
        ["trade_count", true],
        ["fees_paid", false],
        ["draft_term", false],
        ["orphan_term", false],
        ["live_sharpe", true],
        ["net_liquidation", true],
        ["pnl", true],
        ["position", true],
        ["buying_power", true],
      ]);
      expect(repository.catalog).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a non-operator and an anonymous caller", async () => {
    await expect(run("list", {}, stranger)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(run("list", {}, anonymous)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("reports a missing or failing repository as STORAGE_ERROR", async () => {
    await expect(run("list", {}, operator, null)).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      status: 503,
    });
    const repository = repositoryMock();
    repository.catalog.mockRejectedValueOnce(new Error("db down"));
    await expect(run("list", {}, operator, repository)).rejects.toMatchObject({
      code: "STORAGE_ERROR",
    });
  });
});

describe("summarizeTerms and catalogOutput", () => {
  it("copies params and synonyms and maps certification times to ISO text", () => {
    const [summary] = summarizeTerms(CATALOG);
    expect(summary).toEqual({
      certified: true,
      description: "Definition of trade_count.",
      groupings: [{ certified: true, grain: "strategy" }],
      id: "trade_count",
      label: "trade_count",
      params: [SYMBOL_PARAM],
      source: "postgres",
      synonyms: ["trades"],
      unit: "trades",
    });
    expect(summary?.params[0]).not.toBe(SYMBOL_PARAM);
    const output = catalogOutput(CATALOG);
    expect(output.terms[0]).toMatchObject({
      certificationNote: "reviewed",
      certifiedAt: at.toISOString(),
      certifiedBy: OPERATOR,
      feedPath: null,
      mappedColumns: ["trades.id"],
      updatedAt: at.toISOString(),
      updatedBy: null,
    });
    expect(output.attributes[1]).toEqual({
      certificationNote: null,
      certified: false,
      certifiedAt: null,
      certifiedBy: null,
      description: "SQL for fees_paid",
      grain: "strategy",
      id: "fees_paid_sql",
      sql: "select 1",
      termId: "fees_paid",
      updatedAt: at.toISOString(),
      updatedBy: null,
    });
    expect(output.relationships).toEqual([
      {
        cardinality: "many_to_one",
        certificationNote: null,
        certified: false,
        certifiedAt: null,
        certifiedBy: null,
        description: "Each fill belongs to one order.",
        fromColumn: "order_id",
        fromTable: "fills",
        id: "fills_orders",
        toColumn: "id",
        toTable: "orders",
        updatedAt: at.toISOString(),
        updatedBy: null,
      },
    ]);
  });
});

describe("semanticTerms.catalog", () => {
  it("returns the full catalog to an operator session and a viewer", async () => {
    for (const [caller, canWrite] of [
      [operator, true],
      [viewer, false],
    ] as const) {
      const result = await run("catalog", {}, caller);
      expect(result).toEqual({ canWrite, ...catalogOutput(CATALOG) });
    }
  });

  it("refuses every API key, even a write key", async () => {
    for (const caller of [readKey, writeKey]) {
      const repository = repositoryMock();
      await expect(
        run("catalog", {}, caller, repository)
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: OPERATOR_SESSION_MESSAGE,
      });
      expect(repository.catalog).not.toHaveBeenCalled();
    }
  });

  it("refuses a non-operator and reports storage failures", async () => {
    await expect(run("catalog", {}, stranger)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(run("catalog", {}, operator, null)).rejects.toMatchObject({
      code: "STORAGE_ERROR",
    });
    const repository = repositoryMock();
    repository.catalog.mockRejectedValueOnce(new Error("db down"));
    await expect(
      run("catalog", {}, operator, repository)
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
});

describe("semanticTerms.update", () => {
  it("edits a term, an attribute and a relationship as the signed-in operator", async () => {
    const repository = repositoryMock();
    const actor = `user-${OPERATOR}`;
    await expect(
      run(
        "update",
        {
          id: "trade_count",
          kind: "term",
          label: "Trades",
          synonyms: ["fills"],
        },
        operator,
        repository
      )
    ).resolves.toEqual({ ok: true });
    expect(repository.updateTerm).toHaveBeenCalledWith(
      "trade_count",
      {
        description: undefined,
        label: "Trades",
        synonyms: ["fills"],
        unit: undefined,
      },
      actor
    );
    await expect(
      run(
        "update",
        { id: "trade_count_sql", kind: "attribute", sql: "select 2" },
        operator,
        repository
      )
    ).resolves.toEqual({ ok: true });
    expect(repository.updateAttribute).toHaveBeenCalledWith(
      "trade_count_sql",
      { description: undefined, sql: "select 2" },
      actor
    );
    await expect(
      run(
        "update",
        {
          description: "One order per fill.",
          id: "fills_orders",
          kind: "relationship",
        },
        operator,
        repository
      )
    ).resolves.toEqual({ ok: true });
    expect(repository.updateRelationship).toHaveBeenCalledWith(
      "fills_orders",
      { description: "One order per fill." },
      actor
    );
  });

  it("answers NOT_FOUND for an unknown id of each kind", async () => {
    const repository = repositoryMock();
    repository.updateTerm.mockResolvedValueOnce(null as never);
    repository.updateAttribute.mockResolvedValueOnce(null as never);
    repository.updateRelationship.mockResolvedValueOnce(null as never);
    for (const kind of ["term", "attribute", "relationship"] as const) {
      await expect(
        run("update", { id: "missing_id", kind }, operator, repository)
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: `No ${kind} missing_id`,
      });
    }
  });

  it("refuses API keys, viewers and non-operators", async () => {
    const repository = repositoryMock();
    const input = { id: "trade_count", kind: "term", label: "x" };
    for (const caller of [readKey, writeKey]) {
      await expect(
        run("update", input, caller, repository)
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: OPERATOR_SESSION_MESSAGE,
      });
    }
    await expect(
      run("update", input, viewer, repository)
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Operator write access required",
    });
    await expect(
      run("update", input, stranger, repository)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(repository.updateTerm).not.toHaveBeenCalled();
  });

  it("reports a missing or failing repository as STORAGE_ERROR", async () => {
    const input = { id: "trade_count", kind: "term", label: "x" };
    await expect(run("update", input, operator, null)).rejects.toMatchObject({
      code: "STORAGE_ERROR",
    });
    const repository = repositoryMock();
    repository.updateTerm.mockRejectedValueOnce(new Error("db down"));
    await expect(
      run("update", input, operator, repository)
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
});

describe("semanticTerms.certify", () => {
  it("certifies with a note and stores an empty or null note as null", async () => {
    const repository = repositoryMock();
    const actor = `user-${OPERATOR}`;
    for (const [note, stored] of [
      [
        "Checked against the broker statement",
        "Checked against the broker statement",
      ],
      ["", null],
      [null, null],
    ] as const) {
      await expect(
        run(
          "certify",
          {
            certified: true,
            expectedUpdatedAt: at.toISOString(),
            id: "trade_count",
            kind: "term",
            note,
          },
          operator,
          repository
        )
      ).resolves.toEqual({ ok: true });
      expect(repository.certify).toHaveBeenLastCalledWith({
        actor,
        certified: true,
        expectedUpdatedAt: at,
        id: "trade_count",
        kind: "term",
        note: stored,
      });
    }
  });

  it("answers NOT_FOUND for an unknown id", async () => {
    const repository = repositoryMock();
    repository.certify.mockResolvedValueOnce("not_found");
    await expect(
      run(
        "certify",
        {
          certified: false,
          expectedUpdatedAt: at.toISOString(),
          id: "missing_id",
          kind: "attribute",
          note: null,
        },
        operator,
        repository
      )
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "No attribute missing_id",
    });
  });

  it("answers CONFLICT when the row changed after it was read", async () => {
    const repository = repositoryMock();
    repository.certify.mockResolvedValueOnce("changed");
    await expect(
      run(
        "certify",
        {
          certified: true,
          expectedUpdatedAt: at.toISOString(),
          id: "trade_count",
          kind: "term",
          note: null,
        },
        operator,
        repository
      )
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The row changed after you read it; reload and review it again",
      status: 409,
    });
  });

  it("rejects a missing or non-ISO expectedUpdatedAt", async () => {
    const repository = repositoryMock();
    for (const expectedUpdatedAt of [undefined, "yesterday"]) {
      await expect(
        run(
          "certify",
          {
            certified: true,
            expectedUpdatedAt,
            id: "trade_count",
            kind: "term",
            note: null,
          },
          operator,
          repository
        )
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(repository.certify).not.toHaveBeenCalled();
  });

  it("refuses API keys and viewers and reports storage failures", async () => {
    const input = {
      certified: true,
      expectedUpdatedAt: at.toISOString(),
      id: "trade_count",
      kind: "term",
      note: null,
    };
    const repository = repositoryMock();
    for (const caller of [readKey, writeKey]) {
      await expect(
        run("certify", input, caller, repository)
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: OPERATOR_SESSION_MESSAGE,
      });
    }
    await expect(
      run("certify", input, viewer, repository)
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Operator write access required",
    });
    expect(repository.certify).not.toHaveBeenCalled();
    await expect(run("certify", input, operator, null)).rejects.toMatchObject({
      code: "STORAGE_ERROR",
    });
    repository.certify.mockRejectedValueOnce(new Error("db down"));
    await expect(
      run("certify", input, operator, repository)
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
});

describe("semanticTerms.query", () => {
  it("answers a certified SQL term for an operator, a viewer and a read key", async () => {
    for (const caller of [operator, viewer, readKey]) {
      const repository = repositoryMock();
      const result = await run(
        "query",
        { params: { symbol: "SPY" }, term: "trade_count" },
        caller,
        repository
      );
      expect(result).toMatchObject({
        rowCount: 1,
        rows: [{ trades: 3 }],
        status: "ok",
      });
      expect(fakeReader).toHaveBeenLastCalledWith(null);
      expect(repository.runAttribute).toHaveBeenCalledWith(
        tradesAttribute,
        ["SPY"],
        { rowLimit: 100, timeoutMs: SEMANTIC_SQL_TIMEOUT_MS }
      );
    }
  });

  it("turns bad parameters into BAD_REQUEST and repository failures into STORAGE_ERROR", async () => {
    await expect(
      run("query", { params: {}, term: "trade_count" }, operator)
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Parameter symbol is required. This term takes symbol (text, required).",
      status: 400,
    });
    const repository = repositoryMock();
    repository.term.mockRejectedValueOnce(new Error("db down"));
    await expect(
      run("query", { term: "trade_count" }, operator, repository)
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    await expect(
      run("query", { term: "trade_count" }, operator, null)
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  it("builds the reader from context.semanticDatabaseUrl", async () => {
    const url =
      "postgresql://vertex_semantic_reader:x@127.0.0.1:55582/darkfactory_dev";
    await run(
      "query",
      { params: { symbol: "SPY" }, term: "trade_count" },
      operator,
      repositoryMock(),
      null,
      url
    );
    expect(fakeReader).toHaveBeenLastCalledWith(url);
  });

  it("refuses a non-operator", async () => {
    await expect(
      run("query", { term: "trade_count" }, stranger)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reads feed terms through the portfolio monitor and its test seams", async () => {
    // Default clock and fetch options; the feed is not configured.
    await expect(
      run("query", { term: "net_liquidation" }, operator)
    ).resolves.toMatchObject({
      answer:
        "Unknown: the vertex-portfolio feed is unavailable (Portfolio monitor endpoint not configured (VERTEX_PORTFOLIO_URL)). No value is given; the paper exec node is not a substitute.",
      asOf: null,
      status: "unknown",
    });
    const fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    seam({
      feed: { fetch },
      now: () => NOW,
    });
    const result = (await run(
      "query",
      { term: "net_liquidation" },
      operator,
      repositoryMock(),
      {
        token: "t".repeat(43),
        url: "https://quantvps.tailnet.test:8443/vertex-portfolio",
      }
    )) as { status: string; answer: string };
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("unknown");
    expect(result.answer).toContain("the vertex-portfolio feed is unavailable");
    // Resetting the seams restores the real clock.
    seam();
    await expect(
      run("query", { term: "net_liquidation" }, operator)
    ).resolves.toMatchObject({ status: "unknown" });
  });
});

describe("answerTerm", () => {
  it("answers not_available for an unknown term", async () => {
    await expect(answer({ term: "no_such_term" })).resolves.toEqual({
      answer:
        "No certified term is named no_such_term. Call terms_list for the catalog; if no term covers the measure, it is not available.",
      asOf: null,
      certified: false,
      groupings: [],
      label: null,
      params: {},
      query: null,
      rowCount: 0,
      rows: [],
      source: null,
      status: "not_available",
      term: "no_such_term",
      truncated: false,
      unit: null,
    });
  });

  it("answers not_available for a term with no source", async () => {
    await expect(answer({ term: "live_sharpe" })).resolves.toMatchObject({
      answer: "Not available. Sharpe of the live account is not tracked.",
      certified: true,
      query: null,
      source: "none",
      status: "not_available",
      unit: "ratio",
    });
  });

  it("answers not_available for an uncertified term or SQL attribute", async () => {
    const repository = repositoryMock();
    for (const term of ["draft_term", "fees_paid", "orphan_term"]) {
      const result = await answer({ term }, repository);
      expect(result).toMatchObject({
        answer:
          "This term is not certified, so it gives no value. An operator certifies it on the /semantic-terms page.",
        certified: false,
        status: "not_available",
      });
    }
    await expect(
      answer({ term: "orphan_term" }, repository)
    ).resolves.toMatchObject({ query: null });
    await expect(
      answer({ term: "fees_paid" }, repository)
    ).resolves.toMatchObject({ query: "select 1" });
    expect(repository.runAttribute).not.toHaveBeenCalled();
  });

  it("throws SemanticParamsError for parameters the model must fix", async () => {
    await expect(
      answer({ params: { ticker: "SPY" }, term: "trade_count" })
    ).rejects.toBeInstanceOf(SemanticParamsError);
  });

  it("returns the rows of a certified SQL attribute with the SQL that ran", async () => {
    const repository = repositoryMock();
    await expect(
      answer({ params: { symbol: "SPY" }, term: "trade_count" }, repository)
    ).resolves.toEqual({
      answer: "1 row(s). Definition of trade_count.",
      asOf: AS_OF,
      certified: true,
      groupings: [
        {
          attribute: "trade_count_sql",
          certified: true,
          grain: "strategy",
          rowCount: 1,
          status: "ok",
        },
      ],
      label: "trade_count",
      params: { symbol: "SPY" },
      query: tradesAttribute.sql,
      rowCount: 1,
      rows: [{ trades: 3 }],
      source: "postgres",
      status: "ok",
      term: "trade_count",
      truncated: false,
      unit: "trades",
    });
    repository.runAttribute.mockResolvedValueOnce(
      okRun([{ trades: 1 }, { trades: 2 }], true)
    );
    await expect(
      answer({ params: { symbol: "SPY" }, term: "trade_count" }, repository)
    ).resolves.toMatchObject({
      answer: "2+ row(s). Definition of trade_count.",
      rowCount: 2,
      truncated: true,
    });
    repository.runAttribute.mockResolvedValueOnce(okRun([]));
    await expect(
      answer({ params: { symbol: "SPY" }, term: "trade_count" }, repository)
    ).resolves.toMatchObject({
      answer: "No rows match. Definition of trade_count.",
      rowCount: 0,
      rows: [],
      status: "ok",
    });
  });

  it("answers unknown when the SQL attribute fails", async () => {
    const repository = repositoryMock();
    repository.runAttribute.mockResolvedValueOnce({
      failure: "timeout",
      message: "The query ran past 5 s.",
      query: "select count(*) ... /* ran */",
      status: "failed",
    });
    await expect(
      answer({ params: { symbol: "SPY" }, term: "trade_count" }, repository)
    ).resolves.toMatchObject({
      answer: "Unknown: The query ran past 5 s. No value is given.",
      asOf: null,
      query: "select count(*) ... /* ran */",
      rows: [],
      status: "unknown",
    });
  });

  describe("a term with a per-strategy and a per-run-spec SQL attribute", () => {
    const sharpeTerm = termRow({
      description: "Sharpe of the latest succeeded engine run per strategy.",
      id: "backtest_sharpe",
      params: [
        {
          description: "Strategy",
          name: "strategy",
          required: false,
          type: "text",
        },
      ],
      unit: "ratio",
    });
    const perStrategy = attributeRow({
      id: "backtest_sharpe",
      sql: "select 'ORB' as strategy, 1.2 as sharpe",
      termId: "backtest_sharpe",
    });
    const perRunSpec = attributeRow({
      grain: "run_spec",
      id: "backtest_sharpe_run_spec",
      sql: "select 'SPY' as symbol, 0.8 as sharpe",
      termId: "backtest_sharpe",
      ...certification(false),
    });
    const sharpeRepository = (runSpecCertified: boolean) => {
      const repository = repositoryMock();
      repository.term.mockResolvedValue({
        attributes: [
          perStrategy,
          { ...perRunSpec, ...certification(runSpecCertified) },
        ],
        term: sharpeTerm,
      });
      return repository;
    };

    it("runs only the certified attribute and says the run-spec SQL waits for owner certification", async () => {
      const repository = sharpeRepository(false);
      repository.runAttribute.mockResolvedValueOnce({
        query: "ran strategy sql",
        rows: [],
        status: "ok",
        truncated: false,
      });
      const output = await answer({ term: "backtest_sharpe" }, repository);
      expect(repository.runAttribute).toHaveBeenCalledTimes(1);
      expect((repository.runAttribute.mock.calls as unknown[][])[0]?.[0]).toBe(
        perStrategy
      );
      expect(runAll.mock.lastCall?.[0]).toEqual([perStrategy]);
      expect(output).toMatchObject({
        answer:
          "Partial, not a complete answer. Checked: per strategy (engine runs linked to a strategy): no rows match. NOT checked: per run spec (symbol, timeframe, rule, stop loss, take profit, cost, date range) for engine runs with no strategy: that SQL waits for owner certification on /semantic-terms, so rows of that grouping may exist and are not shown. Do not report that there are none. Sharpe of the latest succeeded engine run per strategy.",
        certified: true,
        groupings: [
          {
            attribute: "backtest_sharpe",
            certified: true,
            grain: "strategy",
            rowCount: 0,
            status: "ok",
          },
          {
            attribute: "backtest_sharpe_run_spec",
            certified: false,
            grain: "run_spec",
            rowCount: 0,
            status: "not_certified",
          },
        ],
        query:
          "-- grain strategy (attribute backtest_sharpe)\nran strategy sql",
        rows: [],
        status: "ok",
      });
    });

    it("answers rows of both groupings, each with its grain, once both are certified", async () => {
      const repository = sharpeRepository(true);
      repository.runAttribute
        .mockResolvedValueOnce({
          query: "ran strategy sql",
          rows: [{ sharpe: 1.2, strategy: "ORB" }],
          status: "ok",
          truncated: false,
        })
        .mockResolvedValueOnce({
          query: "ran run-spec sql",
          rows: [
            { sharpe: 0.8, symbol: "SPY" },
            { sharpe: 0.3, symbol: "QQQ" },
          ],
          status: "ok",
          truncated: false,
        });
      runAll.mockClear();
      const output = await answer(
        { params: { strategy: "ORB" }, term: "backtest_sharpe" },
        repository
      );
      // Both groupings run in one batch: one reader connection for the term.
      expect(runAll).toHaveBeenCalledTimes(1);
      expect(runAll.mock.lastCall?.[0]).toHaveLength(2);
      expect(repository.runAttribute).toHaveBeenCalledTimes(2);
      expect(
        (repository.runAttribute.mock.calls as unknown[][])[1]?.[1]
      ).toEqual(["ORB"]);
      expect(output).toMatchObject({
        answer:
          "3 row(s). per strategy (engine runs linked to a strategy): 1 row(s); per run spec (symbol, timeframe, rule, stop loss, take profit, cost, date range) for engine runs with no strategy: 2 row(s). The grain cell of each row names its grouping. Sharpe of the latest succeeded engine run per strategy.",
        query:
          "-- grain strategy (attribute backtest_sharpe)\nran strategy sql\n\n-- grain run_spec (attribute backtest_sharpe_run_spec)\nran run-spec sql",
        rowCount: 3,
        rows: [
          { grain: "strategy", sharpe: 1.2, strategy: "ORB" },
          { grain: "run_spec", sharpe: 0.8, symbol: "SPY" },
          { grain: "run_spec", sharpe: 0.3, symbol: "QQQ" },
        ],
        status: "ok",
        truncated: false,
      });
      expect(Object.keys(output.rows[0] ?? {})[0]).toBe("grain");
    });

    it("answers unknown with no rows when one grouping fails", async () => {
      const repository = sharpeRepository(true);
      repository.runAttribute
        .mockResolvedValueOnce({
          query: "ran strategy sql",
          rows: [{ sharpe: 1.2, strategy: "ORB" }],
          status: "ok",
          truncated: false,
        })
        .mockResolvedValueOnce({
          failure: "timeout",
          message: "The query ran past 5 s.",
          query: "ran run-spec sql",
          status: "failed",
        });
      await expect(
        answer({ term: "backtest_sharpe" }, repository)
      ).resolves.toMatchObject({
        answer:
          "Unknown (per run spec (symbol, timeframe, rule, stop loss, take profit, cost, date range) for engine runs with no strategy): The query ran past 5 s. No value is given.",
        // The strategy rows ran, but an unknown answer gives no count either.
        groupings: [
          { grain: "strategy", rowCount: 0, status: "not_run" },
          { grain: "run_spec", rowCount: 0, status: "unknown" },
        ],
        query: "ran run-spec sql",
        rowCount: 0,
        rows: [],
        status: "unknown",
      });
    });

    it("marks the failed grouping, not its position among the certified ones, when an uncertified grouping comes first", async () => {
      const repository = repositoryMock();
      repository.term.mockResolvedValue({
        attributes: [
          { ...perStrategy, ...certification(false) },
          { ...perRunSpec, ...certification(true) },
        ],
        term: sharpeTerm,
      });
      repository.runAttribute.mockResolvedValueOnce({
        failure: "timeout",
        message: "The query ran past 5 s.",
        query: "ran run-spec sql",
        status: "failed",
      });
      const output = await answer({ term: "backtest_sharpe" }, repository);
      // Only the certified run-spec SQL ran; it is the first result but the second grouping.
      expect(repository.runAttribute).toHaveBeenCalledTimes(1);
      expect(
        output.groupings.map(({ grain, status }) => [grain, status])
      ).toEqual([
        ["strategy", "not_certified"],
        ["run_spec", "unknown"],
      ]);
      expect(output).toMatchObject({ rows: [], status: "unknown" });
    });

    it("caps the combined rows at the query limit and marks them truncated", async () => {
      const repository = sharpeRepository(true);
      const many = (count: number) =>
        Array.from({ length: count }, (_, index) => ({ n: index }));
      repository.runAttribute
        .mockResolvedValueOnce({
          query: "a",
          rows: many(60),
          status: "ok",
          truncated: false,
        })
        .mockResolvedValueOnce({
          query: "b",
          rows: many(60),
          status: "ok",
          truncated: false,
        });
      const output = await answer({ term: "backtest_sharpe" }, repository);
      expect(output.rows).toHaveLength(SEMANTIC_QUERY_MAX_ROWS);
      expect(output.truncated).toBe(true);
      // Counts are the rows shown: 60 strategy rows, then 40 of the 60 run-spec rows.
      expect(output.groupings.map((grouping) => grouping.rowCount)).toEqual([
        60, 40,
      ]);
      expect(output.answer).toContain(
        "for engine runs with no strategy: 40 row(s) (more not shown)"
      );
      expect(
        output.answer.startsWith(`${SEMANTIC_QUERY_MAX_ROWS}+ row(s).`)
      ).toBe(true);
    });

    it("says a grouping was not shown, not that it has no rows, when the row cap is used up", async () => {
      const repository = sharpeRepository(true);
      const many = (count: number) =>
        Array.from({ length: count }, (_, index) => ({ n: index }));
      repository.runAttribute
        .mockResolvedValueOnce({
          query: "a",
          rows: many(SEMANTIC_QUERY_MAX_ROWS),
          status: "ok",
          truncated: false,
        })
        .mockResolvedValueOnce({
          query: "b",
          rows: many(5),
          status: "ok",
          truncated: false,
        });
      const output = await answer({ term: "backtest_sharpe" }, repository);
      expect(output.groupings.map((grouping) => grouping.rowCount)).toEqual([
        SEMANTIC_QUERY_MAX_ROWS,
        0,
      ]);
      expect(output.answer).toContain(
        "for engine runs with no strategy: not shown (row cap reached)"
      );
      expect(output.answer).not.toContain("no rows match");
    });

    it("keeps the grain cell first even when the SQL returns its own grain column", async () => {
      const repository = sharpeRepository(true);
      repository.runAttribute
        .mockResolvedValueOnce({
          query: "a",
          rows: [{ grain: "fake", sharpe: 1 }],
          status: "ok",
          truncated: false,
        })
        .mockResolvedValueOnce({
          query: "b",
          rows: [],
          status: "ok",
          truncated: false,
        });
      const output = await answer({ term: "backtest_sharpe" }, repository);
      expect(output.rows).toEqual([{ grain: "strategy", sharpe: 1 }]);
      expect(output.answer.startsWith("1 row(s).")).toBe(true);
    });

    it("lists both groupings with their certification in terms_list", () => {
      const [summary] = summarizeTerms({
        attributes: [perStrategy, perRunSpec],
        relationships: [],
        terms: [sharpeTerm],
      });
      expect(summary).toMatchObject({
        certified: true,
        groupings: [
          { certified: true, grain: "strategy" },
          { certified: false, grain: "run_spec" },
        ],
      });
    });
  });

  it("converts SQL cells to the row schema", async () => {
    const repository = repositoryMock();
    const wide = Object.fromEntries(
      Array.from({ length: 45 }, (_, index) => [`c${index}`, index])
    );
    repository.runAttribute.mockResolvedValueOnce(
      okRun([
        {
          array: [1, "two"],
          flag: true,
          huge: Number.POSITIVE_INFINITY,
          [`k${"x".repeat(80)}`]: "long key",
          missing: null,
          nan: Number.NaN,
          object: { a: 1 },
          price: 1.5,
          short: "text",
          story: "y".repeat(2500),
        },
        wide,
      ])
    );
    const result = await answer(
      { params: { symbol: "SPY" }, term: "trade_count" },
      repository
    );
    const [first, second] = result.rows;
    expect(first).toEqual({
      array: '[1,"two"]',
      flag: true,
      huge: null,
      [`k${"x".repeat(63)}`]: "long key",
      missing: null,
      nan: null,
      object: '{"a":1}',
      price: 1.5,
      short: "text",
      story: `${"y".repeat(1999)}…`,
    });
    expect(Object.keys(second ?? {})).toHaveLength(40);
  });

  it("answers not_available for a feed term without a reader", async () => {
    const readFeed = vi.fn(async () => snapshot());
    await expect(
      answer({ term: "buying_power" }, repositoryMock(), readFeed)
    ).resolves.toMatchObject({
      answer: "Not available: no feed reader is built for this term.",
      query: "summary.buyingPower",
      source: "feed",
      status: "not_available",
    });
    expect(readFeed).not.toHaveBeenCalled();
  });

  it("answers unknown when the feed request fails", async () => {
    await expect(
      answer({ term: "net_liquidation" }, repositoryMock(), async () => {
        throw new PortfolioMonitorError("UNAVAILABLE", "Gateway timed out");
      })
    ).resolves.toMatchObject({
      answer:
        "Unknown: the vertex-portfolio feed is unavailable (Gateway timed out). No value is given; the paper exec node is not a substitute.",
      asOf: null,
      status: "unknown",
    });
    await expect(
      answer({ term: "net_liquidation" }, repositoryMock(), async () => {
        throw new Error("secret detail");
      })
    ).resolves.toMatchObject({
      answer:
        "Unknown: the vertex-portfolio feed is unavailable (Portfolio request failed). No value is given; the paper exec node is not a substitute.",
      status: "unknown",
    });
  });

  it("answers unknown with the as-of time for a stale or disconnected feed", async () => {
    const stale = "2026-11-06T14:40:00.000Z";
    await expect(
      answer({ term: "net_liquidation" }, repositoryMock(), async () =>
        snapshot({ status: { dataAsOf: stale } })
      )
    ).resolves.toMatchObject({
      answer: `Unknown: The feed data is 20 minutes old (as of ${stale}); live account values are unknown.`,
      asOf: stale,
      rows: [],
      status: "unknown",
    });
    await expect(
      answer({ term: "net_liquidation" }, repositoryMock(), async () =>
        snapshot({ status: { connected: false, gateway: "disconnected" } })
      )
    ).resolves.toMatchObject({
      answer:
        "Unknown: The IB gateway is disconnected and disconnected; live account values are unknown.",
      asOf: AS_OF,
      status: "unknown",
    });
  });

  it("answers a fresh feed term with the reader's rows and as-of time", async () => {
    await expect(
      answer({ term: "net_liquidation" }, repositoryMock())
    ).resolves.toEqual({
      answer: `Net liquidation of the live IBKR account (vertex-portfolio feed): 250,000.00 USD. As of ${AS_OF}.`,
      asOf: AS_OF,
      certified: true,
      groupings: [],
      label: "net_liquidation",
      params: {},
      query: "summary.netLiquidation",
      rowCount: 1,
      rows: [{ currency: "USD", net_liquidation: 250_000 }],
      source: "feed",
      status: "ok",
      term: "net_liquidation",
      truncated: false,
      unit: "USD",
    });
    // Options are matched case-insensitively and passed to the reader in their catalog spelling.
    await expect(
      answer({ params: { window: "DAILY" }, term: "pnl" }, repositoryMock())
    ).resolves.toMatchObject({
      rows: [{ currency: "USD", pnl: 10, window: "daily" }],
      status: "ok",
    });
    // An optional parameter left out reaches the reader as null: every window.
    await expect(
      answer({ term: "pnl" }, repositoryMock())
    ).resolves.toMatchObject({ rowCount: 3 });
  });

  it("answers unknown when the reader has no value", async () => {
    await expect(
      answer({ term: "net_liquidation" }, repositoryMock(), async () =>
        snapshot({ netLiquidation: null })
      )
    ).resolves.toMatchObject({
      answer: "Unknown: The feed reports no net liquidation value.",
      asOf: AS_OF,
      rows: [],
      status: "unknown",
    });
  });

  it("caps feed rows at 100 and marks them truncated", async () => {
    const positions = Array.from({ length: 101 }, (_, index) => ({
      avgPrice: 1,
      costBasis: 1,
      currency: "USD",
      dailyPnl: null,
      description: `SPY lot ${index}`,
      id: `lot-${index}`,
      last: 1,
      marketValue: 1,
      position: 1,
      realized: null,
      secType: "STK",
      symbol: "SPY",
      unrealized: null,
      unrealizedPct: null,
      weightPct: null,
    }));
    const result = await answer(
      { params: { symbol: "spy" }, term: "position" },
      repositoryMock(),
      async () => snapshot({ positions })
    );
    expect(result.rowCount).toBe(100);
    expect(result.rows).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });
});

describe("bindParams", () => {
  const NUMBER_PARAM: SemanticParamSpec = {
    description: "Days back",
    name: "days",
    required: false,
    type: "number",
  };

  it("refuses unknown parameters and describes the expected ones", () => {
    expect(bindParams([], { symbol: "SPY" })).toEqual({
      message: "Unknown parameter symbol. This term takes no parameters.",
      ok: false,
    });
    expect(
      bindParams([SYMBOL_PARAM, WINDOW_PARAM, NUMBER_PARAM], {
        a: 1,
        b: 2,
      })
    ).toEqual({
      message:
        "Unknown parameter a, b. This term takes symbol (text, required), window (text: daily|unrealized|realized), days (number).",
      ok: false,
    });
  });

  it("requires required parameters and treats an empty string as missing", () => {
    for (const params of [{}, { symbol: "" }, { symbol: null }]) {
      expect(bindParams([SYMBOL_PARAM], params)).toEqual({
        message:
          "Parameter symbol is required. This term takes symbol (text, required).",
        ok: false,
      });
    }
    expect(bindParams([WINDOW_PARAM, NUMBER_PARAM], { window: "" })).toEqual({
      ok: true,
      values: [null, null],
    });
  });

  it("checks number and text types", () => {
    expect(bindParams([NUMBER_PARAM], { days: "7" })).toEqual({
      message: "Parameter days must be a number.",
      ok: false,
    });
    expect(bindParams([SYMBOL_PARAM], { symbol: 7 })).toEqual({
      message: "Parameter symbol must be text.",
      ok: false,
    });
    expect(
      bindParams([SYMBOL_PARAM, NUMBER_PARAM], { days: 7, symbol: "SPY" })
    ).toEqual({ ok: true, values: ["SPY", 7] });
  });

  it("normalizes options case-insensitively and refuses others", () => {
    expect(bindParams([WINDOW_PARAM], { window: "Realized" })).toEqual({
      ok: true,
      values: ["realized"],
    });
    expect(bindParams([WINDOW_PARAM], { window: "weekly" })).toEqual({
      message: "Parameter window must be one of daily, unrealized, realized.",
      ok: false,
    });
  });
});

describe("SemanticParamsError", () => {
  it("is an Error with the model-facing message", () => {
    const error = new SemanticParamsError("Parameter x is required.");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Parameter x is required.");
  });
});
