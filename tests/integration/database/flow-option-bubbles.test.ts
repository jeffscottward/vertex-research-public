import {
  createFlowRepository,
  createNodeDatabase,
  type DatabaseResource,
  type FlowOptionPrintRecord,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real Postgres proof for readLargeOptionPrints behind flow.optionBubbles:
// - symbol isolation, end-exclusive [from, to), inclusive premium >= minPremiumUsd
// - ordering by (premium desc, traded_at desc, id desc) and limit truncation

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
  premium: 300_000,
  price: 10,
  right: "call",
  sentiment: "bullish",
  side: "ask",
  size: 300,
  strike: 685,
  symbol: "SPY",
  ticker: "SPY",
  tradedAt,
  underlyingPrice: 683.5,
  unusual: false,
  volume: 500,
  volumeOverOi: false,
  ...overrides,
});

describe("flow option bubbles queries on real Postgres", {
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

  it("filters by symbol, session range, and minPremiumUsd, ordering by premium desc, traded_at desc, id desc", async () => {
    const flow = createFlowRepository(databaseResource.db);
    await flow.insertOptionPrints([
      // Included: exact lower bound of session & exact threshold
      stored("b-01", FRI_OPEN, { premium: 250_000 }),
      // Excluded: below threshold
      stored("b-small", new Date("2026-11-20T15:00:00.000Z"), {
        premium: 249_999,
      }),
      // Excluded: at exclusive upper bound
      stored("b-after", FRI_CLOSE, { premium: 900_000 }),
      // Excluded: different symbol
      stored("b-es", new Date("2026-11-20T15:10:00.000Z"), {
        premium: 1_200_000,
        symbol: "ES",
        ticker: "SPX",
      }),
      // Included: largest print
      stored("b-max", new Date("2026-11-20T16:00:00.000Z"), {
        goldenSweep: true,
        premium: 1_500_000,
        right: "put",
        side: "above_ask",
      }),
      // Included: tie on premium (500k), earlier time
      stored("b-tie-old", new Date("2026-11-20T15:20:00.000Z"), {
        premium: 500_000,
      }),
      // Included: tie on premium (500k) and same time, lower id
      stored("b-tie-a", new Date("2026-11-20T15:30:00.000Z"), {
        premium: 500_000,
      }),
      // Included: tie on premium (500k) and same time, higher id -> wins tie
      stored("b-tie-z", new Date("2026-11-20T15:30:00.000Z"), {
        premium: 500_000,
      }),
    ]);

    const all = await flow.readLargeOptionPrints({
      from: FRI_OPEN,
      limit: 20,
      minPremiumUsd: 250_000,
      symbol: "SPY",
      to: FRI_CLOSE,
    });
    expect(all.map((row) => row.id)).toEqual([
      "b-max",
      "b-tie-z",
      "b-tie-a",
      "b-tie-old",
      "b-01",
    ]);

    const capped = await flow.readLargeOptionPrints({
      from: FRI_OPEN,
      limit: 3,
      minPremiumUsd: 250_000,
      symbol: "SPY",
      to: FRI_CLOSE,
    });
    expect(capped.map((row) => row.id)).toEqual([
      "b-max",
      "b-tie-z",
      "b-tie-a",
    ]);

    const esOnly = await flow.readLargeOptionPrints({
      from: FRI_OPEN,
      limit: 10,
      minPremiumUsd: 1_000_000,
      symbol: "ES",
      to: FRI_CLOSE,
    });
    expect(esOnly.map((row) => row.id)).toEqual(["b-es"]);
  });
});
