import {
  createMarketBarsRepository,
  createMarketDailySeriesRepository,
  createNodeDatabase,
  type Database,
  type MarketBarRow,
  type MarketDailyPoint,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Append mode of the stored daily prices (card vertex-daily-series-refresh) on a real database:
// upsertPoints with the append argument and appendBars write only rows after the last stored
// row, keep the stored rows byte for byte and refuse a gap.
const SHA = "e".repeat(64);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 2);

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const db = (): Database => {
  if (resource === undefined) throw new Error("Database not started");
  return resource.db;
};
const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};

const point = (
  date: string,
  close: number,
  adjClose: number | null
): MarketDailyPoint => ({
  adjClose,
  close,
  date,
  high: close + 1,
  low: close - 1,
  open: close,
});

const bar = (t: number, c: number, v: number | null = 1000): MarketBarRow => ({
  c,
  h: c + 1,
  l: c - 1,
  o: c,
  t,
  v,
});

describe("append mode of stored daily prices (Postgres)", () => {
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

  it("appends daily points after the seam with adj_close on the stored basis", async () => {
    const repository = createMarketDailySeriesRepository(db());
    await repository.replaceSeries(
      { id: "SPY", kind: "etf", source: "import", sourceSha256: SHA },
      [point("2026-11-05", 590, 49), point("2026-11-06", 600, 50)]
    );
    const storedBefore = await postgres().query<{ row: string }>(
      "select row(p.*)::text as row from market_daily_points p where series_id = 'SPY' order by date"
    );
    const input = {
      id: "SPY",
      kind: "etf",
      source: "daily-prices",
      sourceSha256: SHA,
    } as const;
    const options = { linkAdjClose: true, seamCloseTolerance: 0.005 };
    const batch = [
      point("2026-11-05", 1, 1),
      point("2026-11-06", 600.5, 80),
      point("2026-11-09", 610, 88),
      point("2026-11-10", 620, 99),
    ];

    const first = await repository.upsertPoints(input, batch, options);
    expect(first.written).toBe(2);
    expect(first.series).toMatchObject({
      firstDate: "2026-11-05",
      kind: "etf",
      lastDate: "2026-11-10",
      pointCount: 4,
      source: "import",
    });
    const columns = (await repository.loadSeries(["SPY"])).get("SPY");
    expect(columns?.dates).toEqual([
      "2026-11-05",
      "2026-11-06",
      "2026-11-09",
      "2026-11-10",
    ]);
    expect(columns?.adjClose).toEqual([49, 50, 55, 61.875]);
    expect(columns?.close).toEqual([590, 600, 610, 620]);
    expect(first.series.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.series.sourceSha256).not.toBe(SHA);

    // A second run of the same batch: the seam is now 2026-11-10 and nothing is after it.
    const second = await repository.upsertPoints(input, batch, options);
    expect(second.written).toBe(0);
    const storedAfter = await postgres().query<{ row: string }>(
      "select row(p.*)::text as row from market_daily_points p where series_id = 'SPY' order by date limit 2"
    );
    expect(storedAfter).toEqual(storedBefore);
  });

  it("refuses a gap, a close mismatch and a missing series for daily points", async () => {
    const repository = createMarketDailySeriesRepository(db());
    const input = {
      id: "SPY",
      kind: "etf",
      source: "daily-prices",
      sourceSha256: SHA,
    } as const;
    const options = { linkAdjClose: true, seamCloseTolerance: 0.005 };
    await expect(
      repository.upsertPoints(input, [point("2026-11-12", 630, 100)], options)
    ).rejects.toThrow("send rows from 2026-11-10");
    await expect(
      repository.upsertPoints(
        input,
        [point("2026-11-10", 624.5, 99), point("2026-11-11", 630, 100)],
        options
      )
    ).rejects.toThrow("close on 2026-11-10 differs from the stored close");
    await expect(
      repository.upsertPoints(
        { ...input, id: "QQQ" },
        [point("2026-11-10", 620, 99)],
        options
      )
    ).rejects.toThrow("series is not imported");
    const [row] = await postgres().query<{ n: number }>(
      "select count(*)::int as n from market_daily_points"
    );
    expect(row?.n).toBe(4);
  });

  it("appends bars after the last stored bar and keeps the stored bars", async () => {
    const repository = createMarketBarsRepository(db());
    await repository.replaceSeries(
      { source: "import", sourceSha256: SHA, symbol: "QQQ", timeframe: "1d" },
      [bar(T0, 680), bar(T0 + DAY, 685)]
    );
    const batch = [
      bar(T0, 2),
      bar(T0 + DAY, 685.5),
      bar(T0 + 2 * DAY, 690, null),
      bar(T0 + 3 * DAY, 700),
    ];
    const options = { seamCloseTolerance: 0.005 };

    const first = await repository.appendBars("QQQ", "1d", batch, options);
    expect(first.written).toBe(2);
    expect(first.series).toMatchObject({
      barCount: 4,
      firstT: T0,
      lastT: T0 + 3 * DAY,
      source: "import",
      sourceSha256: SHA,
    });
    const columns = await repository.loadColumns("QQQ:1d");
    expect([...columns.c]).toEqual([680, 685, 690, 700]);
    expect([...(columns.v ?? [])]).toEqual([1000, 1000, Number.NaN, 1000]);

    const second = await repository.appendBars("QQQ", "1d", batch, options);
    expect(second.written).toBe(0);
    expect((await repository.getSeries("QQQ", "1d"))?.barCount).toBe(4);
  });

  it("refuses a gap, a close mismatch and a missing series for bars", async () => {
    const repository = createMarketBarsRepository(db());
    const options = { seamCloseTolerance: 0.005 };
    await expect(
      repository.appendBars("QQQ", "1d", [bar(T0 + 5 * DAY, 710)], options)
    ).rejects.toThrow("send rows from 2026-11-05");
    await expect(
      repository.appendBars(
        "QQQ",
        "1d",
        [bar(T0 + 3 * DAY, 705), bar(T0 + 4 * DAY, 710)],
        options
      )
    ).rejects.toThrow("close on 2026-11-05 differs from the stored close");
    await expect(
      repository.appendBars("DIA", "1d", [bar(T0, 400)], options)
    ).rejects.toThrow("series is not imported");
    const [row] = await postgres().query<{ n: number }>(
      "select count(*)::int as n from market_bars"
    );
    expect(row?.n).toBe(4);
  });
});
