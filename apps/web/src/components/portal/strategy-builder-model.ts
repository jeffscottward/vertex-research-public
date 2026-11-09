import {
  type BacktestRunSubmitInput,
  type BacktestRunSummary,
  type InstantBacktestSeries,
  STRATEGY_EVENT_OPERATORS,
  type STRATEGY_INDICATORS,
  STRATEGY_TEMPLATES,
  type StrategyCondition,
  type StrategyDefinition,
  StrategyDefinitionSchema,
  type StrategyExpr,
  type StrategyFilter,
  type StrategyOptions,
  type StrategyPortfolio,
  type StrategySeriesRef,
  type StrategyTemplateId,
} from "@darkfactory/api";

import { isNotFound } from "./backtest-runs-model.ts";

// Pure helpers of the strategy builder: template loading, definition text, list edits, the run
// request and the result summary. Research only; the request queues a backtest, never an order.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export const templateDefinition = (
  id: StrategyTemplateId
): StrategyDefinition => StrategyDefinitionSchema.parse(STRATEGY_TEMPLATES[id]);

export const definitionText = (definition: StrategyDefinition): string =>
  JSON.stringify(definition, null, 2);

/** Expressions the visual builder edits; every other type is shown read-only and kept as is. */
export type EditableExpr = Extract<
  StrategyExpr,
  { type: "price" | "const" | "indicator" }
>;

export const isEditableExpr = (expr: StrategyExpr): expr is EditableExpr =>
  expr.type === "price" || expr.type === "const" || expr.type === "indicator";

export const defaultExpr = (type: EditableExpr["type"]): EditableExpr => {
  if (type === "price") return { field: "close", type: "price" };
  if (type === "const") return { type: "const", value: 0 };
  return { length: 20, name: "sma", source: "close", type: "indicator" };
};

type StrategyIndicator = (typeof STRATEGY_INDICATORS)[number];

/** Plain labels of the indicator choices. */
export const INDICATOR_LABELS: Readonly<Record<StrategyIndicator, string>> = {
  adx: "ADX (trend strength)",
  atr: "ATR (average true range)",
  ema: "EMA (exponential average)",
  highest: "Highest (prior bars)",
  lowest: "Lowest (prior bars)",
  realizedVol: "Realized volatility (annualized %)",
  rsi: "RSI (relative strength)",
  rvol: "Relative volume at time",
  sma: "SMA (simple average)",
  zscore: "Z-score (against trailing window)",
};

/** atr, adx and rvol do not read a price source. */
export const usesSource = (name: StrategyIndicator): boolean =>
  name !== "atr" && name !== "adx" && name !== "rvol";

/** rvol length counts previous sessions, a 1d indicator's length days, every other length bars. */
export const lengthUnit = (
  name: StrategyIndicator,
  timeframe?: string
): string => {
  if (name === "rvol") return "sessions";
  return timeframe === "1d" ? "days" : "bars";
};

type IndicatorExpr = Extract<StrategyExpr, { type: "indicator" }>;

/** Changes the indicator; rvol takes no timeframe, so switching to it drops the timeframe. */
export const withIndicator = (
  expr: IndicatorExpr,
  name: StrategyIndicator
): IndicatorExpr => {
  const { timeframe: _timeframe, ...rest } = expr;
  return name === "rvol" ? { ...rest, name } : { ...expr, name };
};

/** Changes the operator; oncePerLevel works only with crosses and breaks, so others drop it. */
export const withOperator = (
  condition: StrategyCondition,
  op: StrategyCondition["op"]
): StrategyCondition => {
  const { oncePerLevel: _once, ...rest } = condition;
  return STRATEGY_EVENT_OPERATORS.includes(op)
    ? { ...condition, op }
    : { ...rest, op };
};

/**
 * Fields of the definition the visual builder does not edit (it keeps them): entry.any,
 * management, oncePerLevel, an indicator timeframe and maxLeverage. Edit them in the JSON text.
 */
export const jsonOnlyFields = (definition: StrategyDefinition): string[] => {
  const conditions = [
    ...definition.entry.all,
    ...(definition.entry.any ?? []),
    ...definition.exit.any,
  ];
  const sides = conditions.flatMap((condition) => [
    condition.left,
    condition.right,
  ]);
  const used: [string, boolean][] = [
    ["entry.any", definition.entry.any !== undefined],
    ["management", definition.management !== undefined],
    [
      "oncePerLevel",
      conditions.some((condition) => condition.oncePerLevel !== undefined),
    ],
    [
      "timeframe",
      sides.some(
        (expr) => expr.type === "indicator" && expr.timeframe !== undefined
      ),
    ],
    [
      "maxLeverage",
      definition.sizing.mode === "riskPct" &&
        definition.sizing.maxLeverage !== undefined,
    ],
  ];
  return used.filter(([, present]) => present).map(([field]) => field);
};

export type ShiftableExpr = Extract<
  StrategyExpr,
  { type: "price" | "indicator" }
>;

/**
 * Sets the bars-ago offset from the input text. Empty or 0 removes the key, so the definition JSON
 * and its revision stay the same as without an offset. Other text is kept for validation to check.
 */
export const withOffset = <T extends ShiftableExpr>(
  expr: T,
  text: string
): T => {
  const { offset: _previous, ...rest } = expr;
  const offset = numberOf(text);
  return (
    Number.isNaN(offset) || offset === 0 ? rest : { ...rest, offset }
  ) as T;
};

export const defaultCondition = (): StrategyCondition => ({
  left: { field: "close", type: "price" },
  op: ">",
  right: { length: 20, name: "sma", source: "close", type: "indicator" },
});

const MATH_SYMBOLS: Readonly<Record<"add" | "sub" | "mul" | "div", string>> = {
  add: "+",
  div: "/",
  mul: "*",
  sub: "-",
};

// "[n]" for an expression read n bars ago; nothing for the current bar.
const barsAgo = (offset: number | undefined): string =>
  offset === undefined || offset === 0 ? "" : `[${offset}]`;

/**
 * A compact text form of an expression, for example `change(series $future, 252)` or
 * `sma(close, 20)[1]` (one bar ago). Read-only display of expressions the builder does not edit.
 */
export const describeExpr = (expr: StrategyExpr): string => {
  switch (expr.type) {
    case "price":
      return `${expr.field}${barsAgo(expr.offset)}`;
    case "const":
      return String(expr.value);
    case "indicator":
      return `${expr.name}(${usesSource(expr.name) ? `${expr.source}, ` : ""}${expr.length})${barsAgo(expr.offset)}`;
    case "series":
      return `series ${expr.series}${barsAgo(expr.offset)}`;
    case "math":
      return `(${describeExpr(expr.left)} ${MATH_SYMBOLS[expr.op]} ${describeExpr(expr.right)})`;
    case "change":
      return `change(${describeExpr(expr.of)}, ${expr.length})${barsAgo(expr.offset)}`;
    case "returnStdev":
      return `returnStdev(${describeExpr(expr.of)}, ${expr.length})`;
    case "regression":
      return `regression(${describeExpr(expr.y)} on ${describeExpr(expr.x)}, ${expr.length}, lag ${expr.lag})`;
    case "seasonal":
      return `seasonal(${describeExpr(expr.of)}, ${expr.monthsAhead} months ahead, min ${expr.minCount})`;
  }
};

export const describeCondition = (condition: StrategyCondition): string =>
  `${describeExpr(condition.left)} ${condition.op} ${describeExpr(condition.right)}`;

/** A filter in one line: a series filter by its condition, any other by its settings. */
export const describeFilter = (filter: StrategyFilter): string => {
  if (filter.type === "series")
    return `series ${filter.series}: ${describeCondition(filter.condition)}`;
  const { type, ...settings } = filter;
  return `${type} ${JSON.stringify(settings)}`;
};

/** Plain labels of the relative series refs; series ids are shown as they are. */
const RELATIVE_SERIES_LABELS: Readonly<Record<string, string>> = {
  $future: "$future (futures twin of the traded symbol)",
  $iv: "$iv (IV index of the traded symbol)",
  $tr: "$tr (total return of the traded symbol)",
};

export const seriesRefLabel = (ref: StrategySeriesRef): string =>
  RELATIVE_SERIES_LABELS[ref] ??
  (ref.endsWith(":TR") ? `${ref} (${ref.slice(0, -3)} total return)` : ref);

/** The option vertical in one line, its optional settings appended as written. */
export const describeOptions = (options: StrategyOptions): string => {
  const { dte, maxLossPct, structure, widthSigma, ...rest } = options;
  return [
    `${structure}, DTE ${dte.min} to ${dte.target}, max loss ${maxLossPct}% of equity, width ${widthSigma} sigma`,
    ...Object.entries(rest).map(([name, value]) => `${name} ${value}`),
  ].join(", ");
};

/** The portfolio block as lines: policy, symbols, the selection and each further leg. */
export const describePortfolio = (
  portfolio: StrategyPortfolio
): readonly string[] => {
  const { legs = [], policy, select, symbols, ...rest } = portfolio;
  return [
    [
      `Policy ${policy}`,
      ...Object.entries(rest).map(([name, value]) => `${name} ${value}`),
    ].join(", "),
    `Symbols ${symbols.join(", ")}`,
    ...(select === undefined
      ? []
      : [
          `Each month-end, the top ${select.top} by ${describeExpr(select.score)}${select.tieBreak === undefined ? "" : `, then ${describeExpr(select.tieBreak)}`}`,
        ]),
    ...legs.map(
      (leg, index) =>
        `Leg ${index + 2}: enter when ${leg.entry.all.map(describeCondition).join(" and ")}; ${describeOptions(leg.options)}`
    ),
  ];
};

export const replaceAt = <T>(
  items: readonly T[],
  index: number,
  item: T
): T[] =>
  items.map((current, position) => (position === index ? item : current));

export const removeAt = <T>(items: readonly T[], index: number): T[] =>
  items.filter((_, position) => position !== index);

/** Reads a number input. An empty field becomes NaN, so validation reports it. */
export const numberOf = (text: string): number =>
  text.trim() === "" ? Number.NaN : Number(text);

export type BuilderRunForm = Readonly<{
  from: string;
  to: string;
  initialCapital: number;
  costBps: number;
}>;

export const toBuilderRunInput = (
  definition: StrategyDefinition,
  series: InstantBacktestSeries,
  form: BuilderRunForm
):
  | Readonly<{ input: BacktestRunSubmitInput }>
  | Readonly<{ error: string }> => {
  if (!(DATE_PATTERN.test(form.from) && DATE_PATTERN.test(form.to)))
    return { error: "Enter both dates as YYYY-MM-DD." };
  if (form.from > form.to)
    return { error: "The start date must not be after the end date." };
  if (!(form.initialCapital >= 1 && form.initialCapital <= 1_000_000_000))
    return { error: "Initial capital must be from 1 to 1,000,000,000." };
  if (!(form.costBps >= 0 && form.costBps <= 500))
    return { error: "Cost per side must be from 0 to 500 bps." };
  return {
    input: {
      costBps: form.costBps,
      from: form.from,
      initialCapital: form.initialCapital,
      rule: { definition, kind: "dsl" },
      symbol: series.symbol,
      timeframe: series.timeframe,
      to: form.to,
    },
  };
};

export type BuilderQuery = Readonly<{
  run: string | null;
  symbol: string | null;
}>;

/** Reads the builder deep link: run=<id> and symbol=<symbol>. */
export const readBuilderQuery = (search: string): BuilderQuery => {
  const params = new URLSearchParams(search);
  const read = (name: string) => {
    const value = params.get(name)?.trim() ?? "";
    return value === "" ? null : value;
  };
  return { run: read("run"), symbol: read("symbol") };
};

/**
 * The run to show on open: the linked builder (dsl) run whatever its status (the page follows it
 * until it finishes), else the newest finished builder run (of the symbol, when one is given).
 * Null when there is none.
 */
export const pickBuilderRun = (
  runs: readonly BacktestRunSummary[],
  query: BuilderQuery
): Readonly<{
  run: BacktestRunSummary;
  definition: StrategyDefinition;
}> | null => {
  const builder = runs
    .flatMap((run) =>
      run.spec.rule.kind === "dsl"
        ? [{ definition: run.spec.rule.definition, run }]
        : []
    )
    .sort((a, b) => b.run.createdAt.getTime() - a.run.createdAt.getTime());
  return (
    builder.find((entry) => entry.run.id === query.run) ??
    builder.find(
      (entry) =>
        entry.run.status === "succeeded" &&
        (query.symbol === null || entry.run.spec.symbol === query.symbol)
    ) ??
    null
  );
};

/**
 * Adds the linked run when the list (only the newest runs) does not hold it. A missing run is
 * skipped, so the page falls back to the newest one; other read errors are thrown.
 */
export const withLinkedRun = async (
  listed: readonly BacktestRunSummary[],
  linkedId: string | null,
  get: (id: string) => Promise<BacktestRunSummary>
): Promise<readonly BacktestRunSummary[]> => {
  if (linkedId === null || listed.some((entry) => entry.id === linkedId))
    return listed;
  try {
    return [...listed, await get(linkedId)];
  } catch (error) {
    if (isNotFound(error)) return listed;
    throw error;
  }
};

/**
 * The run to open and the URL to write for it. A linked run selects its own series, so its symbol
 * goes in the URL; values equal to the default pick and the default symbol are left out.
 */
export const openBuilderRun = (
  runs: readonly BacktestRunSummary[],
  query: BuilderQuery,
  defaultSymbol: string | null
) => {
  const picked = pickBuilderRun(runs, query);
  const defaultPick = pickBuilderRun(runs, { ...query, run: null });
  const linked = picked !== null && picked.run.id === query.run;
  return {
    defaults: {
      run: defaultPick?.run.id ?? null,
      symbol: defaultSymbol,
    },
    picked,
    updates: {
      run: picked?.run.id ?? null,
      symbol: linked ? picked.run.spec.symbol : query.symbol,
    },
  };
};
