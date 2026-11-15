import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  semanticRelationships,
  semanticSqlAttributes,
  semanticTerms,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

/** When set, createRequestDatabase resolves this resource instead of connecting. */
const requestDatabase = vi.hoisted(() => ({
  calls: [] as unknown[],
  resource: undefined as unknown,
}));
vi.mock("./client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.ts")>();
  return {
    ...actual,
    createRequestDatabase: (
      ...args: Parameters<typeof actual.createRequestDatabase>
    ) => {
      requestDatabase.calls.push(args[0]);
      return requestDatabase.resource === undefined
        ? actual.createRequestDatabase(...args)
        : Promise.resolve(requestDatabase.resource);
    },
  };
});

import { DatabasePersistenceError } from "./repository-errors.ts";
import {
  certifiedStatement,
  createSemanticLayerRepository,
  createSemanticReader,
  SEMANTIC_READER_ROLE,
  type SemanticReaderClient,
  type SemanticReaderConnection,
  SemanticSqlParameterError,
} from "./semantic-layer.ts";

interface Operation {
  fields?: unknown;
  kind: "select" | "update";
  limit?: number;
  returning?: unknown;
  set?: { synonyms?: unknown } & Record<string, unknown>;
  table?: unknown;
  where?: SQL;
}

const dialect = new PgDialect();
const render = (query: SQL | undefined) =>
  query === undefined ? undefined : dialect.sqlToQuery(query);

type Outcome = unknown[] | Error;

/**
 * Query double: every awaited builder takes the next queued result (default: no rows). `execute` inside a
 * transaction takes the next queued execute outcome ({ rows } or an Error).
 */
const createDouble = (
  outcomes: Outcome[] = [],
  executeOutcomes: Outcome[] = []
) => {
  const operations: Operation[] = [];
  const executed: SQL[] = [];
  const transactions: unknown[] = [];
  const builder = (operation: Operation) => {
    operations.push(operation);
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      leftJoin: () => chain,
      limit: (limit: number) => {
        operation.limit = limit;
        return chain;
      },
      orderBy: () => chain,
      returning: (fields?: unknown) => {
        operation.returning = fields ?? "all";
        return chain;
      },
      set: (values: Record<string, unknown>) => {
        operation.set = values;
        return chain;
      },
      then: (
        resolve: (rows: unknown) => unknown,
        reject: (error: unknown) => unknown
      ) => {
        const next = outcomes.shift() ?? [];
        return (
          next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
        ).then(resolve, reject);
      },
      where: (where: SQL) => {
        operation.where = where;
        return chain;
      },
    };
    return chain;
  };
  const tx = {
    execute: (query: SQL) => {
      executed.push(query);
      const next = executeOutcomes.shift() ?? [];
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve({ rows: next });
    },
  };
  const database = {
    select: (fields?: unknown) => builder({ fields, kind: "select" }),
    transaction: (work: (tx: unknown) => Promise<unknown>, config: unknown) => {
      transactions.push(config);
      return work(tx);
    },
    update: (table: unknown) => builder({ kind: "update", table }),
  };
  return {
    database: database as unknown as DatabaseExecutor,
    executed,
    operations,
    transactions,
  };
};

const NOW = new Date("2026-11-08T12:00:00.000Z");
const now = () => NOW;
const coded = (code: string) =>
  Object.assign(new Error(`pg ${code}`), { code });
const EDITED = {
  certificationNote: null,
  certified: false,
  certifiedAt: null,
  certifiedBy: null,
  updatedAt: NOW,
  updatedBy: "operator",
};

describe("semantic layer catalog reads", () => {
  it("reads the three tables ordered by id", async () => {
    const double = createDouble([[{ id: "t" }], [{ id: "a" }], [{ id: "r" }]]);
    const repository = createSemanticLayerRepository(double.database, now);
    await expect(repository.catalog()).resolves.toEqual({
      attributes: [{ id: "a" }],
      relationships: [{ id: "r" }],
      terms: [{ id: "t" }],
    });
    expect(double.operations.map((operation) => operation.table)).toEqual([
      semanticTerms,
      semanticSqlAttributes,
      semanticRelationships,
    ]);
  });

  it("returns a term with its attributes in grain order, without any, or null", async () => {
    const term = { id: "backtest_sharpe" };
    const runSpec = { grain: "run_spec", id: "backtest_sharpe_run_spec" };
    const strategy = { grain: "strategy", id: "backtest_sharpe" };
    const double = createDouble([[term], [runSpec, strategy], [term], [], []]);
    const repository = createSemanticLayerRepository(double.database, now);
    await expect(repository.term("backtest_sharpe")).resolves.toEqual({
      attributes: [strategy, runSpec],
      term,
    });
    await expect(repository.term("backtest_sharpe")).resolves.toEqual({
      attributes: [],
      term,
    });
    await expect(repository.term("missing")).resolves.toBeNull();
    // Two reads per known term, one for an unknown id.
    expect(double.operations).toHaveLength(5);
    const [first, second] = double.operations;
    expect(first).toMatchObject({ limit: 1, table: semanticTerms });
    expect(render(first?.where)?.params).toEqual(["backtest_sharpe"]);
    expect(second).toMatchObject({ table: semanticSqlAttributes });
    expect(render(second?.where)?.params).toEqual(["backtest_sharpe"]);
  });
});

describe("semantic layer edits", () => {
  it("updates a term, copies synonyms and removes its certification", async () => {
    const double = createDouble([[{ id: "pnl" }], []]);
    const repository = createSemanticLayerRepository(double.database, now);
    const synonyms = ["profit"];
    await expect(
      repository.updateTerm(
        "pnl",
        { description: "d", label: "L", synonyms, unit: "USD" },
        "operator"
      )
    ).resolves.toEqual({ id: "pnl" });
    const [operation] = double.operations;
    expect(operation).toMatchObject({
      kind: "update",
      returning: "all",
      table: semanticTerms,
    });
    expect(operation?.set).toEqual({
      description: "d",
      label: "L",
      synonyms: ["profit"],
      unit: "USD",
      ...EDITED,
    });
    expect(operation?.set?.synonyms).not.toBe(synonyms);
    expect(render(operation?.where)?.params).toEqual(["pnl"]);
    await expect(
      repository.updateTerm("missing", { label: "L" }, "operator")
    ).resolves.toBeNull();
    expect(double.operations[1]?.set?.synonyms).toBeUndefined();
  });

  it("updates an attribute and removes its certification", async () => {
    const double = createDouble([[{ id: "a" }], []]);
    const repository = createSemanticLayerRepository(double.database, now);
    await expect(
      repository.updateAttribute("a", { sql: "select 2" }, "operator")
    ).resolves.toEqual({ id: "a" });
    expect(double.operations[0]).toMatchObject({
      set: { sql: "select 2", ...EDITED },
      table: semanticSqlAttributes,
    });
    await expect(
      repository.updateAttribute("missing", {}, "operator")
    ).resolves.toBeNull();
  });

  it("updates a relationship and removes its certification", async () => {
    const double = createDouble([[{ id: "r" }], []]);
    const repository = createSemanticLayerRepository(double.database, now);
    await expect(
      repository.updateRelationship("r", { description: "x" }, "operator")
    ).resolves.toEqual({ id: "r" });
    expect(double.operations[0]).toMatchObject({
      set: { description: "x", ...EDITED },
      table: semanticRelationships,
    });
    await expect(
      repository.updateRelationship("missing", {}, "operator")
    ).resolves.toBeNull();
  });
});

describe("semantic layer certification", () => {
  const VERSION = new Date("2026-11-01T00:00:00.000Z");
  const input = (
    kind: "term" | "attribute" | "relationship",
    certified: boolean,
    id = "x"
  ) => ({
    actor: "reviewer",
    certified,
    expectedUpdatedAt: VERSION,
    id,
    kind,
    note: certified ? "ok" : "revoked",
  });

  it.each([
    ["term", semanticTerms],
    ["attribute", semanticSqlAttributes],
    ["relationship", semanticRelationships],
  ] as const)(
    "certifies, reports changed and not_found for a %s",
    async (kind, table) => {
      const double = createDouble([
        [{ id: "x" }],
        [{ id: "x" }],
        [],
        [{ id: "x" }],
        [],
        [],
      ]);
      const repository = createSemanticLayerRepository(double.database, now);
      await expect(repository.certify(input(kind, true))).resolves.toBe(
        "certified"
      );
      await expect(repository.certify(input(kind, false))).resolves.toBe(
        "certified"
      );
      await expect(repository.certify(input(kind, true))).resolves.toBe(
        "changed"
      );
      await expect(
        repository.certify(input(kind, true, "missing"))
      ).resolves.toBe("not_found");
      const [certify, uncertify, stale, lookup] = double.operations;
      expect(certify).toMatchObject({ kind: "update", table });
      expect(certify?.returning).toEqual({ id: table.id });
      expect(certify?.set).toEqual({
        certificationNote: "ok",
        certified: true,
        certifiedAt: NOW,
        certifiedBy: "reviewer",
      });
      expect(uncertify?.set).toEqual({
        certificationNote: "revoked",
        certified: false,
        certifiedAt: null,
        certifiedBy: null,
      });
      const where = render(certify?.where);
      expect(where?.sql).toContain(
        `date_trunc('milliseconds', "${getTableConfig(table).name}"."updated_at") = $`
      );
      expect(where?.params).toEqual(["x", VERSION]);
      expect(stale?.kind).toBe("update");
      expect(lookup).toMatchObject({ kind: "select", limit: 1, table });
      expect(render(lookup?.where)?.params).toEqual(["x"]);
      expect(double.operations).toHaveLength(6);
    }
  );
});

describe("semantic layer persistence errors", () => {
  it("converts coded database errors and rethrows uncoded ones", async () => {
    const plain = new Error("bug");
    const double = createDouble([coded("08006"), plain]);
    const repository = createSemanticLayerRepository(double.database, now);
    await expect(repository.term("pnl")).rejects.toBeInstanceOf(
      DatabasePersistenceError
    );
    await expect(repository.term("pnl")).rejects.toBe(plain);
  });

  describe("certifiedStatement", () => {
    it("renumbers placeholders in first-use order, repeats and binds the limit last", () => {
      expect(
        certifiedStatement(
          "select * from t where a = $2 and b = $1 or c = $2",
          ["one", 2],
          50
        )
      ).toEqual({
        text: "select * from (\nselect * from t where a = $1 and b = $2 or c = $1\n) as certified_result limit $3",
        values: [2, "one", 51],
      });
    });

    it("does not send an unused parameter", () => {
      expect(certifiedStatement("select $3 as x", ["a", "b", null], 5)).toEqual(
        {
          text: "select * from (\nselect $1 as x\n) as certified_result limit $2",
          values: [null, 6],
        }
      );
    });

    it("binds only the limit without placeholders", () => {
      expect(certifiedStatement("select 1", [], 10).values).toEqual([11]);
    });

    it.each(["$0", "$2"])(
      "rejects the out-of-range placeholder %s",
      (placeholder) => {
        expect(() =>
          certifiedStatement(`select ${placeholder}`, ["a"], 1)
        ).toThrow(
          new SemanticSqlParameterError(
            `The SQL uses ${placeholder}, but the term has 1 parameter(s).`
          )
        );
        expect(() =>
          certifiedStatement(`select ${placeholder}`, ["a"], 1)
        ).toThrow(SemanticSqlParameterError);
      }
    );
  });

  const READER_URL = `postgres://${SEMANTIC_READER_ROLE}:secret@db:5432/vertex`;
  const IDENTITY = {
    current_user: SEMANTIC_READER_ROLE,
    no_memberships: true,
    rolbypassrls: false,
    rolsuper: false,
    session_user: SEMANTIC_READER_ROLE,
  };

  /**
   * Fake reader seam: `open` records the URL and returns {client, close}. The client answers the identity
   * query with `identity` (or no row), other strings with no rows, and the main query with `rows` or `error`.
   */
  const createFakeOpen = (
    outcome: {
      closeError?: unknown;
      discardError?: unknown;
      error?: unknown;
      identity?: Record<string, unknown> | null;
      openError?: unknown;
      rows?: unknown[];
    } = {}
  ) => {
    const calls: unknown[] = [];
    const opened: string[] = [];
    const client: SemanticReaderClient = {
      query: async (query) => {
        if (
          typeof query === "string" &&
          query.startsWith("select session_user")
        ) {
          calls.push("identity");
          const identity =
            outcome.identity === undefined ? IDENTITY : outcome.identity;
          return { rows: identity === null ? [] : [identity] };
        }
        calls.push(query);
        if (query === "discard all" && outcome.discardError !== undefined) {
          throw outcome.discardError;
        }
        if (typeof query === "string") return { rows: [] };
        if (outcome.error !== undefined) throw outcome.error;
        return { rows: (outcome.rows ?? []) as Record<string, unknown>[] };
      },
    };
    const open = async (url: string): Promise<SemanticReaderConnection> => {
      opened.push(url);
      if (outcome.openError !== undefined) throw outcome.openError;
      return {
        client,
        close: async () => {
          calls.push("close");
          if (outcome.closeError !== undefined) throw outcome.closeError;
        },
      };
    };
    return { calls, open, opened };
  };

  const OPTIONS = { rowLimit: 2, timeoutMs: 1500.9 };
  const ATTRIBUTE = { sql: "select * from strategies where id = $1" };
  const STATEMENT = certifiedStatement(ATTRIBUTE.sql, ["s1"], 2);
  const UNAVAILABLE = {
    failure: "reader_unavailable",
    message: `The read-only database login ${SEMANTIC_READER_ROLE} is not configured or cannot connect.`,
    query: STATEMENT.text,
    status: "failed",
  };

  describe("createSemanticReader", () => {
    it.each([
      ["no connection string", null],
      ["an unparsable URL", "not a url"],
      ["the app login", "postgres://vertex_research:pw@db/vertex"],
      [
        "a percent-encoded other login",
        "postgres://vertex%5Fresearch:pw@db/vertex",
      ],
      [
        "a user query parameter",
        `postgres://${SEMANTIC_READER_ROLE}:pw@db/vertex?user=vertex_research`,
      ],
      [
        "a password query parameter",
        `postgres://${SEMANTIC_READER_ROLE}:pw@db/vertex?password=other`,
      ],
    ])(
      "fails reader_unavailable with %s and opens nothing",
      async (_label, url) => {
        const fake = createFakeOpen();
        const reader = createSemanticReader(url, fake.open);
        await expect(reader.run(ATTRIBUTE, ["s1"], OPTIONS)).resolves.toEqual(
          UNAVAILABLE
        );
        expect(fake.opened).toEqual([]);
        expect(fake.calls).toEqual([]);
      }
    );

    it("accepts a percent-encoded reader login with other query parameters", async () => {
      const fake = createFakeOpen({ rows: [] });
      const url =
        "postgres://vertex%5Fsemantic%5Freader:pw@db/vertex?sslmode=require";
      const reader = createSemanticReader(url, fake.open);
      await expect(
        reader.run(ATTRIBUTE, ["s1"], OPTIONS)
      ).resolves.toMatchObject({ status: "ok" });
      expect(fake.opened).toEqual([url]);
    });

    it("fails invalid_sql on a bad placeholder without opening", async () => {
      const fake = createFakeOpen();
      const reader = createSemanticReader(READER_URL, fake.open);
      await expect(
        reader.run({ sql: "select $2" }, ["a"], OPTIONS)
      ).resolves.toEqual({
        failure: "invalid_sql",
        message: "The SQL uses $2, but the term has 1 parameter(s).",
        query: "select $2",
        status: "failed",
      });
      expect(fake.opened).toEqual([]);
    });

    it.each([
      ["no identity row", null],
      [
        "another session user",
        { ...IDENTITY, session_user: "vertex_research" },
      ],
      [
        "another current user",
        { ...IDENTITY, current_user: "vertex_research" },
      ],
      ["a superuser", { ...IDENTITY, rolsuper: true }],
      ["a role membership", { ...IDENTITY, no_memberships: false }],
      ["unknown memberships", { ...IDENTITY, no_memberships: null }],
      ["an RLS bypass", { ...IDENTITY, rolbypassrls: true }],
      ["an unknown superuser flag", { ...IDENTITY, rolsuper: null }],
    ])(
      "fails reader_unavailable on %s and runs nothing",
      async (_label, identity) => {
        const fake = createFakeOpen({ identity });
        const reader = createSemanticReader(READER_URL, fake.open);
        await expect(reader.run(ATTRIBUTE, ["s1"], OPTIONS)).resolves.toEqual({
          ...UNAVAILABLE,
          message: `The reader connection is not the plain read-only role ${SEMANTIC_READER_ROLE}.`,
        });
        expect(fake.calls).toEqual(["identity", "close"]);
      }
    );

    it("checks identity, runs read-only with a timeout, rolls back and converts rows", async () => {
      const fake = createFakeOpen({
        rows: [
          {
            at: new Date("2026-01-02T03:04:05.000Z"),
            big: 12n,
            list: [1n, "a"],
            n: 1.5,
            nested: { when: new Date("2026-01-01T00:00:00.000Z"), x: null },
            ok: true,
          },
        ],
      });
      const reader = createSemanticReader(READER_URL, fake.open);
      await expect(reader.run(ATTRIBUTE, ["s1"], OPTIONS)).resolves.toEqual({
        query: STATEMENT.text,
        rows: [
          {
            at: "2026-01-02T03:04:05.000Z",
            big: "12",
            list: ["1", "a"],
            n: 1.5,
            nested: { when: "2026-01-01T00:00:00.000Z", x: null },
            ok: true,
          },
        ],
        status: "ok",
        truncated: false,
      });
      expect(fake.opened).toEqual([READER_URL]);
      expect(fake.calls).toEqual([
        "identity",
        "begin read only",
        "set local statement_timeout = 1500",
        { queryMode: "extended", text: STATEMENT.text, values: ["s1", 3] },
        "rollback",
        "close",
      ]);
    });

    it.each([
      [Number.NaN, 1],
      [Number.POSITIVE_INFINITY, 1],
      [0, 1],
      [-50, 1],
      [0.4, 1],
      [2.9, 2],
      [250, 250],
    ])("clamps timeout %s to %s ms", async (timeoutMs, expected) => {
      const fake = createFakeOpen();
      const reader = createSemanticReader(READER_URL, fake.open);
      await reader.run(ATTRIBUTE, ["s1"], { rowLimit: 2, timeoutMs });
      expect(fake.calls).toContain(`set local statement_timeout = ${expected}`);
    });

    it("truncates rows past the limit", async () => {
      const fake = createFakeOpen({ rows: [{ a: 1 }, { a: 2 }, { a: 3 }] });
      const reader = createSemanticReader(READER_URL, fake.open);
      await expect(
        reader.run(ATTRIBUTE, ["s1"], OPTIONS)
      ).resolves.toMatchObject({
        rows: [{ a: 1 }, { a: 2 }],
        status: "ok",
        truncated: true,
      });
    });

    it("still resolves when close rejects", async () => {
      const fake = createFakeOpen({ closeError: new Error("gone"), rows: [] });
      const reader = createSemanticReader(READER_URL, fake.open);
      await expect(
        reader.run(ATTRIBUTE, ["s1"], OPTIONS)
      ).resolves.toMatchObject({ status: "ok" });
      expect(fake.calls.at(-1)).toBe("close");
    });

    it.each([
      ["25006", "write_refused"],
      ["57014", "timeout"],
      ["42601", "invalid_sql"],
      ["42703", "invalid_sql"],
      ["42P01", "invalid_sql"],
      ["42883", "invalid_sql"],
      ["42804", "invalid_sql"],
      ["42501", "permission_denied"],
      ["28P01", "reader_unavailable"],
      ["28000", "reader_unavailable"],
      ["3D000", "reader_unavailable"],
      ["08006", "reader_unavailable"],
      ["53300", "reader_unavailable"],
      ["57P03", "reader_unavailable"],
      ["XX000", "query_failed"],
      ["ECONNREFUSED", "reader_unavailable"],
    ])("maps code %s to %s and closes", async (code, failure) => {
      const fake = createFakeOpen({ error: coded(code) });
      const reader = createSemanticReader(READER_URL, fake.open);
      const result = await reader.run(ATTRIBUTE, ["s1"], OPTIONS);
      expect(result).toMatchObject({
        failure,
        query: STATEMENT.text,
        status: "failed",
      });
      expect(
        result.status === "failed" && result.message.length
      ).toBeGreaterThan(0);
      expect(fake.calls).not.toContain("rollback");
      expect(fake.calls.at(-1)).toBe("close");
    });

    it.each([
      ["a SQLSTATE", coded("08001")],
      ["a network code", coded("ECONNREFUSED")],
      ["no code", new Error("connect failed")],
    ])(
      "fails reader_unavailable when open throws an error with %s",
      async (_label, openError) => {
        const fake = createFakeOpen({ openError });
        const reader = createSemanticReader(READER_URL, fake.open);
        await expect(reader.run(ATTRIBUTE, ["s1"], OPTIONS)).resolves.toEqual(
          UNAVAILABLE
        );
        expect(fake.calls).toEqual([]);
      }
    );

    it("rethrows a codeless error after opening and still closes", async () => {
      const bug = new Error("bug");
      const fake = createFakeOpen({ error: bug });
      const reader = createSemanticReader(READER_URL, fake.open);
      await expect(reader.run(ATTRIBUTE, ["s1"], OPTIONS)).rejects.toBe(bug);
      expect(fake.calls.at(-1)).toBe("close");
    });

    it("uses the default opener when none is passed", async () => {
      const reader = createSemanticReader(
        `postgres://${SEMANTIC_READER_ROLE}:pw@127.0.0.1:1/vertex?sslmode=disable`
      );
      await expect(reader.run(ATTRIBUTE, ["s1"], OPTIONS)).resolves.toEqual(
        UNAVAILABLE
      );
    }, 15_000);

    it("opens the request client with a connect timeout and closes it", async () => {
      const fake = createFakeOpen({ rows: [{ a: 1 }] });
      const connection = await fake.open(READER_URL);
      fake.calls.length = 0;
      requestDatabase.calls.length = 0;
      requestDatabase.resource = {
        close: connection.close,
        db: { $client: connection.client },
      };
      try {
        const reader = createSemanticReader(READER_URL);
        await expect(
          reader.run(ATTRIBUTE, ["s1"], OPTIONS)
        ).resolves.toMatchObject({ rows: [{ a: 1 }], status: "ok" });
      } finally {
        requestDatabase.resource = undefined;
      }
      expect(requestDatabase.calls).toEqual([
        { connectionString: READER_URL, connectionTimeoutMillis: 5000 },
      ]);
      expect(fake.calls.at(-1)).toBe("close");
    });

    describe("runAll", () => {
      const SECOND_ATTRIBUTE = { sql: "select * from runs where id = $1" };
      const SECOND = certifiedStatement(SECOND_ATTRIBUTE.sql, ["s1"], 2);
      const checked = (statement: typeof STATEMENT) => [
        "identity",
        "begin read only",
        "set local statement_timeout = 1500",
        { queryMode: "extended", text: statement.text, values: ["s1", 3] },
      ];

      it("runs every text on one connection, each with the identity check and its own read-only transaction", async () => {
        const fake = createFakeOpen({ rows: [{ a: 1 }] });
        const reader = createSemanticReader(READER_URL, fake.open);
        await expect(
          reader.runAll([ATTRIBUTE, SECOND_ATTRIBUTE], ["s1"], OPTIONS)
        ).resolves.toEqual([
          {
            query: STATEMENT.text,
            rows: [{ a: 1 }],
            status: "ok",
            truncated: false,
          },
          {
            query: SECOND.text,
            rows: [{ a: 1 }],
            status: "ok",
            truncated: false,
          },
        ]);
        expect(fake.opened).toEqual([READER_URL]);
        expect(fake.calls).toEqual([
          ...checked(STATEMENT),
          "rollback",
          "discard all",
          ...checked(SECOND),
          "rollback",
          "close",
        ]);
      });

      it("checks the identity again before every text and runs nothing after a failed check", async () => {
        const calls: unknown[] = [];
        let identityChecks = 0;
        const client: SemanticReaderClient = {
          query: async (query) => {
            if (
              typeof query !== "string" ||
              !query.startsWith("select session_user")
            ) {
              calls.push(query);
              return { rows: [] };
            }
            calls.push("identity");
            identityChecks += 1;
            return {
              rows: [
                identityChecks === 1
                  ? IDENTITY
                  : { ...IDENTITY, current_user: "vertex_research" },
              ],
            };
          },
        };
        const reader = createSemanticReader(READER_URL, async () => ({
          client,
          close: async () => {
            calls.push("close");
          },
        }));
        await expect(
          reader.runAll(
            [ATTRIBUTE, SECOND_ATTRIBUTE, ATTRIBUTE],
            ["s1"],
            OPTIONS
          )
        ).resolves.toEqual([
          {
            query: STATEMENT.text,
            rows: [],
            status: "ok",
            truncated: false,
          },
          {
            failure: "reader_unavailable",
            message: `The reader connection is not the plain read-only role ${SEMANTIC_READER_ROLE}.`,
            query: SECOND.text,
            status: "failed",
          },
        ]);
        expect(calls).toEqual([
          ...checked(STATEMENT),
          "rollback",
          "discard all",
          "identity",
          "close",
        ]);
      });

      it("ends the batch at a text that fails before it reaches the database", async () => {
        const fake = createFakeOpen();
        const reader = createSemanticReader(READER_URL, fake.open);
        const results = await reader.runAll(
          [ATTRIBUTE, { sql: "select $2" }, SECOND_ATTRIBUTE],
          ["s1"],
          OPTIONS
        );
        expect(results.map(({ status }) => status)).toEqual(["ok", "failed"]);
        expect(results[1]).toMatchObject({ failure: "invalid_sql" });
        expect(fake.opened).toEqual([READER_URL]);
        expect(fake.calls).toEqual([
          ...checked(STATEMENT),
          "rollback",
          "discard all",
          "close",
        ]);
      });

      it("runs no further text on the connection after a failed statement", async () => {
        const fake = createFakeOpen({
          error: Object.assign(new Error("canceled"), { code: "57014" }),
        });
        const reader = createSemanticReader(READER_URL, fake.open);
        const results = await reader.runAll(
          [ATTRIBUTE, SECOND_ATTRIBUTE],
          ["s1"],
          OPTIONS
        );
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          query: STATEMENT.text,
          status: "failed",
        });
        // No rollback and no second text: the connection is closed with its transaction open.
        expect(fake.calls).toEqual([...checked(STATEMENT), "close"]);
      });

      it("fails the text and ends the batch when the session reset fails", async () => {
        const fake = createFakeOpen({
          discardError: Object.assign(new Error("terminated"), {
            code: "57P01",
          }),
        });
        const reader = createSemanticReader(READER_URL, fake.open);
        const results = await reader.runAll(
          [ATTRIBUTE, SECOND_ATTRIBUTE],
          ["s1"],
          OPTIONS
        );
        // Rows are returned only from a clean session: the text that could not reset fails.
        expect(results).toEqual([
          expect.objectContaining({ query: STATEMENT.text, status: "failed" }),
        ]);
        expect(fake.calls).toEqual([
          ...checked(STATEMENT),
          "rollback",
          "discard all",
          "close",
        ]);
      });

      it("opens no connection for no texts", async () => {
        const fake = createFakeOpen();
        const reader = createSemanticReader(READER_URL, fake.open);
        await expect(reader.runAll([], ["s1"], OPTIONS)).resolves.toEqual([]);
        expect(fake.opened).toEqual([]);
        expect(fake.calls).toEqual([]);
      });
    });
  });
});
