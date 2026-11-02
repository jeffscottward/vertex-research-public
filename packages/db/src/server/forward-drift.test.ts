import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  type ForwardDriftThresholds,
  forwardDriftAlerts,
  forwardDriftMonitors,
} from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  boundDriftMessage,
  createForwardDriftRepository,
  FORWARD_DRIFT_MESSAGE_MAX_LENGTH,
} from "./forward-drift.ts";
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
  let transactions = 0;
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
    transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      transactions += 1;
      return work(database);
    },
  } as unknown as Database;
  return { database, operations, transactions: () => transactions };
};

const sqlText = (condition: SQL | undefined) =>
  condition === undefined ? "" : dialect.sqlToQuery(condition).sql;

let ids = 0;
const dependencies = {
  now: () => FIXED_NOW,
  generateId: () => {
    ids += 1;
    return `id-${ids}`;
  },
};

const thresholds: ForwardDriftThresholds = {
  drawdown: { alert: 1.5, warn: 1 },
  losingStreak: { alert: 1.5, warn: 1.25 },
  profitFactor: { alert: 0.5, warn: 0.75 },
  sharpe: { alert: 0, warn: 0.5 },
  winRate: { alert: 0.6, warn: 0.8 },
};

describe("boundDriftMessage", () => {
  it("bounds the alert text", () => {
    expect(boundDriftMessage("x".repeat(900))).toHaveLength(
      FORWARD_DRIFT_MESSAGE_MAX_LENGTH
    );
    expect(boundDriftMessage("short")).toBe("short");
  });
});

describe("createForwardDriftRepository", () => {
  it("creates an empty monitor pinned to the baseline", async () => {
    ids = 0;
    const { database, operations } = createDouble([[{ id: "id-1" }]]);
    const created = await createForwardDriftRepository(
      database,
      dependencies
    ).create({
      baselineRunId: "run-1",
      createdBy: "user-1",
      label: "SPY paper",
      strategyRevision: null,
      thresholds,
    });
    expect(created).toEqual({ id: "id-1" });
    expect(operations[0]?.values).toEqual({
      baselineRunId: "run-1",
      createdAt: FIXED_NOW,
      createdBy: "user-1",
      id: "id-1",
      label: "SPY paper",
      strategyRevision: null,
      thresholds,
      updatedAt: FIXED_NOW,
    });
  });

  it("reads one monitor or null", async () => {
    const { database, operations } = createDouble([[{ id: "m" }], []]);
    const repository = createForwardDriftRepository(database, dependencies);
    await expect(repository.get("m")).resolves.toEqual({ id: "m" });
    await expect(repository.get("missing")).resolves.toBeNull();
    expect(operations[0]?.limit).toBe(1);
  });

  it("lists summaries with point and trade counts and a bounded limit", async () => {
    const { database, operations } = createDouble([[], []]);
    const repository = createForwardDriftRepository(database, dependencies);
    await repository.list(500);
    await repository.list(0);
    expect(operations[0]?.limit).toBe(100);
    expect(operations[1]?.limit).toBe(1);
    const columns = Object.keys(operations[0]?.columns as object);
    expect(columns).toContain("pointCount");
    expect(columns).not.toContain("points");
  });

  it("saves an evaluation with its alerts in one transaction under the version lock", async () => {
    ids = 0;
    const { database, operations, transactions } = createDouble([
      [{ id: "m", version: 4 }],
      [{ id: "id-1" }],
    ]);
    const saved = await createForwardDriftRepository(
      database,
      dependencies
    ).saveEvaluation({
      alerts: [
        {
          baselineValue: 0.1,
          check: "drawdown",
          forwardValue: 0.15,
          level: "alert",
          message: "m".repeat(600),
          ratio: 1.5,
        },
      ],
      expectedVersion: 3,
      id: "m",
      level: "alert",
      levels: { drawdown: "alert" },
      points: [{ equity: 100, t: 0 }],
      trades: [],
    });
    expect(transactions()).toBe(1);
    expect(saved).toEqual({
      alerts: [{ id: "id-1" }],
      monitor: { id: "m", version: 4 },
    });
    expect(operations[0]?.set).toMatchObject({
      level: "alert",
      updatedAt: FIXED_NOW,
      version: 4,
    });
    expect(sqlText(operations[0]?.where)).toContain(
      '"forward_drift_monitors"."version"'
    );
    expect(operations[1]?.values).toEqual([
      expect.objectContaining({
        createdAt: FIXED_NOW,
        id: "id-1",
        message: "m".repeat(FORWARD_DRIFT_MESSAGE_MAX_LENGTH),
        monitorId: "m",
      }),
    ]);
  });

  it("returns null on a version conflict and inserts no alert", async () => {
    const { database, operations } = createDouble([[]]);
    const saved = await createForwardDriftRepository(
      database,
      dependencies
    ).saveEvaluation({
      alerts: [
        {
          baselineValue: null,
          check: "sharpe",
          forwardValue: null,
          level: "warn",
          message: "x",
          ratio: null,
        },
      ],
      expectedVersion: 0,
      id: "m",
      level: "warn",
      levels: {},
      points: [],
      trades: [],
    });
    expect(saved).toBeNull();
    expect(operations).toHaveLength(1);
  });

  it("skips the alert insert when nothing was raised", async () => {
    const { database, operations } = createDouble([[{ id: "m" }]]);
    const saved = await createForwardDriftRepository(
      database,
      dependencies
    ).saveEvaluation({
      alerts: [],
      expectedVersion: 0,
      id: "m",
      level: "ok",
      levels: {},
      points: [],
      trades: [],
    });
    expect(saved).toEqual({ alerts: [], monitor: { id: "m" } });
    expect(operations).toHaveLength(1);
  });

  it("lists alerts, optionally only open ones of one monitor", async () => {
    const { database, operations } = createDouble([[], []]);
    const repository = createForwardDriftRepository(database, dependencies);
    await repository.listAlerts({ limit: 999, openOnly: false });
    await repository.listAlerts({ limit: 5, monitorId: "m", openOnly: true });
    expect(operations[0]?.limit).toBe(200);
    expect(sqlText(operations[0]?.where)).toBe("");
    const where = sqlText(operations[1]?.where);
    expect(where).toContain('"forward_drift_alerts"."monitor_id"');
    expect(where).toContain('"forward_drift_alerts"."acknowledged_at" is null');
  });

  it("acknowledges an open alert once", async () => {
    const { database, operations } = createDouble([[{ id: "a" }], []]);
    const repository = createForwardDriftRepository(database, dependencies);
    await expect(repository.acknowledgeAlert("a", "user-1")).resolves.toEqual({
      id: "a",
    });
    await expect(
      repository.acknowledgeAlert("a", "user-1")
    ).resolves.toBeNull();
    expect(operations[0]?.set).toEqual({
      acknowledgedAt: FIXED_NOW,
      acknowledgedBy: "user-1",
    });
    expect(sqlText(operations[0]?.where)).toContain("is null");
  });

  it("starts and stops the paper runner without changing the version", async () => {
    const { database, operations } = createDouble([[{ id: "m" }], []]);
    const repository = createForwardDriftRepository(database, dependencies);
    await expect(repository.setPaperStatus("m", "running")).resolves.toEqual({
      id: "m",
    });
    await expect(repository.setPaperStatus("x", "off")).resolves.toBeNull();
    expect(operations[0]?.set).toEqual({
      paperStatus: "running",
      updatedAt: FIXED_NOW,
    });
  });

  it("notes a paper tick with a bounded note", async () => {
    const { database, operations } = createDouble([[], []]);
    const repository = createForwardDriftRepository(database, dependencies);
    await repository.notePaperTick("m", "n".repeat(900));
    await repository.notePaperTick("m", null);
    expect(operations[0]?.set).toEqual({
      paperNote: "n".repeat(FORWARD_DRIFT_MESSAGE_MAX_LENGTH),
      paperTickedAt: FIXED_NOW,
    });
    expect(operations[1]?.set).toEqual({
      paperNote: null,
      paperTickedAt: FIXED_NOW,
    });
  });

  it("lists running paper runner ids with a bounded limit", async () => {
    const { database, operations } = createDouble([[{ id: "a" }, { id: "b" }]]);
    const repository = createForwardDriftRepository(database, dependencies);
    await expect(repository.listRunningPaper(1000)).resolves.toEqual([
      "a",
      "b",
    ]);
    expect(operations[0]?.limit).toBe(100);
    expect(sqlText(operations[0]?.where)).toContain(
      '"forward_drift_monitors"."paper_status"'
    );
  });

  it("is part of createRepositories", () => {
    const { database } = createDouble([]);
    expect(createRepositories(database).forwardDrift).toBeDefined();
  });
});

describe("forward drift tables", () => {
  it("declares indexes, checks and references", () => {
    const monitors = getTableConfig(forwardDriftMonitors);
    expect(monitors.checks.map((entry) => entry.name)).toEqual([
      "forward_drift_monitors_label_check",
      "forward_drift_monitors_revision_check",
      "forward_drift_monitors_level_check",
      "forward_drift_monitors_version_check",
      "forward_drift_monitors_paper_status_check",
      "forward_drift_monitors_paper_note_check",
    ]);
    expect(monitors.foreignKeys[0]?.onDelete).toBe("restrict");
    const alerts = getTableConfig(forwardDriftAlerts);
    expect(alerts.indexes.map((entry) => entry.config.name)).toEqual([
      "forward_drift_alerts_created_idx",
      "forward_drift_alerts_monitor_idx",
    ]);
    expect(alerts.foreignKeys[0]?.onDelete).toBe("cascade");
  });
});

describe("0027_forward_drift migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0027_forward_drift.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0027_forward_drift.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: Array<{ idx: number; tag: string }> };

  it("creates both tables and is journaled before the paper runner columns", () => {
    expect(migration).toContain('CREATE TABLE "forward_drift_monitors"');
    expect(migration).toContain('CREATE TABLE "forward_drift_alerts"');
    expect(
      journal.entries.find(
        (entry: { tag: string }) => entry.tag === "0027_forward_drift"
      )
    ).toMatchObject({
      idx: 27,
      tag: "0027_forward_drift",
    });
  });

  it("rollback refuses while monitors exist and never cascades", () => {
    expect(rollback).toContain(
      "forward_drift_monitors is not empty; refusing rollback"
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
  });
});

describe("0028_paper_forward_runner migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0028_paper_forward_runner.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL(
      "../../rollback/0028_paper_forward_runner.down.sql",
      import.meta.url
    ),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: Array<{ idx: number; tag: string }> };

  it("adds the runner columns with an off default and is journaled before 0029", () => {
    expect(migration).toContain(
      `ADD COLUMN "paper_status" text DEFAULT 'off' NOT NULL`
    );
    expect(migration).toContain('ADD COLUMN "paper_ticked_at"');
    expect(migration).not.toMatch(/DROP|DELETE/i);
    expect(
      journal.entries.find(
        (entry: { tag: string }) => entry.tag === "0028_paper_forward_runner"
      )
    ).toMatchObject({
      idx: 28,
      tag: "0028_paper_forward_runner",
    });
  });

  it("rollback refuses while a runner is running and keeps the paper series", () => {
    expect(rollback).toContain("a paper runner is running");
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DROP TABLE/i);
  });
});
