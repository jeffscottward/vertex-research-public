import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { Transaction } from "../../../db/src/server/client.ts";
import {
  createVertexPolicyStore,
  createVertexPolicyStoreForTransaction,
} from "../../../db/src/server/vertex-policy-store.ts";
import {
  fixtureBoundary,
  fixtureScope,
  fixtureSelection,
} from "./vertex-policy.test-support.ts";

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

// Authored only. No database connection, SQL migration, test runner or runtime
// import was executed while building this implementation.
const driver = (
  responses: readonly (readonly Record<string, unknown>[])[] = [],
  failure?: unknown
) => {
  const queries: CapturedQuery[] = [];
  const dialect = new PgDialect();
  let index = 0;
  const tx = {
    execute: async (query: SQL) => {
      queries.push(dialect.sqlToQuery(query));
      if (failure) throw failure;
      const rows = responses[index] ?? [];
      index += 1;
      return { rows };
    },
  } as unknown as Transaction;
  return { tx, queries };
};

const queryAt = (queries: readonly CapturedQuery[], index: number) => {
  const query = queries[index];
  if (query === undefined) throw new Error(`missing query ${index}`);
  return query;
};

describe("policy PostgreSQL ownership and integrity boundary", () => {
  it("joins the caller transaction without opening a nested transaction or obtaining a connection", async () => {
    const db = driver();
    const store = createVertexPolicyStoreForTransaction(db.tx, {
      boundary: fixtureBoundary,
    });
    await expect(
      store.transaction(fixtureScope, async (tx) => tx.getHead())
    ).resolves.toBe(null);
    expect(db.queries).toHaveLength(3);
    expect(queryAt(db.queries, 0).params).toEqual([
      "vertex-authorization:global",
    ]);
    expect(queryAt(db.queries, 1).params).toEqual([
      JSON.stringify([
        "vertex-policy",
        fixtureScope.accountAlias,
        fixtureScope.environment,
      ]),
    ]);
    expect(queryAt(db.queries, 2).sql).toContain('"vertex_policy_heads"');
    expect(queryAt(db.queries, 2).params).toEqual([
      fixtureScope.accountAlias,
      fixtureScope.environment,
    ]);
  });

  it("uses one caller-owned transaction and lets callback failure roll back atomically", async () => {
    const db = driver();
    let committed = false;
    let rolledBack = false;
    const store = createVertexPolicyStore(
      {
        transaction: async (operation) => {
          try {
            const result = await operation(db.tx);
            committed = true;
            return result;
          } catch (error) {
            rolledBack = true;
            throw error;
          }
        },
      },
      { boundary: fixtureBoundary }
    );
    await expect(
      store.transaction(fixtureScope, async () => {
        throw new Error("synthetic-private-driver-message");
      })
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(committed).toBe(false);
    expect(rolledBack).toBe(true);
  });

  it("rejects scope and immutable selection hash mismatches before returning stored data", async () => {
    const value = await fixtureSelection();
    const db = driver([
      [],
      [],
      [
        {
          selection_id: value.selectionId,
          selection_sha256: "b".repeat(64),
          revision: value.revision,
          issued_at_ns: fixtureBoundary
            .epochNanoseconds(value.issuedAt)
            .toString(),
          expires_at_ns: fixtureBoundary
            .epochNanoseconds(value.expiresAt)
            .toString(),
          payload: value,
        },
      ],
    ]);
    const store = createVertexPolicyStoreForTransaction(db.tx, {
      boundary: fixtureBoundary,
    });
    await expect(
      store.transaction(fixtureScope, (tx) =>
        tx.getSelection(value.selectionId)
      )
    ).rejects.toMatchObject({ code: "integrity" });
  });

  it("preserves exact canonical selection revision and expiry in SQL parameters", async () => {
    const value = await fixtureSelection("9007199254740993");
    const db = driver([[], [], [], [{ maximum: null }], []]);
    const store = createVertexPolicyStoreForTransaction(db.tx, {
      boundary: fixtureBoundary,
    });
    await expect(
      store.transaction(fixtureScope, (tx) => tx.insertSelection(value))
    ).resolves.toBe("recorded");
    const insert = db.queries.find((query) =>
      query.sql.startsWith("insert into vertex_policy_selections")
    );
    if (insert === undefined) throw new Error("missing selection insert");
    expect(insert.params).toContain("9007199254740993");
    expect(insert.params).toContain(
      fixtureBoundary.epochNanoseconds(value.expiresAt).toString()
    );
    expect(insert.sql).not.toContain(value.selectionId);
  });

  it("rejects stale selection revisions rather than silently replacing immutable versions", async () => {
    const value = await fixtureSelection("2");
    const db = driver([[], [], [], [{ maximum: "3" }]]);
    const store = createVertexPolicyStoreForTransaction(db.tx, {
      boundary: fixtureBoundary,
    });
    await expect(
      store.transaction(fixtureScope, (tx) => tx.insertSelection(value))
    ).rejects.toMatchObject({ code: "conflict" });
    expect(db.queries.some((query) => query.sql.startsWith("insert"))).toBe(
      false
    );
  });

  it.each(["23505", "40001", "40P01"])(
    "maps PostgreSQL %s to safe retryable conflict without leaking driver content",
    async (code) => {
      const db = driver([], {
        code,
        message: "synthetic-private-driver-message",
      });
      const store = createVertexPolicyStoreForTransaction(db.tx, {
        boundary: fixtureBoundary,
      });
      await expect(
        store.transaction(fixtureScope, async () => null)
      ).rejects.toMatchObject({
        code: "conflict",
        message: "Vertex policy conflict",
      });
    }
  );
});
