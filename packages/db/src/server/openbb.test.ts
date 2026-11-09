import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  createOpenbbRepository,
  OPENBB_UPSERT_TABLES,
  type OpenbbRunInput,
} from "./openbb.ts";
import { createRepositories } from "./repositories.ts";

// Unit tests of the OpenBB repository with a recording query double; the SQL itself runs against
// Postgres in tests/integration/database/openbb.test.ts.

const NOW = new Date("2026-11-08T12:00:00.000Z");
const dialect = new PgDialect();

type Call = Readonly<{ method: string; args: unknown[] }>;

/** A chainable query double: every builder call is recorded; awaiting yields the next result. */
const createDouble = (results: unknown[][] = []) => {
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

const methods = (calls: readonly Call[]) => calls.map((call) => call.method);
const argOf = (calls: readonly Call[], method: string, nth = 0) =>
  calls.filter((call) => call.method === method)[nth]?.args[0];
const render = (value: unknown) => dialect.sqlToQuery(value as SQL);

describe("0063 openbb migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0063_openbb_sources.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0063_openbb_sources.down.sql", import.meta.url),
    "utf8"
  );
  const tables = Object.values(schema)
    .filter(
      (value): value is Parameters<typeof getTableConfig>[0] =>
        typeof value === "object" &&
        value !== null &&
        Symbol.for("drizzle:IsDrizzleTable") in value
    )
    .map((table) => getTableConfig(table))
    .filter((config) => config.name.startsWith("openbb_"));

  it("creates every openbb table with its columns and checks, and grants them", () => {
    expect(tables).toHaveLength(16);
    for (const config of tables) {
      expect(migration).toContain(`CREATE TABLE "${config.name}"`);
      for (const column of config.columns)
        expect(migration).toContain(`"${column.name}"`);
      for (const check of config.checks)
        expect(migration).toContain(`CONSTRAINT "${check.name}" CHECK`);
      expect(migration).toContain(`"${config.name}"`);
      expect(rollback).toContain(`DROP TABLE "public"."${config.name}"`);
      expect(rollback).toContain(`SELECT 1 FROM "public"."${config.name}"`);
    }
    expect(migration).toContain(
      'GRANT UPDATE ON TABLE "market_daily_series", "market_daily_points" TO "vertex_research"'
    );
    expect(migration).toContain("GRANT SELECT, INSERT, UPDATE, DELETE");
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "openbb_ingest_runs" TO "vertex_research"'
    );
  });

  it("grants inside the role guard: UPDATE on the daily series tables, insert-only run ledger", () => {
    const GUARD =
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN";
    const guarded = (text: string): Map<string, string[]> => {
      const start = text.indexOf(GUARD);
      expect(start).toBeGreaterThan(-1);
      const block = text.slice(start, text.indexOf("END IF;", start));
      const privileges = new Map<string, string[]>();
      for (const match of block.matchAll(
        /(GRANT|REVOKE) ([A-Z, ]+) ON TABLE ((?:"[\w.]+"(?:\."\w+")?(?:, )?)+) (?:TO|FROM) "vertex_research"/gu
      ))
        for (const table of (match[3] ?? "").matchAll(/"(\w+)"(?!\.)/gu))
          privileges.set(`${match[1]} ${table[1]}`, [
            ...(privileges.get(`${match[1]} ${table[1]}`) ?? []),
            ...(match[2] ?? "").split(", "),
          ]);
      return privileges;
    };
    const granted = guarded(migration);
    expect(granted.get("GRANT market_daily_series")).toEqual(["UPDATE"]);
    expect(granted.get("GRANT market_daily_points")).toEqual(["UPDATE"]);
    expect(granted.get("GRANT openbb_ingest_runs")).toEqual([
      "SELECT",
      "INSERT",
    ]);
    for (const config of tables.filter(
      (table) => table.name !== "openbb_ingest_runs"
    ))
      expect(granted.get(`GRANT ${config.name}`)).toEqual([
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
      ]);
    const revoked = guarded(rollback);
    expect(revoked.get("REVOKE market_daily_series")).toEqual(["UPDATE"]);
    expect(revoked.get("REVOKE market_daily_points")).toEqual(["UPDATE"]);
  });

  it("rollback refuses while rows exist and never cascades", () => {
    expect(rollback).toContain(
      "openbb tables are not empty; refusing rollback"
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/iu);
    expect(rollback).toContain(
      'REVOKE UPDATE ON TABLE "public"."market_daily_series", "public"."market_daily_points"'
    );
  });
});

describe("openbb repository writes", () => {
  it("upserts rows by primary key, keeps the last duplicate and sets every other column", async () => {
    const { calls, database } = createDouble();
    const repository = createOpenbbRepository(database);
    const written = await repository.upsertRows("vx_curve", [
      { asOf: "2026-11-06", contractMonth: "2026-12", price: 18 },
      { asOf: "2026-11-06", contractMonth: "2026-12", price: 18.5 },
      { asOf: "2026-11-06", contractMonth: "2027-01", price: 19 },
    ]);
    expect(written).toBe(2);
    expect(methods(calls)).toEqual(["insert", "values", "onConflictDoUpdate"]);
    expect(argOf(calls, "insert")).toBe(schema.openbbVxCurve);
    expect(argOf(calls, "values")).toEqual([
      { asOf: "2026-11-06", contractMonth: "2026-12", price: 18.5 },
      { asOf: "2026-11-06", contractMonth: "2027-01", price: 19 },
    ]);
    const conflict = argOf(calls, "onConflictDoUpdate") as {
      set: Record<string, SQL>;
      target: unknown[];
    };
    expect(conflict.target).toEqual([
      schema.openbbVxCurve.asOf,
      schema.openbbVxCurve.contractMonth,
    ]);
    expect(Object.keys(conflict.set)).toEqual(["price"]);
    expect(render(conflict.set["price"]).sql).toBe('excluded."price"');
    expect(await repository.upsertRows("sec_ftd", [])).toBe(0);
    const holdings = createDouble();
    await createOpenbbRepository(holdings.database).upsertRows(
      "sec_13f_holdings",
      [
        {
          assetClass: null,
          cusip: "037833100",
          filerCik: "1067983",
          filerName: "Berkshire",
          issuer: "APPLE INC",
          optionType: "",
          periodEnding: "2026-09-30",
          shares: 1,
          symbol: null,
          value: 1,
          weight: null,
        },
      ]
    );
    const holdingsSet = (
      argOf(holdings.calls, "onConflictDoUpdate") as {
        set: Record<string, SQL>;
      }
    ).set;
    expect(render(holdingsSet["symbol"]).sql).toBe(
      'coalesce(excluded."symbol", "openbb_sec_13f_holdings"."symbol")'
    );
    expect(render(holdingsSet["issuer"]).sql).toBe('excluded."issuer"');
    expect(OPENBB_UPSERT_TABLES).toHaveLength(13);
  });

  it("upserts macro points with their series and recomputes the series range", async () => {
    const { calls, database } = createDouble();
    const repository = createOpenbbRepository(database, () => NOW);
    const base = {
      frequency: "daily",
      name: "Effective federal funds rate",
      source: "federal_reserve",
      unit: "percent",
    };
    const written = await repository.upsertMacroPoints([
      { ...base, date: "2026-11-05", seriesId: "EFFR", value: 3.9 },
      { ...base, date: "2026-11-06", seriesId: "EFFR", value: 3.88 },
      { ...base, date: "2026-11-06", seriesId: "EFFR", value: 3.87 },
    ]);
    expect(written).toBe(2);
    expect(methods(calls)).toEqual([
      "transaction",
      "insert",
      "values",
      "onConflictDoUpdate",
      "insert",
      "values",
      "onConflictDoUpdate",
      "execute",
    ]);
    expect(argOf(calls, "values", 0)).toEqual([
      {
        ...base,
        firstDate: "2026-11-06",
        id: "EFFR",
        lastDate: "2026-11-06",
        pointCount: 1,
        updatedAt: NOW,
      },
    ]);
    expect(argOf(calls, "values", 1)).toEqual([
      { date: "2026-11-05", seriesId: "EFFR", value: 3.9 },
      { date: "2026-11-06", seriesId: "EFFR", value: 3.87 },
    ]);
    const update = render(argOf(calls, "execute"));
    expect(update.sql).toContain('update "openbb_macro_series" as s');
    expect(update.params).toEqual(["EFFR"]);
    expect(await repository.upsertMacroPoints([])).toBe(0);
    const clocked = createDouble();
    await createOpenbbRepository(clocked.database).upsertMacroPoints([
      { ...base, date: "2026-11-05", seriesId: "SOFR", value: 3.9 },
    ]);
    const [series] = argOf(clocked.calls, "values") as [{ updatedAt: Date }];
    expect(series.updatedAt).toBeInstanceOf(Date);
    const [foreignKey] = getTableConfig(schema.openbbMacroPoints).foreignKeys;
    expect(foreignKey?.reference().foreignTable).toBe(schema.openbbMacroSeries);
  });

  it("records a run with a copy of its warnings", async () => {
    const run: OpenbbRunInput = {
      error: null,
      finishedAt: NOW,
      job: "cftc-cot",
      openbbVersion: "1.4.0",
      rowsReceived: 3,
      rowsWritten: 3,
      startedAt: NOW,
      status: "ok",
      warnings: ["one"],
    };
    const { calls, database } = createDouble([[{ ...run, id: "run-1" }]]);
    const stored = await createOpenbbRepository(database).recordRun(run);
    expect(stored).toMatchObject({ id: "run-1" });
    expect(methods(calls)).toEqual(["insert", "values", "returning"]);
    expect(argOf(calls, "values")).toEqual({ ...run, warnings: ["one"] });
  });
});

describe("openbb repository reads", () => {
  it("reads runs and table stats", async () => {
    const stats = Array.from({ length: 16 }, (_, index) => [
      { newestDate: index === 0 ? null : "2026-11-06", rows: index },
    ]);
    const { calls, database } = createDouble([[{ job: "cftc-cot" }], ...stats]);
    const repository = createOpenbbRepository(database);
    expect(await repository.latestRuns()).toEqual([{ job: "cftc-cot" }]);
    expect(methods(calls).slice(0, 3)).toEqual([
      "selectDistinctOn",
      "from",
      "orderBy",
    ]);
    const tableStats = await repository.tableStats();
    expect(tableStats[0]).toEqual({
      newestDate: null,
      rows: 0,
      table: "openbb_ingest_runs",
    });
    expect(tableStats.at(-1)).toEqual({
      newestDate: "2026-11-06",
      rows: 15,
      table: "openbb_factor_returns",
    });
  });

  it("reads the vx curve and option iv tables", async () => {
    const { calls, database } = createDouble([
      [{ asOf: "2026-11-06" }, { asOf: "2026-11-05" }],
      [],
      [{ asOf: "2026-11-06", contractMonth: "2026-12", price: 18 }],
      [{ asOf: "2026-11-06", session: 1, underlying: "SPY" }],
      [],
      [{ asOf: "2026-11-06" }],
      [{ asOf: "2026-11-06", underlying: "SPY" }],
      [{ asOf: null }],
    ]);
    const repository = createOpenbbRepository(database);
    expect(await repository.vxCurveDates("2026-11-06", 6)).toEqual([
      "2026-11-06",
      "2026-11-05",
    ]);
    expect(await repository.vxCurveDates(null, 6)).toEqual([]);
    expect(await repository.vxCurve([])).toEqual([]);
    expect(await repository.vxCurve(["2026-11-06"])).toHaveLength(1);
    expect(await repository.optionIvDaily([], null, 252)).toEqual([]);
    expect(await repository.optionIvDaily(["SPY"], "2026-11-06", 252)).toEqual([
      { asOf: "2026-11-06", underlying: "SPY" },
    ]);
    expect(await repository.optionIvDaily(["SPY"], null, 252)).toEqual([]);
    expect(await repository.optionIvTermLatest("2026-11-06")).toEqual([
      { asOf: "2026-11-06", underlying: "SPY" },
    ]);
    expect(await repository.optionIvTermLatest(null)).toEqual([]);
    expect(methods(calls)).toContain("selectDistinct");
    expect(methods(calls)).toContain("as");
  });

  it("reads cot, macro, events, shorts, sec and factors with and without optional filters", async () => {
    const { calls, database } = createDouble([
      [{ market: "ES" }],
      [],
      [{ id: "EFFR" }],
      [{ id: "EFFR" }],
      [{ date: "2026-11-06" }],
      [],
      [{ title: "FOMC" }],
      [],
      [{ symbol: "SPY" }],
      [{ symbol: "SPY" }],
      [{ symbol: "SPY" }],
      [{ cusip: "78462F103" }],
      [],
      [{ symbol: "SPY" }],
      [{ symbol: "SPY" }],
      [{ holding: { cusip: "78462F103" } }],
      [{ holding: { cusip: "78462F103" } }],
      [{ factor: "smb" }],
      [],
    ]);
    const repository = createOpenbbRepository(database);
    expect(await repository.cot("ES", "2026-01-01")).toHaveLength(1);
    expect(await repository.cot(null, "2026-01-01")).toEqual([]);
    expect(await repository.macroSeries(["EFFR"])).toHaveLength(1);
    expect(await repository.macroSeries(null)).toHaveLength(1);
    expect(await repository.macroPoints([], null)).toEqual([]);
    expect(await repository.macroPoints(["EFFR"], "2026-01-01")).toHaveLength(
      1
    );
    expect(await repository.macroPoints(["EFFR"], null)).toEqual([]);
    expect(
      await repository.events("2026-11-01", "2026-12-01", ["fomc"])
    ).toHaveLength(1);
    expect(await repository.events("2026-11-01", "2026-12-01", null)).toEqual(
      []
    );
    expect(await repository.shortVolume("SPY", "2026-09-01")).toHaveLength(1);
    expect(await repository.shortInterest("SPY", "2026-09-01")).toHaveLength(1);
    expect(await repository.otcWeekly("SPY", "2026-09-01")).toHaveLength(1);
    expect(await repository.ftd("SPY", "2026-09-01", 10)).toHaveLength(1);
    expect(await repository.ftd("SPY", null, 10)).toEqual([]);
    expect(await repository.secFilings("SPY", 25)).toHaveLength(1);
    expect(await repository.insiderTrades("SPY", 50)).toHaveLength(1);
    expect(await repository.holdings13f("SPY", [])).toHaveLength(1);
    expect(await repository.holdings13f("SPY", ["78462F103"])).toEqual([
      { cusip: "78462F103" },
    ]);
    expect(await repository.factors("daily", "2026-01-01")).toHaveLength(1);
    expect(await repository.factors("monthly", null)).toEqual([]);
    expect(methods(calls)).toContain("innerJoin");
    expect(methods(calls)).toContain("limit");
  });

  it("is wired into createRepositories", () => {
    const { database } = createDouble();
    expect(createRepositories(database as never).openbb?.upsertRows).toBeTypeOf(
      "function"
    );
  });
});
