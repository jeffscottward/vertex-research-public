import {
  createFlowRepository,
  createNodeDatabase,
  type FlowTapeSecondsRecord,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The unit tests compare the rendered SQL text only. This suite runs the replace rule, the two
// range reads and the check constraint of flow_tape_seconds (migration 0091) on real Postgres.

let testDatabase: PostgresTestDatabase;
let databaseResource: ReturnType<typeof createNodeDatabase>;

const MINUTE = new Date("2026-11-02T15:00:00.000Z");
const NEXT = new Date("2026-11-02T15:01:00.000Z");
const AFTER = new Date("2026-11-02T15:02:00.000Z");

/** A row with `trades` prints in second 0 and the first `covered` seconds covered. */
const row = (
  symbol: FlowTapeSecondsRecord["symbol"],
  minute: Date,
  trades: number,
  covered: number
): FlowTapeSecondsRecord => ({
  contract: `${symbol}Z6`,
  contracts: [trades * 2, ...new Array<number>(59).fill(0)],
  covered: "1".repeat(covered) + "0".repeat(60 - covered),
  minute,
  symbol,
  totalTrades: trades,
  trades: [trades, ...new Array<number>(59).fill(0)],
});

const ZEROS = `{${new Array<number>(60).fill(0).join(",")}}`;
const MASK = "1".repeat(60);
const INSERT =
  "INSERT INTO flow_tape_seconds (contract, contracts, covered, minute, symbol, total_trades, trades) VALUES ($1, $2::integer[], $3, $4, $5, 0, $6::integer[])";

describe("flow tape seconds on real Postgres", { concurrent: false }, () => {
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

  it("stores a row with its arrays and replaces it by a read with more or equal trades only", async () => {
    const flow = createFlowRepository(databaseResource.db);
    const stored = () =>
      flow.readTapeSeconds({ from: MINUTE, symbol: "ES", to: NEXT });
    expect(await flow.upsertTapeSeconds([row("ES", MINUTE, 60, 60)])).toBe(1);
    expect(await stored()).toEqual([row("ES", MINUTE, 60, 60)]);

    // A late trade: the second read has more trades and fewer covered seconds. It is correct.
    expect(await flow.upsertTapeSeconds([row("ES", MINUTE, 61, 59)])).toBe(1);
    expect(await stored()).toEqual([row("ES", MINUTE, 61, 59)]);

    // Equal trades replace the row, as the minute rows do under the rule trades.
    expect(await flow.upsertTapeSeconds([row("ES", MINUTE, 61, 58)])).toBe(1);
    expect(await stored()).toEqual([row("ES", MINUTE, 61, 58)]);

    // A read after a service restart with an empty ring has fewer trades. The stored row stays.
    expect(await flow.upsertTapeSeconds([row("ES", MINUTE, 40, 60)])).toBe(0);
    return expect(await stored()).toEqual([row("ES", MINUTE, 61, 58)]);
  });

  it("reads a symbol's rows from the start minute up to, and not at, the end minute", async () => {
    const flow = createFlowRepository(databaseResource.db);
    await flow.upsertTapeSeconds([
      row("NQ", MINUTE, 0, 60),
      row("NQ", NEXT, 5, 60),
      row("NQ", AFTER, 7, 60),
    ]);
    expect(
      await flow.readTapeSeconds({ from: MINUTE, symbol: "NQ", to: AFTER })
    ).toEqual([row("NQ", MINUTE, 0, 60), row("NQ", NEXT, 5, 60)]);
    return expect(
      await flow.readTapeSeconds({ from: NEXT, symbol: "NQ", to: NEXT })
    ).toEqual([]);
  });

  it("reads the starts of a symbol's minute rows, end-exclusive", async () => {
    const flow = createFlowRepository(databaseResource.db);
    const minute = (at: Date) => ({
      absorption: null,
      buyVolume: 1,
      close: 25_000,
      coveredSeconds: 60,
      delta: 1,
      high: 25_000,
      largePrints: 0,
      largePrintVolume: 0,
      low: 25_000,
      minute: at,
      offExchangeVolume: 0,
      open: 25_000,
      sellVolume: 0,
      stackedBuy: 0,
      stackedSell: 0,
      symbol: "NQ" as const,
      trades: 1,
      volume: 1,
      vwap: 25_000,
    });
    await flow.upsertMinutes([minute(MINUTE), minute(AFTER)], "trades");
    expect(
      await flow.readMinuteStarts({ from: MINUTE, symbol: "NQ", to: AFTER })
    ).toEqual([MINUTE]);
    expect(
      await flow.readMinuteStarts({ from: MINUTE, symbol: "ES", to: AFTER })
    ).toEqual([]);
    return expect(
      await flow.readMinuteStarts({
        from: MINUTE,
        symbol: "NQ",
        to: new Date(AFTER.getTime() + 1),
      })
    ).toEqual([MINUTE, AFTER]);
  });

  it.each([
    ["an array of 59 elements", { trades: `{${new Array(59).fill(0)}}` }],
    ["an empty array", { contracts: "{}" }],
    ["a NULL element", { trades: ZEROS.replace("{0", "{NULL") }],
    ["a negative element", { contracts: ZEROS.replace("{0", "{-1") }],
    ["a mask of 59 characters", { covered: "1".repeat(59) }],
    ["a mask with another character", { covered: `2${"1".repeat(59)}` }],
    ["a symbol without a streamed tape", { symbol: "SPY" }],
    ["an empty contract name", { contract: "" }],
    ["a contract name of 21 characters", { contract: "E".repeat(21) }],
  ])("the check constraint refuses %s", async (_name, change) => {
    const values = {
      contract: "ESZ6",
      contracts: ZEROS,
      covered: MASK,
      symbol: "ES",
      trades: ZEROS,
      ...change,
    };
    const before = await testDatabase.query(
      "SELECT count(*)::int AS rows FROM flow_tape_seconds"
    );
    await expect(
      testDatabase.query(INSERT, [
        values.contract,
        values.contracts,
        values.covered,
        new Date("2026-11-03T15:00:00.000Z"),
        values.symbol,
        values.trades,
      ])
    ).rejects.toThrow(/flow_tape_seconds_check/);
    const after = await testDatabase.query(
      "SELECT count(*)::int AS rows FROM flow_tape_seconds"
    );
    return expect(after).toEqual(before);
  });

  it("the check constraint accepts a covered minute of zeros", async () => {
    await testDatabase.query(INSERT, [
      "ESZ6",
      ZEROS,
      MASK,
      new Date("2026-11-03T15:00:00.000Z"),
      "ES",
      ZEROS,
    ]);
    const flow = createFlowRepository(databaseResource.db);
    const [stored] = await flow.readTapeSeconds({
      from: new Date("2026-11-03T15:00:00.000Z"),
      symbol: "ES",
      to: new Date("2026-11-03T15:01:00.000Z"),
    });
    expect(stored?.trades).toEqual(new Array<number>(60).fill(0));
    return expect(stored?.covered).toBe(MASK);
  });
});
