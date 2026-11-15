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
import { DEFAULT_DRIFT_THRESHOLDS } from "../../../packages/api/src/forward-drift.ts";
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
  { id: "m_mom", level: "warn", pointCount: 25, tradeCount: 3 },
  { id: "m_mr", level: "ok", pointCount: 25, tradeCount: 12 },
  { id: "m_orb", level: "alert", pointCount: 25, tradeCount: 13 },
] as const;

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
      ["m_orb", "losingStreak", "alert"],
      ["m_orb", "winRate", "alert"],
    ]);
  });

  // drift_monitor_get evaluates the stored points and trades. Its level must be the stored level that
  // drift_status lists; with no forward data it was "insufficient" for every monitor.
  it.each(FIXTURE_MONITORS)(
    "evaluates $id to its stored level $level",
    async ({ id, level }) => {
      expect(
        await call<Summary>(backend, "backtestRuns/drift/get", { id })
      ).toMatchObject({ id, level });
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
