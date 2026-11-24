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

// The unit test compares the rendered SQL text only. This suite runs the grouped read of the
// strike profiles (optionsAnalytics.snapshot, stored prints) on real Postgres: the symbol filter,
// the end-exclusive range, the expiry floor, the sums and counts per strike, right and sentiment,
// and the oldest and newest trade time of each group.

let testDatabase: PostgresTestDatabase;
let databaseResource: ReturnType<typeof createNodeDatabase>;

const FROM = new Date("2026-11-20T14:30:00.000Z");
const TO = new Date("2026-11-20T21:00:00.000Z");
const at = (minutes: number): Date =>
  new Date(FROM.getTime() + minutes * 60_000);

/** A stored SPY print with the columns that the query does not read filled in. */
const stored = (
  id: string,
  tradedAt: Date,
  overrides: Partial<FlowOptionPrintRecord> = {}
): FlowOptionPrintRecord => ({
  ask: 1.1,
  bid: 0.9,
  consolidation: "sweep",
  dte: 0.4,
  expiry: "2026-11-20",
  goldenSweep: false,
  id,
  iv: 18.5,
  moneyness: "otm",
  moneynessPct: 0.4,
  openInterest: 1000,
  opening: false,
  premium: 1000,
  price: 1,
  right: "call",
  sentiment: "bullish",
  side: "ask",
  size: 10,
  strike: 660,
  symbol: "SPY",
  ticker: "SPY",
  tradedAt,
  underlyingPrice: 661.2,
  unusual: false,
  volume: 500,
  volumeOverOi: false,
  ...overrides,
});

describe("flow option strike totals on real Postgres", {
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

  it("groups one symbol's prints of the range and expiry floor by strike, right and sentiment", async () => {
    const flow = createFlowRepository(databaseResource.db);
    const prints = [
      stored("a", at(10)),
      stored("b", at(40), { premium: 2500, size: 25 }),
      stored("c", at(20), {
        premium: 700,
        right: "put",
        sentiment: "bearish",
        size: 7,
      }),
      stored("d", at(30), { premium: 300, sentiment: "neutral", size: 3 }),
      stored("e", at(50), { premium: 4000, size: 40, strike: 650.5 }),
      // Left out: before the range, at its end, expired, a zero strike, another symbol.
      stored("before", new Date(FROM.getTime() - 1)),
      stored("at-end", TO),
      stored("expired", at(15), { expiry: "2026-11-19" }),
      stored("zero-strike", at(15), { strike: 0 }),
      stored("es", at(15), { strike: 6600, symbol: "ES", ticker: "SPX" }),
    ];
    expect(await flow.insertOptionPrints(prints)).toBe(prints.length);

    expect(
      await flow.readOptionStrikeTotals({
        from: FROM,
        minExpiry: "2026-11-20",
        symbol: "SPY",
        to: TO,
      })
    ).toEqual([
      {
        contracts: 40,
        newestAt: at(50),
        oldestAt: at(50),
        premium: 4000,
        right: "call",
        sentiment: "bullish",
        strike: 650.5,
        trades: 1,
      },
      {
        contracts: 35,
        newestAt: at(40),
        oldestAt: at(10),
        premium: 3500,
        right: "call",
        sentiment: "bullish",
        strike: 660,
        trades: 2,
      },
      {
        contracts: 3,
        newestAt: at(30),
        oldestAt: at(30),
        premium: 300,
        right: "call",
        sentiment: "neutral",
        strike: 660,
        trades: 1,
      },
      {
        contracts: 7,
        newestAt: at(20),
        oldestAt: at(20),
        premium: 700,
        right: "put",
        sentiment: "bearish",
        strike: 660,
        trades: 1,
      },
    ]);
    return expect(
      await flow.readOptionStrikeTotals({
        from: FROM,
        minExpiry: "2026-11-20",
        symbol: "ES",
        to: TO,
      })
    ).toEqual([
      expect.objectContaining({ contracts: 10, strike: 6600, trades: 1 }),
    ]);
  });
});
