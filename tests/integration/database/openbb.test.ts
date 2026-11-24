import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  createMarketBarsRepository,
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

// Migration 0064 (OpenBB data sources), its guarded rollback, idempotent upserts and the reads of
// the openbb repository, plus market daily series upsertPoints, on a real database.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migrationSql = read(
  "../../../packages/db/migrations/0064_openbb_sources.sql"
);
const rollbackSql = read(
  "../../../packages/db/rollback/0064_openbb_sources.down.sql"
);
const congressMigrationSql = read(
  "../../../packages/db/migrations/0085_congress_trades.sql"
);
const congressRollbackSql = read(
  "../../../packages/db/rollback/0085_congress_trades.down.sql"
);
// Migration 0087 adds the run status blocked_upstream; its rollback keeps the runs as failed runs.
const blockedMigrationSql = read(
  "../../../packages/db/migrations/0087_openbb_blocked_upstream.sql"
);
const blockedRollbackSql = read(
  "../../../packages/db/rollback/0087_openbb_blocked_upstream.down.sql"
);
const fullBooksMigrationSql = read(
  "../../../packages/db/migrations/0086_sec_13f_full_books.sql"
);
const fullBooksRollbackSql = read(
  "../../../packages/db/rollback/0086_sec_13f_full_books.down.sql"
);
const form4MigrationSql = read(
  "../../../packages/db/migrations/0089_sec_form4.sql"
);
const form4RollbackSql = read(
  "../../../packages/db/rollback/0089_sec_form4.down.sql"
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

describe("0064 openbb sources (Postgres)", () => {
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

  it("reads the last point of stored series, appends bars after the last bar and reads the last bars", async () => {
    const series = createMarketDailySeriesRepository(db());
    await expect(
      series.upsertPoints(
        { id: "QQQ", kind: "etf", source: "daily-prices", sourceSha256: SHA },
        [
          {
            adjClose: 99,
            close: 100,
            date: "2026-11-05",
            high: 101,
            low: 98,
            open: 99.5,
          },
        ],
        { createIfMissing: false }
      )
    ).rejects.toThrow("no stored series QQQ");
    expect(await series.latestPoints(["QQQ"])).toEqual([]);
    await series.replaceSeries(
      { id: "QQQ", kind: "etf", source: "import qqq.csv", sourceSha256: SHA },
      [
        {
          adjClose: 99,
          close: 100,
          date: "2026-11-05",
          high: 101,
          low: 98,
          open: 99.5,
        },
        {
          adjClose: 100.5,
          close: 101.5,
          date: "2026-11-06",
          high: 102,
          low: 100,
          open: 100,
        },
      ]
    );
    expect(await series.latestPoints(["QQQ", "NOPE"])).toEqual([
      { adjClose: 100.5, close: 101.5, id: "QQQ", lastDate: "2026-11-06" },
    ]);

    const bars = createMarketBarsRepository(db());
    const day = (date: string) => Date.parse(`${date}T00:00:00Z`);
    const row = (date: string, c: number, v: number | null = 10) => ({
      c,
      h: c + 1,
      l: c - 1,
      o: c,
      t: day(date),
      v,
    });
    const key = { symbol: "QQQ", timeframe: "1d" as const };
    await expect(
      bars.appendBars(key, [row("2026-11-06", 100)])
    ).rejects.toThrow("no stored series QQQ:1d");
    await bars.replaceSeries(
      { ...key, source: "import qqq bars", sourceSha256: SHA },
      [row("2026-11-05", 100), row("2026-11-06", 101.5)]
    );
    const { series: stored, written } = await bars.appendBars(key, [
      row("2026-11-06", 999),
      row("2026-11-09", 103, null),
      row("2026-11-10", 104),
    ]);
    expect(written).toBe(2);
    expect(stored).toMatchObject({
      barCount: 4,
      firstT: day("2026-11-05"),
      lastT: day("2026-11-10"),
      source: "import qqq bars",
      sourceSha256: createHash("sha256")
        .update(
          [
            `${day("2026-11-05")}|100|101|99|100|10`,
            `${day("2026-11-06")}|101.5|102.5|100.5|101.5|10`,
            `${day("2026-11-09")}|103|104|102|103|`,
            `${day("2026-11-10")}|104|105|103|104|10`,
          ].join("\n")
        )
        .digest("hex"),
    });
    expect(Array.from((await bars.loadColumns("QQQ:1d")).c)).toEqual([
      100, 101.5, 103, 104,
    ]);
    expect(await bars.appendBars(key, [row("2026-11-10", 100)])).toMatchObject({
      written: 0,
    });
    expect(
      (await bars.latestBars("1d")).filter((bar) => bar.symbol === "QQQ")
    ).toEqual([{ close: 104, lastT: day("2026-11-10"), symbol: "QQQ" }]);
    expect(await bars.latestBars("1m")).toEqual([]);
    // Later tests count the stored points: leave no QQQ rows behind.
    await postgres().query(
      "delete from market_daily_points where series_id = 'QQQ'"
    );
    await postgres().query("delete from market_daily_series where id = 'QQQ'");
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

  it("upserts congress rows twice, keeps first_seen_at and reads by the ledger rule", async () => {
    const repository = createOpenbbRepository(db());
    const houseUrl =
      "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20099001.pdf";
    const trade = (rowNumber: number, ticker: string | null) => ({
      amountHigh: 15_000,
      amountLabel: "$1,001 - $15,000",
      amountLow: 1001,
      asset: "Example Holdings Inc.",
      assetType: "ST",
      chamber: "house" as const,
      docId: "20099001",
      filedOn: "2026-11-03",
      holder: "spouse" as const,
      member: "Hon. Avery Example",
      rowNumber,
      ticker,
      transactionDate: "2026-10-21",
      transactionType: "purchase" as const,
    });
    const filing = {
      amends: false,
      chamber: "house" as const,
      docId: "20099001",
      filedOn: "2026-11-03",
      member: "Hon. Avery Example",
      parserVersion: "house.v1",
      reason: null,
      rowCount: 2,
      stateDistrict: "ZZ01",
      status: "parsed" as const,
      url: houseUrl,
    };
    const scanned = {
      ...filing,
      docId: "8099002",
      reason: "scanned_image" as const,
      rowCount: 0,
      status: "unparsed" as const,
    };
    const trades = [trade(1, "EXMP"), trade(2, null)];
    await repository.upsertRows("congress_trades", trades);
    await repository.upsertRows("congress_filings", [filing, scanned]);
    const firstSeen = async () =>
      await postgres().query<{ at: string }>(
        "select first_seen_at::text as at from openbb_congress_trades union all select first_seen_at::text from openbb_congress_filings order by 1"
      );
    const before = await firstSeen();
    await postgres().query("select pg_sleep(0.02)");
    await repository.upsertRows("congress_trades", trades);
    await repository.upsertRows("congress_filings", [filing, scanned]);
    expect(await firstSeen()).toEqual(before);
    expect(await countRows("openbb_congress_trades")).toBe(2);

    const feed = await repository.congressFeed({ from: "2026-10-20" });
    expect(feed.trades.map((row) => [row.rowNumber, row.url])).toEqual([
      [1, houseUrl],
      [2, houseUrl],
    ]);
    expect(feed.filings.map((row) => row.docId)).toEqual([
      "20099001",
      "8099002",
    ]);
    const filtered = await repository.congressFeed({
      chamber: "house",
      from: "2026-10-20",
      member: "avery",
      ticker: "EXMP",
    });
    expect(filtered.trades).toHaveLength(1);
    expect(
      (await repository.congressFeed({ from: "2026-10-20", member: "%" }))
        .filings
    ).toEqual([]);
    // A shorter re-parse hides the leftover row 2.
    await repository.upsertRows("congress_filings", [
      { ...filing, rowCount: 1 },
    ]);
    expect(
      (await repository.congressFeed({ from: "2026-10-20" })).trades
    ).toHaveLength(1);
    await repository.upsertRows("congress_filings", [
      { ...filing, reason: "layout_unknown", rowCount: 0, status: "unparsed" },
    ]);
    expect(
      (await repository.congressFeed({ from: "2026-10-20" })).trades
    ).toEqual([]);

    await repository.recordRun({
      error: null,
      finishedAt: new Date("2026-11-19T10:00:00Z"),
      job: "congress-house",
      openbbVersion: null,
      rowsReceived: 2,
      rowsWritten: 2,
      startedAt: new Date("2026-11-19T09:59:00Z"),
      status: "ok",
      warnings: [],
    });
    await repository.recordRun({
      error: "boom",
      finishedAt: new Date("2026-11-19T11:00:00Z"),
      job: "congress-house",
      openbbVersion: null,
      rowsReceived: 0,
      rowsWritten: 0,
      startedAt: new Date("2026-11-19T10:59:00Z"),
      status: "failed",
      warnings: [],
    });
    const [house, senate] = await repository.lastRunsFor([
      "congress-house",
      "congress-senate",
    ]);
    expect(house?.latest?.status).toBe("failed");
    expect(house?.latestUsable?.status).toBe("ok");
    expect(senate).toEqual({
      job: "congress-senate",
      latest: null,
      latestUsable: null,
    });
    const reject = (statement: string) =>
      expect(postgres().query(statement)).rejects.toThrow(/_check/u);
    await reject(
      "insert into openbb_congress_filings (amends, chamber, doc_id, filed_on, member, parser_version, reason, row_count, status, url) values (false, 'senate', '20099001', '2026-11-03', 'x', 'senate.v1', null, 0, 'parsed', 'https://x')"
    );
    await reject(
      "insert into openbb_congress_filings (amends, chamber, doc_id, filed_on, member, parser_version, reason, row_count, status, url) values (false, 'house', '1', '2026-11-03', 'x', 'house.v1', null, 3, 'unparsed', 'https://x')"
    );
  });

  it("upserts Form 4 rows twice, keeps first_seen_at and reads state, purchases and insider rows", async () => {
    const repository = createOpenbbRepository(db());
    const accession = (n: number) => `000090000${n}-26-000001`;
    const filing = (n: number, accepted: string) => ({
      acceptedAt: new Date(accepted),
      accessionNumber: accession(n),
      formType: "4" as const,
      indexDay: "2026-11-05",
      issuerCik: "800001",
      issuerName: "Example Widgets Inc",
      issuerSymbol: "EXW",
      parserVersion: "form4.v1",
      periodOfReport: "2026-11-03",
      plan10b51: false,
      reason: null,
      rowCount: 1,
      status: "parsed" as const,
      url: `https://www.sec.gov/${n}`,
    });
    const filings = [
      filing(1, "2026-11-05T21:00:00Z"),
      filing(2, "2026-11-05T21:10:00Z"),
      {
        ...filing(3, "2026-11-05T21:20:00Z"),
        acceptedAt: null,
        issuerCik: null,
        reason: "layout_unknown" as const,
        rowCount: 0,
        status: "unparsed" as const,
      },
    ];
    const transactions = [1, 2].map((n) => ({
      accessionNumber: accession(n),
      acquiredDisposed: "A",
      derivative: false,
      directIndirect: "D",
      price: 10,
      rowNumber: 1,
      securityTitle: "Common Stock",
      shares: 100,
      sharesAfter: 1000,
      transactionCode: "P" as const,
      transactionDate: "2026-11-03",
    }));
    const owners = [1, 2].map((n) => ({
      accessionNumber: accession(n),
      isDirector: true,
      isOfficer: false,
      isOther: false,
      isTenPercentOwner: false,
      officerTitle: null,
      ownerCik: String(700 + n),
      ownerName: `Person ${n}`,
    }));
    const write = async () => {
      await repository.upsertRows("sec_form4_transactions", transactions);
      await repository.upsertRows("sec_form4_owners", owners);
      await repository.upsertRows("sec_form4_filings", filings);
      await repository.upsertRows("sec_form4_index_days", [
        {
          complete: false,
          entriesDone: 3,
          entriesListed: 4,
          indexDay: "2026-11-05",
        },
        {
          complete: true,
          entriesDone: 2,
          entriesListed: 2,
          indexDay: "2026-11-04",
        },
      ]);
    };
    await write();
    const firstSeen = await postgres().query<{ at: string }>(
      "select first_seen_at::text as at from openbb_sec_form4_filings order by accession_number"
    );
    await write();
    expect(
      await postgres().query<{ at: string }>(
        "select first_seen_at::text as at from openbb_sec_form4_filings order by accession_number"
      )
    ).toEqual(firstSeen);
    expect(await countRows("openbb_sec_form4_transactions")).toBe(2);
    expect(
      await repository.form4State("2026-11-01", "2026-11-06", 100)
    ).toEqual({
      completeDays: ["2026-11-04"],
      doneAccessions: [accession(1), accession(2)],
      layoutUnknown: [
        { accessionNumber: accession(3), parserVersion: "form4.v1" },
      ],
    });
    const { owners: buyers, purchases } = await repository.insiderPurchases(
      new Date("2026-11-01T00:00:00Z")
    );
    expect(purchases.map((row) => row.accessionNumber)).toEqual([
      accession(1),
      accession(2),
    ]);
    expect(buyers.map((row) => row.ownerCik)).toEqual(["701", "702"]);
    const rows = await repository.insiderTrades("EXW", 50);
    expect(rows[0]).toMatchObject({
      accessionNumber: accession(2),
      filingDate: "2026-11-05",
      ownerName: "Person 2",
      symbol: "EXW",
    });
    // The ledger hides rows above row_count.
    await repository.upsertRows("sec_form4_filings", [
      { ...filing(2, "2026-11-05T21:10:00Z"), rowCount: 0 },
    ]);
    expect(await repository.insiderTrades("EXW", 50)).toHaveLength(1);
    expect(
      (await repository.form4IndexDays("2026-11-01")).map((day) => day.indexDay)
    ).toEqual(["2026-11-05", "2026-11-04"]);
    await expect(
      postgres().query(
        "insert into openbb_sec_form4_index_days (index_day, entries_listed, entries_done, complete) values ('2026-11-06', 1, 2, false)"
      )
    ).rejects.toThrow(/check/u);
  });

  it("reads blocked streaks and keeps blocked runs through the 0087 rollback", async () => {
    const repository = createOpenbbRepository(db());
    const at = (minutes: number) =>
      new Date(Date.parse("2026-11-19T22:00:00.000Z") + minutes * 60_000);
    const record = async (
      job: string,
      status: "ok" | "blocked_upstream",
      minutes: number
    ) => {
      await repository.recordRun({
        error:
          status === "blocked_upstream"
            ? "HTTP 403 from cdn-api.cboe.com"
            : null,
        finishedAt: at(minutes + 1),
        job,
        openbbVersion: null,
        rowsReceived: 0,
        rowsWritten: 0,
        startedAt: at(minutes),
        status,
        warnings: [],
      });
    };
    // A blocked run before an ok run is not part of the streak.
    await record("cboe-option-iv", "blocked_upstream", 0);
    await record("cboe-option-iv", "ok", 60);
    await record("cboe-option-iv", "blocked_upstream", 120);
    await record("cboe-option-iv", "blocked_upstream", 180);
    // A job that never had another status: every run is in the streak.
    await record("fed-rates", "blocked_upstream", 30);
    // The newest run is ok: no streak.
    await record("cftc-cot", "blocked_upstream", 0);
    await record("cftc-cot", "ok", 60);
    expect(await repository.blockedStreaks()).toEqual([
      { attempts: 2, job: "cboe-option-iv", since: at(120) },
      { attempts: 1, job: "fed-rates", since: at(30) },
    ]);
    const insertRun = (status: string) =>
      postgres().query(
        `insert into openbb_ingest_runs (job, started_at, finished_at, status, rows_received, rows_written) values ('oecd-cli', now(), now(), '${status}', 0, 0)`
      );
    await expect(insertRun("paused")).rejects.toThrow(/_check/u);

    await postgres().query(blockedRollbackSql);
    expect(
      await postgres().query(
        "select status, error from openbb_ingest_runs where job = 'fed-rates'"
      )
    ).toEqual([
      {
        error: "blocked_upstream: HTTP 403 from cdn-api.cboe.com",
        status: "failed",
      },
    ]);
    expect(await repository.blockedStreaks()).toEqual([]);
    await expect(insertRun("blocked_upstream")).rejects.toThrow(/_check/u);
    await postgres().query(blockedMigrationSql);
    await insertRun("blocked_upstream");
    expect((await repository.blockedStreaks()).map(({ job }) => job)).toEqual([
      "oecd-cli",
    ]);
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

  it("stores 13F ledgers, the CUSIP map and FINRA suffix symbols, and reads changes inputs", async () => {
    const repository = createOpenbbRepository(db());
    const holding = (
      accessionNumber: string,
      cusip: string,
      value: number
    ) => ({
      accessionNumber,
      assetClass: null,
      cusip,
      filedOn: "2026-11-14",
      filerCik: "1067983",
      filerName: "BERKSHIRE HATHAWAY INC",
      issuer: "APPLE INC",
      optionType: "" as const,
      periodEnding: "2026-09-30",
      shares: 10,
      symbol: null,
      value,
      weight: null,
    });
    const accession = "0001193125-26-000777";
    await repository.upsertRows("sec_13f_holdings", [
      holding(accession, "037833100", 5),
      holding(accession, "594918104", 7),
    ]);
    expect(await repository.holdings13fCounts([accession])).toEqual(
      new Map([[accession, 2]])
    );
    const ledger = {
      accessionNumber: accession,
      filedOn: "2026-11-14",
      filerCik: "1067983",
      filerName: "BERKSHIRE HATHAWAY INC",
      periodEnding: "2026-09-30",
      rows: 2,
    };
    expect(await repository.upsertRows("sec_13f_filings", [ledger])).toBe(1);
    expect(await repository.upsertRows("sec_13f_filings", [ledger])).toBe(1);
    expect(await repository.sec13fFilings()).toEqual([ledger]);
    expect(await repository.sec13fAccessions(10)).toEqual([accession]);
    expect(
      (
        await repository.holdings13fOfFilings([accession], "AAPL", [
          "037833100",
        ])
      ).map((row) => row.cusip)
    ).toEqual(["037833100"]);

    await repository.upsertRows("cusip_symbols", [
      { cusip: "037833100", lastSeen: "2026-10-15", symbol: "AAPL" },
    ]);
    // An older file never moves last_seen back.
    await repository.upsertRows("cusip_symbols", [
      { cusip: "037833100", lastSeen: "2025-01-15", symbol: "AAPL" },
    ]);
    expect(
      await postgres().query(
        "select last_seen::text as last_seen from openbb_cusip_symbols where cusip = '037833100'"
      )
    ).toEqual([{ last_seen: "2026-10-15" }]);
    expect(await repository.cusipsForSymbol("AAPL")).toContain("037833100");

    await repository.upsertRows("short_volume_daily", [
      {
        date: "2026-11-18",
        shortExemptVolume: 0,
        shortVolume: 1,
        symbol: "AGM/A",
        totalVolume: 2,
      },
      {
        date: "2026-11-18",
        shortExemptVolume: 0,
        shortVolume: 1,
        symbol: "ABRpD",
        totalVolume: 2,
      },
    ]);
    await expect(
      postgres().query(
        "insert into openbb_short_volume_daily (date, symbol, short_volume, short_exempt_volume, total_volume) values ('2026-11-18', 'BAD SYM', 1, 0, 1)"
      )
    ).rejects.toThrow(/openbb_short_volume_daily_check/u);
    await expect(
      postgres().query(
        "insert into openbb_sec_13f_filings (accession_number, filed_on, filer_cik, filer_name, period_ending, rows) values ('12-3', '2026-11-14', '1', 'x', '2026-09-30', 1)"
      )
    ).rejects.toThrow(/openbb_sec_13f_filings_check/u);
  });
  it("computes market-wide 13F quarter-over-quarter changes in Postgres", async () => {
    const repository = createOpenbbRepository(db());
    const q2Acc = "0002000001-26-000001";
    const q3Acc = "0002000001-26-000002";
    const q3LaterAcc = "0002000001-26-000099";
    const gapQ1Acc = "0002000002-26-000001";
    const gapQ3Acc = "0002000002-26-000002";

    await repository.upsertRows("sec_13f_filings", [
      {
        accessionNumber: q2Acc,
        filedOn: "2026-08-14",
        filerCik: "2000001",
        filerName: "ALPHA CAPITAL LP",
        periodEnding: "2026-06-30",
        rows: 4,
      },
      {
        accessionNumber: q3Acc,
        filedOn: "2026-11-12",
        filerCik: "2000001",
        filerName: "ALPHA CAPITAL LP",
        periodEnding: "2026-09-30",
        rows: 4,
      },
      // Later filing for the same period must be ignored in favor of earliest filedOn.
      {
        accessionNumber: q3LaterAcc,
        filedOn: "2026-11-15",
        filerCik: "2000001",
        filerName: "ALPHA CAPITAL LP",
        periodEnding: "2026-09-30",
        rows: 1,
      },
      // Non-consecutive quarters (Q1 -> Q3, missing Q2) must be excluded.
      {
        accessionNumber: gapQ1Acc,
        filedOn: "2026-05-14",
        filerCik: "2000002",
        filerName: "SKIPPED QUARTER FUND",
        periodEnding: "2026-03-31",
        rows: 1,
      },
      {
        accessionNumber: gapQ3Acc,
        filedOn: "2026-11-14",
        filerCik: "2000002",
        filerName: "SKIPPED QUARTER FUND",
        periodEnding: "2026-09-30",
        rows: 1,
      },
    ]);

    await repository.upsertRows("cusip_symbols", [
      { cusip: "67066G104", lastSeen: "2026-11-10", symbol: "NVDA" },
    ]);

    const row = (overrides: {
      accessionNumber: string;
      cusip: string;
      filedOn: string;
      filerCik: string;
      filerName: string;
      issuer: string;
      optionType?: "" | "call" | "put";
      periodEnding: string;
      shares?: number | null;
      symbol?: string | null;
      value: number;
    }) => ({
      assetClass: null,
      optionType: "" as const,
      shares: null,
      symbol: null,
      weight: null,
      ...overrides,
    });

    await repository.upsertRows("sec_13f_holdings", [
      // Q2 holdings for ALPHA CAPITAL LP
      row({
        accessionNumber: q2Acc,
        cusip: "67066G104",
        filedOn: "2026-08-14",
        filerCik: "2000001",
        filerName: "ALPHA CAPITAL LP",
        issuer: "NVIDIA CORP",
        periodEnding: "2026-06-30",
        shares: 100,
        symbol: null,
        value: 10_000,
      }),
      row({
        accessionNumber: q2Acc,
        cusip: "594918104",
        filedOn: "2026-08-14",
        filerCik: "2000001",
        filerName: "ALPHA CAPITAL LP",
        issuer: "MICROSOFT CORP",
        periodEnding: "2026-06-30",
        shares: 500,
        symbol: "MSFT",
        value: 200_000,
      }),
      row({
        accessionNumber: q2Acc,
        cusip: "023135106",
        filedOn: "2026-08-14",
        filerCik: "2000001",
        filerName: "ALPHA CAPITAL LP",
        issuer: "AMAZON COM INC",
        periodEnding: "2026-06-30",
        shares: 300,
        symbol: "AMZN",
        value: 60_000,
      }),
      row({
        accessionNumber: q2Acc,
        cusip: "30303M102",
        filedOn: "2026-08-14",
        filerCik: "2000001",
        filerName: "ALPHA CAPITAL LP",
        issuer: "META PLATFORMS INC",
        periodEnding: "2026-06-30",
        shares: 50,
        symbol: "META",
        value: 25_000,
      }),
      // Q3 holdings for ALPHA CAPITAL LP (earliest original q3Acc)
      row({
        accessionNumber: q3Acc,
        cusip: "67066G104",
        filedOn: "2026-11-12",
        filerCik: "2000001",
        filerName: "ALPHA CAPITAL LP",
        issuer: "NVIDIA CORP",
        periodEnding: "2026-09-30",
        shares: 250,
        symbol: null,
        value: 30_000,
      }),
      row({
        accessionNumber: q3Acc,
        cusip: "594918104",
        filedOn: "2026-11-12",
        filerCik: "2000001",
        filerName: "ALPHA CAPITAL LP",
        issuer: "MICROSOFT CORP",
        periodEnding: "2026-09-30",
        shares: 200,
        symbol: "MSFT",
        value: 80_000,
      }),
      row({
        accessionNumber: q3Acc,
        cusip: "30303M102",
        filedOn: "2026-11-12",
        filerCik: "2000001",
        filerName: "ALPHA CAPITAL LP",
        issuer: "META PLATFORMS INC",
        periodEnding: "2026-09-30",
        shares: 50,
        symbol: "META",
        value: 28_000,
      }),
      row({
        accessionNumber: q3Acc,
        cusip: "88160R101",
        filedOn: "2026-11-12",
        filerCik: "2000001",
        filerName: "ALPHA CAPITAL LP",
        issuer: "TESLA INC",
        periodEnding: "2026-09-30",
        shares: 400,
        symbol: "TSLA",
        value: 100_000,
      }),
      // Non-consecutive filer holdings (must not appear)
      row({
        accessionNumber: gapQ1Acc,
        cusip: "88160R101",
        filedOn: "2026-05-14",
        filerCik: "2000002",
        filerName: "SKIPPED QUARTER FUND",
        issuer: "TESLA INC",
        periodEnding: "2026-03-31",
        shares: 10,
        symbol: "TSLA",
        value: 2000,
      }),
      row({
        accessionNumber: gapQ3Acc,
        cusip: "88160R101",
        filedOn: "2026-11-14",
        filerCik: "2000002",
        filerName: "SKIPPED QUARTER FUND",
        issuer: "TESLA INC",
        periodEnding: "2026-09-30",
        shares: 90,
        symbol: "TSLA",
        value: 20_000,
      }),
    ]);

    const all = await repository.changes13fMarket({
      change: "all",
      limit: 50,
      ticker: null,
    });
    expect(
      all.map((entry) => ({
        accessionNumber: entry.accessionNumber,
        change: entry.change,
        cusip: entry.cusip,
        filedOn: entry.filedOn,
        period: entry.period,
        previousPeriod: entry.previousPeriod,
        previousShares: entry.previousShares,
        shares: entry.shares,
        symbol: entry.symbol,
      }))
    ).toEqual([
      {
        accessionNumber: q3Acc,
        change: "reduced",
        cusip: "594918104",
        filedOn: "2026-11-12",
        period: "2026-09-30",
        previousPeriod: "2026-06-30",
        previousShares: 500,
        shares: 200,
        symbol: "MSFT",
      },
      {
        accessionNumber: q3Acc,
        change: "new",
        cusip: "88160R101",
        filedOn: "2026-11-12",
        period: "2026-09-30",
        previousPeriod: "2026-06-30",
        previousShares: null,
        shares: 400,
        symbol: "TSLA",
      },
      {
        accessionNumber: q3Acc,
        change: "sold",
        cusip: "023135106",
        filedOn: "2026-11-12",
        period: "2026-09-30",
        previousPeriod: "2026-06-30",
        previousShares: 300,
        shares: null,
        symbol: "AMZN",
      },
      {
        accessionNumber: q3Acc,
        change: "added",
        cusip: "67066G104",
        filedOn: "2026-11-12",
        period: "2026-09-30",
        previousPeriod: "2026-06-30",
        previousShares: 100,
        shares: 250,
        symbol: "NVDA",
      },
    ]);

    // Filter by CUSIP-mapped ticker (raw_symbol is null)
    const nvda = await repository.changes13fMarket({
      change: "all",
      limit: 50,
      ticker: "NVDA",
    });
    expect(nvda.map((entry) => [entry.symbol, entry.change])).toEqual([
      ["NVDA", "added"],
    ]);

    // Filter by direct symbol + change kind
    const msftReduced = await repository.changes13fMarket({
      change: "reduced",
      limit: 50,
      ticker: "MSFT",
    });
    expect(msftReduced.map((entry) => [entry.symbol, entry.change])).toEqual([
      ["MSFT", "reduced"],
    ]);

    // Limit caps results in descending max(value, previousValue) order
    const topTwo = await repository.changes13fMarket({
      change: "all",
      limit: 2,
      ticker: null,
    });
    expect(topTwo.map((entry) => entry.symbol)).toEqual(["MSFT", "TSLA"]);
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
    // 0089, 0086 and 0085 drop their tables even with rows in them.
    await postgres().query(form4RollbackSql);
    await postgres().query(fullBooksRollbackSql);
    expect(await countRows("openbb_short_volume_daily")).toBe(0);
    await postgres().query(congressRollbackSql);
    for (const table of await tables())
      await postgres().query(`delete from ${table}`);
    await postgres().query(rollbackSql);
    expect(await tables()).toEqual([]);
    expect(await countRows("market_daily_points")).toBe(7);
    await postgres().query(migrationSql);
    await postgres().query(congressMigrationSql);
    await postgres().query(fullBooksMigrationSql);
    await postgres().query(form4MigrationSql);
    expect(await tables()).toHaveLength(24);
  });
});
