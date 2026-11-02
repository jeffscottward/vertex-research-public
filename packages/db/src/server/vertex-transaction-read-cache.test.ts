import { describe, expect, it } from "vitest";
import type { Transaction } from "./client.ts";
import { accountCatalogArtifact, insert } from "./vertex-persistence-core.ts";
import {
  cachedTransactionRows,
  invalidateTransactionRows,
  withTransactionReadScope,
} from "./vertex-transaction-read-cache.ts";

const scope = {
  accountAlias: "fixture-account",
  environment: "paper",
} as const;

// One executor object, reused across transactions on purpose.
const fakeExecutor = (rows: () => Record<string, unknown>[]) => {
  const statements: string[] = [];
  const tx = {
    execute: async () => {
      statements.push("execute");
      return { rows: rows() };
    },
  } as unknown as Transaction;
  const transaction = <T>(operation: (tx: Transaction) => Promise<T>) =>
    withTransactionReadScope(operation)(tx);
  return { tx, statements, transaction };
};

describe("transaction read cache", () => {
  it("reuses non-empty rows only inside the same transaction", async () => {
    let found: Record<string, unknown>[] = [];
    const db = fakeExecutor(() => found);
    await db.transaction(async (tx) => {
      expect(await accountCatalogArtifact(tx, scope, "a")).toBeNull();
      found = [{ artifact_id: "a" }];
      expect(await accountCatalogArtifact(tx, scope, "a")).toEqual({
        artifact_id: "a",
      });
      expect(await accountCatalogArtifact(tx, scope, "a")).toEqual({
        artifact_id: "a",
      });
    });
    expect(db.statements).toHaveLength(2);
    await db.transaction((tx) => accountCatalogArtifact(tx, scope, "a"));
    expect(db.statements).toHaveLength(3);
  });

  it("drops entries when the transaction ends, even for a reused executor", async () => {
    let found = [{ status: "granted" }];
    const db = fakeExecutor(() => found);
    await db.transaction(async (tx) => {
      await accountCatalogArtifact(tx, scope, "a");
      found = [{ status: "revoked" }];
      expect(await accountCatalogArtifact(tx, scope, "a")).toEqual({
        status: "granted",
      });
    });
    // An unscoped use of the same executor reads current rows.
    expect(await accountCatalogArtifact(db.tx, scope, "a")).toEqual({
      status: "revoked",
    });
    await expect(
      db.transaction(async () => {
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    found = [{ status: "granted" }];
    expect(await accountCatalogArtifact(db.tx, scope, "a")).toEqual({
      status: "granted",
    });
    expect(db.statements).toHaveLength(3);
  });

  it("drops a table's entries on invalidation or insert in the same transaction", async () => {
    const db = fakeExecutor(() => [{ artifact_id: "a" }]);
    await db.transaction(async (tx) => {
      await accountCatalogArtifact(tx, scope, "a");
      await insert(tx, "vertex_artifacts", scope, { artifact_id: "b" });
      await accountCatalogArtifact(tx, scope, "a");
      invalidateTransactionRows(tx, "vertex_artifacts");
      await accountCatalogArtifact(tx, scope, "a");
    });
    expect(db.statements).toHaveLength(4);
    // An unscoped insert has no cache to drop.
    await insert(db.tx, "vertex_artifacts", scope, { artifact_id: "c" });
  });

  it("returns copies so callers cannot change cached results", async () => {
    const db = fakeExecutor(() => []);
    const load = async () => [{ id: 1 }];
    await db.transaction(async (tx) => {
      const first = await cachedTransactionRows(tx, "t", "k", load);
      first.pop();
      expect(await cachedTransactionRows(tx, "t", "k", load)).toHaveLength(1);
      expect(await cachedTransactionRows(tx, "t", "other", load)).toHaveLength(
        1
      );
    });
  });

  it("keeps the outer scope when a borrowed transaction re-enters", async () => {
    const db = fakeExecutor(() => [{ artifact_id: "a" }]);
    await db.transaction(async (tx) => {
      await accountCatalogArtifact(tx, scope, "a");
      await withTransactionReadScope(async (inner: Transaction) =>
        accountCatalogArtifact(inner, scope, "a")
      )(tx);
      await accountCatalogArtifact(tx, scope, "a");
    });
    expect(db.statements).toHaveLength(1);
  });
});
