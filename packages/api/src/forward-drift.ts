import { seriesStats } from "./portfolio-combination.ts";

// Forward drift: compares a paper (forward) equity series and its closed trades with the backtest
// run that is the baseline for the same strategy revision. Five checks, each with a warn and an
// alert threshold on the ratio forward / baseline:
//   drawdown, losingStreak            higher is worse: level when ratio >= threshold
//   profitFactor, sharpe, winRate     lower is worse:  level when ratio <= threshold
// Drawdown and losing streak are fast checks (no minimum sample). Profit factor and win rate use
// the last DRIFT_ROLLING_TRADES closed trades and need DRIFT_MIN_TRADES; Sharpe uses all forward
// points and needs DRIFT_MIN_RETURNS returns. Pure functions; paper data only, no order path.

export const DRIFT_CHECK_KEYS = [
  "drawdown",
  "losingStreak",
  "profitFactor",
  "sharpe",
  "winRate",
] as const;
export type DriftCheckKey = (typeof DRIFT_CHECK_KEYS)[number];
export type DriftLevel = "ok" | "warn" | "alert" | "insufficient";
export type DriftDirection = "higher-is-worse" | "lower-is-worse";
export type DriftThreshold = Readonly<{ warn: number; alert: number }>;
export type DriftThresholds = Readonly<Record<DriftCheckKey, DriftThreshold>>;

const DRIFT_DIRECTIONS: Readonly<Record<DriftCheckKey, DriftDirection>> = {
  drawdown: "higher-is-worse",
  losingStreak: "higher-is-worse",
  profitFactor: "lower-is-worse",
  sharpe: "lower-is-worse",
  winRate: "lower-is-worse",
};

const DRIFT_LABELS: Readonly<Record<DriftCheckKey, string>> = {
  drawdown: "Max drawdown",
  losingStreak: "Losing streak",
  profitFactor: "Rolling profit factor",
  sharpe: "Sharpe",
  winRate: "Rolling win rate",
};

export const DEFAULT_DRIFT_THRESHOLDS: DriftThresholds = {
  drawdown: { alert: 1.5, warn: 1 },
  losingStreak: { alert: 1.5, warn: 1.25 },
  profitFactor: { alert: 0.5, warn: 0.75 },
  sharpe: { alert: 0, warn: 0.5 },
  winRate: { alert: 0.6, warn: 0.8 },
};

/** Closed trades in the rolling window for profit factor and win rate. */
const DRIFT_ROLLING_TRADES = 20;
/** Fewer closed trades than this in the window gives "insufficient" for profit factor and win rate. */
const DRIFT_MIN_TRADES = 10;
/** Fewer forward returns than this gives "insufficient" for Sharpe. */
const DRIFT_MIN_RETURNS = 20;
/** The baseline drawdown used as the divisor is at least this fraction (1%). */
const DRIFT_DRAWDOWN_FLOOR = 0.01;

export type DriftPoint = Readonly<{ t: number; equity: number }>;
export type DriftTrade = Readonly<{ t: number; pnl: number }>;

export type DriftBaseline = Readonly<{
  /** Fraction, for example 0.12 for 12%. */
  maxDrawdownPct: number;
  maxConsecutiveLosses: number;
  profitFactor: number | null;
  /** Fraction of trades with pnl > 0. */
  winRate: number | null;
  equity: readonly DriftPoint[];
}>;

export type DriftForward = Readonly<{
  points: readonly DriftPoint[];
  trades: readonly DriftTrade[];
}>;

export type DriftCheck = Readonly<{
  key: DriftCheckKey;
  label: string;
  direction: DriftDirection;
  baseline: number | null;
  forward: number | null;
  ratio: number | null;
  warnAt: number;
  alertAt: number;
  level: DriftLevel;
  sample: number;
  minSample: number;
  reason: string;
}>;

export type DriftEvaluation = Readonly<{
  level: DriftLevel;
  checks: readonly DriftCheck[];
}>;

export class DriftInputError extends Error {}

const SEVERITY: Readonly<Record<DriftLevel, number>> = {
  alert: 2,
  insufficient: -1,
  ok: 0,
  warn: 1,
};

/** The first threshold problem as text, or null when every threshold is valid. */
export const thresholdProblem = (
  thresholds: DriftThresholds
): string | null => {
  for (const key of DRIFT_CHECK_KEYS) {
    const { warn, alert } = thresholds[key];
    if (!(Number.isFinite(warn) && Number.isFinite(alert)))
      return `${DRIFT_LABELS[key]} thresholds must be finite`;
    const higher = DRIFT_DIRECTIONS[key] === "higher-is-worse";
    if (higher ? alert < warn : alert > warn)
      return `${DRIFT_LABELS[key]} alert threshold must be ${
        higher ? "at or above" : "at or below"
      } the warn threshold`;
  }
  return null;
};

/** Throws DriftInputError when a threshold is invalid. */
export const validateThresholds = (thresholds: DriftThresholds): void => {
  const problem = thresholdProblem(thresholds);
  if (problem !== null) throw new DriftInputError(problem);
};

export type DriftThresholdOverrides = Readonly<
  Partial<
    Record<
      DriftCheckKey,
      | Readonly<{ warn?: number | undefined; alert?: number | undefined }>
      | undefined
    >
  >
>;

/** Default thresholds with the given per-check overrides applied; not validated. */
export const mergeThresholds = (
  overrides: DriftThresholdOverrides = {}
): DriftThresholds =>
  Object.fromEntries(
    DRIFT_CHECK_KEYS.map((key) => {
      const fallback = DEFAULT_DRIFT_THRESHOLDS[key];
      const override = overrides[key];
      return [
        key,
        {
          alert: override?.alert ?? fallback.alert,
          warn: override?.warn ?? fallback.warn,
        },
      ];
    })
  ) as Record<DriftCheckKey, DriftThreshold>;

/** Merged and validated thresholds. */
export const resolveThresholds = (
  overrides: DriftThresholdOverrides = {}
): DriftThresholds => {
  const resolved = mergeThresholds(overrides);
  validateThresholds(resolved);
  return resolved;
};

/** Largest fall from a running peak, as a fraction. Equity is checked positive before. */
const maxDrawdown = (points: readonly DriftPoint[]): number => {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const point of points) {
    peak = Math.max(peak, point.equity);
    worst = Math.max(worst, (peak - point.equity) / peak);
  }
  return worst;
};

/** Longest run of consecutive trades with pnl < 0; a zero-pnl trade ends the run. */
export const longestLosingStreak = (trades: readonly DriftTrade[]): number => {
  let longest = 0;
  let current = 0;
  for (const trade of trades) {
    current = trade.pnl < 0 ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
};

/** Gross profit / gross loss; null when there is no losing trade. */
export const profitFactorOf = (
  trades: readonly DriftTrade[]
): number | null => {
  let profit = 0;
  let loss = 0;
  for (const trade of trades) {
    if (trade.pnl > 0) profit += trade.pnl;
    else loss -= trade.pnl;
  }
  return loss > 0 ? profit / loss : null;
};

/** Tolerance for floating-point error at a threshold (15% / 10% must reach 1.5). */
const THRESHOLD_TOLERANCE = 1e-9;

const levelFor = (
  direction: DriftDirection,
  ratio: number,
  threshold: DriftThreshold
): DriftLevel => {
  if (direction === "higher-is-worse") {
    if (ratio >= threshold.alert - THRESHOLD_TOLERANCE) return "alert";
    return ratio >= threshold.warn - THRESHOLD_TOLERANCE ? "warn" : "ok";
  }
  if (ratio <= threshold.alert + THRESHOLD_TOLERANCE) return "alert";
  return ratio <= threshold.warn + THRESHOLD_TOLERANCE ? "warn" : "ok";
};

type Measured = Readonly<{
  baseline: number | null;
  forward: number | null;
  sample: number;
  minSample: number;
  outcome:
    | Readonly<{ kind: "ratio"; forward: number; divisor: number }>
    | Readonly<{ kind: "fixed"; level: DriftLevel; reason: string }>;
}>;

const insufficient = (
  level: Omit<Measured, "outcome">,
  reason: string
): Measured => ({
  ...level,
  outcome: { kind: "fixed", level: "insufficient", reason },
});

const finish = (
  key: DriftCheckKey,
  measured: Measured,
  threshold: DriftThreshold
): DriftCheck => {
  const base = {
    alertAt: threshold.alert,
    baseline: measured.baseline,
    direction: DRIFT_DIRECTIONS[key],
    forward: measured.forward,
    key,
    label: DRIFT_LABELS[key],
    minSample: measured.minSample,
    sample: measured.sample,
    warnAt: threshold.warn,
  };
  if (measured.outcome.kind === "fixed")
    return {
      ...base,
      level: measured.outcome.level,
      ratio: null,
      reason: measured.outcome.reason,
    };
  const ratio = measured.outcome.forward / measured.outcome.divisor;
  const level = levelFor(DRIFT_DIRECTIONS[key], ratio, threshold);
  const limit = level === "alert" ? threshold.alert : threshold.warn;
  const reason =
    level === "ok"
      ? `Ratio ${ratio.toFixed(2)} is inside the warn threshold ${threshold.warn}`
      : `Ratio ${ratio.toFixed(2)} crossed the ${level} threshold ${limit}`;
  return { ...base, level, ratio, reason };
};

const ascending = (values: readonly Readonly<{ t: number }>[]): boolean => {
  let previous = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value.t < previous) return false;
    previous = value.t;
  }
  return true;
};

const ratioOf = (
  common: Omit<Measured, "outcome">,
  forward: number,
  divisor: number
): Measured => ({ ...common, outcome: { divisor, forward, kind: "ratio" } });

const measureDrawdown = (
  baseline: DriftBaseline,
  points: readonly DriftPoint[]
): Measured => {
  const forward = points.length < 2 ? null : maxDrawdown(points);
  const common = {
    baseline: baseline.maxDrawdownPct,
    forward,
    minSample: 2,
    sample: points.length,
  };
  return forward === null
    ? insufficient(common, "Needs at least 2 forward equity points")
    : ratioOf(
        common,
        forward,
        Math.max(baseline.maxDrawdownPct, DRIFT_DRAWDOWN_FLOOR)
      );
};

const measureLosingStreak = (
  baseline: DriftBaseline,
  trades: readonly DriftTrade[]
): Measured => {
  const forward = trades.length === 0 ? null : longestLosingStreak(trades);
  const common = {
    baseline: baseline.maxConsecutiveLosses,
    forward,
    minSample: 1,
    sample: trades.length,
  };
  return forward === null
    ? insufficient(common, "No closed forward trades yet")
    : ratioOf(common, forward, Math.max(baseline.maxConsecutiveLosses, 1));
};

/** Shared gate: a positive baseline and enough sample, then the ratio. */
const compare = (
  common: Omit<Measured, "outcome">,
  what: string,
  unit: string
): Measured | null => {
  if (common.baseline === null || !(common.baseline > 0))
    return insufficient(
      common,
      `The baseline has no positive ${what} to compare`
    );
  if (common.sample < common.minSample)
    return insufficient(common, `Needs at least ${common.minSample} ${unit}`);
  return null;
};

const measureProfitFactor = (
  baseline: DriftBaseline,
  window: readonly DriftTrade[]
): Measured => {
  const forward = profitFactorOf(window);
  const common = {
    baseline: baseline.profitFactor,
    forward,
    minSample: DRIFT_MIN_TRADES,
    sample: window.length,
  };
  const gated = compare(common, "profit factor", "closed forward trades");
  if (gated !== null) return gated;
  return forward === null
    ? {
        ...common,
        outcome: {
          kind: "fixed",
          level: "ok",
          reason: "No losing trade in the window",
        },
      }
    : ratioOf(common, forward, baseline.profitFactor as number);
};

const sharpeOf = (points: readonly DriftPoint[]): number | null =>
  points.length < 2
    ? null
    : seriesStats(
        points.map((point) => point.t),
        points.map((point) => point.equity)
      ).sharpe;

const measureSharpe = (
  baseline: DriftBaseline,
  points: readonly DriftPoint[]
): Measured => {
  const baselineSharpe = sharpeOf(baseline.equity);
  const forward = sharpeOf(points);
  const common = {
    baseline: baselineSharpe,
    forward,
    minSample: DRIFT_MIN_RETURNS,
    sample: Math.max(points.length - 1, 0),
  };
  const gated = compare(common, "Sharpe", "forward returns");
  if (gated !== null) return gated;
  // Returns that do not vary (for example a flat series without a position) have no Sharpe.
  // That is not evidence of drift, so the check stays insufficient instead of alerting.
  return forward === null
    ? insufficient(common, "Paper returns do not vary, so Sharpe is undefined")
    : ratioOf(common, forward, baselineSharpe as number);
};

const measureWinRate = (
  baseline: DriftBaseline,
  window: readonly DriftTrade[]
): Measured => {
  const forward =
    window.length === 0
      ? null
      : window.filter((trade) => trade.pnl > 0).length / window.length;
  const common = {
    baseline: baseline.winRate,
    forward,
    minSample: DRIFT_MIN_TRADES,
    sample: window.length,
  };
  return (
    compare(common, "win rate", "closed forward trades") ??
    ratioOf(common, forward as number, baseline.winRate as number)
  );
};

/** Evaluates every drift check of a forward series against its baseline. */
export const evaluateDrift = (
  baseline: DriftBaseline,
  forward: DriftForward,
  thresholds: DriftThresholds = DEFAULT_DRIFT_THRESHOLDS
): DriftEvaluation => {
  validateThresholds(thresholds);
  if (!(ascending(forward.points) && ascending(forward.trades)))
    throw new DriftInputError(
      "Forward points and trades must be in time order"
    );
  if (forward.points.some((point) => !(point.equity > 0)))
    throw new DriftInputError("Forward equity must be positive");
  const window = forward.trades.slice(-DRIFT_ROLLING_TRADES);
  const measured: Readonly<Record<DriftCheckKey, Measured>> = {
    drawdown: measureDrawdown(baseline, forward.points),
    losingStreak: measureLosingStreak(baseline, forward.trades),
    profitFactor: measureProfitFactor(baseline, window),
    sharpe: measureSharpe(baseline, forward.points),
    winRate: measureWinRate(baseline, window),
  };
  const checks = DRIFT_CHECK_KEYS.map((key) =>
    finish(key, measured[key], thresholds[key])
  );
  return { checks, level: overallLevel(checks) };
};

/** The most severe level of the checks; "insufficient" only when every check is insufficient. */
export const overallLevel = (
  checks: readonly Readonly<{ level: DriftLevel }>[]
): DriftLevel =>
  checks.reduce<DriftLevel>(
    (worst, check) =>
      SEVERITY[check.level] > SEVERITY[worst] ? check.level : worst,
    "insufficient"
  );

export type DriftLevels = Readonly<Partial<Record<DriftCheckKey, DriftLevel>>>;

/**
 * Checks that must raise an alert: the level is warn or alert and more severe than the level the
 * check had at the previous evaluation. A check that falls back and crosses again alerts again.
 */
export const escalations = (
  previous: DriftLevels,
  checks: readonly DriftCheck[]
): DriftCheck[] =>
  checks.filter(
    (check) =>
      (check.level === "warn" || check.level === "alert") &&
      SEVERITY[check.level] > Math.max(SEVERITY[previous[check.key] ?? "ok"], 0)
  );

/** Levels per check, stored after an evaluation for the next escalation test. */
export const levelsOf = (checks: readonly DriftCheck[]): DriftLevels =>
  Object.fromEntries(checks.map((check) => [check.key, check.level]));

const formatValue = (key: DriftCheckKey, value: number | null): string => {
  if (value === null) return "n/a";
  if (key === "drawdown" || key === "winRate")
    return `${(value * 100).toFixed(2)}%`;
  if (key === "losingStreak") return `${value} trades`;
  return value.toFixed(2);
};

/** In-app alert text. No account data, only the measured values. */
export const alertMessage = (check: DriftCheck): string =>
  `${check.label} ${check.level}: forward ${formatValue(check.key, check.forward)} vs baseline ${formatValue(
    check.key,
    check.baseline
  )} (ratio ${check.ratio === null ? "n/a" : check.ratio.toFixed(2)}; warn at ${check.warnAt}, alert at ${check.alertAt})`;
