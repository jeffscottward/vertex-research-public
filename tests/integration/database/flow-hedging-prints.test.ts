import {
  createFlowRepository,
  createNodeDatabase,
  type FlowHedgingPrintRecord,
  type FlowOptionPrintRecord,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The unit test compares the rendered SQL text only. This suite runs the read of the hedging
// pressure line (flow.hedgingPressure) on real Postgres: the symbol filter, the end-exclusive
// range, the order by time then id, the limit and the nullable columns.

let testDatabase: PostgresTestDatabase;
let databaseResource: ReturnType<typeof createNodeDatabase>;

// Friday 2026-11-20 09:30 and 16:15 New York.
const OPEN = new Date("2026-11-20T14:30:00.000Z");
const CLOSE = new Date("2026-11-20T21:15:00.000Z");
const at = (seconds: number): Date => new Date(OPEN.getTime() + seconds * 1000);

/** A stored SPX print with the columns that the line does not read filled in. */
const stored = (
  id: string,
  tradedAt: Date,
  overrides: Partial<FlowOptionPrintRecord> = {}
): FlowOptionPrintRecord => ({
  ask: 12.1,
  bid: 11.9,
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
  premium: 120_000,
  price: 12,
  right: "call",
  sentiment: "bullish",
  side: "ask",
  size: 100,
  strike: 6650,
  symbol: "ES",
  ticker: "SPX",
  tradedAt,
  underlyingPrice: 6625.5,
  unusual: false,
  volume: 500,
  volumeOverOi: false,
  ...overrides,
});

/** The columns that readHedgingPrints returns. */
const line = (record: FlowOptionPrintRecord): FlowHedgingPrintRecord => ({
  dte: record.dte,
  id: record.id,
  iv: record.iv,
  right: record.right,
  side: record.side,
  size: record.size,
  strike: record.strike,
  tradedAt: record.tradedAt,
  underlyingPrice: record.underlyingPrice,
});

describe("flow hedging prints on real Postgres", { concurrent: false }, () => {
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

  it("reads one symbol's prints of the range, end-exclusive, by time then id, with null columns", async () => {
    const flow = createFlowRepository(databaseResource.db);
    const before = stored("es-before", new Date(OPEN.getTime() - 1));
    const second = stored("es-b", at(5), { right: "put", side: "bid" });
    const first = stored("es-c", at(1));
    // Same time as `second`: id "es-a" sorts first.
    const tie = stored("es-a", at(5), {
      dte: null,
      iv: null,
      side: "unknown",
      underlyingPrice: null,
    });
    const atClose = stored("es-close", CLOSE);
    const spy = stored("spy-1", at(2), {
      strike: 662,
      symbol: "SPY",
      ticker: "SPY",
      underlyingPrice: 661.2,
    });
    expect(
      await flow.insertOptionPrints([before, second, first, tie, atClose, spy])
    ).toBe(6);

    expect(
      await flow.readHedgingPrints({
        from: OPEN,
        limit: 10,
        symbol: "ES",
        to: CLOSE,
      })
    ).toEqual([line(first), line(tie), line(second)]);
    expect(
      await flow.readHedgingPrints({
        from: OPEN,
        limit: 10,
        symbol: "SPY",
        to: CLOSE,
      })
    ).toEqual([line(spy)]);
    // The limit keeps the oldest rows.
    expect(
      await flow.readHedgingPrints({
        from: OPEN,
        limit: 2,
        symbol: "ES",
        to: CLOSE,
      })
    ).toEqual([line(first), line(tie)]);
    return expect(
      await flow.readHedgingPrints({
        from: OPEN,
        limit: 10,
        symbol: "ES",
        to: new Date(CLOSE.getTime() + 1),
      })
    ).toEqual([line(first), line(tie), line(second), line(atClose)]);
  });
});
