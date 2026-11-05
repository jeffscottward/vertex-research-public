import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { type BacktestRunSpec, backtestRuns } from "../schema/index.ts";
import {
  BACKTEST_RUN_CLAIM_ATTEMPTS,
  BACKTEST_RUN_ERROR_MAX_LENGTH,
  boundBacktestRunError,
  createBacktestRunsRepository,
} from "./backtest-runs.ts";
import type { Database } from "./client.ts";
import { createRepositories } from "./repositories.ts";

const FIXED_NOW = new Date("2026-10-23T12:00:00.000Z");
const dialect = new PgDialect();

interface Operation {
  kind: string;
  table?: unknown;
  values?: unknown;
  set?: unknown;
  where?: SQL | undefined;
  limit?: number;
  columns?: unknown;
}

const createDouble = (outcomes: Array<readonly unknown[]>) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      where: (condition: SQL | undefined) => {
        operation.where = condition;
        return chain;
      },
      orderBy: () => chain,
      limit: (count: number) => {
        operation.limit = count;
        return chain;
      },
      values: (values: unknown) => {
        operation.values = values;
        return chain;
      },
      set: (values: unknown) => {
        operation.set = values;
        return chain;
      },
      returning: () => chain,
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(outcomes.shift() ?? []).then(resolve),
    };
    operations.push(operation);
    return chain;
  };
  const database = {
    select: (columns?: unknown) => builder({ kind: "select", columns }),
    insert: (table: unknown) => builder({ kind: "insert", table }),
    update: (table: unknown) => builder({ kind: "update", table }),
  } as unknown as Database;
  return { database, operations };
};

const sqlText = (condition: SQL | undefined) =>
  condition === undefined ? "" : dialect.sqlToQuery(condition).sql;

const spec: BacktestRunSpec = {
  symbol: "SPY",
  timeframe: "1d",
  from: "2020-01-01",
  to: "2024-12-31",
  rule: { kind: "smaCross", fast: 10, slow: 50 },
  stopLossPct: 0,
  takeProfitPct: 0,
  costBps: 5,
  initialCapital: 10_000,
};

const dependencies = { now: () => FIXED_NOW, generateId: () => "run-1" };

describe("boundBacktestRunError", () => {
  it("trims, defaults and bounds the message", () => {
    expect(boundBacktestRunError("  boom  ")).toBe("boom");
    expect(boundBacktestRunError("   ")).toBe("Backtest failed");
    expect(boundBacktestRunError("x".repeat(900))).toHaveLength(
      BACKTEST_RUN_ERROR_MAX_LENGTH
    );
  });
});

describe("createBacktestRunsRepository", () => {
  it("creates a queued run with the spec and revision", async () => {
    const { database, operations } = createDouble([[{ id: "run-1" }]]);
    const created = await createBacktestRunsRepository(
      database,
      dependencies
    ).create({
      strategyId: null,
      strategyRevision: null,
      strategySnapshot: null,
      spec,
      engineVersion: "instant-1",
      requestedBy: "user-1",
    });
    expect(created).toEqual({ id: "run-1" });
    expect(operations[0]?.values).toEqual({
      id: "run-1",
      status: "queued",
      strategyId: null,
      strategyRevision: null,
      strategySnapshot: null,
      spec,
      engineVersion: "instant-1",
      requestedBy: "user-1",
      createdAt: FIXED_NOW,
    });
  });

  it("reads one run or null", async () => {
    const { database, operations } = createDouble([[{ id: "run-1" }], []]);
    const repository = createBacktestRunsRepository(database, dependencies);
    await expect(repository.get("run-1")).resolves.toEqual({ id: "run-1" });
    await expect(repository.get("missing")).resolves.toBeNull();
    expect(operations[0]?.limit).toBe(1);
  });

  it("lists newest first with an optional strategy filter and a bounded limit", async () => {
    const { database, operations } = createDouble([[], [], []]);
    const repository = createBacktestRunsRepository(database, dependencies);
    await repository.list({ limit: 500 });
    await repository.list({ strategyId: "s-1", limit: 0 });
    expect(operations[0]?.limit).toBe(100);
    expect(operations[0]?.where).toBeUndefined();
    expect(operations[1]?.limit).toBe(1);
    expect(sqlText(operations[1]?.where)).toContain(
      '"backtest_runs"."strategy_id"'
    );
    expect(Object.keys(operations[0]?.columns as object)).not.toContain(
      "report"
    );
  });

  it("claims only queued runs", async () => {
    const { database, operations } = createDouble([[{ id: "run-1" }], []]);
    const repository = createBacktestRunsRepository(database, dependencies);
    await expect(repository.claim("run-1")).resolves.toEqual({ id: "run-1" });
    await expect(repository.claim("run-1")).resolves.toBeNull();
    expect(operations[0]?.set).toEqual({
      status: "running",
      startedAt: FIXED_NOW,
    });
    expect(sqlText(operations[0]?.where)).toContain('"backtest_runs"."status"');
  });

  it("completes only running runs and never touches the spec", async () => {
    const { database, operations } = createDouble([[{ id: "run-1" }], []]);
    const repository = createBacktestRunsRepository(database, dependencies);
    await expect(repository.complete("run-1", { a: 1 })).resolves.toEqual({
      id: "run-1",
    });
    await expect(repository.complete("run-1", { a: 1 })).resolves.toBeNull();
    expect(operations[0]?.set).toEqual({
      status: "succeeded",
      report: { a: 1 },
      finishedAt: FIXED_NOW,
    });
  });

  it("fails only non-terminal runs with a bounded error", async () => {
    const { database, operations } = createDouble([[{ id: "run-1" }], []]);
    const repository = createBacktestRunsRepository(database, dependencies);
    await expect(repository.fail("run-1", " no bars ")).resolves.toEqual({
      id: "run-1",
    });
    await expect(repository.fail("run-1", "again")).resolves.toBeNull();
    expect(operations[0]?.set).toEqual({
      status: "failed",
      error: "no bars",
      finishedAt: FIXED_NOW,
    });
    expect(sqlText(operations[0]?.where)).toContain(" in (");
  });

  it("fails one stale running run", async () => {
    const { database, operations } = createDouble([[{ id: "a" }], []]);
    const repository = createBacktestRunsRepository(database, dependencies);
    await expect(
      repository.failIfStale("a", FIXED_NOW, "stopped")
    ).resolves.toBe(true);
    await expect(
      repository.failIfStale("b", FIXED_NOW, "stopped")
    ).resolves.toBe(false);
    const where = sqlText(operations[0]?.where);
    expect(where).toContain('"backtest_runs"."started_at"');
    expect(where).toContain('"backtest_runs"."id"');
  });

  it("claims the oldest queued run of one engine version with a conditional update", async () => {
    const { database, operations } = createDouble([
      [{ id: "run-1" }],
      [{ id: "run-1", status: "running" }],
    ]);
    const repository = createBacktestRunsRepository(database, dependencies);
    await expect(repository.claimNext("nautilus-x")).resolves.toEqual({
      id: "run-1",
      status: "running",
    });
    const select = sqlText(operations[0]?.where);
    expect(select).toContain('"backtest_runs"."status"');
    expect(select).toContain('"backtest_runs"."engine_version"');
    expect(operations[0]?.limit).toBe(1);
    expect(operations[1]?.set).toEqual({
      startedAt: FIXED_NOW,
      status: "running",
    });
    const update = sqlText(operations[1]?.where);
    expect(update).toContain('"backtest_runs"."id"');
    expect(update).toContain('"backtest_runs"."status"');
    expect(update).toContain('"backtest_runs"."engine_version"');
  });

  it("tries the next candidate when another worker wins, and stops when none is queued", async () => {
    const lost = createDouble([
      [{ id: "a" }],
      [],
      [{ id: "b" }],
      [{ id: "b" }],
    ]);
    await expect(
      createBacktestRunsRepository(lost.database, dependencies).claimNext("e")
    ).resolves.toEqual({ id: "b" });
    const empty = createDouble([[]]);
    await expect(
      createBacktestRunsRepository(empty.database, dependencies).claimNext("e")
    ).resolves.toBeNull();
    expect(empty.operations).toHaveLength(1);
    const busy = createDouble(
      Array.from({ length: BACKTEST_RUN_CLAIM_ATTEMPTS }, () => [
        [{ id: "a" }],
        [],
      ]).flat()
    );
    await expect(
      createBacktestRunsRepository(busy.database, dependencies).claimNext("e")
    ).resolves.toBeNull();
    expect(busy.operations).toHaveLength(2 * BACKTEST_RUN_CLAIM_ATTEMPTS);
  });

  it("fails one run still queued after the limit", async () => {
    const { database, operations } = createDouble([[{ id: "a" }], []]);
    const repository = createBacktestRunsRepository(database, dependencies);
    await expect(
      repository.failIfUnclaimed("a", FIXED_NOW, " not picked up ")
    ).resolves.toBe(true);
    await expect(
      repository.failIfUnclaimed("b", FIXED_NOW, "not picked up")
    ).resolves.toBe(false);
    expect(operations[0]?.set).toEqual({
      error: "not picked up",
      finishedAt: FIXED_NOW,
      status: "failed",
    });
    const where = sqlText(operations[0]?.where);
    expect(where).toContain('"backtest_runs"."created_at"');
    expect(where).toContain('"backtest_runs"."status"');
  });

  it("is part of createRepositories", () => {
    const { database } = createDouble([]);
    expect(createRepositories(database).backtestRuns).toBeDefined();
  });
});

describe("backtest_runs table", () => {
  it("declares indexes, checks and a set-null strategy reference", () => {
    const table = getTableConfig(backtestRuns);
    expect(table.indexes.map((entry) => entry.config.name)).toEqual([
      "backtest_runs_created_idx",
      "backtest_runs_strategy_idx",
    ]);
    expect(table.checks.map((entry) => entry.name)).toEqual([
      "backtest_runs_status_check",
      "backtest_runs_revision_check",
      "backtest_runs_outcome_check",
    ]);
    expect(table.foreignKeys[0]?.onDelete).toBe("set null");
  });
});

describe("0026_backtest_runs migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0026_backtest_runs.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0026_backtest_runs.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: Array<{ idx: number; tag: string }> };

  it("creates the table with its checks and is journaled at index 26", () => {
    expect(migration).toContain('CREATE TABLE "backtest_runs"');
    expect(migration).toContain("backtest_runs_outcome_check");
    expect(journal.entries[26]).toMatchObject({
      idx: 26,
      tag: "0026_backtest_runs",
    });
  });

  it("rollback refuses while rows exist and never cascades", () => {
    expect(rollback).toContain("backtest_runs is not empty; refusing rollback");
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
  });
});
