import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type {
  PolicyHead,
  PolicyHistory,
  PolicySelection,
} from "../../../config/src/vertex/ports.ts";
import type { Transaction } from "../../../db/src/server/client.ts";
import {
  createVertexPolicyStore,
  createVertexPolicyStoreForTransaction,
} from "../../../db/src/server/vertex-policy-store.ts";
import {
  fixtureBoundary,
  fixtureHarness,
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

const recordHash = async (value: unknown): Promise<string> =>
  fixtureBoundary.digest(fixtureBoundary.encode(value));

// A real activation receipt from the in-memory registry, so the SQL store sees
// exactly the record shape the registry appends.
const activatedReceipt = async () => {
  const harness = fixtureHarness();
  const selection = await fixtureSelection();
  await harness.registry.stage({
    ...harness.command(selection, "stage-1"),
    selection,
  });
  await harness.registry.activate(harness.command(selection, "activate-1"));
  const receipt = harness.state.history.get("activate-1");
  if (receipt === undefined) throw new Error("missing activation receipt");
  return { selection, receipt };
};

const selectionRow = (value: PolicySelection) => ({
  selection_id: value.selectionId,
  selection_sha256: value.selectionSha256,
  revision: value.revision,
  issued_at_ns: fixtureBoundary.epochNanoseconds(value.issuedAt).toString(),
  expires_at_ns: fixtureBoundary.epochNanoseconds(value.expiresAt).toString(),
  payload: value,
});

const headRow = async (head: PolicyHead) => ({
  revision: head.revision,
  selection_id: head.selectionId,
  selection_sha256: head.selectionSha256,
  state: head.state,
  updated_at: head.updatedAt,
  record_hash: await recordHash(head),
  payload: head,
});

const historyRow = async (receipt: PolicyHistory) => ({
  command_id: receipt.commandId,
  record_hash: await recordHash(receipt),
  request_sha256: receipt.requestSha256,
  operation: receipt.operation,
  actor_id: receipt.actorId,
  selection_id: receipt.selectionId,
  selection_sha256: receipt.selectionSha256,
  revision: receipt.head.revision,
  recorded_at_ns: fixtureBoundary
    .epochNanoseconds(receipt.recordedAt)
    .toString(),
  payload: receipt,
});

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

  it("returns a stored activation receipt only when both bound heads stay in scope", async () => {
    const { receipt } = await activatedReceipt();
    const stored = createVertexPolicyStoreForTransaction(
      driver([[], [], [await historyRow(receipt)]]).tx,
      { boundary: fixtureBoundary }
    );
    await expect(
      stored.transaction(fixtureScope, (tx) => tx.getHistory("activate-1"))
    ).resolves.toEqual(receipt);
    // A recomputed record hash cannot move the next head to another account.
    const moved = {
      ...receipt,
      head: { ...receipt.head, accountAlias: "synthetic-policy-other" },
    };
    const tampered = createVertexPolicyStoreForTransaction(
      driver([[], [], [await historyRow(moved)]]).tx,
      { boundary: fixtureBoundary }
    );
    await expect(
      tampered.transaction(fixtureScope, (tx) => tx.getHistory("activate-1"))
    ).rejects.toMatchObject({ code: "integrity" });
  });

  it("appends history only for the exact current head one revision past the previous head", async () => {
    const { selection, receipt } = await activatedReceipt();
    const current = async () => [
      [],
      [],
      [await headRow(receipt.head)],
      [selectionRow(selection)],
    ];
    const accepted = driver(await current());
    await expect(
      createVertexPolicyStoreForTransaction(accepted.tx, {
        boundary: fixtureBoundary,
      }).transaction(fixtureScope, (tx) => tx.appendHistory(receipt))
    ).resolves.toBeUndefined();
    const insert = accepted.queries.find((query) =>
      query.sql.startsWith("insert into vertex_policy_history")
    );
    if (insert === undefined) throw new Error("missing history insert");
    expect(insert.params).toContain(receipt.commandId);
    expect(insert.params).toContain(await recordHash(receipt));

    const noHead = driver([[], [], []]);
    await expect(
      createVertexPolicyStoreForTransaction(noHead.tx, {
        boundary: fixtureBoundary,
      }).transaction(fixtureScope, (tx) => tx.appendHistory(receipt))
    ).rejects.toMatchObject({ code: "integrity" });
    const otherScope = driver(await current());
    await expect(
      createVertexPolicyStoreForTransaction(otherScope.tx, {
        boundary: fixtureBoundary,
      }).transaction(fixtureScope, (tx) =>
        tx.appendHistory({
          ...receipt,
          scope: { ...receipt.scope, accountAlias: "synthetic-policy-other" },
        })
      )
    ).rejects.toMatchObject({ code: "integrity" });
    for (const db of [noHead, otherScope])
      expect(db.queries.some((query) => query.sql.startsWith("insert"))).toBe(
        false
      );
  });
});
