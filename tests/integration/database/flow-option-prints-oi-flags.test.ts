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

// The unit tests compare the rendered SQL text only. This suite runs the
// flow_option_prints_check of migration 0098 on real Postgres: NULL
// opening/volume_over_oi (not reported) is allowed only on open_interest = 0
// prints, and then for both flags together. It then applies the guarded rollback.

// Postgres check_violation raised by flow_option_prints_check (drizzle keeps it as the cause).
const CHECK_VIOLATION = {
  cause: { code: "23514", constraint: "flow_option_prints_check" },
};

let testDatabase: PostgresTestDatabase;
let databaseResource: DatabaseResource;

const FROM = new Date("2026-11-25T14:30:00.000Z");
const TO = new Date("2026-11-25T21:00:00.000Z");
const at = (minutes: number): Date =>
  new Date(FROM.getTime() + minutes * 60_000);

const makePrint = (
  id: string,
  minutes: number,
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
  strike: 680,
  symbol: "SPY",
  ticker: "SPY",
  tradedAt: at(minutes),
  underlyingPrice: 678.5,
  unusual: false,
  volume: 1000,
  volumeOverOi: false,
  ...overrides,
});

describe("migration 0098 flow option print OI flags on real Postgres", {
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

  it("stores not-reported flags only on OI-0 prints and reads them back as null", async () => {
    const repository = createFlowRepository(databaseResource.db);

    await repository.insertOptionPrints([
      makePrint("oi-zero-null", 5, {
        openInterest: 0,
        opening: null,
        volumeOverOi: null,
      }),
      makePrint("oi-zero-raw", 10, {
        openInterest: 0,
        opening: true,
        volumeOverOi: true,
      }),
      makePrint("oi-pos", 15, { opening: true, volumeOverOi: false }),
    ]);

    // OI > 0 prints must keep both flags.
    await expect(
      repository.insertOptionPrints([
        makePrint("oi-pos-null", 20, { opening: null, volumeOverOi: null }),
      ])
    ).rejects.toMatchObject(CHECK_VIOLATION);
    // A single null flag is rejected, also on OI-0 prints.
    await expect(
      repository.insertOptionPrints([
        makePrint("oi-zero-half", 25, {
          openInterest: 0,
          opening: null,
          volumeOverOi: true,
        }),
      ])
    ).rejects.toMatchObject(CHECK_VIOLATION);
    await expect(
      repository.insertOptionPrints([
        makePrint("oi-zero-half-2", 25, {
          openInterest: 0,
          opening: false,
          volumeOverOi: null,
        }),
      ])
    ).rejects.toMatchObject(CHECK_VIOLATION);
    // Unknown open interest is no reason for not-reported flags.
    await expect(
      repository.insertOptionPrints([
        makePrint("oi-null-null", 30, {
          openInterest: null,
          opening: null,
          volumeOverOi: null,
        }),
      ])
    ).rejects.toMatchObject(CHECK_VIOLATION);

    const tape = await repository.readOptionTape({
      from: FROM,
      limit: 10,
      symbol: "SPY",
      to: TO,
    });
    expect(
      tape.prints.map((print) => ({
        id: print.id,
        openInterest: print.openInterest,
        opening: print.opening,
        volumeOverOi: print.volumeOverOi,
      }))
    ).toEqual([
      { id: "oi-pos", openInterest: 2500, opening: true, volumeOverOi: false },
      {
        id: "oi-zero-raw",
        openInterest: 0,
        opening: true,
        volumeOverOi: true,
      },
      {
        id: "oi-zero-null",
        openInterest: 0,
        opening: null,
        volumeOverOi: null,
      },
    ]);
  });

  it("refuses the guarded rollback while not-reported rows exist, then applies it", async () => {
    const rollback = readFileSync(
      new URL(
        "../../../packages/db/rollback/0098_flow_option_prints_oi_flags.down.sql",
        import.meta.url
      ),
      "utf8"
    );
    await expect(testDatabase.query(rollback)).rejects.toThrow(
      /cannot roll back 0098_flow_option_prints_oi_flags while 1 rows/
    );
    await testDatabase.query("rollback");

    await testDatabase.query(
      "delete from flow_option_prints where opening is null"
    );
    await testDatabase.query(rollback);
    const columns = await testDatabase.query<{
      name: string;
      nullable: string;
    }>(
      "select column_name as name, is_nullable as nullable from information_schema.columns where table_name = 'flow_option_prints' and column_name in ('opening', 'volume_over_oi') order by column_name"
    );
    expect(columns).toEqual([
      { name: "opening", nullable: "NO" },
      { name: "volume_over_oi", nullable: "NO" },
    ]);
    const [check] = await testDatabase.query<{ definition: string }>(
      "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'flow_option_prints_check'"
    );
    expect(check?.definition).toContain("premium >= ");
    expect(check?.definition).not.toMatch(/opening|volume_over_oi/);
  });
});
