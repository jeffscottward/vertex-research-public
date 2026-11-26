import { readFileSync } from "node:fs";

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

let testDatabase: PostgresTestDatabase;
let databaseResource: DatabaseResource;

const FROM = new Date("2026-11-23T14:30:00.000Z");
const TO = new Date("2026-11-23T21:00:00.000Z");
const at = (minutes: number): Date =>
  new Date(FROM.getTime() + minutes * 60_000);

const makePrint = (
  id: string,
  symbol: "IWM" | "NVDA" | "SPY",
  tradedAt: Date,
  overrides: Partial<FlowOptionPrintRecord> = {}
): FlowOptionPrintRecord => ({
  ask: 4.6,
  bid: 4.4,
  consolidation: "sweep",
  dte: 25,
  expiry: "2026-12-18",
  goldenSweep: false,
  id,
  iv: 32.5,
  moneyness: "otm",
  moneynessPct: 1.2,
  openInterest: 2500,
  opening: false,
  premium: 150_000,
  price: 4.5,
  right: "call",
  sentiment: "bullish",
  side: "above_ask",
  size: 333,
  strike: 230,
  symbol,
  ticker: symbol,
  tradedAt,
  underlyingPrice: 228.5,
  unusual: false,
  volume: 1000,
  volumeOverOi: false,
  ...overrides,
});

describe("migration 0095 flow option tickers on real Postgres", {
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

  it("stores IWM and NVDA prints, gaps, options samples and quantdata events while rejecting non-options samples and ibkr events", async () => {
    const repository = createFlowRepository(databaseResource.db);

    await repository.insertOptionPrints([
      makePrint("iwm-1", "IWM", at(5), {
        consolidation: "sweep",
        goldenSweep: true,
        premium: 300_000,
        right: "call",
        sentiment: "bullish",
        unusual: true,
      }),
      makePrint("iwm-2", "IWM", at(10), {
        consolidation: "block",
        premium: 200_000,
        right: "put",
        sentiment: "bearish",
      }),
      makePrint("iwm-3", "IWM", at(15), {
        consolidation: "sweep",
        premium: 100_000,
        right: "call",
        sentiment: "bullish",
      }),
      makePrint("iwm-4", "IWM", at(20), {
        consolidation: "other",
        premium: 50_000,
        right: "put",
        sentiment: "neutral",
      }),
      makePrint("nvda-1", "NVDA", at(25), {
        premium: 500_000,
        strike: 150,
        underlyingPrice: 148,
      }),
    ]);
    await repository.addOptionGap({
      createdAt: at(25),
      endTime: at(25),
      startTime: at(20),
      symbol: "IWM",
    });
    await repository.addOptionGap({
      createdAt: at(30),
      endTime: at(30),
      startTime: at(25),
      symbol: "NVDA",
    });

    await repository.recordSample({
      at: at(20),
      items: 4,
      message: "quantdata flow IWM: 1 page, 4 prints",
      source: "options",
      status: "ok",
      symbol: "IWM",
    });
    await repository.recordSample({
      at: at(25),
      items: 1,
      message: "quantdata flow NVDA: 1 page, 1 print",
      source: "options",
      status: "ok",
      symbol: "NVDA",
    });
    await repository.insertEvents([
      {
        at: at(5),
        detail: "IWM golden sweep $300K",
        direction: "bullish",
        key: "opt:iwm-1",
        kind: "option_sweep",
        premium: 300_000,
        price: 228.5,
        size: 333,
        source: "quantdata",
        symbol: "IWM",
      },
      {
        at: at(25),
        detail: "NVDA sweep $500K",
        direction: "bullish",
        key: "opt:nvda-1",
        kind: "option_sweep",
        premium: 500_000,
        price: 148,
        size: 333,
        source: "quantdata",
        symbol: "NVDA",
      },
    ]);

    // Option-only tickers must reject non-options samples and non-quantdata events
    await expect(
      testDatabase.query(
        "insert into flow_samples (at, items, message, source, status, symbol) values ($1, 1, 'bad', 'ticks', 'ok', 'IWM')",
        [at(21)]
      )
    ).rejects.toThrow();
    await expect(
      testDatabase.query(
        "insert into flow_samples (at, items, message, source, status, symbol) values ($1, 1, 'bad', 'gex', 'ok', 'NVDA')",
        [at(21)]
      )
    ).rejects.toThrow();
    await expect(
      testDatabase.query(
        "insert into flow_events (at, detail, direction, key, kind, source, symbol) values ($1, 'bad', 'bullish', 'bad-iwm', 'large_print', 'ibkr', 'IWM')",
        [at(21)]
      )
    ).rejects.toThrow();

    // readOptionTape computes full-window aggregates independently of limit
    const tape = await repository.readOptionTape({
      from: FROM,
      limit: 2,
      symbol: "IWM",
      to: TO,
    });
    expect(tape.prints.map((p) => p.id)).toEqual(["iwm-4", "iwm-3"]);
    expect(tape.summary).toEqual({
      bearishPremium: 200_000,
      blocks: 1,
      bullishPremium: 400_000,
      callPremium: 400_000,
      goldenSweeps: 1,
      putPremium: 250_000,
      sweeps: 2,
      trades: 4,
      unusualCount: 1,
    });

    const newestIwm = await repository.newestOptionPrintAt("IWM");
    expect(newestIwm?.toISOString()).toBe(at(20).toISOString());
    const iwmGaps = await repository.optionGaps("IWM");
    expect(iwmGaps).toHaveLength(1);
  });

  it("refuses down migration while IWM/NVDA rows exist, then succeeds after cleanup and restores pre-0095 checks", async () => {
    const rollback = readFileSync(
      new URL(
        "../../../packages/db/rollback/0095_flow_option_tickers.down.sql",
        import.meta.url
      ),
      "utf8"
    );

    // Must refuse while IWM/NVDA rows exist; clear the aborted BEGIN block afterwards
    await expect(testDatabase.query(rollback)).rejects.toThrow(
      /cannot roll back 0095_flow_option_tickers/
    );
    await testDatabase.query("rollback");

    // Delete all IWM/NVDA rows across all four tables
    await testDatabase.query(
      "delete from flow_option_prints where symbol in ('IWM', 'NVDA') or ticker in ('IWM', 'NVDA')"
    );
    await testDatabase.query(
      "delete from flow_option_gaps where symbol in ('IWM', 'NVDA')"
    );
    await testDatabase.query(
      "delete from flow_samples where symbol in ('IWM', 'NVDA')"
    );
    await testDatabase.query(
      "delete from flow_events where symbol in ('IWM', 'NVDA')"
    );

    // Now down migration succeeds
    await testDatabase.query(rollback);

    // Pre-0095 CHECK constraints now reject IWM option prints again
    await expect(
      testDatabase.query(
        "insert into flow_samples (at, items, message, source, status, symbol) values ($1, 1, 'after-down', 'options', 'ok', 'IWM')",
        [at(30)]
      )
    ).rejects.toThrow();
  });
});
