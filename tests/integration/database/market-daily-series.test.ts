import { readFileSync } from "node:fs";

import {
  createMarketDailySeriesRepository,
  createNodeDatabase,
  type Database,
  type MarketDailyPoint,
  type MarketDailySeriesRepository,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0060 (daily research series of the QuantConnect idea ports), its guarded rollback, and
// the repository's exact float8 round trip on a real database.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migrationSql = read(
  "../../../packages/db/migrations/0060_market_daily_series.sql"
);
const rollbackSql = read(
  "../../../packages/db/rollback/0060_market_daily_series.down.sql"
);
const SHA = "c".repeat(64);

// CSV texts whose parseFloat must come back bit-identical through node-pg's float8 parser.
const DOUBLE_TEXTS = [
  "0.1",
  "0.30000000000000004",
  "1.100000",
  "4.350000",
  "123.456789",
  "10290.000000",
  "0.000001",
  "-37.630001",
  "9007199254740993",
  "5e-324",
  "2.2250738585072014e-308",
  "1.7976931348623157e308",
  "-0.0",
  "0",
  "3.141592653589793",
  "1e21",
  "1e-7",
];

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};

const repository = (): MarketDailySeriesRepository => {
  if (resource === undefined) throw new Error("Database not started");
  return createMarketDailySeriesRepository(resource.db);
};

const dates = (count: number, start = Date.UTC(2020, 0, 1)) =>
  Array.from({ length: count }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10)
  );

const countRows = async (table: string): Promise<number> => {
  const [row] = await postgres().query<{ n: number }>(
    `select count(*)::int as n from ${table}`
  );
  return row?.n ?? Number.NaN;
};

describe("0060 market daily series (Postgres)", () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 2,
    });
    await migrate(resource.db);
  }, 60_000);

  afterAll(async () => {
    await resource?.close();
    if (testDatabase !== undefined)
      await dropPostgresTestDatabase(testDatabase);
  });

  it("round-trips every double bit for bit, nulls included", async () => {
    const values = DOUBLE_TEXTS.map((text) => Number.parseFloat(text));
    const points: MarketDailyPoint[] = dates(values.length).map(
      (date, index) => {
        const value = values[index] as number;
        return {
          adjClose: index % 3 === 0 ? null : -value,
          close: value,
          date,
          high: value,
          low: index % 2 === 0 ? null : value / 3,
          open: index % 4 === 0 ? null : value * 0.1,
        };
      }
    );
    await repository().replaceSeries(
      {
        id: "EY_TNX_RATIO",
        kind: "derived",
        source: "test",
        sourceSha256: SHA,
      },
      points
    );
    const loaded = (await repository().loadSeries(["EY_TNX_RATIO"])).get(
      "EY_TNX_RATIO"
    );
    expect(loaded?.dates).toEqual(points.map((point) => point.date));
    for (const [index, point] of points.entries()) {
      for (const [key, column] of [
        ["open", loaded?.open],
        ["high", loaded?.high],
        ["low", loaded?.low],
        ["close", loaded?.close],
        ["adjClose", loaded?.adjClose],
      ] as const) {
        const expected = point[key];
        const actual = column?.[index];
        expect(
          Object.is(actual, expected),
          `${key} ${point.date}: ${String(actual)} vs ${String(expected)}`
        ).toBe(true);
      }
    }
    const zeros = await postgres().query<{ text: string }>(
      "select close::text as text from market_daily_points where series_id = 'EY_TNX_RATIO' and close = 0 order by date"
    );
    expect(zeros.map((row) => row.text)).toEqual(["-0", "0"]);
  });

  it("filters an inclusive date range, keeps request order and replaces a whole series", async () => {
    const spyDates = dates(10, Date.UTC(2021, 0, 1));
    const spy = spyDates.map((date, index) => ({
      adjClose: 99 + index,
      close: 100 + index,
      date,
      high: 101 + index,
      low: 98 + index,
      open: 100 + index,
    }));
    await repository().replaceSeries(
      { id: "SPY", kind: "etf", source: "test", sourceSha256: SHA },
      spy
    );
    const loaded = await repository().loadSeries(
      ["SPY", "QQQ", "EY_TNX_RATIO"],
      { from: spyDates[2] as string, to: spyDates[4] as string }
    );
    expect([...loaded.keys()]).toEqual(["SPY", "EY_TNX_RATIO"]);
    expect(loaded.get("SPY")?.dates).toEqual(spyDates.slice(2, 5));
    expect(loaded.get("SPY")?.close).toEqual([102, 103, 104]);
    expect(loaded.get("EY_TNX_RATIO")?.dates).toEqual([]);

    const replaced = await repository().replaceSeries(
      { id: "SPY", kind: "etf", source: "test again", sourceSha256: SHA },
      spy.slice(5)
    );
    expect(replaced).toMatchObject({
      firstDate: spyDates[5],
      lastDate: spyDates[9],
      pointCount: 5,
    });
    const listed = await repository().listSeries();
    expect(listed.map((series) => [series.id, series.pointCount])).toEqual([
      ["EY_TNX_RATIO", DOUBLE_TEXTS.length],
      ["SPY", 5],
    ]);
    expect(listed[1]?.source).toBe("test again");
    expect((await repository().loadSeries(["SPY"])).get("SPY")?.dates).toEqual(
      spyDates.slice(5)
    );
  });

  it("enforces the checks in the database", async () => {
    const insertSeries = (
      id: string,
      kind: string,
      first: string,
      last: string,
      count = 1
    ) =>
      postgres().query(
        "insert into market_daily_series (id, kind, source, source_sha256, point_count, first_date, last_date) values ($1, $2, 'test', $3, $4, $5, $6)",
        [id, kind, SHA, count, first, last]
      );
    await expect(
      insertSeries("spy", "etf", "2024-01-02", "2024-01-02")
    ).rejects.toThrow(/market_daily_series_text_check/u);
    await expect(
      insertSeries("SPY2", "crypto", "2024-01-02", "2024-01-02")
    ).rejects.toThrow(/market_daily_series_text_check/u);
    await expect(
      insertSeries("SPY2", "etf", "2024-01-03", "2024-01-02", 2)
    ).rejects.toThrow(/market_daily_series_range_check/u);
    await expect(
      insertSeries("SPY2", "etf", "2024-01-02", "2024-01-03", 1)
    ).rejects.toThrow(/market_daily_series_range_check/u);
    for (const bad of ["NaN", "Infinity", "-Infinity"]) {
      await expect(
        postgres().query(
          "insert into market_daily_points (series_id, date, close) values ('SPY', '2030-01-01', $1::float8)",
          [bad]
        )
      ).rejects.toThrow(/market_daily_points_finite_check/u);
      await expect(
        postgres().query(
          "insert into market_daily_points (series_id, date, close, adj_close) values ('SPY', '2030-01-01', 1, $1::float8)",
          [bad]
        )
      ).rejects.toThrow(/market_daily_points_finite_check/u);
    }
    await expect(
      postgres().query(
        "insert into market_daily_points (series_id, date, close) values ('NOPE', '2030-01-01', 1)"
      )
    ).rejects.toThrow(/foreign key/u);
  });

  it("cascades a series delete to its points", async () => {
    await postgres().query("delete from market_daily_series where id = 'SPY'");
    const [row] = await postgres().query<{ n: number }>(
      "select count(*)::int as n from market_daily_points where series_id = 'SPY'"
    );
    expect(row?.n).toBe(0);
  });

  it("refuses the rollback while rows exist", async () => {
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    // The refused rollback leaves its BEGIN open on this connection; end it.
    await postgres().query("ROLLBACK");
    expect(await countRows("market_daily_series")).toBe(1);
  });

  return it("rolls back when empty and the migration applies again", async () => {
    await postgres().query("delete from market_daily_series");
    await postgres().query(rollbackSql);
    const tables = async () =>
      (
        await postgres().query<{ name: string }>(
          "select table_name as name from information_schema.tables where table_schema = 'public' and table_name like 'market_daily_%' order by 1"
        )
      ).map((row) => row.name);
    expect(await tables()).toEqual([]);
    await postgres().query(migrationSql);
    expect(await tables()).toEqual([
      "market_daily_points",
      "market_daily_series",
    ]);
    expect(await countRows("market_daily_points")).toBe(0);
  });
});
