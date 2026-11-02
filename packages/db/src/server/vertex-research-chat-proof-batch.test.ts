import {
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  AT,
  END,
  owner,
  scope,
} from "../../../api/src/server/vertex-research-chat-execution-runtime.test-support.ts";
import { lifecycleFixture } from "./vertex-research-chat-copy-lifecycle.test-support.ts";

// Use the existing concrete worker composition; no owner or validator is mocked.
vi.setConfig({ testTimeout: 120_000 });
const effects = "vertex_research_chat_copy_effects";
const observations = "vertex_research_chat_copy_effect_observations";
const closures = "vertex_research_chat_copy_domain_closures";
const batch = (sql: string) =>
  sql.includes("as expected(ordinal, purpose, copy_id)");
type Row = Record<string, unknown>;
type QueryRows = Readonly<{ rows: Row[] }>;
const firstRow = (rows: Row[]): Row => {
  const row = rows[0];
  if (!row) throw new Error("Expected a fixture row");
  return row;
};
const objectField = (row: Row, key: string): Row => {
  const value = row[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected fixture object field ${key}`);
  }
  return value as Row;
};

describe("bounded historical proof pairs", () => {
  it("reads three pairs once, keeps authority query order, and rejects finite corrupt historical cases", async () => {
    const f = await lifecycleFixture(),
      approved = await f.approve();
    await f.runtime.writeApprovedInputs(owner, approved.input);
    const copies = f.runtime.worker.copies;
    const read = () =>
      f.db.transaction((tx) =>
        copies.readCurrentOriginalForTransaction(
          tx,
          scope,
          f.responseRequestId,
          AT
        )
      );
    const offset = f.calls.length;
    expect(await read()).not.toBeNull();
    const baseline = f.calls.slice(offset);
    expect(baseline.filter((q) => batch(q.sql))).toHaveLength(1);
    expect(
      baseline.filter(
        (q) => q.sql.includes(effects) || q.sql.includes(observations)
      )
    ).toHaveLength(1);
    const saved = structuredClone(f.tables);
    const restore = () => {
      f.tables.clear();
      for (const [name, rows] of structuredClone(saved))
        f.tables.set(name, rows);
    };
    // Execute the old six SELECTs only at the SQL transport boundary. Real owners,
    // hashes, reconstruction and pre/post authority remain the same on both runs.
    const transport = f.tx as unknown as {
      execute: (fragment: SQL) => Promise<QueryRows>;
    };
    const originalExecute = transport.execute.bind(transport);
    transport.execute = async (fragment: SQL) => {
      const q = new PgDialect().sqlToQuery(fragment);
      if (!batch(q.sql)) return originalExecute(fragment);
      const result: Row[] = [];
      for (const [ordinal, purpose] of [
        "context",
        "tokenizeInput",
        "completionInput",
      ].entries()) {
        const copyId = q.params[ordinal];
        const pair: Row = { ordinal, purpose, copy_id: copyId };
        for (const [table, alias] of [
          [effects, "effect_row"],
          [observations, "observation_row"],
        ] as const) {
          const selected = await originalExecute(
            sql`select * from ${sql.identifier(table)} where account_alias = ${scope.accountAlias} and environment = ${scope.environment} and response_request_id = ${f.responseRequestId} and copy_id = ${copyId} and operation = 'create'`
          );
          pair[alias] = selected.rows[0] ?? null;
        }
        result.push(pair);
      }
      return { rows: result };
    };
    const oldOffset = f.calls.length;
    expect(await read()).not.toBeNull();
    transport.execute = originalExecute;
    const external = (queries: typeof baseline) =>
      queries.filter(
        (q) => !(q.sql.includes(effects) || q.sql.includes(observations))
      );
    expect(external(f.calls.slice(oldOffset))).toEqual(external(baseline));
    expect(
      f.calls
        .slice(oldOffset)
        .filter((q) => q.sql.includes(effects) || q.sql.includes(observations))
    ).toHaveLength(6);
    const cases = [
      {
        name: "missing effect",
        table: effects,
        change: (rows: Row[]) => {
          rows.shift();
        },
        code: "unavailable",
      },
      {
        name: "missing observation",
        table: observations,
        change: (rows: Row[]) => {
          rows.shift();
        },
        code: "unavailable",
      },
      {
        name: "duplicate effect",
        table: effects,
        change: (rows: Row[]) => {
          rows.push(structuredClone(firstRow(rows)));
        },
        code: "integrity",
      },
      {
        name: "duplicate observation",
        table: observations,
        change: (rows: Row[]) => {
          rows.push(structuredClone(firstRow(rows)));
        },
        code: "integrity",
      },
      {
        name: "cross scope",
        table: effects,
        change: (rows: Row[]) => {
          firstRow(rows)["account_alias"] = "other-scope";
        },
        code: "unavailable",
      },
      {
        name: "wrong operation",
        table: observations,
        change: (rows: Row[]) => {
          firstRow(rows)["operation"] = "fence";
        },
        code: "unavailable",
      },
      {
        name: "wrong request",
        table: observations,
        change: (rows: Row[]) => {
          firstRow(rows)["response_request_id"] = "other-request";
        },
        code: "unavailable",
      },
      {
        name: "bad effect hash",
        table: effects,
        change: (rows: Row[]) => {
          firstRow(rows)["record_hash"] = "0".repeat(64);
        },
        code: "integrity",
      },
      {
        name: "bad observation hash",
        table: observations,
        change: (rows: Row[]) => {
          firstRow(rows)["record_hash"] = "0".repeat(64);
        },
        code: "integrity",
      },
      {
        name: "mismatched copy",
        table: observations,
        change: async (rows: Row[]) => {
          const row = firstRow(rows);
          objectField(row, "payload")["copyId"] = "other-copy";
          row["record_hash"] = await hashArtifact(row["payload"]);
        },
        code: "integrity",
      },
      {
        name: "future intent",
        table: effects,
        change: async (rows: Row[]) => {
          const row = firstRow(rows);
          objectField(row, "payload")["intentCommittedAt"] = END;
          row["intent_committed_at_ns"] =
            timestampToEpochNanoseconds(END).toString();
          row["record_hash"] = await hashArtifact(row["payload"]);
        },
        code: "stale",
      },
      {
        name: "future upload",
        table: observations,
        change: async (rows: Row[]) => {
          const row = firstRow(rows);
          objectField(objectField(row, "payload"), "proof")["uploadedAt"] = END;
          row["record_hash"] = await hashArtifact(row["payload"]);
        },
        code: "integrity",
      },
    ];
    for (const test of cases) {
      restore();
      await test.change(f.table(test.table));
      await expect(read(), test.name).rejects.toMatchObject({
        code: test.code,
      });
      expect(f.table(closures), test.name).toHaveLength(0);
    }
    restore();
    const derived = () =>
      f.db.transaction((tx) =>
        copies.readCurrentDerivedForTransaction(
          tx,
          scope,
          f.responseRequestId,
          AT
        )
      );
    expect(await derived()).not.toBeNull();
    f.table(observations)[0]!["record_hash"] = "0".repeat(64);
    await expect(derived()).rejects.toMatchObject({ code: "integrity" });
    restore();
    f.state.afterQuery = (q) => {
      if (batch(q.sql)) return (f.state.at = END);
      return;
    };
    expect(await read()).toBeNull();
    return expect(
      f
        .table(closures)
        .map((r) => r["domain"])
        .sort()
    ).toEqual(["derived", "inputs"]);
  });
  it("rechecks revocation and explicit closure around asynchronous original-byte reads", async () => {
    const f = await lifecycleFixture(),
      approved = await f.approve();
    await f.runtime.writeApprovedInputs(owner, approved.input);
    const copies = f.runtime.worker.copies;
    const saved = structuredClone(f.tables);
    f.copies.state.afterRead = async () => {
      await f.revokeContext();
    };
    await expect(
      copies.readOriginalInput(scope, f.responseRequestId, "context")
    ).rejects.toMatchObject({ code: "denied" });
    expect(
      f
        .table(closures)
        .map((r) => r["domain"])
        .sort()
    ).toEqual(["derived", "inputs"]);
    f.tables.clear();
    for (const [name, rows] of saved) f.tables.set(name, rows);
    const cleanup = await f.grantCleanup();
    f.copies.state.afterRead = async () => {
      await f.runtime.closeApprovedInputs(cleanup, f.selector);
    };
    await expect(
      copies.readOriginalInput(scope, f.responseRequestId, "context")
    ).rejects.toMatchObject({ code: "denied" });
    return expect(f.table(closures).map((r) => r["domain"])).toEqual([
      "inputs",
    ]);
  });
});
