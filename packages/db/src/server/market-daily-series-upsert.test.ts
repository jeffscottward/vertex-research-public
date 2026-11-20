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
    // Awaited in order: lock, extra_float_digits, stored-series select, series insert, points
    // insert, recount.
    const { calls, database } = createDouble([[], [], [], [], [], [stored]]);
    const repository = createMarketDailySeriesRepository(database, () => NOW);
    const result = await repository.upsertPoints(
      { id: "VIX", kind: "index", source: " cboe ", sourceSha256: SHA },
      [
        point("2026-11-06", 19),
        point("2026-11-05", 18, { open: -0 }),
        point("2026-11-06", 19.5, { high: 20, low: 18.9, open: 19.1 }),
      ]
    );
    expect(result).toEqual({ series: stored, written: 2 });
    expect(calls.map((call) => call.method)).toEqual([
      "transaction",
      "execute",
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
    expect(lock.sql).toBe(
      "select pg_advisory_xact_lock(hashtextextended('market_daily_series:' || $1, 0))"
    );
    expect(lock.params).toEqual(["VIX"]);
    expect(dialect.sqlToQuery(calls[2]?.args[0] as SQL).sql).toBe(
      "set local extra_float_digits = 1"
    );
    expect(calls[6]?.args[0]).toBe(marketDailySeries);
    expect(calls[7]?.args[0]).toEqual({
      firstDate: "2026-11-05",
      id: "VIX",
      importedAt: NOW,
      kind: "index",
      lastDate: "2026-11-06",
      pointCount: 2,
      source: "cboe",
      sourceSha256: SHA,
    });
    expect(calls[8]?.args[0]).toBe(marketDailyPoints);
    const rows = calls[9]?.args[0] as Record<string, unknown>[];
    expect(rows.map((row) => row["date"])).toEqual([
      "2026-11-05",
      "2026-11-06",
    ]);
    expect(rows[1]).toMatchObject({ close: 19.5, open: 19.1 });
    expect(dialect.sqlToQuery(rows[0]?.["open"] as SQL).sql).toBe(
      "'-0'::float8"
    );
    const pointConflict = calls[10]?.args[0] as { set: Record<string, SQL> };
    expect(dialect.sqlToQuery(pointConflict.set["adjClose"] as SQL).sql).toBe(
      'coalesce(excluded."adj_close", "market_daily_points"."adj_close")'
    );
    const recount = calls[12]?.args[0] as Record<string, unknown>;
    expect(recount["importedAt"]).toBe(NOW);
    const first = dialect.sqlToQuery(recount["firstDate"] as SQL);
    expect(first.sql).toBe(
      '(select min(date) from "market_daily_points" where "market_daily_points"."series_id" = $1)'
    );
    expect(first.params).toEqual(["VIX"]);
    expect(dialect.sqlToQuery(recount["sourceSha256"] as SQL).sql).toContain(
      "encode(sha256(convert_to(coalesce(string_agg(concat_ws('|', to_char(date, 'YYYY-MM-DD')"
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
    const appended = createDouble([[], [], [imported], [], [imported]]);
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

    const unchanged = createDouble([[], [], [imported]]);
    const result = await createMarketDailySeriesRepository(
      unchanged.database
    ).upsertPoints(
      { id: "VIX", kind: "index", source: "cboe", sourceSha256: SHA },
      [point("2026-11-04", 18), point("2026-11-05", 99)]
    );
    expect(result).toEqual({ series: imported, written: 0 });
    expect(unchanged.calls.map((call) => call.method)).not.toContain("insert");

    const owned = createDouble([
      [],
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

describe("market daily series upsertPoints in append mode", () => {
  const stored = {
    firstDate: "2026-01-02",
    id: "SPY",
    importedAt: NOW,
    kind: "etf",
    lastDate: "2026-11-06",
    pointCount: 200,
    source: "qc-ports fetch",
    sourceSha256: SHA,
  };
  const input = {
    id: "SPY",
    kind: "etf",
    source: "daily-prices",
    sourceSha256: SHA,
  } as const;
  const etf = { linkAdjClose: true, seamCloseTolerance: 0.005 };
  const plain = { linkAdjClose: false, seamCloseTolerance: null };
  const valuesOf = (calls: readonly Call[]) =>
    calls.find((call) => call.method === "values")?.args[0] as
      | { adjClose: number | null; date: string }[]
      | undefined;
  const params = (rows: { adjClose: number | null }[]) =>
    rows.map((row) => row.adjClose);

  it("links adj_close to the stored basis and writes only dates after the seam", async () => {
    const after = { ...stored, lastDate: "2026-11-10", pointCount: 202 };
    // Awaited in order: lock, extra_float_digits, stored series, seam point, insert, recount.
    const { calls, database } = createDouble([
      [],
      [],
      [stored],
      [{ adjClose: 50, close: 600 }],
      [],
      [after],
    ]);
    const repository = createMarketDailySeriesRepository(database, () => NOW);
    const result = await repository.upsertPoints(
      input,
      [
        point("2026-11-10", 620, { adjClose: 99 }),
        point("2026-11-05", 1, { adjClose: 1 }),
        point("2026-11-06", 600.5, { adjClose: 80 }),
        point("2026-11-09", 610, { adjClose: 88 }),
      ],
      etf
    );
    expect(result).toEqual({ series: after, written: 2 });
    const rows = valuesOf(calls) ?? [];
    expect(rows.map((row) => row.date)).toEqual(["2026-11-09", "2026-11-10"]);
    expect(params(rows)).toEqual([55, 61.875]);
    expect(calls.some((call) => call.method === "update")).toBe(true);
  });

  it("appends as sent without the checks and does not read the seam point", async () => {
    const { calls, database } = createDouble([[], [], [stored], [], [stored]]);
    const repository = createMarketDailySeriesRepository(database, () => NOW);
    const result = await repository.upsertPoints(
      { ...input, source: stored.source },
      [
        point("2026-11-06", 999, { adjClose: 7 }),
        point("2026-11-09", 610, { adjClose: 610 }),
        point("2026-11-10", 611),
      ],
      plain
    );
    expect(result.written).toBe(2);
    expect(calls.filter((call) => call.method === "select")).toHaveLength(1);
    const rows = valuesOf(calls) ?? [];
    expect(rows.map((row) => row.date)).toEqual(["2026-11-09", "2026-11-10"]);
    expect(params(rows)).toEqual([610, null]);
  });

  it("writes nothing when no point is after the seam", async () => {
    const { calls, database } = createDouble([
      [],
      [],
      [stored],
      [{ adjClose: 50, close: 600 }],
    ]);
    const repository = createMarketDailySeriesRepository(database, () => NOW);
    await expect(
      repository.upsertPoints(
        input,
        [point("2026-11-06", 600, { adjClose: 80 })],
        etf
      )
    ).resolves.toEqual({ series: stored, written: 0 });
    expect(calls.some((call) => call.method === "insert")).toBe(false);
  });

  it.each([
    {
      name: "a series that is not imported",
      points: [point("2026-11-06", 600, { adjClose: 80 })],
      results: [[], [], []],
      text: "series is not imported",
    },
    {
      name: "an input without the seam date",
      points: [point("2026-11-09", 610, { adjClose: 88 })],
      results: [[], [], [stored]],
      text: "send rows from 2026-11-06",
    },
    {
      name: "a seam close outside the tolerance",
      points: [point("2026-11-06", 604, { adjClose: 80 })],
      results: [[], [], [stored], [{ adjClose: 50, close: 600 }]],
      text: "close on 2026-11-06 differs from the stored close",
    },
    {
      name: "a stored series without its seam point",
      points: [point("2026-11-06", 600, { adjClose: 80 })],
      results: [[], [], [stored], []],
      text: "close on 2026-11-06 differs from the stored close",
    },
    {
      name: "a stored seam without adj_close",
      points: [point("2026-11-06", 600, { adjClose: 80 })],
      results: [[], [], [stored], [{ adjClose: null, close: 600 }]],
      text: "adj_close on 2026-11-06 is missing",
    },
    {
      name: "an incoming seam without adj_close",
      points: [point("2026-11-06", 600)],
      results: [[], [], [stored], [{ adjClose: 50, close: 600 }]],
      text: "adj_close on 2026-11-06 is missing",
    },
  ])("refuses $name", async ({ points, results, text }) => {
    const { calls, database } = createDouble(results);
    const repository = createMarketDailySeriesRepository(database, () => NOW);
    const refusal = repository.upsertPoints(input, points, etf);
    await expect(refusal).rejects.toBeInstanceOf(MarketDailySeriesInputError);
    await expect(refusal).rejects.toThrow(text);
    expect(calls.some((call) => call.method === "insert")).toBe(false);
  });

  it("refuses a missing seam point when only adj_close is linked", async () => {
    const { database } = createDouble([[], [], [stored], []]);
    const repository = createMarketDailySeriesRepository(database, () => NOW);
    await expect(
      repository.upsertPoints(
        input,
        [point("2026-11-06", 600, { adjClose: 80 })],
        { linkAdjClose: true, seamCloseTolerance: null }
      )
    ).rejects.toThrow("adj_close on 2026-11-06 is missing");
  });

  it("checks the close without a link when only the tolerance is set", async () => {
    const { calls, database } = createDouble([
      [],
      [],
      [stored],
      [{ adjClose: null, close: 600 }],
      [],
      [stored],
    ]);
    const repository = createMarketDailySeriesRepository(database, () => NOW);
    const result = await repository.upsertPoints(
      input,
      [
        point("2026-11-06", 600.5, { adjClose: 80 }),
        point("2026-11-09", 610, { adjClose: 88 }),
      ],
      { linkAdjClose: false, seamCloseTolerance: 0.005 }
    );
    expect(result.written).toBe(1);
    expect(params(valuesOf(calls) ?? [])).toEqual([88]);
  });
});
