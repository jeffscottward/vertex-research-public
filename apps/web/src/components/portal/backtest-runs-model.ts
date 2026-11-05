import {
  type BacktestRun,
  type BacktestRunReportOutput,
  type BacktestRunSubmitInput,
  COST_PROFILE_PRESET_IDS,
  COST_PROFILE_PRESETS,
  type CostProfilePresetId,
  type InstantBacktestSeries,
} from "@darkfactory/api";

import {
  type InstantParams,
  toRunInput,
} from "./instant-backtest-workspace.tsx";

// Pure helpers for the backtest runs page: request building, metric rows and trade replay state.
// Research only; no order path.

export type RunForm = Readonly<{
  params: InstantParams;
  from: string;
  to: string;
  initialCapital: number;
  strategyId: string;
  /** "" for no cost profile. */
  costProfile: CostProfilePresetId | "";
}>;

/** Cost profile choices for the form. Runs use stock bars, so option presets are not offered. */
export const COST_PROFILE_OPTIONS: readonly Readonly<{
  id: CostProfilePresetId;
  label: string;
}>[] = COST_PROFILE_PRESET_IDS.filter(
  (id) => COST_PROFILE_PRESETS[id].instrument === "stock"
).map((id) => ({ id, label: COST_PROFILE_PRESETS[id].label }));

export const isCostProfilePresetId = (
  value: string
): value is CostProfilePresetId =>
  (COST_PROFILE_PRESET_IDS as readonly string[]).includes(value);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export const isoDate = (epochMs: number): string =>
  new Date(epochMs).toISOString().slice(0, 10);

/** Builds the submit request, or returns the reason the form cannot run. */
export const toSubmitInput = (
  form: RunForm,
  series: InstantBacktestSeries
):
  | Readonly<{ input: BacktestRunSubmitInput }>
  | Readonly<{ error: string }> => {
  const base = toRunInput(form.params, series);
  if ("error" in base) return base;
  if (!(DATE_PATTERN.test(form.from) && DATE_PATTERN.test(form.to)))
    return { error: "Enter both dates as YYYY-MM-DD." };
  if (form.from > form.to)
    return { error: "The start date must not be after the end date." };
  if (!(form.initialCapital >= 1 && form.initialCapital <= 1_000_000_000))
    return { error: "Initial capital must be from 1 to 1,000,000,000." };
  return {
    input: {
      ...base.input,
      from: form.from,
      initialCapital: form.initialCapital,
      strategyId: form.strategyId === "" ? null : form.strategyId,
      to: form.to,
      ...(form.costProfile === "" ? {} : { costProfile: form.costProfile }),
    },
  };
};

export type UniverseRunPlan = Readonly<{
  inputs: readonly BacktestRunSubmitInput[];
  /** Series with no stored bars inside the form's dates (the clipped range is empty). */
  skipped: number;
  /** Series the form cannot run for another reason; `firstError` is the first such reason. */
  invalid: number;
  firstError: string | null;
}>;

/**
 * One run per series of a universe. Each run keeps the form's settings; its dates are clipped to
 * that series' stored bars (from = later start, to = earlier end). Series with no bars inside the
 * form's dates are skipped; series the form cannot run for another reason count as invalid.
 */
export const toUniverseSubmitInputs = (
  form: RunForm,
  series: readonly InstantBacktestSeries[]
): UniverseRunPlan => {
  const inputs: BacktestRunSubmitInput[] = [];
  const datesValid =
    DATE_PATTERN.test(form.from) &&
    DATE_PATTERN.test(form.to) &&
    form.from <= form.to;
  let skipped = 0;
  let invalid = 0;
  let firstError: string | null = null;
  for (const entry of series) {
    const first = isoDate(entry.firstT);
    const last = isoDate(entry.lastT);
    const from = form.from > first ? form.from : first;
    const to = form.to < last ? form.to : last;
    if (datesValid && from > to) {
      skipped += 1;
      continue;
    }
    const built = toSubmitInput({ ...form, from, to }, entry);
    if ("error" in built) {
      invalid += 1;
      firstError ??= built.error;
    } else inputs.push(built.input);
  }
  return { firstError, inputs, invalid, skipped };
};

/** Preview next to the batch button, e.g. "7 runs, 0 skipped". */
export const describeUniversePlan = (plan: UniverseRunPlan): string =>
  `${plan.inputs.length} ${plan.inputs.length === 1 ? "run" : "runs"}, ${plan.skipped + plan.invalid} skipped`;

/** Summary line after a universe batch: submitted, not submitted, skipped and any failure. */
export const describeUniverseBatch = ({
  label,
  submitted,
  notSubmitted,
  plan,
  failure,
}: Readonly<{
  label: string;
  submitted: number;
  /** Planned runs not sent because a submit failed (the failed one included). */
  notSubmitted: number;
  plan: UniverseRunPlan;
  failure: string | null;
}>): string =>
  [
    `Submitted ${submitted} ${submitted === 1 ? "run" : "runs"} for ${label}.`,
    notSubmitted === 0 ? null : `${notSubmitted} not submitted.`,
    plan.skipped === 0
      ? null
      : `Skipped ${plan.skipped} series with no bars in the date range.`,
    plan.invalid === 0
      ? null
      : `Skipped ${plan.invalid} series that could not run: ${plan.firstError}`,
    failure,
  ]
    .filter((part) => part !== null)
    .join(" ");

const money = (value: number | null): string =>
  value === null
    ? "n/a"
    : value.toLocaleString("en-US", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      });
const percent = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
const ratio = (value: number | null): string =>
  value === null ? "n/a" : value.toFixed(2);

export type MetricRow = Readonly<{ label: string; value: string }>;

/** Report metrics as labelled rows, in report order. */
export const metricRows = (
  metrics: BacktestRunReportOutput["metrics"]
): readonly MetricRow[] => [
  { label: "Initial deposit", value: money(metrics.initialDeposit) },
  { label: "Total net profit", value: money(metrics.netProfit) },
  { label: "Gross profit", value: money(metrics.grossProfit) },
  { label: "Gross loss", value: money(metrics.grossLoss) },
  { label: "Profit factor", value: ratio(metrics.profitFactor) },
  { label: "Expected payoff", value: money(metrics.expectedPayoff) },
  { label: "Absolute drawdown", value: money(metrics.absoluteDrawdown) },
  {
    label: "Maximal drawdown",
    value: `${money(metrics.maxDrawdownAbs)} (${percent(metrics.maxDrawdownPct)})`,
  },
  { label: "Recovery factor", value: ratio(metrics.recoveryFactor) },
  { label: "Sharpe ratio", value: ratio(metrics.sharpe) },
  { label: "Sortino ratio", value: ratio(metrics.sortino) },
  { label: "Total trades", value: String(metrics.totalTrades) },
  {
    label: "Profit trades (% of total)",
    value: `${metrics.profitTrades} (${percent(metrics.winRate)})`,
  },
  { label: "Loss trades", value: String(metrics.lossTrades) },
  { label: "Largest profit trade", value: money(metrics.largestProfitTrade) },
  { label: "Largest loss trade", value: money(metrics.largestLossTrade) },
  { label: "Average profit trade", value: money(metrics.averageProfitTrade) },
  { label: "Average loss trade", value: money(metrics.averageLossTrade) },
  {
    label: "Maximum consecutive wins",
    value: String(metrics.maxConsecutiveWins),
  },
  {
    label: "Maximum consecutive losses (money)",
    value: `${metrics.maxConsecutiveLosses} (${money(metrics.maxConsecutiveLossesMoney)})`,
  },
  {
    label: "Maximal consecutive loss (count)",
    value: `${money(metrics.maximalConsecutiveLoss)} (${metrics.maximalConsecutiveLossCount})`,
  },
  { label: "Total return", value: percent(metrics.totalReturn) },
  { label: "CAGR", value: percent(metrics.cagr) },
  { label: "Exposure", value: percent(metrics.exposure) },
  { label: "Buy-and-hold return", value: percent(metrics.buyHoldReturn) },
];

/** Gross versus net rows when the run had a cost profile; empty otherwise. */
export const costRows = (
  report: BacktestRunReportOutput
): readonly MetricRow[] => {
  const costs = report.costs;
  if (costs === undefined) return [];
  return [
    { label: "Cost profile", value: costs.profileLabel },
    {
      label: "Net profit before costs",
      value: money(costs.netProfitBeforeCosts),
    },
    {
      label: "Total net profit after costs",
      value: money(report.metrics.netProfit),
    },
    { label: "Total costs", value: money(costs.total) },
    { label: "Commission", value: money(costs.commission) },
    { label: "Fees", value: money(costs.fees) },
    { label: "Spread", value: money(costs.spread) },
    { label: "Slippage", value: money(costs.slippage) },
    { label: "Flat cost (bps)", value: money(costs.bps) },
  ];
};

/** Provenance sentence for the report footer. */
export const describeRevision = (
  run: Pick<BacktestRun, "strategyRevision" | "strategySnapshot">
): string =>
  run.strategyRevision === null || run.strategySnapshot === null
    ? " No strategy linked."
    : ` Strategy ${run.strategySnapshot.name} revision ${run.strategyRevision.slice(0, 12)}….`;

export const isFinished = (run: BacktestRun): boolean =>
  run.status === "succeeded" || run.status === "failed";

export type ReplayGeometry = Readonly<{
  path: string;
  markers: readonly Readonly<{
    n: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    win: boolean;
    current: boolean;
  }>[];
  cursorX: number | null;
}>;

/**
 * Projects the price series and the trades up to `step` (1-based; 0 shows none) into an SVG box.
 * The cursor marks the exit of the current trade.
 */
export const replayGeometry = (
  report: Pick<BacktestRunReportOutput, "prices" | "trades">,
  step: number,
  width: number,
  height: number
): ReplayGeometry => {
  const { prices } = report;
  const first = prices[0];
  const last = prices.at(-1);
  if (first === undefined || last === undefined || last.t === first.t)
    return { cursorX: null, markers: [], path: "" };
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const price of prices) {
    low = Math.min(low, price.l);
    high = Math.max(high, price.h);
  }
  const span = high - low || 1;
  const x = (t: number) => ((t - first.t) / (last.t - first.t)) * width;
  const y = (value: number) => height - ((value - low) / span) * height;
  const path = prices
    .map(
      (price, index) =>
        `${index === 0 ? "M" : "L"}${x(price.t).toFixed(1)},${y(price.c).toFixed(1)}`
    )
    .join("");
  const shown = report.trades.slice(0, Math.max(0, step));
  const markers = shown.map((trade) => ({
    current: trade.n === step,
    n: trade.n,
    win: trade.pnl > 0,
    x1: x(trade.entryT),
    x2: x(trade.exitT),
    y1: y(trade.entryPrice),
    y2: y(trade.exitPrice),
  }));
  const current = shown.at(-1);
  return {
    cursorX: current === undefined ? null : x(current.exitT),
    markers,
    path,
  };
};

// The newest succeeded run in a newest-first list, or null when none finished well.
export const latestSucceededRunId = (
  runs: readonly Readonly<{ id: string; status: string }>[]
): string | null => runs.find((run) => run.status === "succeeded")?.id ?? null;

// The run to open on load: the linked run when the list has it, else the latest succeeded run.
export const pickInitialRunId = (
  linked: string | null,
  runs: readonly Readonly<{ id: string; status: string }>[]
): string | null =>
  linked !== null && runs.some((run) => run.id === linked)
    ? linked
    : latestSucceededRunId(runs);

// True for the API's "no such record" error.
export const isNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "NOT_FOUND";
