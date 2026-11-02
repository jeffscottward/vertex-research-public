import {
  type BacktestRunSubmitInput,
  type InstantBacktestSeries,
  type STRATEGY_INDICATORS,
  STRATEGY_TEMPLATES,
  type StrategyCondition,
  type StrategyDefinition,
  StrategyDefinitionSchema,
  type StrategyExpr,
  type StrategyTemplateId,
} from "@darkfactory/api";

// Pure helpers of the strategy builder: template loading, definition text, list edits, the run
// request and the result summary. Research only; the request queues a backtest, never an order.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export const templateDefinition = (
  id: StrategyTemplateId
): StrategyDefinition => StrategyDefinitionSchema.parse(STRATEGY_TEMPLATES[id]);

export const definitionText = (definition: StrategyDefinition): string =>
  JSON.stringify(definition, null, 2);

export const defaultExpr = (type: StrategyExpr["type"]): StrategyExpr => {
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
  rsi: "RSI (relative strength)",
  rvol: "Relative volume at time",
  sma: "SMA (simple average)",
};

/** atr, adx and rvol do not read a price source. */
export const usesSource = (name: StrategyIndicator): boolean =>
  name !== "atr" && name !== "adx" && name !== "rvol";

/** rvol length counts previous sessions; every other length counts bars. */
export const lengthUnit = (name: StrategyIndicator): string =>
  name === "rvol" ? "sessions" : "bars";

type ShiftableExpr = Exclude<StrategyExpr, { type: "const" }>;

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
