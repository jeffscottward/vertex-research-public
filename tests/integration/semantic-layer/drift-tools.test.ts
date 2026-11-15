import { readFileSync } from "node:fs";

import {
  createBacktestRunsRepository,
  createForwardDriftRepository,
  createNodeDatabase,
  type ForwardDriftAlertRecord,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BacktestRunReportOutput } from "../../../packages/api/src/contracts/backtest-runs.ts";
import { ForwardDriftRecordInputSchema } from "../../../packages/api/src/contracts/forward-drift.ts";
import {
  DEFAULT_DRIFT_THRESHOLDS,
  type DriftLevels,
} from "../../../packages/api/src/forward-drift.ts";
import { seriesStats } from "../../../packages/api/src/portfolio-combination.ts";
import {
  appendObservations,
  baselineOf,
} from "../../../packages/api/src/server/forward-drift-append.ts";
import { type EvalBackend, startEvalBackend } from "./harness.ts";

// The drift monitors of fixture.sql must be rows the API can write: all five thresholds, and a forward
// series (points, trades) with the level, the per-check levels and the alert rows that the API stores
// for it. Then drift_status (backtestRuns/drift/list) and drift_monitor_get (backtestRuns/drift/get)
// agree on every monitor.

type Summary = Readonly<{
  id: string;
  level: string;
  pointCount: number;
  thresholds: Readonly<Record<string, unknown>>;
  tradeCount: number;
}>;
type OpenAlert = Readonly<{ check: string; level: string; monitorId: string }>;

/** The stored level of each fixture monitor, with its point and trade counts. */
const FIXTURE_MONITORS = [
  { id: "m_mom", level: "warn", pointCount: 20, tradeCount: 3 },
  { id: "m_mr", level: "ok", pointCount: 25, tradeCount: 12 },
  { id: "m_orb", level: "alert", pointCount: 25, tradeCount: 13 },
] as const;

type Check = Readonly<{
  baseline: number | null;
  key: string;
  level: string;
  minSample: number;
  reason: string;
  sample: number;
}>;

/** The level of each check that drift_monitor_get computes from the stored series. */
const FIXTURE_CHECK_LEVELS: Readonly<
  Record<(typeof FIXTURE_MONITORS)[number]["id"], Readonly<DriftLevels>>
> = {
  m_mom: {
    drawdown: "warn",
    losingStreak: "ok",
    profitFactor: "insufficient",
    sharpe: "insufficient",
    winRate: "insufficient",
  },
  m_mr: {
    drawdown: "ok",
    losingStreak: "ok",
    profitFactor: "ok",
    sharpe: "ok",
    winRate: "ok",
  },
  m_orb: {
    drawdown: "ok",
    losingStreak: "ok",
    profitFactor: "alert",
    sharpe: "alert",
    winRate: "alert",
  },
};

const call = async <Output>(
  backend: EvalBackend,
  procedure: string,
  input: unknown
): Promise<Output> => {
  const result = await backend.callProcedure(procedure, input);
  if (!result.ok) throw new Error(`${procedure}: ${result.message}`);
  return result.value as Output;
};

describe("drift tools on the eval fixture", () => {
  let backend: EvalBackend;

  beforeAll(async () => {
    backend = await startEvalBackend();
  }, 120_000);

  afterAll(async () => {
    await backend.close();
  });

  it("lists the three fixture monitors with their levels, thresholds and open alerts", async () => {
    const { monitors, openAlerts } = await call<{
      monitors: readonly Summary[];
      openAlerts: readonly OpenAlert[];
    }>(backend, "backtestRuns/drift/list", { limit: 50 });
    expect(
      monitors
        .map(({ id, level, pointCount, tradeCount }) => ({
          id,
          level,
          pointCount,
          tradeCount,
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    ).toEqual(FIXTURE_MONITORS);
    // The fixture copies the defaults into SQL; a changed default must change the fixture too.
    for (const monitor of monitors) {
      expect(monitor.thresholds).toEqual(DEFAULT_DRIFT_THRESHOLDS);
    }
    expect(
      openAlerts
        .map((alert) => [alert.monitorId, alert.check, alert.level])
        .sort()
    ).toEqual([
      ["m_mom", "drawdown", "warn"],
      ["m_orb", "profitFactor", "alert"],
      ["m_orb", "sharpe", "alert"],
      ["m_orb", "winRate", "alert"],
    ]);
  });

  // drift_monitor_get evaluates the stored points and trades. Its level must be the stored level that
  // drift_status lists; with no forward data it was "insufficient" for every monitor. The baseline run
  // of each monitor has a value for all five checks; when the run reports had no profit factor, no
  // equity series and no losing streak, three checks had no baseline.
  it.each(FIXTURE_MONITORS)(
    "evaluates $id to its stored level $level, with a baseline for all five checks",
    async ({ id, level }) => {
      const monitor = await call<Summary & { checks: readonly Check[] }>(
        backend,
        "backtestRuns/drift/get",
        { id }
      );
      expect(monitor).toMatchObject({ id, level });
      expect(
        Object.fromEntries(
          monitor.checks.map((check) => [check.key, check.level])
        )
      ).toEqual(FIXTURE_CHECK_LEVELS[id]);
      for (const check of monitor.checks) {
        expect(check.baseline, check.key).toBeGreaterThan(0);
      }
    }
  );

  // m_mom stays at warn only because its 20 points are 19 returns, one fewer than the Sharpe check
  // needs. A changed minimum or one more point of its falling series moves the monitor to alert; then
  // this test fails before the eval answers of Q19 and Q20 change.
  it("leaves the Sharpe check of m_mom without enough forward returns", async () => {
    const monitor = await call<{ checks: readonly Check[] }>(
      backend,
      "backtestRuns/drift/get",
      { id: "m_mom" }
    );
    expect(
      monitor.checks.find((check) => check.key === "sharpe")
    ).toMatchObject({
      minSample: 20,
      reason: "Needs at least 20 forward returns",
      sample: 19,
    });
  });

  // The equity series of a baseline run is its chart series: it must give the return and the drawdown
  // that the metrics of the run state, and the money fields must agree with each other.
  it.each(["br_mom_1", "br_mr_1", "br_orb_2"])(
    "keeps the equity series of baseline run %s consistent with its metrics",
    async (id) => {
      const { report } = await call<{ report: BacktestRunReportOutput }>(
        backend,
        "backtestRuns/get",
        { id }
      );
      const { metrics } = report;
      const stats = seriesStats(
        report.equity.map((point) => point.t),
        report.equity.map((point) => point.equity)
      );
      expect(stats.totalReturn).toBeCloseTo(metrics.totalReturn, 6);
      expect(stats.maxDrawdownPct).toBeCloseTo(metrics.maxDrawdownPct, 4);
      expect(report.equity.at(-1)?.equity).toBe(metrics.finalEquity);
      expect([report.firstT, report.lastT]).toEqual([
        report.equity[0]?.t,
        report.equity.at(-1)?.t,
      ]);
      expect(metrics.netProfit).toBe(metrics.grossProfit + metrics.grossLoss);
      expect(metrics.finalEquity).toBe(
        metrics.initialDeposit + metrics.netProfit
      );
      expect(metrics.profitFactor).toBeCloseTo(
        metrics.grossProfit / -metrics.grossLoss,
        10
      );
      expect(metrics.profitTrades + metrics.lossTrades).toBe(
        metrics.totalTrades
      );
    }
  );
});

// The fixture rows must hold what the API stores. This test runs the history of each fixture monitor on a
// new monitor of the same baseline run, with the repository clock at the fixture's one time: create it,
// save the stored series in one request through appendObservations (the code behind
// backtestRuns/drift/record and the paper runner), and switch the paper runner on for the monitors of
// RUNNER_AFTER_RECORDING. Then it compares the rows. It writes, so it uses its own database (every migration,
// then fixture.sql) and not the read-only eval backend.
describe("the stored drift state of the eval fixture", () => {
  let testDatabase: PostgresTestDatabase;
  let resource: ReturnType<typeof createNodeDatabase>;
  let nextId = 0;
  const dependencies = {
    generateId: () => {
      nextId += 1;
      return `saved-again-${nextId}`;
    },
    // The one time of every step in the fixture history (updated_at and the alert rows).
    now: () => new Date("2026-11-05T14:00:00.000Z"),
  };
  // The last step of the history: the paper runner of m_mom and m_orb is switched on; m_mr stays off.
  const RUNNER_AFTER_RECORDING: Record<
    (typeof FIXTURE_MONITORS)[number]["id"],
    "off" | "running"
  > = { m_mom: "running", m_mr: "off", m_orb: "running" };
  /** What an alert row says, without its id and monitor, in a fixed order. */
  const alertFacts = (alerts: readonly ForwardDriftAlertRecord[]) =>
    alerts
      .map(
        ({
          acknowledgedAt,
          baselineValue,
          check,
          createdAt,
          forwardValue,
          level,
          message,
          ratio,
        }) => ({
          acknowledgedAt,
          baselineValue,
          check,
          createdAt,
          forwardValue,
          level,
          message,
          ratio,
        })
      )
      .sort((left, right) => left.check.localeCompare(right.check));

  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 2,
    });
    await migrate(resource.db);
    await resource.db.execute(
      readFileSync(
        new URL(
          "../../../docs/vertex-rebuild/agent-semantic-layer/fixture.sql",
          import.meta.url
        ),
        "utf8"
      )
    );
  }, 120_000);

  afterAll(async () => {
    try {
      await resource?.close();
    } finally {
      if (testDatabase !== undefined)
        await dropPostgresTestDatabase(testDatabase);
    }
  }, 60_000);

  it.each(FIXTURE_MONITORS)(
    "is what the API stores when $id is created, recorded in one request and started",
    async ({ id }) => {
      const drift = createForwardDriftRepository(resource.db, dependencies);
      const stored = await drift.get(id);
      if (stored === null) throw new Error(`${id} is not in the fixture`);
      const run = await createBacktestRunsRepository(
        resource.db,
        dependencies
      ).get(stored.baselineRunId);
      if (run === null || run.report === null)
        throw new Error(`${id} has no baseline report`);
      const created = await drift.create({
        baselineRunId: stored.baselineRunId,
        createdBy: stored.createdBy,
        label: `${id} saved again`,
        strategyRevision: run.strategyRevision,
        thresholds: stored.thresholds,
      });
      const outcome = await appendObservations(
        drift,
        created,
        baselineOf(run.report as BacktestRunReportOutput),
        { points: stored.points, trades: stored.trades }
      );
      if (outcome.kind !== "saved")
        throw new Error(`${id}: the series was ${outcome.kind}`);
      const again =
        RUNNER_AFTER_RECORDING[id] === "running"
          ? await drift.setPaperStatus(created.id, "running")
          : outcome.monitor;
      if (again === null) throw new Error(`${id}: the new monitor is gone`);
      const storedAlerts = await drift.listAlerts({
        limit: 50,
        monitorId: id,
        openOnly: false,
      });
      // Received: the fixture rows. Expected: what the API stored just now; when this fails, the diff
      // shows the values that fixture.sql must hold.
      expect({
        alerts: alertFacts(storedAlerts),
        level: stored.level,
        levels: stored.levels,
        paperNote: stored.paperNote,
        paperStatus: stored.paperStatus,
        paperTickedAt: stored.paperTickedAt,
        strategyRevision: stored.strategyRevision,
        updatedAt: stored.updatedAt,
        version: stored.version,
      }).toEqual({
        alerts: alertFacts(outcome.alerts),
        level: again.level,
        levels: again.levels,
        paperNote: again.paperNote,
        paperStatus: again.paperStatus,
        paperTickedAt: again.paperTickedAt,
        strategyRevision: again.strategyRevision,
        updatedAt: again.updatedAt,
        version: again.version,
      });
      // The stored series is one that backtestRuns/drift/record accepts (times in order, equity above 0).
      expect(
        ForwardDriftRecordInputSchema.safeParse({
          id,
          points: stored.points,
          source: "paper",
          trades: stored.trades,
        }).success
      ).toBe(true);
    }
  );
});
