import type {
  BacktestRunRecord,
  BacktestRunsRepository,
  ForwardDriftAlertRecord,
  ForwardDriftMonitorRecord,
  ForwardDriftRepository,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type { BacktestRunReportOutput } from "../contracts/backtest-runs.ts";
import {
  type ForwardDriftMonitor,
  PAPER_FORWARD_TICK_MAX,
  type PaperForwardTickResult,
} from "../contracts/forward-drift.ts";
import {
  evaluateDrift,
  mergeThresholds,
  thresholdProblem,
} from "../forward-drift.ts";
import { describeRun } from "./backtest-runs.ts";
import type { ApiContext } from "./context.ts";
import { appendObservations, baselineOf } from "./forward-drift-append.ts";
import { requireOperator } from "./operator-access.ts";
import {
  tickPaperForward,
  tickPaperForwardInBatch,
} from "./paper-forward-runner.ts";

// Forward drift procedures (backtestRuns.drift.*). record appends paper points and trades after
// the stored ones, evaluates every check against the pinned baseline run, and stores the series,
// the levels and the raised in-app alerts in one transaction under the monitor's version. get
// evaluates the stored data again on read. Paper data only; no order path.

/** Alerts returned with one monitor, newest first. */
const MONITOR_ALERTS_SHOWN = 50;
const OPEN_ALERTS_SHOWN = 200;

type Failures = Readonly<{
  NOT_FOUND: (options?: { message?: string }) => Error;
  BAD_REQUEST: (options?: { message?: string }) => Error;
  CONFLICT: (options?: { message?: string }) => Error;
  STORAGE_ERROR: () => Error;
}>;

type Dependencies = Readonly<{
  drift: ForwardDriftRepository;
  runs: BacktestRunsRepository;
}>;

const dependenciesFor = (
  context: ApiContext,
  failures: Failures
): Dependencies => {
  const { backtestRuns: runs, forwardDrift: drift } = context.repositories;
  if (runs === undefined || drift === undefined) throw failures.STORAGE_ERROR();
  return { drift, runs };
};

/** The finished baseline run with its report, or a typed failure. */
const baselineRun = async (
  dependencies: Dependencies,
  failures: Failures,
  runId: string
): Promise<BacktestRunRecord & { report: BacktestRunReportOutput }> => {
  const run = await dependencies.runs.get(runId);
  if (run === null)
    throw failures.NOT_FOUND({ message: "Baseline backtest run not found" });
  if (run.status !== "succeeded" || run.report === null)
    throw failures.BAD_REQUEST({
      message: "The baseline backtest run has not succeeded",
    });
  return run as BacktestRunRecord & { report: BacktestRunReportOutput };
};

const paperOf = (
  monitor: Pick<
    ForwardDriftMonitorRecord,
    "paperNote" | "paperStatus" | "paperTickedAt"
  >
) => ({
  note: monitor.paperNote,
  status: monitor.paperStatus,
  tickedAt: monitor.paperTickedAt,
});

const alertOutput = (alert: ForwardDriftAlertRecord) => ({
  acknowledgedAt: alert.acknowledgedAt,
  baselineValue: alert.baselineValue,
  check: alert.check,
  createdAt: alert.createdAt,
  forwardValue: alert.forwardValue,
  id: alert.id,
  level: alert.level,
  message: alert.message,
  monitorId: alert.monitorId,
  ratio: alert.ratio,
});

const detailOf = async (
  dependencies: Dependencies,
  monitor: ForwardDriftMonitorRecord,
  run: BacktestRunRecord & { report: BacktestRunReportOutput }
): Promise<ForwardDriftMonitor> => {
  const evaluation = evaluateDrift(
    baselineOf(run.report),
    { points: monitor.points, trades: monitor.trades },
    monitor.thresholds
  );
  const alerts = await dependencies.drift.listAlerts({
    limit: MONITOR_ALERTS_SHOWN,
    monitorId: monitor.id,
    openOnly: false,
  });
  return {
    alerts: alerts.map(alertOutput),
    baseline: {
      engineVersion: run.engineVersion,
      equity: run.report.equity.map((point) => ({
        equity: point.equity,
        t: point.t,
      })),
      initialCapital: run.spec.initialCapital,
      label: describeRun(run),
      seriesSha256: run.report.seriesSha256,
    },
    baselineRunId: monitor.baselineRunId,
    checks: evaluation.checks.map((check) => ({ ...check })),
    createdAt: monitor.createdAt,
    id: monitor.id,
    label: monitor.label,
    level: evaluation.level,
    paper: paperOf(monitor),
    pointCount: monitor.points.length,
    points: monitor.points,
    strategyRevision: monitor.strategyRevision,
    thresholds: monitor.thresholds,
    tradeCount: monitor.trades.length,
    trades: monitor.trades,
    updatedAt: monitor.updatedAt,
    version: monitor.version,
  };
};

const api = implement(appContract).$context<ApiContext>();

const create = api.backtestRuns.drift.create
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const dependencies = dependenciesFor(context, failures);
    const run = await baselineRun(dependencies, failures, input.baselineRunId);
    if (input.expectedRevision !== run.strategyRevision)
      throw failures.BAD_REQUEST({
        message: "The baseline run does not match the pinned strategy revision",
      });
    const thresholds = mergeThresholds(input.thresholds);
    const problem = thresholdProblem(thresholds);
    if (problem !== null) throw failures.BAD_REQUEST({ message: problem });
    const monitor = await dependencies.drift.create({
      baselineRunId: run.id,
      createdBy: context.principal.userId,
      label: input.label,
      strategyRevision: run.strategyRevision,
      thresholds,
    });
    return detailOf(dependencies, monitor, run);
  });

const record = api.backtestRuns.drift.record
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const dependencies = dependenciesFor(context, failures);
    const monitor = await dependencies.drift.get(input.id);
    if (monitor === null)
      throw failures.NOT_FOUND({ message: "Drift monitor not found" });
    const run = await baselineRun(
      dependencies,
      failures,
      monitor.baselineRunId
    );
    // A manual point or trade after the newest settled bar would move the runner's cursor past
    // bars it has not recorded yet; while the runner owns the series, manual recording waits.
    if (monitor.paperStatus === "running")
      throw failures.CONFLICT({
        message: "Stop the paper forward runner before recording by hand",
      });
    const outcome = await appendObservations(
      dependencies.drift,
      monitor,
      baselineOf(run.report),
      input
    );
    if (outcome.kind === "rejected")
      throw failures.BAD_REQUEST({ message: outcome.message });
    if (outcome.kind === "conflict") throw failures.CONFLICT();
    const saved = outcome;
    return {
      monitor: await detailOf(dependencies, saved.monitor, run),
      raised: saved.alerts.map(alertOutput),
    };
  });

const get = api.backtestRuns.drift.get
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const dependencies = dependenciesFor(context, failures);
    const monitor = await dependencies.drift.get(input.id);
    if (monitor === null)
      throw failures.NOT_FOUND({ message: "Drift monitor not found" });
    const run = await baselineRun(
      dependencies,
      failures,
      monitor.baselineRunId
    );
    return detailOf(dependencies, monitor, run);
  });

const list = api.backtestRuns.drift.list
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const dependencies = dependenciesFor(context, failures);
    const monitors = await dependencies.drift.list(input.limit);
    const openAlerts = await dependencies.drift.listAlerts({
      limit: OPEN_ALERTS_SHOWN,
      openOnly: true,
    });
    return {
      monitors: monitors.map((monitor) => ({
        baselineRunId: monitor.baselineRunId,
        createdAt: monitor.createdAt,
        id: monitor.id,
        label: monitor.label,
        level: monitor.level,
        paper: paperOf(monitor),
        pointCount: monitor.pointCount,
        strategyRevision: monitor.strategyRevision,
        thresholds: monitor.thresholds,
        tradeCount: monitor.tradeCount,
        updatedAt: monitor.updatedAt,
        version: monitor.version,
      })),
      openAlerts: openAlerts.map(alertOutput),
    };
  });

const acknowledge = api.backtestRuns.drift.acknowledge
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const dependencies = dependenciesFor(context, failures);
    const alert = await dependencies.drift.acknowledgeAlert(
      input.id,
      context.principal.userId
    );
    if (alert === null)
      throw failures.NOT_FOUND({
        message: "Alert not found or already acknowledged",
      });
    return alertOutput(alert);
  });

const paperSet = api.backtestRuns.drift.paperSet
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const dependencies = dependenciesFor(context, failures);
    const existing = await dependencies.drift.get(input.id);
    if (existing === null)
      throw failures.NOT_FOUND({ message: "Drift monitor not found" });
    const run = await baselineRun(
      dependencies,
      failures,
      existing.baselineRunId
    );
    const monitor = await dependencies.drift.setPaperStatus(
      input.id,
      input.running ? "running" : "off"
    );
    if (monitor === null)
      throw failures.NOT_FOUND({ message: "Drift monitor not found" });
    return detailOf(dependencies, monitor, run);
  });

const paperTick = api.backtestRuns.drift.paperTick
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const dependencies = dependenciesFor(context, failures);
    const marketBars = context.repositories.marketBars;
    if (marketBars === undefined) throw failures.STORAGE_ERROR();
    const ids =
      input.id === undefined
        ? await dependencies.drift.listRunningPaper(PAPER_FORWARD_TICK_MAX)
        : [input.id];
    const results: PaperForwardTickResult[] = [];
    const tick =
      input.id === undefined ? tickPaperForwardInBatch : tickPaperForward;
    for (const id of ids) {
      const ticked = await tick({ ...dependencies, marketBars }, id);
      if (ticked === null && input.id !== undefined)
        throw failures.NOT_FOUND({ message: "Drift monitor not found" });
      if (ticked !== null) results.push(ticked);
    }
    return { results };
  });

export const forwardDriftRouter = {
  acknowledge,
  create,
  get,
  list,
  paperSet,
  paperTick,
  record,
};
