import {
  createFlowRepository,
  createNodeDatabase,
  type FlowLargeTradeRecord,
  type FlowMinuteRecord,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The unit tests compare the rendered SQL text only. This suite runs the two replace rules of
// upsertMinutes and the capture check of migration 0081 on real Postgres.

let testDatabase: PostgresTestDatabase;
let databaseResource: ReturnType<typeof createNodeDatabase>;

const MINUTE = new Date("2026-11-02T15:00:00.000Z");
const SECOND = new Date("2026-11-02T15:00:01.000Z");
const SAMPLED_AT = new Date("2026-11-02T15:01:05.000Z");

const minute = (
  symbol: FlowMinuteRecord["symbol"],
  coveredSeconds: number,
  trades: number
): FlowMinuteRecord => ({
  absorption: null,
  buyVolume: trades,
  close: 6870.5,
  coveredSeconds,
  delta: trades,
  high: 6871,
  largePrints: 0,
  largePrintVolume: 0,
  low: 6870,
  minute: MINUTE,
  offExchangeVolume: 0,
  open: 6870.25,
  sellVolume: 0,
  stackedBuy: 0,
  stackedSell: 0,
  symbol,
  trades,
  volume: trades,
  vwap: 6870.5,
});

describe("flow minutes and deep trades on real Postgres", {
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

  const storedMinute = async (symbol: FlowMinuteRecord["symbol"]) => {
    const window = await createFlowRepository(databaseResource.db).readWindow({
      from: MINUTE,
      symbol,
      to: MINUTE,
    });
    return window.minutes;
  };

  it("the rule trades replaces a minute by a read with more or equal trades and keeps it after a restart", async () => {
    const flow = createFlowRepository(databaseResource.db);
    expect(await flow.upsertMinutes([minute("ES", 60, 60)], "trades")).toBe(1);

    // A late trade: the second read has more trades and fewer covered seconds. It is correct.
    expect(await flow.upsertMinutes([minute("ES", 59, 61)], "trades")).toBe(1);
    expect(await storedMinute("ES")).toEqual([minute("ES", 59, 61)]);

    // Equal trades replace the row, also with fewer covered seconds.
    expect(await flow.upsertMinutes([minute("ES", 58, 61)], "trades")).toBe(1);
    expect(await storedMinute("ES")).toEqual([minute("ES", 58, 61)]);

    // A read after a service restart with an empty ring has fewer trades. The stored row stays.
    expect(await flow.upsertMinutes([minute("ES", 60, 40)], "trades")).toBe(0);
    return expect(await storedMinute("ES")).toEqual([minute("ES", 58, 61)]);
  });

  it("the default rule coverage keeps a minute against less coverage and replaces it on equal coverage", async () => {
    const flow = createFlowRepository(databaseResource.db);
    expect(await flow.upsertMinutes([minute("SPY", 60, 60)])).toBe(1);

    // A later sample that covers less of the minute does not replace the row.
    expect(await flow.upsertMinutes([minute("SPY", 59, 61)])).toBe(0);
    expect(await storedMinute("SPY")).toEqual([minute("SPY", 60, 60)]);

    // Equal coverage replaces the row, also with fewer trades.
    expect(await flow.upsertMinutes([minute("SPY", 60, 50)])).toBe(1);
    return expect(await storedMinute("SPY")).toEqual([minute("SPY", 60, 50)]);
  });

  it("accepts a deep trade with the capture mode streamed and refuses another capture mode", async () => {
    const flow = createFlowRepository(databaseResource.db);
    const streamed: FlowLargeTradeRecord = {
      capture: "streamed",
      limitSize: 40,
      price: 6870.5,
      sampledAt: SAMPLED_AT,
      second: SECOND,
      seq: 0,
      side: "buy",
      signing: "tick",
      size: 42,
      symbol: "ES",
    };
    expect(
      await flow.insertTickSample({ events: [], trades: [streamed] })
    ).toEqual({
      events: 0,
      trades: 1,
    });
    expect(
      await flow.readLargeTrades({ from: MINUTE, symbol: "ES", to: SAMPLED_AT })
    ).toEqual([streamed]);

    await expect(
      testDatabase.query(
        "INSERT INTO flow_large_trades (capture, limit_size, price, sampled_at, second, seq, side, signing, size, symbol) VALUES ($1, 40, 6870.5, $2, $3, 1, 'buy', 'tick', 42, 'ES')",
        ["other", SAMPLED_AT, SECOND]
      )
    ).rejects.toThrow(/flow_large_trades_check/);
    return expect(
      await flow.readLargeTrades({ from: MINUTE, symbol: "ES", to: SAMPLED_AT })
    ).toEqual([streamed]);
  });
});
