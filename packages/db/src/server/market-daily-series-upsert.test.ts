import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { marketDailyPoints, marketDailySeries } from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  createMarketDailySeriesRepository,
  type MarketDailyPoint,
  MarketDailySeriesInputError,
} from "./market-daily-series.ts";

// upsertPoints (openbb.ingest, Cboe vol index closes) with a recording query double; the real
// upsert and recount run against Postgres in tests/integration/database/openbb.test.ts.

const NOW = new Date("2026-11-08T12:00:00.000Z");
const SHA = "d".repeat(64);
const dialect = new PgDialect();

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

const point = (
  date: string,
  close: number,
  extra: Partial<MarketDailyPoint> = {}
): MarketDailyPoint => ({
  adjClose: null,
  close,
  date,
  high: null,
  low: null,
  open: null,
  ...extra,
});

describe("market daily series upsertPoints", () => {
  it("creates a missing series under a lock, upserts sorted points and recomputes from storage", async () => {
    const stored = {
      firstDate: "2026-11-05",
      id: "VIX",
      importedAt: NOW,
      kind: "index",
      lastDate: "2026-11-06",
      pointCount: 2,
      source: "cboe",
      sourceSha256: SHA,
    };
    // Awaited in order: lock, stored-series select, series insert, points insert, recount.
    const { calls, database } = createDouble([[], [], [], [], [stored]]);
    const repository = createMarketDailySeriesRepository(database, () => NOW);
    const result = await repository.upsertPoints(
      { id: "VIX", kind: "index", source: " cboe ", sourceSha256: SHA },
      [
        point("2026-11-06", 19),
        point("2026-11-05", 18, { open: -0 }),
        point("2026-11-06", 19.5, { high: 20, low: 18.9, open: 19.1 }),
      ]
    );
    expect(result).toEqual(stored);
    expect(calls.map((call) => call.method)).toEqual([
      "transaction",
      "execute",
      "select",
      "from",
      "where",
      "insert",
      "values",
      "insert",
      "values",
      "onConflictDoUpdate",
      "update",
      "set",
      "where",
      "returning",
    ]);
    const lock = dialect.sqlToQuery(calls[1]?.args[0] as SQL);
    expect(lock.sql).toBe("select pg_advisory_xact_lock(hashtext($1))");
    expect(lock.params).toEqual(["VIX"]);
    expect(calls[5]?.args[0]).toBe(marketDailySeries);
    expect(calls[6]?.args[0]).toEqual({
      firstDate: "2026-11-05",
      id: "VIX",
      importedAt: NOW,
      kind: "index",
      lastDate: "2026-11-06",
      pointCount: 2,
      source: "cboe",
      sourceSha256: SHA,
    });
    expect(calls[7]?.args[0]).toBe(marketDailyPoints);
    const rows = calls[8]?.args[0] as Record<string, unknown>[];
    expect(rows.map((row) => row["date"])).toEqual([
      "2026-11-05",
      "2026-11-06",
    ]);
    expect(rows[1]).toMatchObject({ close: 19.5, open: 19.1 });
    expect(dialect.sqlToQuery(rows[0]?.["open"] as SQL).sql).toBe(
      "'-0'::float8"
    );
    const pointConflict = calls[9]?.args[0] as { set: Record<string, SQL> };
    expect(dialect.sqlToQuery(pointConflict.set["adjClose"] as SQL).sql).toBe(
      'coalesce(excluded."adj_close", "market_daily_points"."adj_close")'
    );
    const recount = calls[11]?.args[0] as Record<string, unknown>;
    expect(recount["importedAt"]).toBe(NOW);
    const first = dialect.sqlToQuery(recount["firstDate"] as SQL);
    expect(first.sql).toBe(
      '(select min(date) from "market_daily_points" where "market_daily_points"."series_id" = $1)'
    );
    expect(first.params).toEqual(["VIX"]);
    expect(dialect.sqlToQuery(recount["sourceSha256"] as SQL).sql).toContain(
      "encode(sha256(convert_to(coalesce(string_agg(concat_ws('|', date::text"
    );
  });

  it("appends only newer dates to a series another source owns and never changes its source", async () => {
    const imported = {
      firstDate: "2020-01-02",
      id: "VIX",
      importedAt: NOW,
      kind: "index",
      lastDate: "2026-11-05",
      pointCount: 1700,
      source: "vertex:series:import vix.csv",
      sourceSha256: SHA,
    };
    const appended = createDouble([[], [imported], [], [imported]]);
    await createMarketDailySeriesRepository(
      appended.database,
      () => NOW
    ).upsertPoints(
      { id: "VIX", kind: "index", source: "cboe", sourceSha256: SHA },
      [point("2026-11-05", 99), point("2026-11-06", 19)]
    );
    const methods = appended.calls.map((call) => call.method);
    expect(methods).not.toContain("onConflictDoNothing");
    expect(methods.filter((method) => method === "insert")).toHaveLength(1);
    const values = appended.calls.find((call) => call.method === "values")
      ?.args[0] as Record<string, unknown>[];
    expect(values.map((row) => row["date"])).toEqual(["2026-11-06"]);
    const set = appended.calls.find((call) => call.method === "set")?.args[0];
    expect(Object.keys(set as object)).not.toContain("source");

    const unchanged = createDouble([[], [imported]]);
    const result = await createMarketDailySeriesRepository(
      unchanged.database
    ).upsertPoints(
      { id: "VIX", kind: "index", source: "cboe", sourceSha256: SHA },
      [point("2026-11-04", 18), point("2026-11-05", 99)]
    );
    expect(result).toBe(imported);
    expect(unchanged.calls.map((call) => call.method)).not.toContain("insert");

    const owned = createDouble([
      [],
      [{ ...imported, source: "cboe" }],
      [],
      [imported],
    ]);
    await createMarketDailySeriesRepository(owned.database).upsertPoints(
      { id: "VIX", kind: "index", source: "cboe", sourceSha256: SHA },
      [point("2026-11-04", 18)]
    );
    const ownedValues = owned.calls.find((call) => call.method === "values")
      ?.args[0] as Record<string, unknown>[];
    expect(ownedValues.map((row) => row["date"])).toEqual(["2026-11-04"]);
  });

  it("keeps the id, kind and value checks", async () => {
    const { database } = createDouble([]);
    const repository = createMarketDailySeriesRepository(database);
    await expect(
      repository.upsertPoints(
        { id: "vix", kind: "index", source: "cboe", sourceSha256: SHA },
        [point("2026-11-06", 19)]
      )
    ).rejects.toThrow(MarketDailySeriesInputError);
    await expect(
      repository.upsertPoints(
        { id: "VIX", kind: "index", source: "cboe", sourceSha256: SHA },
        [point("2026-11-06", Number.NaN)]
      )
    ).rejects.toThrow(/close must be finite/u);
    await expect(
      repository.upsertPoints(
        { id: "VIX", kind: "index", source: "cboe", sourceSha256: SHA },
        []
      )
    ).rejects.toThrow(/at least 1 point/u);
  });
});
