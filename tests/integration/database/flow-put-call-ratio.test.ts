import {
  createFlowRepository,
  createNodeDatabase,
  type FlowOptionPrintRecord,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real Postgres proof for the SQL aggregations behind flow.putCallRatio:
// - per-minute sums, last_traded_at, newest positive underlying_price tiebreak, end-exclusive range
// - per-day New York regular-hours (09:30 to 16:15, Mon-Fri) sums, symbol isolation, newest limit

let testDatabase: PostgresTestDatabase;
let databaseResource: ReturnType<typeof createNodeDatabase>;

// Thursday 2026-11-19 and Friday 2026-11-20 (EST = UTC-5).
const THU_OPEN = new Date("2026-11-19T14:30:00.000Z");
const FRI_OPEN = new Date("2026-11-20T14:30:00.000Z");
const FRI_CLOSE = new Date("2026-11-20T21:15:00.000Z");
const SAT_NOON = new Date("2026-11-21T17:00:00.000Z");

const stored = (
  id: string,
  tradedAt: Date,
  overrides: Partial<FlowOptionPrintRecord> = {}
): FlowOptionPrintRecord => ({
  ask: 12.1,
  bid: 11.9,
  consolidation: "sweep",
  dte: 1,
  expiry: "2026-11-20",
  goldenSweep: false,
  id,
  iv: 18.5,
  moneyness: "otm",
  moneynessPct: 0.4,
  openInterest: 1000,
  opening: false,
  premium: 100_000,
  price: 10,
  right: "call",
  sentiment: "bullish",
  side: "ask",
  size: 100,
  strike: 665,
  symbol: "SPY",
  ticker: "SPY",
  tradedAt,
  underlyingPrice: 661.2,
  unusual: false,
  volume: 500,
  volumeOverOi: false,
  ...overrides,
});

describe("flow put/call ratio queries on real Postgres", {
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
  }, 60_000);

  it("aggregates per-minute and per-day regular-hours sums with newest positive price and symbol isolation", async () => {
    const flow = createFlowRepository(databaseResource.db);
    const prints: FlowOptionPrintRecord[] = [
      // Thursday 09:30 ET: 1 call ($200k, 200) + 1 put ($300k, 300), newest price 660.5
      stored("thu-1", THU_OPEN, {
        premium: 200_000,
        right: "call",
        size: 200,
        underlyingPrice: 660.1,
      }),
      stored("thu-2", new Date(THU_OPEN.getTime() + 10_000), {
        premium: 300_000,
        right: "put",
        size: 300,
        underlyingPrice: 660.5,
      }),
      // Friday pre-open (09:29:59 ET): excluded from both session and daily reads
      stored("fri-pre", new Date(FRI_OPEN.getTime() - 1000), {
        premium: 999_000,
        right: "put",
        size: 999,
      }),
      // Friday 09:30 ET minute: 2 calls + 1 put; tie on timestamp picks higher id for lastPrice
      stored("fri-m0-a", new Date(FRI_OPEN.getTime() + 5000), {
        premium: 100_000,
        right: "call",
        size: 50,
        underlyingPrice: 661.0,
      }),
      stored("fri-m0-b", new Date(FRI_OPEN.getTime() + 5000), {
        premium: 150_000,
        right: "call",
        size: 75,
        underlyingPrice: 661.25,
      }),
      stored("fri-m0-c", new Date(FRI_OPEN.getTime() + 20_000), {
        premium: 200_000,
        right: "put",
        size: 100,
        underlyingPrice: null,
      }),
      // Friday 09:31 ET minute: 1 put without positive underlying price
      stored("fri-m1-a", new Date(FRI_OPEN.getTime() + 75_000), {
        premium: 50_000,
        right: "put",
        size: 25,
        underlyingPrice: 0,
      }),
      // Friday at close (16:15:00 ET): end-exclusive, excluded
      stored("fri-close", FRI_CLOSE, {
        premium: 500_000,
        right: "call",
        size: 500,
      }),
      // Saturday print: excluded by weekday check
      stored("sat-1", SAT_NOON, {
        premium: 400_000,
        right: "put",
        size: 400,
      }),
      // Different symbol (ES / SPX): isolated from SPY
      stored("es-1", new Date(FRI_OPEN.getTime() + 10_000), {
        premium: 700_000,
        right: "call",
        size: 70,
        symbol: "ES",
        ticker: "SPX",
        underlyingPrice: 6625.5,
      }),
    ];
    expect(await flow.insertOptionPrints(prints)).toBe(prints.length);

    expect(
      await flow.readOptionPrintMinutes({
        from: FRI_OPEN,
        symbol: "SPY",
        to: FRI_CLOSE,
      })
    ).toEqual([
      {
        callPremium: 250_000,
        callPrints: 2,
        callVolume: 125,
        lastPrice: 661.25,
        lastTradedAt: new Date(FRI_OPEN.getTime() + 20_000),
        minute: FRI_OPEN,
        putPremium: 200_000,
        putPrints: 1,
        putVolume: 100,
      },
      {
        callPremium: 0,
        callPrints: 0,
        callVolume: 0,
        lastPrice: null,
        lastTradedAt: new Date(FRI_OPEN.getTime() + 75_000),
        minute: new Date(FRI_OPEN.getTime() + 60_000),
        putPremium: 50_000,
        putPrints: 1,
        putVolume: 25,
      },
    ]);

    expect(
      await flow.readOptionPrintDays({
        from: new Date("2026-11-01T00:00:00.000Z"),
        limit: 20,
        symbol: "SPY",
        to: new Date("2026-11-23T00:00:00.000Z"),
      })
    ).toEqual([
      {
        callPremium: 200_000,
        callPrints: 1,
        callVolume: 200,
        lastPrice: 660.5,
        putPremium: 300_000,
        putPrints: 1,
        putVolume: 300,
        session: "2026-11-19",
      },
      {
        callPremium: 250_000,
        callPrints: 2,
        callVolume: 125,
        lastPrice: 661.25,
        putPremium: 250_000,
        putPrints: 2,
        putVolume: 125,
        session: "2026-11-20",
      },
    ]);

    // Limit keeps the newest sessions and still returns oldest first.
    expect(
      await flow.readOptionPrintDays({
        from: new Date("2026-11-01T00:00:00.000Z"),
        limit: 1,
        symbol: "SPY",
        to: new Date("2026-11-23T00:00:00.000Z"),
      })
    ).toEqual([
      {
        callPremium: 250_000,
        callPrints: 2,
        callVolume: 125,
        lastPrice: 661.25,
        putPremium: 250_000,
        putPrints: 2,
        putVolume: 125,
        session: "2026-11-20",
      },
    ]);
  });
});
