import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  type SectorRotationPointRow,
  sectorRotationAlerts,
  sectorRotationPoints,
} from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  createSectorRotationRepository,
  SECTOR_ROTATION_UPSERT_BATCH,
  type SectorRotationPointRecord,
} from "./sector-rotation.ts";

const NOW = new Date("2026-11-02T21:50:00.000Z");
const COMPUTED = new Date("2026-11-02T21:45:00.000Z");
const dialect = new PgDialect();

interface Operation {
  conflict?: "nothing" | Record<string, unknown>;
  kind: "select" | "insert" | "update";
  orderBy?: unknown[];
  returning?: unknown;
  set?: Record<string, unknown>;
  table?: unknown;
  values?: unknown;
  where?: SQL;
}

// Chainable query double: records each operation and resolves the queued rows.
const createDouble = (outcomes: Array<readonly Record<string, unknown>[]>) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    operations.push(operation);
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      onConflictDoNothing: () => {
        operation.conflict = "nothing";
        return chain;
      },
      onConflictDoUpdate: (config: Record<string, unknown>) => {
        operation.conflict = config;
        return chain;
      },
      orderBy: (...order: unknown[]) => {
        operation.orderBy = order;
        return chain;
      },
      returning: (columns: unknown) => {
        operation.returning = columns;
        return chain;
      },
      set: (values: Record<string, unknown>) => {
        operation.set = values;
        return chain;
      },
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(outcomes.shift() ?? []).then(resolve),
      values: (values: unknown) => {
        operation.values = values;
        return chain;
      },
      where: (condition: SQL) => {
        operation.where = condition;
        return chain;
      },
    };
    return chain;
  };
  const database = {
    insert: (table: unknown) => builder({ kind: "insert", table }),
    select: () => builder({ kind: "select" }),
    update: (table: unknown) => builder({ kind: "update", table }),
  } as unknown as Database;
  return { database, operations };
};

const whereOf = (operation: Operation | undefined) => {
  if (operation?.where === undefined) throw new Error("no where clause");
  return dialect.sqlToQuery(operation.where);
};

const point = (
  overrides: Partial<SectorRotationPointRecord> = {}
): SectorRotationPointRecord => ({
  benchmark: "SPY",
  computedAt: COMPUTED,
  date: "2026-11-02",
  momentum: 100.4,
  quadrant: "leading",
  ratio: 101.2,
  symbol: "XLK",
  timeframe: "daily",
  ...overrides,
});

const row = (
  overrides: Partial<SectorRotationPointRow> = {}
): SectorRotationPointRow => ({ ...point(), ...overrides });

describe("createSectorRotationRepository", () => {
  it("upserts points in batches with an update on the primary key", async () => {
    const double = createDouble([]);
    const repository = createSectorRotationRepository(double.database);
    const points = Array.from(
      { length: SECTOR_ROTATION_UPSERT_BATCH + 2 },
      (_, index) => point({ date: `2026-01-${String((index % 28) + 1)}` })
    );
    await expect(repository.upsertPoints(points)).resolves.toBe(points.length);
    expect(double.operations).toHaveLength(2);
    const [first, second] = double.operations;
    expect(first?.table).toBe(sectorRotationPoints);
    expect(first?.values).toHaveLength(SECTOR_ROTATION_UPSERT_BATCH);
    expect(second?.values).toEqual([
      {
        benchmark: "SPY",
        computedAt: COMPUTED,
        date: points.at(-2)?.date,
        momentum: 100.4,
        quadrant: "leading",
        ratio: 101.2,
        symbol: "XLK",
        timeframe: "daily",
      },
      expect.objectContaining({ date: points.at(-1)?.date }),
    ]);
    const conflict = first?.conflict as {
      target: unknown[];
      set: Record<string, SQL>;
    };
    expect(conflict.target).toEqual([
      sectorRotationPoints.timeframe,
      sectorRotationPoints.symbol,
      sectorRotationPoints.date,
    ]);
    expect(Object.keys(conflict.set).sort()).toEqual([
      "benchmark",
      "computedAt",
      "momentum",
      "quadrant",
      "ratio",
    ]);
    expect(dialect.sqlToQuery(conflict.set["computedAt"] as SQL).sql).toBe(
      "excluded.computed_at"
    );
  });

  it("writes nothing for an empty upsert", async () => {
    const double = createDouble([]);
    const repository = createSectorRotationRepository(double.database);
    await expect(repository.upsertPoints([])).resolves.toBe(0);
    expect(double.operations).toHaveLength(0);
  });

  it("lists points by timeframe and date range, optionally by symbol, sorted", async () => {
    const double = createDouble([
      [row(), row({ date: "2026-11-03", symbol: "XLV" })],
      [row({ timeframe: "weekly" })],
    ]);
    const repository = createSectorRotationRepository(double.database);
    await expect(
      repository.listPoints({
        fromDate: "2025-11-01",
        symbols: ["XLK", "XLV"],
        timeframe: "daily",
        toDate: "2026-11-02",
      })
    ).resolves.toEqual([point(), point({ date: "2026-11-03", symbol: "XLV" })]);
    const bounded = whereOf(double.operations[0]);
    expect(bounded.sql).toContain('"sector_rotation_points"."date" <= $3');
    expect(bounded.params).toEqual([
      "daily",
      "2025-11-01",
      "2026-11-02",
      "XLK",
      "XLV",
    ]);
    expect(double.operations[0]?.orderBy).toHaveLength(2);
    await expect(
      repository.listPoints({ fromDate: "2025-11-01", timeframe: "weekly" })
    ).resolves.toEqual([point({ timeframe: "weekly" })]);
    const open = whereOf(double.operations[1]);
    expect(open.sql).not.toContain("<=");
    expect(open.params).toEqual(["weekly", "2025-11-01"]);
  });

  it("returns no points for an empty symbol list without a query", async () => {
    const double = createDouble([]);
    const repository = createSectorRotationRepository(double.database);
    await expect(
      repository.listPoints({
        fromDate: "2025-11-01",
        symbols: [],
        timeframe: "daily",
      })
    ).resolves.toEqual([]);
    expect(double.operations).toHaveLength(0);
  });

  it("records an alert once and reports whether this call created it", async () => {
    const double = createDouble([[{ symbol: "XLK" }], []]);
    const repository = createSectorRotationRepository(double.database);
    const input = {
      createdAt: NOW,
      enteredOn: "2026-11-02",
      line: "Sector rotation: XLK (Technology) entered Leading on 2026-11-02.",
      quadrant: "leading" as const,
      symbol: "XLK",
    };
    await expect(repository.recordAlert(input)).resolves.toBe(true);
    await expect(repository.recordAlert(input)).resolves.toBe(false);
    expect(double.operations[0]).toMatchObject({
      conflict: "nothing",
      kind: "insert",
      table: sectorRotationAlerts,
      values: {
        createdAt: NOW,
        delivery: "pending",
        enteredOn: "2026-11-02",
        quadrant: "leading",
        symbol: "XLK",
        updatedAt: NOW,
      },
    });
  });

  it("settles a delivery by the alert key with the injected or real clock", async () => {
    const double = createDouble([]);
    await createSectorRotationRepository(double.database, {
      now: () => NOW,
    }).recordDelivery({
      delivery: "sent",
      enteredOn: "2026-11-02",
      quadrant: "lagging",
      symbol: "XLE",
    });
    expect(double.operations[0]).toMatchObject({
      kind: "update",
      set: { delivery: "sent", updatedAt: NOW },
      table: sectorRotationAlerts,
    });
    expect(whereOf(double.operations[0]).params).toEqual([
      "XLE",
      "lagging",
      "2026-11-02",
    ]);
    await createSectorRotationRepository(double.database).recordDelivery({
      delivery: "failed",
      enteredOn: "2026-11-02",
      quadrant: "lagging",
      symbol: "XLE",
    });
    expect(double.operations[1]?.set?.["updatedAt"]).toBeInstanceOf(Date);
  });
});

describe("recordChatDelivery", () => {
  it("updates only an undelivered row by the alert key and reports whether it changed", async () => {
    const double = createDouble([[{ symbol: "XLK" }], []]);
    const repository = createSectorRotationRepository(double.database, {
      now: () => NOW,
    });
    const key = {
      enteredOn: "2026-11-02",
      quadrant: "leading" as const,
      symbol: "XLK",
    };
    await expect(
      repository.recordChatDelivery({ ...key, delivery: "sent" })
    ).resolves.toBe(true);
    await expect(
      repository.recordChatDelivery({ ...key, delivery: "failed" })
    ).resolves.toBe(false);
    expect(double.operations[0]).toMatchObject({
      kind: "update",
      set: { delivery: "sent", updatedAt: NOW },
      table: sectorRotationAlerts,
    });
    expect(double.operations[0]?.returning).toBeDefined();
    expect(whereOf(double.operations[0]).params).toEqual([
      "XLK",
      "leading",
      "2026-11-02",
      "not-configured",
      "failed",
    ]);
    expect(double.operations.some((op) => op.kind === "insert")).toBe(false);
  });
});

describe("0047_sector_rotation migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0047_sector_rotation.sql");
  const rollback = read("../../rollback/0047_sector_rotation.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: Array<{ idx: number; tag: string }>;
  };

  it("creates both tables with their keys and checks", () => {
    expect(migration).toContain('CREATE TABLE "sector_rotation_points"');
    expect(migration).toContain('CREATE TABLE "sector_rotation_alerts"');
    expect(migration).toContain('PRIMARY KEY("timeframe","symbol","date")');
    expect(migration).toContain(
      'PRIMARY KEY("symbol","quadrant","entered_on")'
    );
    expect(migration).toContain("sector_rotation_points_values_check");
    expect(migration).toContain("sector_rotation_alerts_fields_check");
    expect(
      journal.entries.find((entry) => entry.tag === "0047_sector_rotation")
    ).toMatchObject({ idx: 47 });
  });

  it("grants the app role the repository privileges only when the role exists", () => {
    expect(migration).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN"
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "sector_rotation_points" TO "vertex_research";'
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "sector_rotation_alerts" TO "vertex_research";'
    );
  });

  it("rollback refuses while alerts exist and never cascades", () => {
    expect(rollback).toContain(
      "sector_rotation_alerts is not empty; refusing rollback"
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
  });
});
