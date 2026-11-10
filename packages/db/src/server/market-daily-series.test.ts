import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { marketDailyPoints, marketDailySeries } from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  createMarketDailySeriesRepository,
  isMarketDailyDate,
  type MarketDailyPoint,
  type MarketDailySeriesInput,
  MarketDailySeriesInputError,
  validateMarketDailySeries,
} from "./market-daily-series.ts";
import { createRepositories } from "./repositories.ts";

const FIXED_NOW = new Date("2026-11-08T12:00:00.000Z");
const SHA = "b".repeat(64);
const dialect = new PgDialect();

interface Operation {
  kind: string;
  table?: unknown;
  values?: unknown;
  where?: SQL;
}

const createDouble = (outcomes: Array<readonly unknown[]>) => {
  const executed: SQL[] = [];
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      orderBy: () => chain,
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(
          operation.kind === "select" ? (outcomes.shift() ?? []) : []
        ).then(resolve),
      values: (values: unknown) => {
        operation.values = values;
        return chain;
      },
      where: (condition: SQL) => {
        operation.where = condition;
        return chain;
      },
    };
    operations.push(operation);
    return chain;
  };
  const executor = {
    delete: (table: unknown) => builder({ kind: "delete", table }),
    execute: async (query: SQL) => {
      executed.push(query);
      return [];
    },
    insert: (table: unknown) => builder({ kind: "insert", table }),
    select: () => builder({ kind: "select" }),
  };
  const database = {
    ...executor,
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      operations.push({ kind: "begin" });
      return await work(executor);
    },
  } as unknown as Database;
  return { database, executed, operations };
};

const series: MarketDailySeriesInput = {
  id: "EY_TNX_RATIO",
  kind: "derived",
  source: "  qc-ports fetch  ",
  sourceSha256: SHA,
};

const point = (
  date: string,
  overrides: Partial<MarketDailyPoint> = {}
): MarketDailyPoint => ({
  adjClose: 9.5,
  close: 10,
  date,
  high: 11,
  low: 9,
  open: 10.25,
  ...overrides,
});

const sqlQuery = (condition: SQL | undefined) =>
  condition === undefined
    ? { params: [], sql: "" }
    : dialect.sqlToQuery(condition);

describe("isMarketDailyDate", () => {
  it.each([
    ["2024-02-29", true],
    ["1990-01-02", true],
    ["2023-02-29", false],
    ["2024-13-01", false],
    ["0999-01-01", false],
    ["2024-1-01", false],
    ["2024-01-01T00:00", false],
  ])("%s -> %s", (value, expected) => {
    expect(isMarketDailyDate(value)).toBe(expected);
  });
});

describe("validateMarketDailySeries", () => {
  it("accepts ids with '_', '=', '^' and '.', and null optional columns", () => {
    for (const id of ["EY_TNX_RATIO", "ES=F", "^VIX", "BRK.B"]) {
      expect(() =>
        validateMarketDailySeries({ ...series, id }, [
          point("2024-01-02"),
          point("2024-01-03", {
            adjClose: null,
            high: null,
            low: null,
            open: null,
          }),
        ])
      ).not.toThrow();
    }
  });

  it.each([
    [{ id: "spy" }, "id must match"],
    [{ id: "SPY:TR" }, "id must match"],
    [{ id: "X".repeat(21) }, "id must match"],
    [{ kind: "crypto" }, "kind must be"],
    [{ source: "   " }, "source must be"],
    [{ source: "x".repeat(301) }, "source must be"],
    [{ sourceSha256: "A".repeat(64) }, "sourceSha256 must be"],
  ])("rejects %j", (overrides, message) => {
    expect(() =>
      validateMarketDailySeries(
        { ...series, ...overrides } as MarketDailySeriesInput,
        [point("2024-01-02")]
      )
    ).toThrow(message);
  });

  it("needs at least one point", () => {
    expect(() => validateMarketDailySeries(series, [])).toThrow(
      "at least 1 point needed"
    );
  });

  it.each([
    [[point("2024-01-03"), point("2024-01-02")]],
    [[point("2024-01-02"), point("2024-01-02")]],
    [[point("2024-02-30")]],
  ])("rejects unordered, repeated or invalid dates", (points) => {
    expect(() => validateMarketDailySeries(series, points)).toThrow(
      "date must be a YYYY-MM-DD date after the previous point"
    );
  });

  it.each([
    [{ close: Number.NaN }],
    [{ close: Number.POSITIVE_INFINITY }],
    [{ open: Number.NaN }],
    [{ high: Number.NEGATIVE_INFINITY }],
    [{ low: Number.POSITIVE_INFINITY }],
    [{ adjClose: Number.NaN }],
  ])("rejects non-finite values %j", (overrides) => {
    expect(() =>
      validateMarketDailySeries(series, [point("2024-01-02", overrides)])
    ).toThrow(MarketDailySeriesInputError);
  });

  it("accepts negative and zero closes (data.load_series keeps every finite close)", () => {
    expect(() =>
      validateMarketDailySeries(series, [
        point("2024-01-02", { close: -37.63 }),
        point("2024-01-03", { close: 0 }),
      ])
    ).not.toThrow();
  });
});

describe("createMarketDailySeriesRepository", () => {
  const stored = {
    firstDate: "2024-01-02",
    id: "EY_TNX_RATIO",
    importedAt: FIXED_NOW,
    kind: "derived",
    lastDate: "2024-01-03",
    pointCount: 2,
    source: "qc-ports fetch",
    sourceSha256: SHA,
  };

  it("lists series ordered by id", async () => {
    const { database, operations } = createDouble([[stored]]);
    await expect(
      createMarketDailySeriesRepository(database).listSeries()
    ).resolves.toEqual([stored]);
    expect(operations[0]?.table).toBe(marketDailySeries);
  });

  it("loads stored series as columns in request order with nulls kept", async () => {
    const { database, operations } = createDouble([
      [{ id: "SPY" }, { id: "VIX" }],
      [
        { seriesId: "SPY", ...point("2024-01-02") },
        { seriesId: "SPY", ...point("2024-01-03", { open: null }) },
        {
          seriesId: "VIX",
          ...point("2024-01-02", {
            adjClose: null,
            close: 13.2,
            high: null,
            low: null,
            open: null,
          }),
        },
      ],
    ]);
    const loaded = await createMarketDailySeriesRepository(database).loadSeries(
      ["VIX", "QQQ", "SPY", "VIX"],
      {
        from: "2024-01-02",
        to: "2024-01-31",
      }
    );
    expect([...loaded.keys()]).toEqual(["VIX", "SPY"]);
    expect(loaded.get("SPY")).toEqual({
      adjClose: [9.5, 9.5],
      close: [10, 10],
      dates: ["2024-01-02", "2024-01-03"],
      high: [11, 11],
      low: [9, 9],
      open: [10.25, null],
    });
    expect(loaded.get("VIX")).toEqual({
      adjClose: [null],
      close: [13.2],
      dates: ["2024-01-02"],
      high: [null],
      low: [null],
      open: [null],
    });
    expect(operations[0]?.table).toBe(marketDailySeries);
    expect(sqlQuery(operations[0]?.where).params).toEqual([
      "VIX",
      "QQQ",
      "SPY",
    ]);
    expect(operations[1]?.table).toBe(marketDailyPoints);
    const points = sqlQuery(operations[1]?.where);
    expect(points.sql).toContain('"market_daily_points"."date" >= $3');
    expect(points.sql).toContain('"market_daily_points"."date" <= $4');
    expect(points.params).toEqual(["VIX", "SPY", "2024-01-02", "2024-01-31"]);
  });

  it("keeps a stored series with no point in the range and skips absent bounds", async () => {
    const { database, operations } = createDouble([[{ id: "SPY" }], []]);
    const loaded = await createMarketDailySeriesRepository(database).loadSeries(
      ["SPY"]
    );
    expect(loaded.get("SPY")?.dates).toEqual([]);
    const points = sqlQuery(operations[1]?.where);
    expect(points.sql).not.toContain(">=");
    expect(points.sql).not.toContain("<=");
    expect(points.params).toEqual(["SPY"]);
  });

  it("reads nothing for no ids and only the catalog when no id is stored", async () => {
    const empty = createDouble([]);
    const repository = createMarketDailySeriesRepository(empty.database);
    await expect(repository.loadSeries([])).resolves.toEqual(new Map());
    expect(empty.operations).toEqual([]);
    const unknown = createDouble([[]]);
    await expect(
      createMarketDailySeriesRepository(unknown.database).loadSeries(["QQQ"], {
        to: "2024-01-31",
      })
    ).resolves.toEqual(new Map());
    expect(unknown.operations.map((operation) => operation.kind)).toEqual([
      "select",
    ]);
  });

  it("validates ids and range bounds before reading", async () => {
    const { database, operations } = createDouble([]);
    const repository = createMarketDailySeriesRepository(database);
    await expect(repository.loadSeries(["SPY", "spy; drop"])).rejects.toThrow(
      "id must match"
    );
    await expect(
      repository.loadSeries(["SPY"], { from: "2024-1-1" })
    ).rejects.toThrow("range bounds must be YYYY-MM-DD dates");
    await expect(
      repository.loadSeries(["SPY"], { to: "2024-02-30" })
    ).rejects.toThrow(MarketDailySeriesInputError);
    expect(operations).toEqual([]);
  });

  it("replaces a series inside one transaction in chunks", async () => {
    const { database, executed, operations } = createDouble([]);
    const start = Date.UTC(2000, 0, 1);
    const points = Array.from({ length: 5001 }, (_, index) =>
      point(new Date(start + index * 86_400_000).toISOString().slice(0, 10))
    );
    const result = await createMarketDailySeriesRepository(
      database,
      () => FIXED_NOW
    ).replaceSeries(series, points);
    expect(result).toEqual({
      ...stored,
      firstDate: "2000-01-01",
      lastDate: (points.at(-1) as MarketDailyPoint).date,
      pointCount: 5001,
    });
    expect(operations.map((operation) => operation.kind)).toEqual([
      "begin",
      "delete",
      "insert",
      "insert",
      "insert",
    ]);
    // The per-series lock comes first, with the namespaced key upsertPoints also takes.
    expect(executed.map((query) => sqlQuery(query))).toEqual([
      {
        params: ["EY_TNX_RATIO"],
        sql: "select pg_advisory_xact_lock(hashtextextended('market_daily_series:' || $1, 0))",
        typings: ["none"],
      },
    ]);
    expect(operations[1]?.table).toBe(marketDailySeries);
    expect(sqlQuery(operations[1]?.where).params).toEqual(["EY_TNX_RATIO"]);
    expect(operations[2]?.table).toBe(marketDailySeries);
    const [, , , firstChunk, secondChunk] = operations;
    expect(firstChunk?.table).toBe(marketDailyPoints);
    expect(firstChunk?.values).toHaveLength(5000);
    expect(secondChunk?.values).toEqual([
      { seriesId: "EY_TNX_RATIO", ...points.at(-1) },
    ]);
  });

  it("sends negative zero as a float8 literal and keeps nulls", async () => {
    const { database, operations } = createDouble([]);
    await createMarketDailySeriesRepository(database).replaceSeries(series, [
      point("2024-01-02", { adjClose: null, close: -0, open: -0 }),
    ]);
    const rows = (operations[3] as Operation).values as Record<
      string,
      unknown
    >[];
    expect(rows[0]?.["adjClose"]).toBeNull();
    expect(rows[0]?.["high"]).toBe(11);
    for (const key of ["close", "open"]) {
      expect(dialect.sqlToQuery(rows[0]?.[key] as SQL).sql).toBe(
        "'-0'::float8"
      );
    }
  });

  it("validates before writing", async () => {
    const { database, operations } = createDouble([]);
    await expect(
      createMarketDailySeriesRepository(database).replaceSeries(series, [])
    ).rejects.toBeInstanceOf(MarketDailySeriesInputError);
    expect(operations).toEqual([]);
  });

  it("uses the current time by default and is part of createRepositories", async () => {
    const { database } = createDouble([]);
    const before = Date.now();
    const result = await createRepositories(
      database
    ).marketDailySeries?.replaceSeries(series, [point("2024-01-02")]);
    expect(result?.importedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("market daily tables", () => {
  it("declare keys, checks and the cascading series reference", () => {
    const seriesTable = getTableConfig(marketDailySeries);
    const pointsTable = getTableConfig(marketDailyPoints);
    expect(seriesTable.checks.map((entry) => entry.name)).toEqual([
      "market_daily_series_text_check",
      "market_daily_series_range_check",
    ]);
    expect(
      pointsTable.primaryKeys[0]?.columns.map((column) => column.name)
    ).toEqual(["series_id", "date"]);
    expect(pointsTable.checks.map((entry) => entry.name)).toEqual([
      "market_daily_points_finite_check",
    ]);
    const [reference] = pointsTable.foreignKeys;
    expect(reference?.onDelete).toBe("cascade");
    expect(reference?.reference().foreignColumns[0]?.name).toBe("id");
  });
});

describe("0060_market_daily_series migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0060_market_daily_series.sql");
  const rollback = read("../../rollback/0060_market_daily_series.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: Array<{ idx: number; tag: string }>;
  };

  it("creates both tables with their checks and is journaled at index 60", () => {
    expect(migration).toContain('CREATE TABLE "market_daily_series"');
    expect(migration).toContain('CREATE TABLE "market_daily_points"');
    expect(migration).toContain("'^[A-Z0-9._^=-]{1,20}$'");
    expect(migration).toContain("in ('etf', 'future', 'index', 'derived')");
    expect(migration).toContain("< 'Infinity'::float8");
    expect(migration).toContain("ON DELETE cascade");
    expect(journal.entries[60]).toMatchObject({
      idx: 60,
      tag: "0060_market_daily_series",
    });
  });

  it("rollback refuses while rows exist and never cascades", () => {
    expect(rollback).toContain(
      "market daily series tables are not empty; refusing rollback"
    );
    expect(rollback).toContain('DROP TABLE "public"."market_daily_points"');
    expect(rollback).toContain('DROP TABLE "public"."market_daily_series"');
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DELETE/i);
  });
});
