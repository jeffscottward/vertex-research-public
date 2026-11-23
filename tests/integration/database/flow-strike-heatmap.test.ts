import {
  createFlowRepository,
  createNodeDatabase,
  type DatabaseResource,
  type FlowOptionPrintRecord,
  InvalidRepositoryInputError,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real Postgres proof for the SQL queries behind flow.strikeHeatmap:
// - readOptionPrintStrikeBuckets: 5m/15m/30m slot bucketing aligned to 09:30 NY,
//   (strike, slotIndex, right, side) grouping, symbol isolation, end-exclusive bounds
// - readOptionPrintSlotPrices: DISTINCT ON slotIndex with (traded_at desc, id desc) tie-breaking
//   across all strikes, ignoring null/non-positive/NaN/Infinity prices

let testDatabase: PostgresTestDatabase;
let databaseResource: DatabaseResource;

// Friday 2026-11-20 regular options hours (EST = UTC-5): 09:30 to 16:15 ET.
const FRI_OPEN = new Date("2026-11-20T14:30:00.000Z");
const FRI_CLOSE = new Date("2026-11-20T21:15:00.000Z");

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
  strike: 600,
  symbol: "SPY",
  ticker: "SPY",
  tradedAt,
  underlyingPrice: 600.25,
  unusual: false,
  volume: 500,
  volumeOverOi: false,
  ...overrides,
});

describe("flow strike heatmap queries on real Postgres", {
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

  it("groups prints by (strike, slotIndex, right, side) across 5m/15m/30m and breaks slot price ties by id desc", async () => {
    const flow = createFlowRepository(databaseResource.db);
    await flow.insertOptionPrints([
      // Slot 0 (09:30-09:45): two 600 call@ask prints + one 600 put@ask + one 600 call@mid
      stored("p-01", new Date("2026-11-20T14:30:05.000Z"), {
        premium: 120_000,
        right: "call",
        side: "ask",
        size: 120,
        strike: 600,
        underlyingPrice: 600.1,
      }),
      stored("p-02", new Date("2026-11-20T14:44:59.000Z"), {
        premium: 80_000,
        right: "call",
        side: "ask",
        size: 80,
        strike: 600,
        underlyingPrice: 600.4,
      }),
      // Exact same timestamp as p-02 on a different strike (602), lexicographically larger id -> wins slot 0 price
      stored("p-03", new Date("2026-11-20T14:44:59.000Z"), {
        premium: 90_000,
        right: "put",
        side: "bid",
        size: 90,
        strike: 602,
        underlyingPrice: 600.55,
      }),
      // Null / zero / non-finite prices later in slot 0 must be ignored by readOptionPrintSlotPrices
      stored("p-04", new Date("2026-11-20T14:44:59.900Z"), {
        premium: 50_000,
        right: "call",
        side: "mid",
        size: 50,
        strike: 600,
        underlyingPrice: null,
      }),
      stored("p-05", new Date("2026-11-20T14:44:59.950Z"), {
        premium: 25_000,
        right: "put",
        side: "ask",
        size: 25,
        strike: 600,
        underlyingPrice: 0,
      }),
      // Final 15m slot (16:00-16:15 -> slot 26 at 15m, slot 13 at 30m, slot 80 at 5m for 16:10:05)
      stored("p-06", new Date("2026-11-20T21:10:05.000Z"), {
        premium: 300_000,
        right: "put",
        side: "above_ask",
        size: 300,
        strike: 595,
        underlyingPrice: 598.75,
      }),
      // At exact session close (end-exclusive -> excluded)
      stored("p-07", FRI_CLOSE, {
        premium: 999_000,
        strike: 600,
        underlyingPrice: 610,
      }),
      // Other symbol (ES -> excluded from SPY query)
      stored("p-08", new Date("2026-11-20T14:35:00.000Z"), {
        premium: 500_000,
        strike: 6000,
        symbol: "ES",
        ticker: "SPX",
        underlyingPrice: 6005,
      }),
    ]);

    const buckets15 = await flow.readOptionPrintStrikeBuckets({
      bucketMinutes: 15,
      from: FRI_OPEN,
      symbol: "SPY",
      to: FRI_CLOSE,
    });

    expect(buckets15).toEqual([
      {
        lastTradedAt: new Date("2026-11-20T14:44:59.000Z"),
        premium: 90_000,
        prints: 1,
        right: "put",
        side: "bid",
        slotIndex: 0,
        strike: 602,
        volume: 90,
      },
      {
        lastTradedAt: new Date("2026-11-20T14:44:59.000Z"),
        premium: 200_000,
        prints: 2,
        right: "call",
        side: "ask",
        slotIndex: 0,
        strike: 600,
        volume: 200,
      },
      {
        lastTradedAt: new Date("2026-11-20T14:44:59.900Z"),
        premium: 50_000,
        prints: 1,
        right: "call",
        side: "mid",
        slotIndex: 0,
        strike: 600,
        volume: 50,
      },
      {
        lastTradedAt: new Date("2026-11-20T14:44:59.950Z"),
        premium: 25_000,
        prints: 1,
        right: "put",
        side: "ask",
        slotIndex: 0,
        strike: 600,
        volume: 25,
      },
      {
        lastTradedAt: new Date("2026-11-20T21:10:05.000Z"),
        premium: 300_000,
        prints: 1,
        right: "put",
        side: "above_ask",
        slotIndex: 26,
        strike: 595,
        volume: 300,
      },
    ]);

    const prices15 = await flow.readOptionPrintSlotPrices({
      bucketMinutes: 15,
      from: FRI_OPEN,
      symbol: "SPY",
      to: FRI_CLOSE,
    });
    expect(prices15).toEqual([
      {
        price: 600.55,
        pricedAt: new Date("2026-11-20T14:44:59.000Z"),
        slotIndex: 0,
      },
      {
        price: 598.75,
        pricedAt: new Date("2026-11-20T21:10:05.000Z"),
        slotIndex: 26,
      },
    ]);

    // Insert later slot-0 prints with NaN, +/-Infinity, and negative underlying prices;
    // readOptionPrintSlotPrices must ignore every non-finite or non-positive price in Postgres.
    await flow.insertOptionPrints([
      stored("p-05a", new Date("2026-11-20T14:44:59.960Z"), {
        premium: 15_000,
        strike: 600,
        underlyingPrice: Number.NaN,
      }),
      stored("p-05b", new Date("2026-11-20T14:44:59.970Z"), {
        premium: 15_000,
        strike: 600,
        underlyingPrice: Number.POSITIVE_INFINITY,
      }),
      stored("p-05c", new Date("2026-11-20T14:44:59.980Z"), {
        premium: 15_000,
        strike: 600,
        underlyingPrice: Number.NEGATIVE_INFINITY,
      }),
      stored("p-05d", new Date("2026-11-20T14:44:59.990Z"), {
        premium: 15_000,
        strike: 600,
        underlyingPrice: -5,
      }),
    ]);
    expect(
      await flow.readOptionPrintSlotPrices({
        bucketMinutes: 15,
        from: FRI_OPEN,
        symbol: "SPY",
        to: FRI_CLOSE,
      })
    ).toEqual(prices15);

    // Verify 30m and 5m slot indexing on the exact same data
    const buckets30 = await flow.readOptionPrintStrikeBuckets({
      bucketMinutes: 30,
      from: FRI_OPEN,
      symbol: "SPY",
      to: FRI_CLOSE,
    });
    expect(buckets30.find((row) => row.strike === 595)?.slotIndex).toBe(13);

    const buckets5 = await flow.readOptionPrintStrikeBuckets({
      bucketMinutes: 5,
      from: FRI_OPEN,
      symbol: "SPY",
      to: FRI_CLOSE,
    });
    expect(buckets5.find((row) => row.strike === 595)?.slotIndex).toBe(80);
    expect(
      buckets5
        .filter(
          (row) =>
            row.strike === 600 && row.right === "call" && row.side === "ask"
        )
        .map((r) => r.slotIndex)
    ).toEqual([0, 2]);

    await expect(
      flow.readOptionPrintStrikeBuckets({
        bucketMinutes: 10 as 15,
        from: FRI_OPEN,
        symbol: "SPY",
        to: FRI_CLOSE,
      })
    ).rejects.toThrow(InvalidRepositoryInputError);
  });
});
