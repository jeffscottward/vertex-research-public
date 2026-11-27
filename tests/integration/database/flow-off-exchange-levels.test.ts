import {
  createFlowRepository,
  createNodeDatabase,
  createOpenbbRepository,
  type DatabaseResource,
  type FlowEventRecord,
  type FlowMinuteRecord,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real Postgres proof for the SQL queries behind flow.offExchangeLevels:
// - newestMinuteAt(symbol) returns the newest stored flow_minutes.minute for SPY only
// - readMinutes({ symbol, from, to }) enforces [from, to) end-exclusive bounds ascending
// - readEvents({ symbol, from, to, kinds: ["off_exchange_print"], limit }) isolates off-exchange prints
// - openbb.otcWeekly("SPY", from) returns ATS and non-ATS weekly context rows

let testDatabase: PostgresTestDatabase;
let databaseResource: DatabaseResource;

const minuteRow = (
  symbol: FlowMinuteRecord["symbol"],
  minute: Date,
  close: number,
  offExchangeVolume: number
): FlowMinuteRecord => ({
  absorption: null,
  buyVolume: 60_000,
  close,
  coveredSeconds: 60,
  delta: 20_000,
  high: close + 0.15,
  largePrintVolume: offExchangeVolume,
  largePrints: offExchangeVolume >= 10_000 ? 1 : 0,
  low: close - 0.15,
  minute,
  offExchangeVolume,
  open: close - 0.05,
  sellVolume: 40_000,
  stackedBuy: 0,
  stackedSell: 0,
  symbol,
  trades: 300,
  volume: 100_000,
  vwap: close,
});

const eventRow = (
  overrides: Partial<FlowEventRecord> &
    Pick<FlowEventRecord, "at" | "key" | "kind" | "symbol">
): FlowEventRecord => ({
  detail: "25000 @ 592.4 off-exchange (FINRA TRF), buy (quote rule)",
  direction: "bullish",
  premium: null,
  price: 592.4,
  size: 25_000,
  source: "ibkr",
  ...overrides,
});

describe("flow off-exchange levels queries on real Postgres", {
  concurrent: false,
}, () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    databaseResource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 4,
    });
    return await migrate(databaseResource.db);
  }, 60_000);

  afterAll(async () => {
    try {
      if (databaseResource !== undefined) return await databaseResource.close();
      return;
    } finally {
      if (testDatabase !== undefined)
        await dropPostgresTestDatabase(testDatabase);
    }
  });

  it("isolates SPY minutes, enforces [from, to) bounds, filters off_exchange_print events, and reads FINRA weekly rows", async () => {
    const flow = createFlowRepository(databaseResource.db);
    const openbb = createOpenbbRepository(databaseResource.db);

    expect(await flow.newestMinuteAt("SPY")).toBeNull();

    const m1 = new Date("2026-11-20T14:30:00.000Z");
    const m2 = new Date("2026-11-20T14:35:00.000Z");
    const m3 = new Date("2026-11-20T21:00:00.000Z");
    await flow.upsertMinutes([
      minuteRow("SPY", m2, 592.6, 40_000),
      minuteRow("SPY", m1, 592.2, 25_000),
      minuteRow("SPY", m3, 592.8, 10_000),
      minuteRow("ES", new Date("2026-11-20T22:00:00.000Z"), 5950, 0),
    ]);

    expect(await flow.newestMinuteAt("SPY")).toEqual(m3);

    const minutes = await flow.readMinutes({ from: m1, symbol: "SPY", to: m3 });
    expect(minutes.map((row) => row.minute.toISOString())).toEqual([
      m1.toISOString(),
      m2.toISOString(),
    ]);
    expect(minutes.map((row) => row.offExchangeVolume)).toEqual([
      25_000, 40_000,
    ]);

    await flow.insertEvents([
      eventRow({
        at: new Date("2026-11-20T14:31:10.000Z"),
        key: "print:1:592.4:25000:FINRA",
        kind: "off_exchange_print",
        price: 592.4,
        size: 25_000,
        symbol: "SPY",
      }),
      eventRow({
        at: new Date("2026-11-20T14:32:10.000Z"),
        key: "print:2:592.5:15000:ARCA",
        kind: "large_print",
        price: 592.5,
        size: 15_000,
        symbol: "SPY",
      }),
      eventRow({
        at: new Date("2026-11-20T14:33:10.000Z"),
        key: "print:3:5950:50:CME",
        kind: "off_exchange_print",
        price: 5950,
        size: 50,
        symbol: "ES",
      }),
    ]);

    const events = await flow.readEvents({
      from: m1,
      kinds: ["off_exchange_print"],
      limit: 50,
      symbol: "SPY",
      to: m3,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.key).toBe("print:1:592.4:25000:FINRA");

    await openbb.upsertRows("finra_otc_weekly", [
      {
        lastUpdated: "2026-11-02",
        shares: 38_400_000,
        symbol: "SPY",
        tier: "NMS_TIER_1",
        trades: 240_000,
        venue: "ats",
        weekStart: "2026-10-19",
      },
      {
        lastUpdated: "2026-11-02",
        shares: 92_100_000,
        symbol: "SPY",
        tier: "NMS_TIER_1",
        trades: 610_000,
        venue: "non_ats",
        weekStart: "2026-10-19",
      },
    ]);

    const otc = await openbb.otcWeekly("SPY", "2026-10-01");
    expect(otc).toHaveLength(2);
    expect(otc.map((row) => row.venue)).toEqual(["ats", "non_ats"]);
  });
});
