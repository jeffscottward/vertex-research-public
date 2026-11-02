import {
  createBacktestRunsRepository,
  createForwardDriftRepository,
  createNodeDatabase,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let testDatabase: PostgresTestDatabase;
let databaseResource: ReturnType<typeof createNodeDatabase>;

const thresholds = {
  drawdown: { alert: 1.5, warn: 1 },
  losingStreak: { alert: 1.5, warn: 1.25 },
  profitFactor: { alert: 0.5, warn: 0.75 },
  sharpe: { alert: 0, warn: 0.5 },
  winRate: { alert: 0.6, warn: 0.8 },
};

let next = 0;
const dependencies = {
  generateId: () => {
    next += 1;
    return `fd-${next}`;
  },
  now: () => new Date("2026-10-23T12:00:00.000Z"),
};

describe("forward drift tables on real Postgres", { concurrent: false }, () => {
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

  const baselineRun = async () =>
    createBacktestRunsRepository(databaseResource.db, dependencies).create({
      engineVersion: "instant-2",
      requestedBy: "operator",
      spec: {
        costBps: 0,
        from: "2020-01-01",
        initialCapital: 10_000,
        rule: { fast: 5, kind: "smaCross", slow: 20 },
        stopLossPct: 0,
        symbol: "SPY",
        takeProfitPct: 0,
        timeframe: "1d",
        to: "2021-01-01",
      },
      strategyId: null,
      strategyRevision: null,
      strategySnapshot: null,
    });

  it("stores evaluations under the version lock, raises alerts and acknowledges once", async () => {
    const run = await baselineRun();
    const drift = createForwardDriftRepository(
      databaseResource.db,
      dependencies
    );
    const monitor = await drift.create({
      baselineRunId: run.id,
      createdBy: "operator",
      label: "SPY paper",
      strategyRevision: null,
      thresholds,
    });
    expect(monitor).toMatchObject({
      level: "insufficient",
      levels: {},
      points: [],
      trades: [],
      version: 0,
    });

    const saved = await drift.saveEvaluation({
      alerts: [
        {
          baselineValue: 0.1,
          check: "drawdown",
          forwardValue: 0.16,
          level: "alert",
          message: "Max drawdown alert",
          ratio: 1.6,
        },
      ],
      expectedVersion: 0,
      id: monitor.id,
      level: "alert",
      levels: { drawdown: "alert" },
      points: [
        { equity: 100, t: 0 },
        { equity: 84, t: 1 },
      ],
      trades: [{ pnl: -1, t: 1 }],
    });
    expect(saved?.monitor.version).toBe(1);
    expect(saved?.alerts).toHaveLength(1);

    // A second writer that read version 0 loses and writes nothing.
    await expect(
      drift.saveEvaluation({
        alerts: [
          {
            baselineValue: null,
            check: "sharpe",
            forwardValue: null,
            level: "warn",
            message: "late",
            ratio: null,
          },
        ],
        expectedVersion: 0,
        id: monitor.id,
        level: "warn",
        levels: {},
        points: [],
        trades: [],
      })
    ).resolves.toBeNull();

    const [listed] = await drift.list(10);
    expect(listed).toMatchObject({
      id: monitor.id,
      level: "alert",
      pointCount: 2,
      tradeCount: 1,
    });
    const reread = await drift.get(monitor.id);
    expect(reread?.points).toEqual([
      { equity: 100, t: 0 },
      { equity: 84, t: 1 },
    ]);

    const open = await drift.listAlerts({ limit: 10, openOnly: true });
    expect(open.map((alert) => alert.message)).toEqual(["Max drawdown alert"]);
    const alertId = open[0]?.id ?? "";
    expect(
      (await drift.acknowledgeAlert(alertId, "operator"))?.acknowledgedBy
    ).toBe("operator");
    await expect(
      drift.acknowledgeAlert(alertId, "operator")
    ).resolves.toBeNull();
    await expect(
      drift.listAlerts({ limit: 10, monitorId: monitor.id, openOnly: true })
    ).resolves.toEqual([]);
    await expect(
      drift.listAlerts({ limit: 10, monitorId: monitor.id, openOnly: false })
    ).resolves.toHaveLength(1);
  });

  it("keeps the baseline run while a monitor uses it and enforces the checks", async () => {
    const run = await baselineRun();
    const drift = createForwardDriftRepository(
      databaseResource.db,
      dependencies
    );
    await drift.create({
      baselineRunId: run.id,
      createdBy: "operator",
      label: "Pinned",
      strategyRevision: null,
      thresholds,
    });
    await expect(
      testDatabase.query("DELETE FROM backtest_runs WHERE id = $1", [run.id])
    ).rejects.toThrow(/forward_drift_monitors_baseline_run_id/u);
    await expect(
      drift.create({
        baselineRunId: run.id,
        createdBy: "operator",
        label: "",
        strategyRevision: null,
        thresholds,
      })
    ).rejects.toThrow();
    await expect(
      drift.create({
        baselineRunId: run.id,
        createdBy: "operator",
        label: "Bad revision",
        strategyRevision: "not-a-digest",
        thresholds,
      })
    ).rejects.toThrow();
    await expect(
      drift.create({
        baselineRunId: "missing-run",
        createdBy: "operator",
        label: "No run",
        strategyRevision: null,
        thresholds,
      })
    ).rejects.toThrow();
  });

  it("starts, notes and lists paper runners, least recently ticked first", async () => {
    const run = await baselineRun();
    let clock = Date.parse("2026-10-23T12:00:00.000Z");
    const drift = createForwardDriftRepository(databaseResource.db, {
      generateId: dependencies.generateId,
      now: () => new Date(clock),
    });
    const make = (label: string) =>
      drift.create({
        baselineRunId: run.id,
        createdBy: "operator",
        label,
        strategyRevision: null,
        thresholds,
      });
    const first = await make("Runner A");
    const second = await make("Runner B");
    const third = await make("Runner C");
    expect(first.paperStatus).toBe("off");
    expect(first.paperTickedAt).toBeNull();
    for (const monitor of [first, second, third])
      await drift.setPaperStatus(monitor.id, "running");
    const stopped = await drift.setPaperStatus(third.id, "off");
    expect(stopped?.version).toBe(0);
    await expect(
      drift.setPaperStatus("missing", "running")
    ).resolves.toBeNull();
    clock += 1000;
    await drift.notePaperTick(first.id, "No new settled bars");
    const listed = await drift.listRunningPaper(10);
    expect(listed.indexOf(second.id)).toBeLessThan(listed.indexOf(first.id));
    expect(listed).not.toContain(third.id);
    const noted = await drift.get(first.id);
    expect(noted?.paperNote).toBe("No new settled bars");
    expect(noted?.paperTickedAt?.toISOString()).toBe(
      "2026-10-23T12:00:01.000Z"
    );
    expect(noted?.version).toBe(0);
    await expect(
      testDatabase.query(
        "UPDATE forward_drift_monitors SET paper_status = 'live' WHERE id = $1",
        [first.id]
      )
    ).rejects.toThrow(/forward_drift_monitors_paper_status_check/u);
  });
});
