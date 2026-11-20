import { readFileSync } from "node:fs";

import {
  createFlowRepository,
  createNodeDatabase,
  type FlowMarketPremiumRecord,
  type FlowMarketPremiumSessionRecord,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The unit tests compare the rendered SQL text only. This suite runs the market premium writes
// and the ranking SQL of migration 0088 on real Postgres, then applies the guarded rollback.

let testDatabase: PostgresTestDatabase;
let databaseResource: ReturnType<typeof createNodeDatabase>;

const FIRST = new Date("2026-11-19T15:00:00.000Z");
const SECOND = new Date("2026-11-19T16:00:00.000Z");

const premium = (
  sessionDate: string,
  ticker: string,
  bullishPremium: number,
  bearishPremium: number,
  capturedAt: Date
): FlowMarketPremiumRecord => ({
  bearishPremium,
  bullishPremium,
  capturedAt,
  filterProfile: "premium-gte-100k.v1",
  premium: bullishPremium + bearishPremium + 10,
  sessionDate,
  ticker,
  tradeCount: 2,
  volume: 3_000_000_000,
});

const ledger = (
  sessionDate: string,
  capturedAt: Date,
  overrides: Partial<FlowMarketPremiumSessionRecord> = {}
): FlowMarketPremiumSessionRecord => ({
  attempts: 1,
  capturedAt,
  lastAttemptAt: capturedAt,
  lastMessage: "stored",
  sessionDate,
  status: "partial",
  tickers: 2,
  ...overrides,
});

describe("flow market premium on real Postgres", { concurrent: false }, () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    databaseResource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 4,
    });
    return await migrate(databaseResource.db);
  });

  afterAll(async () => {
    await databaseResource.close();
    return await dropPostgresTestDatabase(testDatabase);
  });

  it("replaces a session's rows with the newest capture and keeps one ledger row", async () => {
    const repository = createFlowRepository(databaseResource.db);
    await expect(
      repository.storeMarketPremium({
        rows: [
          premium("2026-11-19", "AAPL", 5, 1, FIRST),
          premium("2026-11-19", "GONE", 1, 1, FIRST),
        ],
        session: ledger("2026-11-19", FIRST),
      })
    ).resolves.toBe(2);
    await expect(
      repository.storeMarketPremium({
        rows: [
          premium("2026-11-19", "AAPL", 9, 2, SECOND),
          premium("2026-11-19", "NVDA", 1, 7, SECOND),
        ],
        session: ledger("2026-11-19", SECOND, { attempts: 2, tickers: 2 }),
      })
    ).resolves.toBe(2);
    const stored = await testDatabase.query<{
      ticker: string;
      bullish_premium: number;
      volume: string;
    }>(
      "select ticker, bullish_premium, volume::text from flow_market_premium order by ticker"
    );
    expect(stored).toEqual([
      { bullish_premium: 9, ticker: "AAPL", volume: "3000000000" },
      { bullish_premium: 1, ticker: "NVDA", volume: "3000000000" },
    ]);
    await expect(
      repository.marketPremiumLedger({ from: "2026-11-01", to: "2026-11-30" })
    ).resolves.toEqual([ledger("2026-11-19", SECOND, { attempts: 2 })]);
  });

  it("keeps the ledger row of an attempt without rows and the stored rows of other sessions", async () => {
    const repository = createFlowRepository(databaseResource.db);
    await repository.storeMarketPremium({
      rows: [premium("2026-11-18", "AAPL", 2, 4, FIRST)],
      session: ledger("2026-11-18", FIRST, { status: "complete", tickers: 1 }),
    });
    await expect(
      repository.storeMarketPremium({
        rows: [],
        session: ledger("2026-11-17", FIRST, {
          capturedAt: null,
          status: "no_data",
          tickers: 0,
        }),
      })
    ).resolves.toBe(0);
    const ledgerRows = await repository.marketPremiumLedger({
      from: "2026-11-17",
      to: "2026-11-19",
    });
    expect(ledgerRows.map((row) => [row.sessionDate, row.status])).toEqual([
      ["2026-11-17", "no_data"],
      ["2026-11-18", "complete"],
      ["2026-11-19", "partial"],
    ]);
  });

  it("sums sessions per ticker, sorts by each key and totals the window", async () => {
    const repository = createFlowRepository(databaseResource.db);
    const sessionDates = ["2026-11-19", "2026-11-18"];
    const bullish = await repository.marketPremiumRanking({
      filterProfile: "premium-gte-100k.v1",
      limit: 10,
      sessionDates,
      sort: "net_bullish",
      ticker: null,
    });
    expect(
      bullish.rows.map((row) => [
        row.ticker,
        row.bullishPremium,
        row.bearishPremium,
        row.sessionsPresent,
        row.tradeCount,
        row.volume,
      ])
    ).toEqual([
      ["AAPL", 11, 6, 2, 4, 6_000_000_000],
      ["NVDA", 1, 7, 1, 2, 3_000_000_000],
    ]);
    expect(bullish.totals).toEqual({
      bearishPremium: 13,
      bullishPremium: 12,
      premium: 55,
      tickers: 2,
    });
    const bearish = await repository.marketPremiumRanking({
      filterProfile: "premium-gte-100k.v1",
      limit: 1,
      sessionDates,
      sort: "net_bearish",
      ticker: null,
    });
    expect(bearish.rows.map((row) => row.ticker)).toEqual(["NVDA"]);
    const total = await repository.marketPremiumRanking({
      filterProfile: "premium-gte-100k.v1",
      limit: 10,
      sessionDates: ["2026-11-19"],
      sort: "total",
      ticker: "NVDA",
    });
    expect(
      total.rows.map((row) => [row.ticker, row.premium, row.rank])
    ).toEqual([["NVDA", 18, 2]]);
    expect(total.totals.tickers).toBe(2);
    const none = await repository.marketPremiumRanking({
      filterProfile: "premium-gte-100k.v1",
      limit: 10,
      sessionDates: ["2026-01-02"],
      sort: "total",
      ticker: null,
    });
    expect(none).toEqual({
      rows: [],
      totals: { bearishPremium: 0, bullishPremium: 0, premium: 0, tickers: 0 },
    });
  });

  it("refuses rows that break the checks", async () => {
    const repository = createFlowRepository(databaseResource.db);
    await expect(
      repository.storeMarketPremium({
        rows: [premium("2026-11-20", "bad ticker", 1, 1, FIRST)],
        session: ledger("2026-11-20", FIRST),
      })
    ).rejects.toThrow();
    await expect(
      repository.storeMarketPremium({
        rows: [],
        session: ledger("2026-11-20", FIRST, { status: "no_data" }),
      })
    ).rejects.toThrow();
    await expect(
      testDatabase.query(
        "insert into flow_samples (at, items, message, source, status, symbol) values (now(), 1, 'ok', 'market_premium', 'ok', 'SPY')"
      )
    ).resolves.toBeDefined();
  });

  it("applies the guarded rollback after the market premium samples are deleted", async () => {
    const rollback = readFileSync(
      new URL(
        "../../../packages/db/rollback/0088_flow_market_premium.down.sql",
        import.meta.url
      ),
      "utf8"
    );
    await testDatabase.query(
      "delete from flow_samples where source = 'market_premium'"
    );
    await testDatabase.query(rollback);
    const tables = await testDatabase.query<{ name: string }>(
      "select table_name as name from information_schema.tables where table_name like 'flow_market_premium%'"
    );
    expect(tables).toEqual([]);
  });
});
