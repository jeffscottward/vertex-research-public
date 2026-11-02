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
      to: form.to,
      initialCapital: form.initialCapital,
      strategyId: form.strategyId === "" ? null : form.strategyId,
      ...(form.costProfile === "" ? {} : { costProfile: form.costProfile }),
    },
  };
};

const money = (value: number | null): string =>
  value === null
    ? "n/a"
    : value.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
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
    return { path: "", markers: [], cursorX: null };
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
    n: trade.n,
    x1: x(trade.entryT),
    y1: y(trade.entryPrice),
    x2: x(trade.exitT),
    y2: y(trade.exitPrice),
    win: trade.pnl > 0,
    current: trade.n === step,
  }));
  const current = shown.at(-1);
  return {
    path,
    markers,
    cursorX: current === undefined ? null : x(current.exitT),
  };
};
