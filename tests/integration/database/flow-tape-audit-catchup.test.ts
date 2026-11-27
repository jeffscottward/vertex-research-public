import {
  createFlowRepository,
  createNodeDatabase,
  type FlowTapeAuditRecord,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The unit tests compare the rendered SQL text only. This suite runs the tape gaps (merge, move of
// the start, delete) and the tape checks (insert once, range read, check constraint) of migration
// 0101 on real Postgres.

let testDatabase: PostgresTestDatabase;
let databaseResource: ReturnType<typeof createNodeDatabase>;

const T = new Date("2026-11-02T15:00:00.000Z");
const at = (minutes: number): Date => new Date(T.getTime() + minutes * 60_000);

const audit = (
  fromMinute: number,
  overrides: Partial<FlowTapeAuditRecord> = {}
): FlowTapeAuditRecord => ({
  checkedAt: at(fromMinute + 1),
  comparedSeconds: 18,
  contract: "ESZ6",
  fromSecond: at(fromMinute),
  historyContracts: 40,
  historyTrades: 30,
  matchedSeconds: 17,
  symbol: "ES",
  tapeContracts: 39,
  tapeTrades: 29,
  toSecond: new Date(at(fromMinute).getTime() + 17_000),
  ...overrides,
});

describe("flow tape gaps and checks on real Postgres", {
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

  it("merges a gap with the same start, moves its start forward and deletes it", async () => {
    const flow = createFlowRepository(databaseResource.db);
    const gap = {
      createdAt: T,
      endTime: at(30),
      startTime: at(0),
      symbol: "ES" as const,
    };
    await flow.addTapeGap(gap);
    await flow.addTapeGap({ ...gap, endTime: at(20) });
    await flow.addTapeGap({ ...gap, startTime: at(60), endTime: at(70) });
    await flow.addTapeGap({ ...gap, symbol: "NQ" });
    expect(await flow.tapeGaps("ES")).toEqual([
      gap,
      { ...gap, endTime: at(70), startTime: at(60) },
    ]);
    await flow.moveTapeGapStart("ES", at(0), at(10));
    expect((await flow.tapeGaps("ES"))[0]).toEqual({
      ...gap,
      startTime: at(10),
    });
    // The same cut range stored again (a lost sample), then moved onto the stored row: they merge.
    await flow.addTapeGap({ ...gap, endTime: at(35) });
    await flow.moveTapeGapStart("ES", at(0), at(10));
    expect(await flow.tapeGaps("ES")).toEqual([
      { ...gap, endTime: at(35), startTime: at(10) },
      { ...gap, endTime: at(70), startTime: at(60) },
    ]);
    // A gap that is not stored: nothing happens.
    await flow.moveTapeGapStart("ES", at(1), at(2));
    await flow.deleteTapeGap("ES", at(10));
    await flow.deleteTapeGap("ES", at(60));
    expect(await flow.tapeGaps("ES")).toEqual([]);
    expect(await flow.tapeGaps("NQ")).toEqual([{ ...gap, symbol: "NQ" }]);
  });

  it("refuses an empty gap and a gap of another symbol", async () => {
    const flow = createFlowRepository(databaseResource.db);
    await expect(
      flow.addTapeGap({
        createdAt: T,
        endTime: at(5),
        startTime: at(5),
        symbol: "ES",
      })
    ).rejects.toThrow();
    await expect(
      flow.addTapeGap({
        createdAt: T,
        endTime: at(6),
        startTime: at(5),
        symbol: "SPY" as "ES",
      })
    ).rejects.toThrow();
  });

  it("inserts a check once and reads the checks of one symbol in a range", async () => {
    const flow = createFlowRepository(databaseResource.db);
    expect(await flow.insertTapeAudit(audit(0))).toBe(1);
    expect(await flow.insertTapeAudit(audit(0, { matchedSeconds: 3 }))).toBe(0);
    expect(await flow.insertTapeAudit(audit(5))).toBe(1);
    expect(await flow.insertTapeAudit(audit(5, { symbol: "NQ" }))).toBe(1);
    expect(await flow.insertTapeAudit(audit(10))).toBe(1);
    expect(
      await flow.readTapeAudits({ from: at(0), symbol: "ES", to: at(10) })
    ).toEqual([audit(0), audit(5)]);
  });

  it("refuses a check with more matched than compared seconds", async () => {
    const flow = createFlowRepository(databaseResource.db);
    await expect(
      flow.insertTapeAudit(audit(20, { comparedSeconds: 2, matchedSeconds: 3 }))
    ).rejects.toThrow();
    await expect(
      flow.insertTapeAudit(audit(21, { comparedSeconds: 0, matchedSeconds: 0 }))
    ).rejects.toThrow();
  });
});
