import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { marketBarSeries, marketBars } from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  createMarketBarsRepository,
  type MarketBarRow,
  type MarketBarSeriesInput,
  MarketBarsInputError,
  marketBarSeriesId,
  toMarketBarColumns,
  validateMarketBars,
} from "./market-bars.ts";
import { createRepositories } from "./repositories.ts";

const FIXED_NOW = new Date("2026-10-18T12:00:00.000Z");
const SHA = "a".repeat(64);
const dialect = new PgDialect();

interface Operation {
  kind: string;
  limit?: number;
  table?: unknown;
  values?: unknown;
  where?: SQL;
}

const createDouble = (outcomes: Array<readonly unknown[] | Error>) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      limit: (count: number) => {
        operation.limit = count;
        return chain;
      },
      orderBy: () => chain,
      returning: () => chain,
      set: (values: unknown) => {
        operation.values = values;
        return chain;
      },
      then: (
        resolve: (rows: unknown) => unknown,
        reject: (error: unknown) => unknown
      ) => {
        const outcome =
          operation.kind === "select" || operation.kind === "update"
            ? outcomes.shift()
            : [];
        return (
          outcome instanceof Error
            ? Promise.reject(outcome)
            : Promise.resolve(outcome ?? [])
        ).then(resolve, reject);
      },
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
      operations.push({ kind: "lock", where: query });
    },
    insert: (table: unknown) => builder({ kind: "insert", table }),
    select: () => builder({ kind: "select" }),
    update: (table: unknown) => builder({ kind: "update", table }),
  };
  const database = {
    ...executor,
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      operations.push({ kind: "begin" });
      return await work(executor);
    },
  } as unknown as Database;
  return { database, operations };
};

const series: MarketBarSeriesInput = {
  source: "  Test source  ",
  sourceSha256: SHA,
  symbol: "SPY",
  timeframe: "1d",
};

const bar = (
  t: number,
  overrides: Partial<MarketBarRow> = {}
): MarketBarRow => ({
  c: 10.5,
  h: 11,
  l: 9,
  o: 10,
  t,
  v: 100,
  ...overrides,
});

const sqlText = (condition: SQL | undefined) =>
  condition === undefined ? "" : dialect.sqlToQuery(condition).sql;

describe("validateMarketBars", () => {
  it("accepts ordered positive bars with null or positive volume", () => {
    expect(() =>
      validateMarketBars(series, [bar(1), bar(2, { v: null })])
    ).not.toThrow();
  });

  it("accepts Yahoo continuous futures symbols such as ES=F", () => {
    expect(() =>
      validateMarketBars({ ...series, symbol: "ES=F" }, [bar(1), bar(2)])
    ).not.toThrow();
  });

  it("rejects a symbol with SQL-like text", () => {
    expect(() =>
      validateMarketBars({ ...series, symbol: "ES; DROP" }, [bar(1), bar(2)])
    ).toThrow("symbol must match ^[A-Z0-9.^=-]{1,20}$");
  });

  it.each([
    [{ symbol: "spy" }, "symbol"],
    [{ timeframe: "5m" }, "timeframe"],
    [{ source: "   " }, "source"],
    [{ source: "x".repeat(301) }, "source"],
    [{ sourceSha256: "abc" }, "sourceSha256"],
  ])("rejects series %j", (overrides, field) => {
    expect(() =>
      validateMarketBars({ ...series, ...overrides } as MarketBarSeriesInput, [
        bar(1),
        bar(2),
      ])
    ).toThrow(field);
  });

  it.each([
    [[bar(1)], "at least 2 bars"],
    [[bar(2), bar(2)], "bar 1: t must be"],
    [[bar(1.5), bar(2)], "bar 0: t must be"],
    [[bar(1), bar(2, { o: 0 })], "bar 1: prices"],
    [[bar(1), bar(2, { h: Number.NaN })], "bar 1: prices"],
    [[bar(1), bar(2, { l: -1 })], "bar 1: prices"],
    [[bar(1), bar(2, { c: Number.POSITIVE_INFINITY })], "bar 1: prices"],
    [[bar(1), bar(2, { h: 8 })], "bar 1: prices"],
    [[bar(1), bar(2, { o: 11.5 })], "bar 1: prices"],
    [[bar(1), bar(2, { c: 8.5 })], "bar 1: prices"],
    [[bar(1), bar(2, { v: -1 })], "bar 1: prices"],
    [[bar(1), bar(2, { v: Number.NaN })], "bar 1: prices"],
  ])("rejects bars %#", (bars, message) => {
    let thrown: unknown;
    try {
      validateMarketBars(series, bars);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MarketBarsInputError);
    expect((thrown as Error).message).toContain(message);
  });
});

describe("toMarketBarColumns", () => {
  it("returns one typed array per field in row order", () => {
    const columns = toMarketBarColumns([bar(1), bar(2, { c: 12, v: null })]);
    expect(Array.from(columns.t)).toEqual([1, 2]);
    expect(Array.from(columns.o)).toEqual([10, 10]);
    expect(Array.from(columns.h)).toEqual([11, 11]);
    expect(Array.from(columns.l)).toEqual([9, 9]);
    expect(Array.from(columns.c)).toEqual([10.5, 12]);
    expect(columns.v?.[0]).toBe(bar(1).v);
    expect(columns.v?.[1]).toBeNaN();
  });
});

describe("createMarketBarsRepository", () => {
  const stored = {
    barCount: 2,
    firstT: 1,
    id: "SPY:1d",
    importedAt: FIXED_NOW,
    lastT: 2,
    source: "Test source",
    sourceSha256: SHA,
    symbol: "SPY",
    timeframe: "1d",
  };

  it("builds series ids from symbol and timeframe", () => {
    expect(marketBarSeriesId("BTCUSDT", "1m")).toBe("BTCUSDT:1m");
  });

  it("lists series", async () => {
    const { database, operations } = createDouble([[stored]]);
    await expect(
      createMarketBarsRepository(database).listSeries()
    ).resolves.toEqual([stored]);
    expect(operations[0]?.table).toBe(marketBarSeries);
  });

  it("reads one series by id or returns null", async () => {
    const { database, operations } = createDouble([[stored], []]);
    const repository = createMarketBarsRepository(database);
    await expect(repository.getSeries("SPY", "1d")).resolves.toEqual(stored);
    await expect(repository.getSeries("QQQ", "1d")).resolves.toBeNull();
    expect(operations[0]?.limit).toBe(1);
    expect(sqlText(operations[0]?.where)).toContain('"market_bar_series"."id"');
  });

  it("loads bars as columns", async () => {
    const { database, operations } = createDouble([[bar(1), bar(2)]]);
    const columns =
      await createMarketBarsRepository(database).loadColumns("SPY:1d");
    expect(Array.from(columns.c)).toEqual([10.5, 10.5]);
    expect(operations[0]?.table).toBe(marketBars);
    expect(sqlText(operations[0]?.where)).toContain(
      '"market_bars"."series_id"'
    );
  });

  it("replaces a series inside one transaction in chunks", async () => {
    const { database, operations } = createDouble([]);
    const bars = Array.from({ length: 5001 }, (_, index) => bar(index + 1));
    const result = await createMarketBarsRepository(
      database,
      () => FIXED_NOW
    ).replaceSeries(series, bars);
    expect(result).toEqual({ ...stored, barCount: 5001, lastT: 5001 });
    expect(operations.map((operation) => operation.kind)).toEqual([
      "begin",
      "lock",
      "delete",
      "insert",
      "insert",
      "insert",
    ]);
    expect(sqlText(operations[1]?.where)).toContain(
      "pg_advisory_xact_lock(hashtextextended('market_bar_series:' || $1, 0))"
    );
    expect(operations[2]?.table).toBe(marketBarSeries);
    const [, , , , firstChunk, secondChunk] = operations;
    expect(firstChunk?.values).toHaveLength(5000);
    expect(secondChunk?.values).toEqual([
      {
        seriesId: "SPY:1d",
        ...bar(5001),
      },
    ]);
  });

  it("validates before writing", async () => {
    const { database, operations } = createDouble([]);
    await expect(
      createMarketBarsRepository(database).replaceSeries(series, [bar(1)])
    ).rejects.toBeInstanceOf(MarketBarsInputError);
    expect(operations).toEqual([]);
  });

  it("uses the current time by default and is part of createRepositories", async () => {
    const { database } = createDouble([]);
    const before = Date.now();
    const result = await createRepositories(database).marketBars?.replaceSeries(
      series,
      [bar(1), bar(2)]
    );
    expect(result?.importedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("market bars appendBars", () => {
  const DAY = 86_400_000;
  const SEAM = Date.UTC(2026, 10, 3);
  const storedSeries = {
    barCount: 100,
    firstT: 1,
    id: "QQQ:1d",
    importedAt: FIXED_NOW,
    lastT: SEAM,
    source: "Yahoo",
    sourceSha256: SHA,
    symbol: "QQQ",
    timeframe: "1d",
  };
  const append = (
    outcomes: Array<readonly unknown[] | Error>,
    bars: MarketBarRow[],
    seamCloseTolerance: number | null = 0.005
  ) => {
    const double = createDouble(outcomes);
    return {
      ...double,
      result: createMarketBarsRepository(
        double.database,
        () => FIXED_NOW
      ).appendBars("QQQ", "1d", bars, { seamCloseTolerance }),
    };
  };

  it("appends only the bars after the last stored bar under the series lock", async () => {
    const after = { ...storedSeries, barCount: 102, lastT: SEAM + 2 * DAY };
    const { operations, result } = append(
      [[storedSeries], [{ c: 600 }], [after]],
      [
        bar(SEAM - DAY),
        bar(SEAM, { c: 600.5, h: 601, l: 590, o: 595 }),
        bar(SEAM + DAY, { v: null }),
        bar(SEAM + 2 * DAY),
      ]
    );
    await expect(result).resolves.toEqual({ series: after, written: 2 });
    expect(operations.map((operation) => operation.kind)).toEqual([
      "begin",
      "lock",
      "select",
      "select",
      "insert",
      "update",
    ]);
    expect(operations[4]?.values).toEqual([
      { seriesId: "QQQ:1d", ...bar(SEAM + DAY, { v: null }) },
      { seriesId: "QQQ:1d", ...bar(SEAM + 2 * DAY) },
    ]);
    expect(operations[5]?.values).toEqual({
      barCount: 102,
      importedAt: FIXED_NOW,
      lastT: SEAM + 2 * DAY,
    });
  });

  it("skips the close check without a tolerance", async () => {
    const { operations, result } = append(
      [[storedSeries], [storedSeries]],
      [bar(SEAM, { c: 999, h: 1000 }), bar(SEAM + DAY)],
      null
    );
    await expect(result).resolves.toMatchObject({ written: 1 });
    expect(
      operations.filter((operation) => operation.kind === "select")
    ).toHaveLength(1);
  });

  it("writes nothing when no bar is after the last stored bar", async () => {
    const { operations, result } = append(
      [[storedSeries], [{ c: 10.5 }]],
      [bar(SEAM)]
    );
    await expect(result).resolves.toEqual({ series: storedSeries, written: 0 });
    expect(operations.some((operation) => operation.kind === "insert")).toBe(
      false
    );
  });

  it.each([
    {
      bars: [bar(SEAM), bar(SEAM + DAY)],
      name: "a series that is not imported",
      outcomes: [[]],
      text: "series is not imported",
    },
    {
      bars: [bar(SEAM + DAY)],
      name: "an input without the last stored bar",
      outcomes: [[storedSeries]],
      text: "send rows from 2026-11-03",
    },
    {
      bars: [bar(SEAM, { c: 604, h: 605, l: 590, o: 600 }), bar(SEAM + DAY)],
      name: "a close outside the tolerance",
      outcomes: [[storedSeries], [{ c: 600 }]],
      text: "close on 2026-11-03 differs from the stored close",
    },
    {
      bars: [bar(SEAM), bar(SEAM + DAY)],
      name: "a series without its last bar",
      outcomes: [[storedSeries], []],
      text: "close on 2026-11-03 differs from the stored close",
    },
  ])("refuses $name", async ({ bars, outcomes, text }) => {
    const { operations, result } = append(outcomes, bars);
    await expect(result).rejects.toBeInstanceOf(MarketBarsInputError);
    await expect(result).rejects.toThrow(text);
    expect(operations.some((operation) => operation.kind === "insert")).toBe(
      false
    );
  });

  it("validates the bars before the transaction", async () => {
    const { operations, result } = append(
      [],
      [bar(SEAM), bar(SEAM + DAY, { h: 1 })]
    );
    await expect(result).rejects.toThrow("bar 1: prices must be positive");
    expect(operations).toEqual([]);
  });
});

describe("market bar tables", () => {
  it("declare keys, checks and the cascading series reference", () => {
    const series = getTableConfig(marketBarSeries);
    const bars = getTableConfig(marketBars);
    expect(series.indexes.map((entry) => entry.config.name)).toEqual([
      "market_bar_series_symbol_timeframe_idx",
    ]);
    expect(series.checks.map((entry) => entry.name)).toEqual([
      "market_bar_series_text_check",
      "market_bar_series_range_check",
    ]);
    expect(bars.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "series_id",
      "t",
    ]);
    expect(bars.checks.map((entry) => entry.name)).toEqual([
      "market_bars_price_check",
    ]);
    const [reference] = bars.foreignKeys;
    expect(reference?.onDelete).toBe("cascade");
    expect(reference?.reference().foreignColumns[0]?.name).toBe("id");
  });
});

describe("0025_market_bars migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0025_market_bars.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0025_market_bars.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: Array<{ idx: number; tag: string }> };

  it("creates both tables with their checks and is journaled at index 25", () => {
    expect(migration).toContain('CREATE TABLE "market_bar_series"');
    expect(migration).toContain('CREATE TABLE "market_bars"');
    expect(migration).toContain("market_bars_price_check");
    expect(migration).toContain('PRIMARY KEY("series_id","t")');
    expect(
      journal.entries.find((entry) => entry.tag === "0025_market_bars")
    ).toMatchObject({
      idx: 25,
      tag: "0025_market_bars",
    });
  });

  it("rollback refuses while rows exist and never cascades", () => {
    expect(rollback).toContain(
      "market bar tables are not empty; refusing rollback"
    );
    expect(rollback).toContain('DROP TABLE "public"."market_bars"');
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
  });
});

describe("0045_market_bar_futures_symbols migration", () => {
  const migration = readFileSync(
    new URL(
      "../../migrations/0045_market_bar_futures_symbols.sql",
      import.meta.url
    ),
    "utf8"
  );
  const rollback = readFileSync(
    new URL(
      "../../rollback/0045_market_bar_futures_symbols.down.sql",
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

  it("widens only the symbol check to admit '=' and is journaled at index 45", () => {
    expect(migration).toContain(
      'DROP CONSTRAINT "market_bar_series_text_check"'
    );
    expect(migration).toContain("'^[A-Z0-9.^=-]{1,20}$'");
    expect(migration).not.toMatch(/DROP TABLE|DELETE|TRUNCATE/i);
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0045_market_bar_futures_symbols"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 45 });
    expect(journal.entries[index - 1]).toMatchObject({
      tag: "0044_research_reports",
    });
  });

  it("matches the schema check", () => {
    const [textCheck] = getTableConfig(marketBarSeries).checks;
    expect(sqlText(textCheck?.value)).toContain("'^[A-Z0-9.^=-]{1,20}$'");
  });

  it("rollback refuses while futures symbols are stored", () => {
    expect(rollback).toContain("position('=' in \"symbol\") > 0");
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain("'^[A-Z0-9.^-]{1,20}$'");
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DELETE/i);
  });
});
