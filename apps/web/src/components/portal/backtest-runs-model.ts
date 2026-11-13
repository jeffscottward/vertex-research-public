import {
  type BacktestRun,
  type BacktestRunReportOutput,
  type BacktestRunSubmitInput,
  COST_PROFILE_PRESET_IDS,
  COST_PROFILE_PRESETS,
  type CostProfilePresetId,
  type InstantBacktestSeries,
  STRATEGY_OPTION_SYMBOLS,
  type StrategyDefinition,
  type StrategyDefinitionGetOutput,
} from "@darkfactory/api";

import {
  type InstantParams,
  toRunInput,
} from "./instant-backtest-workspace.tsx";

// Pure helpers for the backtest runs page: request building, metric rows and trade replay state.
// Research only; no order path.

/** A stored strategy definition revision the form runs (from a strategy library link). */
export type LinkedDefinition = Readonly<{
  id: string;
  revision: number;
  sha256: string;
  name: string;
  definition: StrategyDefinition;
  /** False when the linked SHA-256 was not found, so the latest revision was loaded instead. */
  pinned: boolean;
}>;

export type RunForm = Readonly<{
  params: InstantParams;
  from: string;
  to: string;
  initialCapital: number;
  strategyId: string;
  /** "" for no cost profile. */
  costProfile: CostProfilePresetId | "";
  /** Set to run a stored definition (rule kind dsl) instead of the SMA cross or breakout rule. */
  definition?: LinkedDefinition | null;
  /** The options run dates, kept while another rule runs on stored bars. */
  storeDates?: Readonly<{ from: string; to: string }> | undefined;
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

/** True for a real calendar day written as YYYY-MM-DD (2026-02-30 is not one). */
export const isCalendarDate = (value: string): boolean =>
  DATE_PATTERN.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  isoDate(Date.parse(`${value}T00:00:00Z`)) === value;

/** The rule part of a run request, before dates, capital and strategy are added. */
export type RunRuleInput = Pick<
  BacktestRunSubmitInput,
  "costBps" | "rule" | "stopLossPct" | "symbol" | "takeProfitPct" | "timeframe"
>;

/**
 * True when the form runs a stored options definition. The options book charges its own costs
 * ($0.65 per contract per leg plus half the bid-ask spread), so the flat cost is 0 and no cost
 * profile is sent.
 */
export const runsOptionsDefinition = (form: Pick<RunForm, "definition">) =>
  form.definition?.definition.options !== undefined;

/**
 * The symbol and timeframe a run reads: a stored bar series, or for an options definition a symbol
 * of the daily series store on 1d.
 */
export type RunSeries = Pick<InstantBacktestSeries, "symbol" | "timeframe">;

/** The rule part of the request: the stored definition, or the SMA cross or breakout rule. */
const ruleInput = (
  form: RunForm,
  series: RunSeries
): Readonly<{ input: RunRuleInput }> | Readonly<{ error: string }> => {
  const definition = form.definition ?? null;
  if (definition === null) return toRunInput(form.params, series);
  if (runsOptionsDefinition(form)) {
    const symbols = optionsRunSymbols(definition.definition);
    if (!symbols.includes(series.symbol))
      return {
        error: `The definition trades ${symbols.join(", ")}; choose one of them.`,
      };
  }
  const costBps = runsOptionsDefinition(form) ? 0 : form.params.costBps;
  if (!(costBps >= 0 && costBps <= 500))
    return { error: "Cost per side must be from 0 to 500 bps." };
  return {
    input: {
      costBps,
      rule: { definition: definition.definition, kind: "dsl" },
      symbol: series.symbol,
      timeframe: series.timeframe,
    },
  };
};

/** Builds the submit request, or returns the reason the form cannot run. */
export const toSubmitInput = (
  form: RunForm,
  series: RunSeries
):
  | Readonly<{ input: BacktestRunSubmitInput }>
  | Readonly<{ error: string }> => {
  const base = ruleInput(form, series);
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
      ...(form.costProfile === "" || runsOptionsDefinition(form)
        ? {}
        : { costProfile: form.costProfile }),
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

/** The options book of an options run (report.options). */
export type OptionsBook = NonNullable<BacktestRunReportOutput["options"]>;
export type TradeExitReason =
  BacktestRunReportOutput["trades"][number]["exitReason"];

/** Plain labels of every exit reason, the options book reasons included. */
export const EXIT_REASON_LABELS: Readonly<Record<TradeExitReason, string>> = {
  end: "End of data",
  exitDte: "Exit DTE reached",
  expiry: "Expiry",
  profitTake: "Profit take",
  sessionClose: "Session close",
  signal: "Exit signal",
  "stale-iv": "Stale IV",
  stop: "Stop loss",
  target: "Take profit",
};

/** The label of an exit reason; a reason this page does not know is shown as stored. */
export const exitReasonLabel = (reason: string): string =>
  (EXIT_REASON_LABELS as Readonly<Record<string, string | undefined>>)[
    reason
  ] ?? reason;

/** Options book metrics as labelled rows; the Nautilus gap only when the run has one. */
export const optionsMetricRows = (book: OptionsBook): readonly MetricRow[] => {
  const { metrics } = book;
  return [
    { label: "Start", value: metrics.start },
    { label: "End", value: metrics.end },
    { label: "Capital", value: money(book.capital) },
    { label: "Final equity", value: money(metrics.finalEquity) },
    { label: "Total return", value: percent(metrics.totalReturn) },
    { label: "CAGR", value: percent(metrics.cagr) },
    { label: "Sharpe ratio", value: ratio(metrics.sharpe) },
    {
      label: "Probabilistic Sharpe (1 trial)",
      value: ratio(metrics.deflatedSharpe),
    },
    // The runner stores drawdowns as negative or positive fractions; show the loss as negative.
    { label: "Max drawdown", value: percent(-Math.abs(metrics.maxDrawdown)) },
    {
      label: "Worst month",
      value:
        metrics.worstMonth === null
          ? "n/a"
          : `${metrics.worstMonth} (${percent(metrics.worstMonthReturn)})`,
    },
    { label: "Trades", value: String(metrics.trades) },
    { label: "Win rate", value: percent(metrics.winRate) },
    { label: "Exposure", value: percent(metrics.exposure) },
    { label: "Skipped entries", value: String(metrics.skipped) },
    { label: "Max open risk", value: percent(metrics.maxOpenRisk) },
    { label: "Stale-IV exits", value: String(metrics.staleIvExits) },
    ...(book.nautilusGap === null
      ? []
      : [
          {
            label: "Nautilus gap (largest daily equity gap)",
            value: `${(book.nautilusGap * 100).toFixed(4)}%`,
          },
        ]),
  ];
};

/** Entry signals of each traded symbol, in symbol order (0 when the book has none). */
export const optionsSignalRows = (
  book: OptionsBook
): readonly Readonly<{ symbol: string; signals: number }>[] =>
  book.symbols.map((symbol) => ({
    signals: book.signals[symbol] ?? 0,
    symbol,
  }));

/** Heading of the option trades table; marks a stored list shorter than the trade count. */
export const optionTradesHeading = (book: OptionsBook): string =>
  book.trades.length < book.metrics.trades
    ? `Option trades (first ${book.trades.length} of ${book.metrics.trades})`
    : "Option trades";

/**
 * A link that opens this page with a stored strategy definition, e.g. from the strategy library:
 * /backtest-runs?definition=<id>&sha=<sha256>&strategy=<id>&timeframe=1d&from=…&initialCapital=…
 * An options definition runs on the daily series store: without `symbol` the page takes its first
 * portfolio symbol, without `to` today's UTC date. Other definitions run on the stored bar series of
 * `symbol`; without `to` the form keeps the series' last stored date.
 */
export type DefinitionLink = Readonly<{
  id: string;
  sha256: string | null;
  symbol: string | null;
  timeframe: string;
  from: string | null;
  to: string | null;
  initialCapital: number | null;
  costBps: number | null;
}>;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Reads a definition link from the address bar; null when it names no definition. */
export const readDefinitionLink = (search: string): DefinitionLink | null => {
  const params = new URLSearchParams(search);
  const text = (name: string): string | null => {
    const value = params.get(name)?.trim() ?? "";
    return value === "" ? null : value;
  };
  const number = (name: string): number | null => {
    const value = Number(text(name) ?? Number.NaN);
    return Number.isFinite(value) ? value : null;
  };
  const id = text("definition");
  if (id === null) return null;
  const sha256 = text("sha");
  const date = (name: string): string | null => {
    const value = text(name);
    return value !== null && isCalendarDate(value) ? value : null;
  };
  // A start after the end cannot run: such a link keeps neither date.
  const from = date("from");
  const to = date("to");
  const ordered = from === null || to === null || from <= to;
  return {
    costBps: number("costBps"),
    from: ordered ? from : null,
    id,
    initialCapital: number("initialCapital"),
    sha256: sha256 !== null && SHA256_PATTERN.test(sha256) ? sha256 : null,
    symbol: text("symbol"),
    timeframe: text("timeframe") ?? "1d",
    to: ordered ? to : null,
  };
};

/** The page address of a definition link; empty values are left out. */
export const definitionRunHref = (
  link: DefinitionLink & Readonly<{ strategyId: string | null }>
): string => {
  const entries: readonly (readonly [string, string | number | null])[] = [
    ["definition", link.id],
    ["sha", link.sha256],
    ["strategy", link.strategyId],
    ["symbol", link.symbol],
    ["timeframe", link.timeframe],
    ["from", link.from],
    ["to", link.to],
    ["initialCapital", link.initialCapital],
    ["costBps", link.costBps],
  ];
  const params = new URLSearchParams();
  for (const [name, value] of entries)
    if (value !== null) params.set(name, String(value));
  return `/backtest-runs?${params.toString()}`;
};

export type DefinitionGetter = (
  id: string,
  revision?: number
) => Promise<StrategyDefinitionGetOutput>;

/**
 * Loads the linked definition: the latest revision, or the revision whose SHA-256 the link names
 * when the latest one differs. A SHA-256 that no listed revision has loads the latest, unpinned.
 */
export const loadLinkedDefinition = async (
  get: DefinitionGetter,
  link: Pick<DefinitionLink, "id" | "sha256">
): Promise<LinkedDefinition> => {
  const latest = await get(link.id);
  const linked = (
    revision: StrategyDefinitionGetOutput["revision"],
    pinned: boolean
  ): LinkedDefinition => ({
    definition: revision.definition,
    id: revision.id,
    name: revision.name,
    pinned,
    revision: revision.revision,
    sha256: revision.sha256,
  });
  if (link.sha256 === null || latest.revision.sha256 === link.sha256)
    return linked(latest.revision, true);
  const match = latest.history.find((entry) => entry.sha256 === link.sha256);
  if (match === undefined) return linked(latest.revision, false);
  return linked((await get(link.id, match.revision)).revision, true);
};

/** The stored bar series a definition link names (definitions without options), if any. */
export const definitionSeries = (
  series: readonly InstantBacktestSeries[],
  link: Pick<DefinitionLink, "symbol" | "timeframe">
): InstantBacktestSeries | undefined =>
  series.find(
    (entry) =>
      entry.symbol === link.symbol && entry.timeframe === link.timeframe
  );

/**
 * Symbols an options definition may run on: its portfolio members, else every Core 7 ETF. Options
 * runs read the daily series store, so a member needs no stored bar series.
 */
export const optionsRunSymbols = (
  definition: StrategyDefinition
): readonly string[] =>
  definition.portfolio?.symbols ?? STRATEGY_OPTION_SYMBOLS;

/** The symbol an options definition link opens with: the link symbol when allowed, else the first. */
export const optionsLinkSymbol = (
  link: Pick<DefinitionLink, "symbol">,
  definition: StrategyDefinition
): string => {
  const symbols = optionsRunSymbols(definition);
  return link.symbol !== null && symbols.includes(link.symbol)
    ? link.symbol
    : (symbols[0] as string);
};

/** Today's date in UTC as YYYY-MM-DD: the default end of an options run (the store slices to it). */
export const todayUtc = (): string => isoDate(Date.now());

/**
 * The default start of an options run without a linked start: one year before its end; a leap
 * day ends on 28 February of the year before.
 */
export const optionsDefaultFrom = (to: string): string => {
  const year = Number(to.slice(0, 4)) - 1;
  const monthDay = to.slice(5) === "02-29" ? "02-28" : to.slice(5);
  return `${String(year).padStart(4, "0")}-${monthDay}`;
};

/**
 * The dates after a rule switch. Moving off an options definition takes the stored range of the
 * selected series (the store dates may lie outside its bars) and remembers the options dates;
 * moving back onto it restores them, else a year to today (UTC). A switch that keeps the data
 * source keeps the dates.
 */
export const ruleSwitchDates = (
  current: Pick<RunForm, "definition" | "from" | "to" | "storeDates">,
  next: Pick<RunForm, "definition">,
  series: InstantBacktestSeries | undefined
): Pick<RunForm, "from" | "to" | "storeDates"> => {
  const wasOptions = runsOptionsDefinition(current);
  const options = runsOptionsDefinition(next);
  const kept = {
    from: current.from,
    storeDates: current.storeDates,
    to: current.to,
  };
  if (wasOptions === options) return kept;
  if (options) {
    if (current.storeDates !== undefined)
      return { ...current.storeDates, storeDates: undefined };
    const to = todayUtc();
    return { from: optionsDefaultFrom(to), storeDates: undefined, to };
  }
  const storeDates = { from: current.from, to: current.to };
  return series === undefined
    ? { ...kept, storeDates }
    : { from: isoDate(series.firstT), storeDates, to: isoDate(series.lastT) };
};

/** "Strategy definition: <id> revision 1 (sha 0123456789ab…), <name>." */
export const describeLinkedDefinition = (linked: LinkedDefinition): string =>
  `Strategy definition: ${linked.id} revision ${linked.revision} (sha ${linked.sha256.slice(0, 12)}…), ${linked.name}.${linked.pinned ? "" : " The linked SHA-256 is not a stored revision, so the latest revision is loaded."}`;

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
