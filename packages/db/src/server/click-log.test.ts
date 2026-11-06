import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { uiClickEvents } from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  CLICK_LOG_RETENTION_DAYS,
  type ClickLogInsert,
  createClickLogRepository,
} from "./click-log.ts";
import { DatabasePersistenceError } from "./repository-errors.ts";

interface Operation {
  kind: "select" | "insert" | "delete";
  limit?: number;
  table?: unknown;
  values?: unknown;
  where?: SQL;
}

const dialect = new PgDialect();
const render = (where: SQL | undefined) =>
  where === undefined ? undefined : dialect.sqlToQuery(where);

/** Query double: every awaited query takes the next queued result (default: no rows). */
const createDouble = (outcomes: (unknown[] | Error)[] = []) => {
  const operations: Operation[] = [];
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
      returning: () => chain,
      then: (
        resolve: (rows: unknown) => unknown,
        reject: (error: unknown) => unknown
      ) => {
        const next = outcomes.shift() ?? [];
        return (
          next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
        ).then(resolve, reject);
      },
      values: (values: unknown) => {
        operation.values = values;
        return chain;
      },
      where: (where: SQL) => {
        operation.where = where;
        return chain;
      },
    };
    return chain;
  };
  const database = {
    delete: (table: unknown) => builder({ kind: "delete", table }),
    insert: (table: unknown) => builder({ kind: "insert", table }),
    select: () => builder({ kind: "select" }),
  };
  return { database: database as unknown as DatabaseExecutor, operations };
};

const NOW = new Date("2026-11-03T20:00:00.000Z");
const options = {
  generateId: () => "id-1",
  now: () => NOW,
  retentionDays: CLICK_LOG_RETENTION_DAYS,
};

const event: ClickLogInsert = {
  buildSha: "abc1234",
  important: true,
  kind: "click",
  label: "Stop",
  occurredAt: new Date("2026-11-03T19:59:00.000Z"),
  recordRequestId: "req-record",
  requestIds: ["req-1"],
  role: "button",
  route: "/assistant",
  tabId: "0f0e8a52-1d6e-4c55-9d4b-3c1f2b8b5a11",
  targetRoute: null,
  testId: "assistant-stop",
  userId: "user-1",
};

describe("click log repository", () => {
  it("keeps 14 days", () => {
    expect(CLICK_LOG_RETENTION_DAYS).toBe(14);
  });

  it("inserts the events with fresh ids, then deletes rows received before the retention cutoff", async () => {
    const double = createDouble([[{ id: "id-1" }], []]);
    const repository = createClickLogRepository(double.database, options);

    await expect(repository.record([event])).resolves.toBe(1);

    const [insert, prune] = double.operations;
    expect(insert).toMatchObject({ kind: "insert", table: uiClickEvents });
    expect(insert?.values).toEqual([{ ...event, id: "id-1" }]);
    expect(prune).toMatchObject({ kind: "delete", table: uiClickEvents });
    const where = render(prune?.where);
    expect(where?.sql).toBe('"ui_click_events"."received_at" < $1');
    expect(where?.params).toEqual(["2026-10-20T20:00:00.000Z"]);
  });

  it("does nothing for an empty batch", async () => {
    const double = createDouble();
    const repository = createClickLogRepository(double.database, options);
    await expect(repository.record([])).resolves.toBe(0);
    expect(double.operations).toEqual([]);
  });

  it("reads a time range for all users, oldest first, and reports truncation", async () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const double = createDouble([rows]);
    const repository = createClickLogRepository(double.database, options);

    const result = await repository.query({
      from: new Date("2026-11-03T00:00:00.000Z"),
      limit: 2,
      to: new Date("2026-11-03T23:59:59.000Z"),
    });

    expect(result).toEqual({ events: rows.slice(0, 2), truncated: true });
    const [select] = double.operations;
    expect(select).toMatchObject({ kind: "select", limit: 3 });
    expect(render(select?.where)?.sql).toBe(
      '("ui_click_events"."occurred_at" >= $1 and "ui_click_events"."occurred_at" <= $2 and "ui_click_events"."received_at" >= $3)'
    );
  });

  it("filters by user id or case-insensitive email", async () => {
    const double = createDouble([[{ id: "a" }]]);
    const repository = createClickLogRepository(double.database, options);

    const result = await repository.query({
      from: new Date("2026-11-03T00:00:00.000Z"),
      limit: 5,
      to: new Date("2026-11-03T23:59:59.000Z"),
      user: "Owner@Example.test",
    });

    expect(result.truncated).toBe(false);
    const where = render(double.operations[0]?.where);
    expect(where?.sql).toContain(
      '("ui_click_events"."user_id" = $4 or lower("user"."email") = lower($5))'
    );
    expect(where?.params.slice(3)).toEqual([
      "Owner@Example.test",
      "Owner@Example.test",
    ]);
  });

  it("maps Postgres failures to DatabasePersistenceError and rethrows other errors", async () => {
    const postgres = Object.assign(new Error("relation missing"), {
      code: "42P01",
    });
    const repository = createClickLogRepository(
      createDouble([postgres]).database,
      options
    );
    await expect(
      repository.query({ from: NOW, limit: 1, to: NOW })
    ).rejects.toBeInstanceOf(DatabasePersistenceError);

    const other = new Error("bug");
    const failing = createClickLogRepository(
      createDouble([other]).database,
      options
    );
    await expect(failing.record([event])).rejects.toBe(other);
  });
});
