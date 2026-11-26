import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  createOpenbbRepository,
  newYorkDay,
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

/** Tables that migration 0086 (smart-money PR 5) adds. */
const PR5_TABLES = ["openbb_sec_13f_filings", "openbb_cusip_symbols"];
/** Columns that migration 0086 adds to 0064 tables. */
const PR5_COLUMNS = ["accession_number", "filed_on"];

describe("0064 openbb migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0064_openbb_sources.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0064_openbb_sources.down.sql", import.meta.url),
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
    .filter(
      (config) =>
        config.name.startsWith("openbb_") &&
        !config.name.startsWith("openbb_congress_") &&
        !config.name.startsWith("openbb_sec_form4_") &&
        !PR5_TABLES.includes(config.name)
    );

  it("creates every openbb table with its columns and checks, and grants them", () => {
    expect(tables).toHaveLength(16);
    for (const config of tables) {
      expect(migration).toContain(`CREATE TABLE "${config.name}"`);
      for (const column of config.columns)
        if (!PR5_COLUMNS.includes(column.name))
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

describe("0085 congress trades migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0085_congress_trades.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0085_congress_trades.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };

  it("creates both congress tables with checks, indexes and the guarded grant", () => {
    for (const table of [
      schema.openbbCongressTrades,
      schema.openbbCongressFilings,
    ]) {
      const config = getTableConfig(table);
      expect(migration).toContain(`CREATE TABLE "${config.name}"`);
      for (const column of config.columns)
        expect(migration).toContain(`"${column.name}"`);
      for (const check of config.checks)
        expect(migration).toContain(`CONSTRAINT "${check.name}" CHECK`);
      for (const index of config.indexes)
        expect(migration).toContain(`CREATE INDEX "${index.config.name}"`);
      expect(rollback).toContain(`DROP TABLE "public"."${config.name}"`);
    }
    expect(migration).toContain(
      '"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL'
    );
    expect(migration).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN"
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "openbb_congress_trades", "openbb_congress_filings" TO "vertex_research"'
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/iu);
    expect(journal.entries.find((entry) => entry.idx === 85)).toMatchObject({
      tag: "0085_congress_trades",
    });
  });
});

describe("0089 sec form4 migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0089_sec_form4.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0089_sec_form4.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };

  it("creates the four Form 4 tables with checks, indexes and the guarded grant", () => {
    const names: string[] = [];
    for (const table of [
      schema.openbbSecForm4Filings,
      schema.openbbSecForm4Transactions,
      schema.openbbSecForm4Owners,
      schema.openbbSecForm4IndexDays,
    ]) {
      const config = getTableConfig(table);
      names.push(`"${config.name}"`);
      expect(migration).toContain(`CREATE TABLE "${config.name}"`);
      for (const column of config.columns)
        expect(migration).toContain(`"${column.name}"`);
      for (const check of config.checks)
        expect(migration).toContain(`CONSTRAINT "${check.name}" CHECK`);
      for (const index of config.indexes)
        expect(migration).toContain(`CREATE INDEX "${index.config.name}"`);
      expect(rollback).toContain(`DROP TABLE "public"."${config.name}"`);
    }
    expect(migration).toContain(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${names.join(", ")} TO "vertex_research"`
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/iu);
    expect(
      journal.entries.find((entry) => entry.tag === "0089_sec_form4")
    ).toBeDefined();
  });
});

describe("0086 13F full books migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0086_sec_13f_full_books.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0086_sec_13f_full_books.down.sql", import.meta.url),
    "utf8"
  );

  it("creates the ledger and CUSIP map, widens the FINRA symbol CHECK, seeds the map and grants", () => {
    for (const table of [
      schema.openbbSec13fFilings,
      schema.openbbCusipSymbols,
    ]) {
      const config = getTableConfig(table);
      expect(migration).toContain(`CREATE TABLE "${config.name}"`);
      for (const column of config.columns)
        expect(migration).toContain(`"${column.name}"`);
      for (const check of config.checks)
        expect(migration).toContain(`CONSTRAINT "${check.name}" CHECK`);
      for (const index of config.indexes)
        expect(migration).toContain(`CREATE INDEX "${index.config.name}"`);
      expect(rollback).toContain(`DROP TABLE "public"."${config.name}"`);
    }
    expect(migration).toContain(
      'ALTER TABLE "openbb_sec_13f_holdings" ADD COLUMN "accession_number" text'
    );
    expect(migration).toContain(`'^[A-Za-z0-9./^=-]{1,16}$'`);
    expect(migration).toContain('INSERT INTO "openbb_cusip_symbols"');
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "openbb_sec_13f_filings", "openbb_cusip_symbols" TO "vertex_research"'
    );
    expect(rollback).toContain('DROP COLUMN "accession_number"');
    expect(rollback).toContain(`'^[A-Z0-9.^=-]{1,16}$'`);
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/iu);
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
    expect(OPENBB_UPSERT_TABLES).toHaveLength(21);
    const map = createDouble();
    await createOpenbbRepository(map.database).upsertRows("cusip_symbols", [
      { cusip: "78462F103", lastSeen: "2026-10-15", symbol: "SPY" },
    ]);
    const mapSet = (
      argOf(map.calls, "onConflictDoUpdate") as { set: Record<string, SQL> }
    ).set;
    expect(Object.keys(mapSet)).toEqual(["lastSeen"]);
    expect(render(mapSet["lastSeen"]).sql).toBe(
      'greatest(excluded."last_seen", "openbb_cusip_symbols"."last_seen")'
    );
  });

  it("never updates first_seen_at of congress rows on conflict", async () => {
    const { calls, database } = createDouble();
    await createOpenbbRepository(database).upsertRows("congress_filings", [
      {
        amends: false,
        chamber: "house",
        docId: "20001234",
        filedOn: "2026-11-02",
        member: "Hon. Avery Example",
        parserVersion: "house.v1",
        reason: null,
        rowCount: 2,
        stateDistrict: "ZZ01",
        status: "parsed",
        url: "https://example.test/20001234.pdf",
      },
    ]);
    const conflict = argOf(calls, "onConflictDoUpdate") as {
      set: Record<string, SQL>;
      target: unknown[];
    };
    expect(conflict.target).toEqual([
      schema.openbbCongressFilings.chamber,
      schema.openbbCongressFilings.docId,
    ]);
    expect(Object.keys(conflict.set)).not.toContain("firstSeenAt");
    expect(Object.keys(conflict.set)).toContain("rowCount");
    const trades = createDouble();
    await createOpenbbRepository(trades.database).upsertRows(
      "congress_trades",
      [
        {
          amountHigh: 15_000,
          amountLabel: "$1,001 - $15,000",
          amountLow: 1001,
          asset: "Example Corp",
          assetType: "ST",
          chamber: "house",
          docId: "20001234",
          filedOn: "2026-11-02",
          holder: null,
          member: "Hon. Avery Example",
          rowNumber: 1,
          ticker: "EXMP",
          transactionDate: "2026-10-20",
          transactionType: "purchase",
        },
      ]
    );
    const tradeSet = (
      argOf(trades.calls, "onConflictDoUpdate") as { set: Record<string, SQL> }
    ).set;
    expect(Object.keys(tradeSet)).not.toContain("firstSeenAt");
    expect(Object.keys(tradeSet)).toContain("ticker");
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
    const stats = Array.from({ length: 22 }, (_, index) => [
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
      rows: 21,
      table: "openbb_congress_filings",
    });
  });

  it("reads the newest run and the newest ok-or-partial run per job", async () => {
    const failed = { job: "congress-house", status: "failed" };
    const ok = { job: "congress-house", status: "ok" };
    const { calls, database } = createDouble([[failed], [ok]]);
    const repository = createOpenbbRepository(database);
    expect(
      await repository.lastRunsFor(["congress-house", "congress-senate"])
    ).toEqual([
      { job: "congress-house", latest: failed, latestUsable: ok },
      { job: "congress-senate", latest: null, latestUsable: null },
    ]);
    expect(methods(calls).filter((method) => method === "where")).toHaveLength(
      2
    );
    const usable = render(argOf(calls, "where", 1)).sql;
    expect(usable).toContain('"openbb_ingest_runs"."status" in');
    expect(render(argOf(calls, "where", 0)).sql).not.toContain("status");
    expect(await repository.lastRunsFor([])).toEqual([]);
  });

  it("reads the congress feed: parsed filings only, up to row_count, filters optional", async () => {
    const trade = { chamber: "house", docId: "20001234", rowNumber: 1 };
    const filing = { chamber: "house", docId: "20001234" };
    const { calls, database } = createDouble([
      [{ amends: true, trade, url: "https://example.test/a.pdf" }],
      [filing],
      [],
      [],
    ]);
    const repository = createOpenbbRepository(database);
    expect(
      await repository.congressFeed({
        chamber: "house",
        from: "2026-10-01",
        member: "50%_off\\",
        ticker: "EXMP",
      })
    ).toEqual({
      filings: [filing],
      trades: [{ ...trade, amends: true, url: "https://example.test/a.pdf" }],
    });
    const tradeWhere = render(argOf(calls, "where", 0));
    expect(tradeWhere.sql).toContain(
      '"openbb_congress_trades"."row_number" <= "openbb_congress_filings"."row_count"'
    );
    expect(tradeWhere.sql).toContain('"openbb_congress_filings"."status" =');
    expect(tradeWhere.sql).toContain("ilike");
    expect(tradeWhere.params).toEqual([
      "2026-10-01",
      "parsed",
      "EXMP",
      "%50\\%\\_off\\\\%",
      "house",
    ]);
    expect(render(argOf(calls, "where", 1)).params).toEqual([
      "2026-10-01",
      "%50\\%\\_off\\\\%",
      "house",
    ]);
    expect(argOf(calls, "limit")).toBe(5000);
    expect(argOf(calls, "limit", 1)).toBe(5000);
    expect(await repository.congressFeed({ from: "2026-10-01" })).toEqual({
      filings: [],
      trades: [],
    });
    expect(render(argOf(calls, "where", 2)).params).toEqual([
      "2026-10-01",
      "parsed",
    ]);
    expect(render(argOf(calls, "where", 3)).params).toEqual(["2026-10-01"]);
  });

  it("reads the blocked streak of each job whose newest run is blocked", async () => {
    const since = new Date("2026-11-19T22:45:00.000Z");
    const { calls, database } = createDouble([
      [
        { attempts: 2, job: "cboe-option-iv", since },
        { attempts: 0, job: "never", since: null },
      ],
    ]);
    const streaks = await createOpenbbRepository(database).blockedStreaks();
    expect(streaks).toEqual([{ attempts: 2, job: "cboe-option-iv", since }]);
    // The inner query (newest run with a different status) is built first, then the grouped read.
    expect(methods(calls)).toEqual([
      "select",
      "from",
      "where",
      "select",
      "from",
      "where",
      "groupBy",
      "orderBy",
    ]);
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
      [],
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

  it("reads the Form 4 state: complete days, done and layout_unknown accessions", async () => {
    const { calls, database } = createDouble([
      [{ indexDay: "2026-11-04" }],
      [
        {
          accessionNumber: "0000000001-26-000001",
          parserVersion: "form4.v1",
          reason: null,
        },
        {
          accessionNumber: "0000000002-26-000002",
          parserVersion: "form4.v1",
          reason: "no_xml",
        },
        {
          accessionNumber: "0000000003-26-000003",
          parserVersion: "form4.v0",
          reason: "layout_unknown",
        },
      ],
      [],
      [],
      [],
      [{ accessionNumber: "a" }, { accessionNumber: "b" }],
    ]);
    const repository = createOpenbbRepository(database);
    expect(await repository.form4State("2026-11-01", "2026-11-05", 10)).toEqual(
      {
        completeDays: ["2026-11-04"],
        doneAccessions: ["0000000001-26-000001", "0000000002-26-000002"],
        layoutUnknown: [
          {
            accessionNumber: "0000000003-26-000003",
            parserVersion: "form4.v0",
          },
        ],
      }
    );
    expect(render(argOf(calls, "where", 1)).sql).toContain("not in");
    expect(argOf(calls, "limit")).toBe(11);
    expect(await repository.form4State("2026-11-01", "2026-11-05", 10)).toEqual(
      {
        completeDays: [],
        doneAccessions: [],
        layoutUnknown: [],
      }
    );
    expect(render(argOf(calls, "where", 3)).sql).not.toContain("not in");
    await expect(
      repository.form4State("2026-11-01", "2026-11-05", 1)
    ).rejects.toThrow("more than 1 ledger rows");
  });

  it("reads Form 4 purchases with owners, insider rows of a symbol and index days", async () => {
    const accepted = new Date("2026-11-05T21:30:12Z");
    const { calls, database } = createDouble([
      [
        { acceptedAt: accepted, accessionNumber: "a", issuerCik: "1" },
        { acceptedAt: null, accessionNumber: "b", issuerCik: "1" },
        { acceptedAt: accepted, accessionNumber: "c", issuerCik: null },
      ],
      [{ accessionNumber: "a", ownerCik: "7" }],
      [
        {
          acceptedAt: accepted,
          accessionNumber: "a",
          acquiredDisposed: "A",
          price: 12.5,
          rowNumber: 1,
          shares: 1000,
          sharesAfter: 11_000,
          transactionCode: "P",
          transactionDate: "2026-11-03",
          url: "https://www.sec.gov/a",
        },
        {
          acceptedAt: null,
          accessionNumber: "b",
          acquiredDisposed: "X",
          price: null,
          rowNumber: 1,
          shares: null,
          sharesAfter: null,
          transactionCode: null,
          transactionDate: null,
          url: "https://www.sec.gov/b",
        },
      ],
      [
        { accessionNumber: "a", officerTitle: null, ownerName: "Doe Jane" },
        {
          accessionNumber: "a",
          officerTitle: "x".repeat(250),
          ownerName: "Doe Family Trust",
        },
      ],
      [],
      [{ indexDay: "2026-11-05" }],
    ]);
    const repository = createOpenbbRepository(
      database,
      () => new Date("2026-11-06T15:00:00Z")
    );
    expect(
      await repository.insiderPurchases(new Date("2026-10-01T00:00:00Z"))
    ).toEqual({
      owners: [{ accessionNumber: "a", ownerCik: "7" }],
      purchases: [
        { acceptedAt: accepted, accessionNumber: "a", issuerCik: "1" },
      ],
    });
    expect(render(argOf(calls, "where", 0)).params).toEqual(
      expect.arrayContaining(["parsed", "4", "P", "A"])
    );
    const rows = await repository.insiderTrades("EXW", 50);
    expect(rows[0]).toMatchObject({
      acquiredDisposed: "A",
      filingDate: "2026-11-05",
      ownerName: "Doe Jane; Doe Family Trust",
      symbol: "EXW",
    });
    expect(rows[0]?.ownerTitle).toHaveLength(200);
    expect(rows[1]).toMatchObject({
      acquiredDisposed: null,
      filingDate: "2026-11-06",
      ownerName: "Unknown reporting person",
      ownerTitle: null,
    });
    expect(argOf(calls, "limit", 0)).toBe(50);
    expect(await repository.insiderTrades("NONE", 50)).toEqual([]);
    expect(await repository.form4IndexDays("2026-10-01")).toEqual([
      { indexDay: "2026-11-05" },
    ]);
    expect(newYorkDay(new Date("2026-11-06T03:00:00Z"))).toBe("2026-11-05");
  });

  it("reads the 13F ledger, CUSIP map, book rows and holdings counts", async () => {
    const ledgerRow = { accessionNumber: "0001193125-26-000001" };
    const { calls, database } = createDouble([
      [{ cusip: "78462F103" }],
      [ledgerRow],
      [ledgerRow],
      [{ cusip: "037833100" }],
      [{ cusip: "78462F103" }],
      [{ accessionNumber: "0001193125-26-000001", rows: 3 }],
    ]);
    const repository = createOpenbbRepository(database);
    expect(await repository.cusipsForSymbol("SPY")).toEqual(["78462F103"]);
    expect(await repository.sec13fAccessions(5000)).toEqual([
      "0001193125-26-000001",
    ]);
    expect(argOf(calls, "limit")).toBe(5000);
    expect(await repository.sec13fFilings()).toEqual([ledgerRow]);
    expect(await repository.holdings13fOfFilings([], "SPY", [])).toEqual([]);
    expect(
      await repository.holdings13fOfFilings(["0001193125-26-000001"], "SPY", [])
    ).toEqual([{ cusip: "037833100" }]);
    expect(
      await repository.holdings13fOfFilings(["0001193125-26-000001"], "SPY", [
        "78462F103",
      ])
    ).toEqual([{ cusip: "78462F103" }]);
    expect(await repository.holdings13fCounts([])).toEqual(new Map());
    expect(
      await repository.holdings13fCounts(["0001193125-26-000001"])
    ).toEqual(new Map([["0001193125-26-000001", 3]]));
    expect(methods(calls)).toContain("selectDistinct");
    expect(methods(calls)).toContain("groupBy");
  });

  it("runs changes13fMarket SQL for both unfiltered and ticker/change-filtered queries", async () => {
    const rawRow = {
      accessionNumber: "0001193125-26-000001",
      change: "added",
      cusip: "037833100",
      filedOn: "2026-11-11",
      filerCik: "1067983",
      filerName: "Berkshire Hathaway",
      issuer: "Apple Inc.",
      optionType: "",
      period: "2026-09-30",
      previousPeriod: "2026-06-30",
      previousShares: "100",
      previousValue: "10000",
      shares: "200",
      symbol: "AAPL",
      value: "20000",
    };
    const nullRow = {
      ...rawRow,
      change: "new",
      previousShares: null,
      previousValue: null,
      shares: null,
      symbol: null,
      value: null,
    };
    const { calls, database } = createDouble([
      { rows: [rawRow, nullRow] } as unknown as unknown[],
      { rows: [rawRow] } as unknown as unknown[],
    ]);
    const repository = createOpenbbRepository(database);
    const all = await repository.changes13fMarket({
      change: "all",
      limit: 50,
      ticker: null,
    });
    expect(all).toHaveLength(2);
    expect(all[0]?.shares).toBe(200);
    expect(all[1]?.shares).toBeNull();
    expect(all[1]?.symbol).toBeNull();
    const sqlAll = render(argOf(calls, "execute", 0)).sql;
    expect(sqlAll).toContain("change <> 'unchanged'");
    expect(sqlAll).toContain(
      "order by cs.last_seen desc, cs.symbol asc limit 1"
    );

    const filtered = await repository.changes13fMarket({
      change: "added",
      limit: 10,
      ticker: "AAPL",
    });
    expect(filtered).toHaveLength(1);
    const sqlFiltered = render(argOf(calls, "execute", 1));
    expect(sqlFiltered.sql).toContain("change = $");
    expect(sqlFiltered.params).toContain("AAPL");
  });

  it("is wired into createRepositories", () => {
    const { database } = createDouble();
    expect(createRepositories(database as never).openbb?.upsertRows).toBeTypeOf(
      "function"
    );
  });
});
