import type {
  ForwardDriftAlertRecord,
  ForwardDriftMonitorRecord,
  ForwardDriftRepository,
} from "@darkfactory/db/server";

import type { BacktestRunReportOutput } from "../contracts/backtest-runs.ts";
import { FORWARD_DRIFT_STORED_MAX } from "../contracts/forward-drift.ts";
import {
  alertMessage,
  type DriftBaseline,
  type DriftPoint,
  type DriftTrade,
  escalations,
  evaluateDrift,
  levelsOf,
} from "../forward-drift.ts";

// Appends paper points and trades to a drift monitor: checks order and storage limits, evaluates
// every check against the baseline, and saves the series, levels and raised alerts under the
// monitor's version. Used by backtestRuns.drift.record and by the paper forward runner.
// Paper data only; no order path.

export const baselineOf = (report: BacktestRunReportOutput): DriftBaseline => ({
  equity: report.equity,
  maxConsecutiveLosses: report.metrics.maxConsecutiveLosses,
  maxDrawdownPct: report.metrics.maxDrawdownPct,
  profitFactor: report.metrics.profitFactor,
  winRate: report.metrics.winRate,
});

export type AppendOutcome =
  | Readonly<{
      kind: "saved";
      monitor: ForwardDriftMonitorRecord;
      alerts: ForwardDriftAlertRecord[];
    }>
  | Readonly<{ kind: "rejected"; message: string }>
  | Readonly<{ kind: "conflict" }>;

export const appendObservations = async (
  drift: ForwardDriftRepository,
  monitor: ForwardDriftMonitorRecord,
  baseline: DriftBaseline,
  input: Readonly<{
    points: readonly DriftPoint[];
    trades: readonly DriftTrade[];
  }>
): Promise<AppendOutcome> => {
  const lastPoint = monitor.points.at(-1)?.t ?? Number.NEGATIVE_INFINITY;
  const lastTrade = monitor.trades.at(-1)?.t ?? Number.NEGATIVE_INFINITY;
  if ((input.points[0]?.t ?? Number.POSITIVE_INFINITY) <= lastPoint)
    return {
      kind: "rejected",
      message: "New points must be later than the last stored point",
    };
  // Strictly later, so a resent request (for example after a lost response) cannot store the
  // same trades twice. Trades inside one request may share a time.
  if ((input.trades[0]?.t ?? Number.POSITIVE_INFINITY) <= lastTrade)
    return {
      kind: "rejected",
      message: "New trades must be later than the last stored trade",
    };
  const points = [...monitor.points, ...input.points];
  const trades = [...monitor.trades, ...input.trades];
  if (
    points.length > FORWARD_DRIFT_STORED_MAX ||
    trades.length > FORWARD_DRIFT_STORED_MAX
  )
    return {
      kind: "rejected",
      message: `A monitor stores at most ${FORWARD_DRIFT_STORED_MAX} points and ${FORWARD_DRIFT_STORED_MAX} trades`,
    };
  const evaluation = evaluateDrift(
    baseline,
    { points, trades },
    monitor.thresholds
  );
  const raised = escalations(monitor.levels, evaluation.checks);
  const saved = await drift.saveEvaluation({
    alerts: raised.map((check) => ({
      baselineValue: check.baseline,
      check: check.key,
      forwardValue: check.forward,
      // escalations() returns only warn and alert checks.
      level: check.level as "warn" | "alert",
      message: alertMessage(check),
      ratio: check.ratio,
    })),
    expectedVersion: monitor.version,
    id: monitor.id,
    level: evaluation.level,
    levels: levelsOf(evaluation.checks),
    points,
    trades,
  });
  if (saved === null) return { kind: "conflict" };
  return { alerts: saved.alerts, kind: "saved", monitor: saved.monitor };
};
