import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  createMarketDailySeriesRepository,
  createNodeDatabase,
  createOpenbbRepository,
  type Database,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0063 (OpenBB data sources), its guarded rollback, idempotent upserts and the reads of
// the openbb repository, plus market daily series upsertPoints, on a real database.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migrationSql = read(
  "../../../packages/db/migrations/0063_openbb_sources.sql"
);
const rollbackSql = read(
  "../../../packages/db/rollback/0063_openbb_sources.down.sql"
);
const SHA = "e".repeat(64);

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};
const db = (): Database => {
  if (resource === undefined) throw new Error("Database not started");
  return resource.db;
};

const countRows = async (table: string): Promise<number> => {
  const [row] = await postgres().query<{ n: number }>(
    `select count(*)::int as n from ${table}`
  );
  return row?.n ?? Number.NaN;
};

const ivRow = (asOf: string, atmIv30d: number | null) => ({
  asOf,
  atmIv30d,
  callIv25d30d: null,
  callOi: 10,
  callVolume: 5,
  callWall: 600,
  contracts: 1200,
  gammaFlip: 580,
  netGex: -1.5e9,
  putIv25d30d: 0.2,
  putOi: 12,
  putVolume: 6,
  putWall: 550,
  underlying: "SPY",
  underlyingPrice: 590.25,
});

describe("0063 openbb sources (Postgres)", () => {
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

  it("upserts the same batch twice into the same rows", async () => {
    const repository = createOpenbbRepository(db());
    const curve = [
      { asOf: "2026-11-06", contractMonth: "2026-12", price: 18.1 },
      { asOf: "2026-11-06", contractMonth: "2027-01", price: 19.2 },
    ];
    expect(await repository.upsertRows("vx_curve", curve)).toBe(2);
    expect(
      await repository.upsertRows("vx_curve", [
        ...curve.slice(0, 1),
        { ...curve[1], price: 19.3 } as (typeof curve)[number],
      ])
    ).toBe(2);
    expect(await countRows("openbb_vx_curve")).toBe(2);
    const [row] = await postgres().query<{ price: number }>(
      "select price from openbb_vx_curve where contract_month = '2027-01'"
    );
    expect(row?.price).toBe(19.3);

    const holding = {
      assetClass: null,
      cusip: "78462F103",
      filerCik: "1067983",
      filerName: "Berkshire",
      issuer: "SPDR S&P 500",
      optionType: "" as const,
      periodEnding: "2026-09-30",
      shares: 100,
      value: 59_000,
      weight: null,
    };
    await repository.upsertRows("sec_13f_holdings", [holding]);
    await repository.upsertRows("sec_13f_holdings", [holding]);
    expect(await countRows("openbb_sec_13f_holdings")).toBe(1);
  });

  it("upserts macro points and recomputes the series range", async () => {
    const repository = createOpenbbRepository(db());
    const base = {
      frequency: "daily",
      name: "Effective federal funds rate",
      seriesId: "EFFR",
      source: "federal_reserve",
      unit: "percent",
    };
    const batch = [
      { ...base, date: "2026-11-05", value: 3.88 },
      { ...base, date: "2026-11-06", value: 3.87 },
    ];
    await repository.upsertMacroPoints(batch);
    await repository.upsertMacroPoints(batch);
    await repository.upsertMacroPoints([
      { ...base, date: "2026-10-01", name: "EFFR", value: 4.1 },
    ]);
    expect(await countRows("openbb_macro_points")).toBe(3);
    const [series] = await repository.macroSeries(["EFFR"]);
    expect(series).toMatchObject({
      firstDate: "2026-10-01",
      lastDate: "2026-11-06",
      name: "EFFR",
      pointCount: 3,
    });
    expect(await repository.macroPoints(["EFFR"], "2026-11-01")).toHaveLength(
      2
    );
  });

  it("upserts vol index points, keeps adjusted closes and recounts the series", async () => {
    const repository = createMarketDailySeriesRepository(db());
    const series = {
      id: "VIX",
      kind: "index" as const,
      source: "cboe",
      sourceSha256: SHA,
    };
    const points = [
      {
        adjClose: null,
        close: 18,
        date: "2026-11-05",
        high: 19,
        low: 17,
        open: 18.5,
      },
      {
        adjClose: null,
        close: 19,
        date: "2026-11-06",
        high: 20,
        low: 18,
        open: 18.2,
      },
    ];
    await repository.upsertPoints(series, points);
    await postgres().query(
      "update market_daily_points set adj_close = 17.9 where series_id = 'VIX' and date = '2026-11-05'"
    );
    const { series: stored, written } = await repository.upsertPoints(series, [
      ...points,
      {
        adjClose: null,
        close: 20,
        date: "2026-11-09",
        high: null,
        low: null,
        open: null,
      },
    ]);
    expect(stored).toMatchObject({
      firstDate: "2026-11-05",
      lastDate: "2026-11-09",
      pointCount: 3,
    });
    expect(written).toBe(3);
    const loaded = await repository.loadSeries(["VIX"]);
    expect(loaded.get("VIX")?.adjClose).toEqual([17.9, null, null]);
    expect(await countRows("market_daily_points")).toBe(3);
  });

  it("only appends newer dates to an imported series and keeps its source; the digest covers storage", async () => {
    const repository = createMarketDailySeriesRepository(db());
    const bar = (date: string, close: number, open: number | null = null) => ({
      adjClose: null,
      close,
      date,
      high: null,
      low: null,
      open,
    });
    await repository.replaceSeries(
      {
        id: "VVIX",
        kind: "index",
        source: "import vvix.csv",
        sourceSha256: SHA,
      },
      [bar("2026-11-04", 90), bar("2026-11-05", 91.5)]
    );
    const cboe = {
      id: "VVIX",
      kind: "index" as const,
      source: "cboe",
      sourceSha256: SHA,
    };
    const { series: stored, written } = await repository.upsertPoints(cboe, [
      bar("2026-11-05", 99),
      bar("2026-11-06", 92.25, 91),
    ]);
    expect(written).toBe(1);
    expect(stored).toMatchObject({
      lastDate: "2026-11-06",
      pointCount: 3,
      source: "import vvix.csv",
    });
    expect((await repository.loadSeries(["VVIX"])).get("VVIX")?.close).toEqual([
      90, 91.5, 92.25,
    ]);
    const expected = createHash("sha256")
      .update(
        [
          "2026-11-04||||90|",
          "2026-11-05||||91.5|",
          "2026-11-06|91|||92.25|",
        ].join("\n")
      )
      .digest("hex");
    expect(stored.sourceSha256).toBe(expected);
    // Nothing newer: the series is returned unchanged.
    const again = await repository.upsertPoints(cboe, [bar("2026-11-06", 1)]);
    expect(again).toMatchObject({ written: 0 });
    expect(again.series.sourceSha256).toBe(expected);
    expect(await countRows("market_daily_points")).toBe(6);
  });

  it("computes the same digest whatever the session's float and date settings", async () => {
    const close = 0.1 + 0.2; // 0.30000000000000004: extra_float_digits = 0 would print 0.3
    const name = postgres().databaseName;
    // New connections of this database start with settings that would change the text of floats
    // and dates; upsertPoints must not depend on them.
    await postgres().query(
      `alter database "${name}" set extra_float_digits = 0`
    );
    await postgres().query(
      `alter database "${name}" set datestyle = 'SQL, DMY'`
    );
    const skewed = createNodeDatabase({
      connectionString: postgres().databaseUrl,
      maxConnections: 1,
    });
    try {
      const { series } = await createMarketDailySeriesRepository(
        skewed.db
      ).upsertPoints(
        { id: "VXN", kind: "index", source: "cboe", sourceSha256: SHA },
        [
          {
            adjClose: null,
            close,
            date: "2026-11-06",
            high: null,
            low: null,
            open: null,
          },
        ]
      );
      expect(series.sourceSha256).toBe(
        createHash("sha256")
          .update(`2026-11-06||||${String(close)}|`)
          .digest("hex")
      );
    } finally {
      await skewed.close();
      await postgres().query(`alter database "${name}" reset all`);
    }
  });

  it("reads runs, stats, iv windows, term rows and 13F holders", async () => {
    const repository = createOpenbbRepository(db());
    const started = new Date("2026-11-06T21:00:00.000Z");
    for (const status of ["failed", "ok"] as const)
      await repository.recordRun({
        error: status === "failed" ? "fetcher exited 3" : null,
        finishedAt: new Date(started.getTime() + 60_000),
        job: "cboe-vx-curve",
        openbbVersion: "1.4.0",
        rowsReceived: 2,
        rowsWritten: status === "ok" ? 2 : 0,
        startedAt:
          status === "ok" ? new Date(started.getTime() + 1000) : started,
        status,
        warnings: [],
      });
    const runs = await repository.latestRuns();
    expect(runs.map((run) => run.status)).toEqual(["ok"]);
    const stats = await repository.tableStats();
    expect(stats.find((stat) => stat.table === "openbb_vx_curve")).toEqual({
      newestDate: "2026-11-06",
      rows: 2,
      table: "openbb_vx_curve",
    });

    const days = Array.from({ length: 260 }, (_, index) =>
      new Date(Date.UTC(2025, 0, 1) + index * 86_400_000)
        .toISOString()
        .slice(0, 10)
    );
    await repository.upsertRows(
      "option_iv_daily",
      days.map((day, index) => ivRow(day, 0.1 + index / 1000))
    );
    const window = await repository.optionIvDaily(["SPY"], null, 252);
    expect(window).toHaveLength(252);
    expect(window[0]?.asOf).toBe(days[8]);
    expect(window.at(-1)?.asOf).toBe(days[259]);
    expect(
      (await repository.optionIvDaily(["SPY"], days[19] as string, 252)).length
    ).toBe(20);

    const term = (asOf: string, expiration: string) => ({
      asOf,
      atmIv: 0.18,
      atmStrike: 590,
      callOi: 1,
      callVolume: 1,
      dte: 7,
      expiration,
      putOi: 1,
      putVolume: 1,
      underlying: "SPY",
    });
    await repository.upsertRows("option_iv_term", [
      term("2026-11-05", "2026-11-12"),
      term("2026-11-06", "2026-11-13"),
      term("2026-11-06", "2026-11-20"),
    ]);
    expect(await repository.optionIvTermLatest(null)).toHaveLength(2);
    expect(await repository.optionIvTermLatest("2026-11-05")).toHaveLength(1);
    expect(await repository.optionIvTermLatest("2020-01-01")).toEqual([]);

    // Without a symbol a row matches only through the FTD CUSIP fallback.
    expect(await repository.holdings13f("SPY", ["78462F103"])).toHaveLength(1);
    expect(await repository.holdings13f("SPY", [])).toEqual([]);
    await repository.upsertRows("sec_13f_holdings", [
      {
        assetClass: null,
        cusip: "037833100",
        filerCik: "1067983",
        filerName: "Berkshire",
        issuer: "APPLE INC",
        optionType: "",
        periodEnding: "2026-09-30",
        shares: 10,
        symbol: "AAPL",
        value: 2250,
        weight: null,
      },
    ]);
    expect(
      (await repository.holdings13f("AAPL", [])).map((row) => row.symbol)
    ).toEqual(["AAPL"]);
    expect(await repository.holdings13f("AAPL", ["78462F103"])).toHaveLength(2);
    await expect(
      postgres().query(
        "update openbb_sec_13f_holdings set symbol = 'bad symbol' where symbol = 'AAPL'"
      )
    ).rejects.toThrow(/_check/u);
    expect(await repository.vxCurveDates(null, 6)).toEqual(["2026-11-06"]);
  });

  it("refuses rows that break the checks", async () => {
    const reject = (statement: string) =>
      expect(postgres().query(statement)).rejects.toThrow(/_check/u);
    await reject(
      "insert into openbb_vx_curve values ('2026-11-06', '2026-13', 1)"
    );
    await reject(
      "insert into openbb_vx_curve values ('2026-11-06', '2026-12', 'NaN'::float8)"
    );
    await reject(
      "insert into openbb_factor_returns values ('2026-11-06', 'weekly', 'smb', 1)"
    );
    await reject(
      "insert into openbb_option_iv_term (as_of, underlying, expiration, dte, call_oi, put_oi, call_volume, put_volume) values ('2026-11-06', 'SPY', '2026-11-05', 0, 0, 0, 0, 0)"
    );
    await reject(
      "insert into openbb_ingest_runs (job, started_at, finished_at, status, rows_received, rows_written) values ('fed-rates', now(), now() - interval '1 minute', 'ok', 0, 0)"
    );
    await reject(
      "insert into openbb_sec_13f_holdings (filer_cik, period_ending, cusip, option_type, filer_name, issuer, value) values ('1', '2026-09-30', '78462F103', 'swap', 'x', 'y', 1)"
    );
  });

  it("refuses the rollback while rows exist", async () => {
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    await postgres().query("ROLLBACK");
    expect(await countRows("openbb_vx_curve")).toBe(2);
  });

  return it("rolls back when empty and the migration applies again", async () => {
    const tables = async () =>
      (
        await postgres().query<{ name: string }>(
          "select table_name as name from information_schema.tables where table_schema = 'public' and table_name like 'openbb_%' order by 1"
        )
      ).map((row) => row.name);
    for (const table of await tables())
      await postgres().query(`delete from ${table}`);
    await postgres().query(rollbackSql);
    expect(await tables()).toEqual([]);
    expect(await countRows("market_daily_points")).toBe(7);
    await postgres().query(migrationSql);
    expect(await tables()).toHaveLength(16);
  });
});
