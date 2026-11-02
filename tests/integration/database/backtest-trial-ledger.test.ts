import {
  createAgentOpsRepository,
  createBacktestResultsRepository,
  createNodeDatabase,
  createStrategyLibraryRepository,
  type Database,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const database = (): Database => {
  if (resource === undefined) throw new Error("Database not started");
  return resource.db;
};

describe("backtest trial ledger aggregation in Postgres", {
  concurrent: false,
}, () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 2,
    });
    return await migrate(resource.db);
  }, 60_000);

  afterAll(async () => {
    try {
      await resource?.close();
    } finally {
      if (testDatabase !== undefined)
        await dropPostgresTestDatabase(testDatabase);
    }
  }, 60_000);

  it("summarizes the returns of every other result in the strategy or task scope", async () => {
    const task = await createAgentOpsRepository(database()).createTask({
      agent: "test",
      kind: "backtest",
      title: "Ledger test",
    });
    const strategy = await createStrategyLibraryRepository(database()).create({
      kind: "python",
      name: "Ledger strategy",
    });
    const backtests = createBacktestResultsRepository(database());
    const record = (strategyId: string | null, equity: number[]) =>
      backtests.record({
        dataSource: "fixture",
        equity: equity.map((value, index) => ({
          equity: value,
          t: `2024-01-0${index + 1}`,
        })),
        instruments: "SPY",
        periodEnd: "2024-01-05",
        periodStart: "2024-01-01",
        strategy: "ledger",
        strategyId,
        taskId: task.id,
      });
    const current = await record(strategy.id, [100, 110, 99, 108.9]);
    await record(strategy.id, [100, 102, 104.04]);
    await record(strategy.id, []);
    await record(null, [100, 101]);

    const byStrategy = await backtests.trialLedger(current);
    expect(byStrategy).toMatchObject({
      key: strategy.id,
      scope: "strategy",
      total: 3,
    });
    const steady = byStrategy.others.find((row) => row.returns === 2);
    expect(steady?.meanReturn).toBeCloseTo(0.02, 12);
    expect(steady?.stdReturn).toBeCloseTo(0, 12);
    expect(steady?.firstT).toBe("2024-01-01");
    expect(steady?.lastT).toBe("2024-01-03");
    const empty = byStrategy.others.find((row) => row.returns === 0);
    expect(empty).toMatchObject({
      firstT: null,
      lastT: null,
      meanReturn: null,
      stdReturn: null,
    });

    const byTask = await backtests.trialLedger({
      ...current,
      strategyId: null,
    });
    expect(byTask).toMatchObject({ key: task.id, scope: "task", total: 4 });
    return expect(byTask.others).toHaveLength(3);
  });

  it("stores a rating series and enforces the 0034 column check", async () => {
    const task = await createAgentOpsRepository(database()).createTask({
      agent: "test",
      kind: "backtest",
      title: "Rating series test",
    });
    const backtests = createBacktestResultsRepository(database());
    const ratingSeries = {
      symbol: "SPY",
      timeframe: "1d",
      costBps: 10,
      decisions: [
        { date: "2024-01-02", rating: "buy" as const, runId: "run-1" },
        { date: "2024-01-03", rating: null },
      ],
    };
    const recorded = await backtests.record({
      dataSource: "fixture",
      instruments: "SPY",
      periodEnd: "2024-01-05",
      periodStart: "2024-01-01",
      strategy: "ratings",
      taskId: task.id,
      ratingSeries,
    });
    expect((await backtests.get(recorded.id))?.ratingSeries).toEqual(
      ratingSeries
    );
    const plain = await backtests.record({
      dataSource: "fixture",
      instruments: "SPY",
      periodEnd: "2024-01-05",
      periodStart: "2024-01-01",
      strategy: "plain",
      taskId: task.id,
    });
    expect((await backtests.get(plain.id))?.ratingSeries).toBeNull();
    if (testDatabase === undefined) throw new Error("Database not started");
    await expect(
      testDatabase.query(
        "UPDATE backtest_results SET rating_series = '[]'::jsonb WHERE id = $1",
        [plain.id]
      )
    ).rejects.toThrow(/backtest_results_rating_series_check/);
    return await expect(
      testDatabase.query(
        "UPDATE backtest_results SET rating_series = jsonb_build_object('pad', repeat('x', 70000)) WHERE id = $1",
        [plain.id]
      )
    ).rejects.toThrow(/backtest_results_rating_series_check/);
  });
});
