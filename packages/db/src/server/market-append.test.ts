import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { DatabaseExecutor } from "./client.ts";
import {
  createMarketBarsRepository,
  type MarketBarRow,
  MarketBarsInputError,
} from "./market-bars.ts";
import {
  createMarketDailySeriesRepository,
  MarketDailySeriesInputError,
} from "./market-daily-series.ts";

// appendBars, latestBars and latestPoints (openbb.ingest daily_bars and openbb.dailyPricesState)
// with a recording query double; the real appends and joins run against Postgres in
// tests/integration/database/openbb.test.ts.

const NOW = new Date("2026-11-22T12:00:00.000Z");
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 19);

type Call = Readonly<{ method: string; args: unknown[] }>;

const createDouble = (results: unknown[][]) => {
  const calls: Call[] = [];
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "then")
          return (resolve: (rows: unknown) => unknown) =>
            Promise.resolve(results.shift() ?? []).then(resolve);
        return (...args: unknown[]) => {
          calls.push({ args, method: String(property) });
          if (property === "transaction")
            return (args[0] as (tx: unknown) => Promise<unknown>)(chain);
          return chain;
        };
      },
    }
  );
  return { calls, database: chain as unknown as DatabaseExecutor };
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

const stored = {
  barCount: 2,
  firstT: T0 - DAY,
  id: "SPY:1d",
  importedAt: NOW,
  lastT: T0,
  source: "base import",
  sourceSha256: "a".repeat(64),
  symbol: "SPY",
  timeframe: "1d",
};

const methods = (calls: readonly Call[]) => calls.map((call) => call.method);

describe("market bars appendBars", () => {
  it("inserts only bars after the stored last bar and recounts from storage", async () => {
    const after = { ...stored, barCount: 3, lastT: T0 + DAY };
    // Awaited in order: lock, extra_float_digits, stored-series select, bars insert, recount.
    const { calls, database } = createDouble([[], [], [stored], [], [after]]);
    const result = await createMarketBarsRepository(
      database,
      () => NOW
    ).appendBars({ symbol: "SPY", timeframe: "1d" }, [
      bar(T0),
      bar(T0 + DAY, { v: null }),
    ]);
    expect(result).toEqual({ series: after, written: 1 });
    expect(methods(calls)).toEqual([
      "transaction",
      "execute",
      "execute",
      "select",
      "from",
      "where",
      "insert",
      "values",
      "update",
      "set",
      "where",
      "returning",
    ]);
    expect(calls.find((call) => call.method === "values")?.args[0]).toEqual([
      { ...bar(T0 + DAY, { v: null }), seriesId: "SPY:1d" },
    ]);
    const values = calls.find((call) => call.method === "set")?.args[0];
    expect(values).toMatchObject({ importedAt: NOW });
    const digest = (values as { sourceSha256: SQL }).sourceSha256;
    expect(new PgDialect().sqlToQuery(digest).sql).toContain(
      "concat_ws('|', t::text, o::text, h::text, l::text, c::text, coalesce(v::text, '')), E'\\n' order by t"
    );
  });

  it("writes nothing when no bar is newer", async () => {
    const { calls, database } = createDouble([[], [], [stored]]);
    const result = await createMarketBarsRepository(database).appendBars(
      { symbol: "SPY", timeframe: "1d" },
      [bar(T0 - DAY), bar(T0)]
    );
    expect(result).toEqual({ series: stored, written: 0 });
    expect(methods(calls)).not.toContain("insert");
  });

  it("refuses a series that is not stored", async () => {
    const { database } = createDouble([[], [], []]);
    await expect(
      createMarketBarsRepository(database).appendBars(
        { symbol: "SPY", timeframe: "1d" },
        [bar(T0)]
      )
    ).rejects.toThrow(new MarketBarsInputError("no stored series SPY:1d"));
  });

  it("validates the series key and the bars before any query", async () => {
    const { calls, database } = createDouble([]);
    const repository = createMarketBarsRepository(database);
    await expect(
      repository.appendBars({ symbol: "spy", timeframe: "1d" }, [bar(T0)])
    ).rejects.toThrow("symbol must match");
    await expect(
      repository.appendBars({ symbol: "SPY", timeframe: "1h" as "1d" }, [
        bar(T0),
      ])
    ).rejects.toThrow("timeframe must be 1d or 1m");
    await expect(
      repository.appendBars({ symbol: "SPY", timeframe: "1d" }, [])
    ).rejects.toThrow("at least 1 bar needed");
    await expect(
      repository.appendBars({ symbol: "SPY", timeframe: "1d" }, [
        bar(T0, { h: 1 }),
      ])
    ).rejects.toThrow("bar 0: prices must be positive");
    expect(calls).toEqual([]);
  });
});

describe("market bars latestBars", () => {
  it("joins each series of the timeframe to its last bar", async () => {
    const rows = [{ close: 10.5, lastT: T0, symbol: "SPY" }];
    const { calls, database } = createDouble([rows]);
    expect(await createMarketBarsRepository(database).latestBars("1d")).toEqual(
      rows
    );
    expect(methods(calls)).toEqual([
      "select",
      "from",
      "innerJoin",
      "where",
      "orderBy",
    ]);
  });
});

describe("market daily series latestPoints", () => {
  it("joins each stored id to the point on its last date", async () => {
    const rows = [
      { adjClose: 9.5, close: 10, id: "SPY", lastDate: "2026-11-20" },
    ];
    const { calls, database } = createDouble([rows]);
    expect(
      await createMarketDailySeriesRepository(database).latestPoints([
        "SPY",
        "SPY",
        "TNX",
      ])
    ).toEqual(rows);
    expect(methods(calls)).toEqual([
      "select",
      "from",
      "innerJoin",
      "where",
      "orderBy",
    ]);
  });

  it("answers no ids without a query and refuses a bad id", async () => {
    const { calls, database } = createDouble([]);
    const repository = createMarketDailySeriesRepository(database);
    expect(await repository.latestPoints([])).toEqual([]);
    await expect(repository.latestPoints(["bad id"])).rejects.toThrow(
      MarketDailySeriesInputError
    );
    expect(calls).toEqual([]);
  });
});
