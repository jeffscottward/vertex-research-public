import { z } from "zod";

import {
  SECTOR_ROTATION_QUADRANTS,
  SECTOR_ROTATION_SECTORS,
} from "./contracts/sector-rotation.ts";

// Strategy definition format (version 1): a small declarative, long-only strategy. Entry needs
// every entry condition on the signal bar; exit needs any exit condition. Conditions compare two
// expressions (price fields, constants or indicators). The definition compiles to the signal
// arrays of the instant backtest engine. Research and backtest use only; it never creates orders.

export const STRATEGY_DSL_VERSION = 1;
export const STRATEGY_DSL_MAX_CONDITIONS = 8;
export const STRATEGY_DSL_MAX_LENGTH = 1000;
/** rvol averages this many previous sessions at most, which keeps its cost per bar small. */
export const STRATEGY_DSL_MAX_RVOL_SESSIONS = 100;
/** Most entry filters in one definition. */
export const STRATEGY_DSL_MAX_FILTERS = 4;
export const STRATEGY_FILTER_TIMEFRAMES = ["daily", "weekly"] as const;

const SECTOR_SYMBOLS: ReadonlySet<string> = new Set(
  SECTOR_ROTATION_SECTORS.map((sector) => sector.symbol)
);

/**
 * Entry filter: entries are allowed only when the latest stored sector rotation point of `sector`
 * on `timeframe`, dated on or before the signal bar, has a quadrant in `quadrants`. No point at or
 * before the bar means no entry. Exits are never blocked.
 */
export const SectorQuadrantFilterSchema = z
  .object({
    quadrants: z
      .array(z.enum(SECTOR_ROTATION_QUADRANTS))
      .min(1)
      .refine((values) => new Set(values).size === values.length, {
        message: "Quadrants must not repeat",
      }),
    sector: z.string().refine((symbol) => SECTOR_SYMBOLS.has(symbol), {
      message:
        "Unknown sector. Use a Select Sector SPDR symbol, for example XLK",
    }),
    timeframe: z.enum(STRATEGY_FILTER_TIMEFRAMES).default("weekly"),
    type: z.literal("sectorQuadrant"),
  })
  .strict();

export const STRATEGY_PRICE_FIELDS = ["open", "high", "low", "close"] as const;
export const STRATEGY_INDICATORS = [
  "sma",
  "ema",
  "rsi",
  "atr",
  "highest",
  "lowest",
  "adx",
  "rvol",
  "zscore",
  "realizedVol",
] as const;
/** zscore and realizedVol use a sample standard deviation, which needs at least two values. */
export const STRATEGY_DSL_MIN_DEVIATION_LENGTH = 2;
export const STRATEGY_OPERATORS = [
  ">",
  ">=",
  "<",
  "<=",
  "crossesAbove",
  "crossesBelow",
  "breaksAbove",
  "breaksBelow",
] as const;
/**
 * Operators that `oncePerLevel` may limit: they hold on one bar of a move. breaksAbove at bar i:
 * left[i] > right[i] and left[i - 1] <= right[i] (the previous left against the current right);
 * breaksBelow mirrors it.
 */
export const STRATEGY_EVENT_OPERATORS: readonly string[] = [
  "crossesAbove",
  "crossesBelow",
  "breaksAbove",
  "breaksBelow",
];
/**
 * Indicator timeframes. "1d" computes the indicator on daily bars built from the signal bars (a
 * session day starts at 17:00 New York); a signal bar reads only days before its own.
 */
export const STRATEGY_INDICATOR_TIMEFRAMES = ["1d"] as const;

const LengthSchema = z.number().int().min(1).max(STRATEGY_DSL_MAX_LENGTH);
/**
 * Bars ago: the value at bar i is the series value at bar i - offset (not available before).
 * Optional with no default, so definitions without it keep the same canonical JSON and revision.
 */
const OffsetSchema = z
  .number()
  .int()
  .min(0)
  .max(STRATEGY_DSL_MAX_LENGTH)
  .optional();

/**
 * Daily series that filters and series expressions may read (Core 7 ETFs, their total-return
 * closes `<ETF>:TR`, futures, volatility and rate indices, and EY_TNX_RATIO: Shiller earnings
 * yield lagged 6 months over the 10-year yield). Each series is one value per date (the close;
 * for `<ETF>:TR` the adjusted close, dividends included).
 */
export const STRATEGY_SERIES_IDS = [
  "SPY",
  "QQQ",
  "DIA",
  "IWM",
  "GLD",
  "SLV",
  "USO",
  "SPY:TR",
  "QQQ:TR",
  "DIA:TR",
  "IWM:TR",
  "GLD:TR",
  "SLV:TR",
  "USO:TR",
  "ES=F",
  "NQ=F",
  "YM=F",
  "RTY=F",
  "GC=F",
  "SI=F",
  "CL=F",
  "VIX",
  "VIX3M",
  "VXN",
  "VXD",
  "RVX",
  "GVZ",
  "OVX",
  "VXSLV",
  "IRX",
  "TNX",
  "EY_TNX_RATIO",
] as const;
export type StrategySeriesId = (typeof STRATEGY_SERIES_IDS)[number];

/**
 * Series of the traded symbol, resolved per symbol: `$tr` its total-return close (`<SYM>:TR`),
 * `$iv` its implied-volatility index (STRATEGY_IV_INDEX) and `$future` its futures twin
 * (STRATEGY_FUTURE_TWIN).
 */
export const STRATEGY_RELATIVE_SERIES = ["$tr", "$iv", "$future"] as const;
export type StrategyRelativeSeries = (typeof STRATEGY_RELATIVE_SERIES)[number];
export const STRATEGY_SERIES_REFS = [
  ...STRATEGY_SERIES_IDS,
  ...STRATEGY_RELATIVE_SERIES,
] as const;
export type StrategySeriesRef = (typeof STRATEGY_SERIES_REFS)[number];

/** Implied-volatility index of each traded symbol, read by the ivRank filter and `$iv`. */
export const STRATEGY_IV_INDEX: Readonly<Record<string, StrategySeriesId>> = {
  DIA: "VXD",
  GLD: "GVZ",
  IWM: "RVX",
  QQQ: "VXN",
  SLV: "VXSLV",
  SPY: "VIX",
  USO: "OVX",
};

/** Continuous front-month future of each Core 7 ETF (Yahoo `=F` series), read by `$future`. */
export const STRATEGY_FUTURE_TWIN: Readonly<Record<string, StrategySeriesId>> =
  {
    DIA: "YM=F",
    GLD: "GC=F",
    IWM: "RTY=F",
    QQQ: "NQ=F",
    SLV: "SI=F",
    SPY: "ES=F",
    USO: "CL=F",
  };

/** Total-return close series of each Core 7 ETF, read by `$tr` and the monthly frame. */
export const STRATEGY_TOTAL_RETURN: Readonly<Record<string, StrategySeriesId>> =
  {
    DIA: "DIA:TR",
    GLD: "GLD:TR",
    IWM: "IWM:TR",
    QQQ: "QQQ:TR",
    SLV: "SLV:TR",
    SPY: "SPY:TR",
    USO: "USO:TR",
  };

/** Most nesting levels of one expression (a leaf is level 1). */
export const STRATEGY_DSL_MAX_EXPR_DEPTH = 6;
/** Most expression nodes in one condition (both sides) or one selection score. */
export const STRATEGY_DSL_MAX_EXPR_NODES = 40;
export const STRATEGY_MATH_OPS = ["add", "sub", "mul", "div"] as const;

const PriceExprSchema = z
  .object({
    field: z.enum(STRATEGY_PRICE_FIELDS),
    offset: OffsetSchema,
    type: z.literal("price"),
  })
  .strict();

const ConstExprSchema = z
  .object({
    type: z.literal("const"),
    value: z.number().min(-1e12).max(1e12),
  })
  .strict();

const IndicatorExprSchema = z
  .object({
    length: LengthSchema,
    name: z.enum(STRATEGY_INDICATORS),
    offset: OffsetSchema,
    /**
     * Input price for sma, ema, rsi, highest, lowest, zscore and realizedVol. atr, adx and rvol
     * ignore it. For rvol, `length` is the number of previous sessions in the average.
     */
    source: z.enum(STRATEGY_PRICE_FIELDS).default("close"),
    /**
     * Optional with no default. "1d": the indicator runs on daily bars built from the signal
     * bars (see STRATEGY_INDICATOR_TIMEFRAMES); `length` counts days. Not for rvol.
     */
    timeframe: z.enum(STRATEGY_INDICATOR_TIMEFRAMES).optional(),
    type: z.literal("indicator"),
  })
  .strict()
  .refine((expr) => expr.name !== "rvol" || expr.timeframe === undefined, {
    message: "rvol has no timeframe; it already compares whole sessions",
    path: ["timeframe"],
  })
  .refine(
    (expr) =>
      expr.name !== "rvol" || expr.length <= STRATEGY_DSL_MAX_RVOL_SESSIONS,
    {
      message: `rvol length must be at most ${STRATEGY_DSL_MAX_RVOL_SESSIONS} sessions`,
      path: ["length"],
    }
  )
  .refine(
    (expr) =>
      (expr.name !== "zscore" && expr.name !== "realizedVol") ||
      expr.length >= STRATEGY_DSL_MIN_DEVIATION_LENGTH,
    {
      message: `zscore and realizedVol length must be at least ${STRATEGY_DSL_MIN_DEVIATION_LENGTH}`,
      path: ["length"],
    }
  );

/**
 * Expression tree over leaf expressions `L` (the parsed or the input form). Every expression is
 * one value per bar of the frame; not available is NaN, and a comparison with NaN is false.
 * - series: the value of a daily series on the bar (aligned like the series filter), `offset`
 *   frame bars ago.
 * - math: add, sub, mul or div of two expressions; a result that is not finite is NaN.
 * - change: of[t − offset] / of[t − offset − length] − 1.
 * - returnStdev: sample standard deviation of the last `length` one-bar simple returns of `of`.
 * - regression: a0 + a1 × x[t], by least squares of y[s] on x[s − lag] over the last `length` s.
 * - seasonal: mean of the values of `of` at this and earlier bars in the calendar month
 *   `monthsAhead` after the bar's month; NaN with fewer than `minCount` values.
 */
export type StrategyExprTree<L> =
  | L
  | { offset?: number | undefined; series: StrategySeriesRef; type: "series" }
  | {
      left: StrategyExprTree<L>;
      op: (typeof STRATEGY_MATH_OPS)[number];
      right: StrategyExprTree<L>;
      type: "math";
    }
  | {
      length: number;
      of: StrategyExprTree<L>;
      offset?: number | undefined;
      type: "change";
    }
  | { length: number; of: StrategyExprTree<L>; type: "returnStdev" }
  | {
      lag: number;
      length: number;
      type: "regression";
      x: StrategyExprTree<L>;
      y: StrategyExprTree<L>;
    }
  | {
      minCount: number;
      monthsAhead: number;
      of: StrategyExprTree<L>;
      type: "seasonal";
    };

type LeafExpr =
  | z.output<typeof PriceExprSchema>
  | z.output<typeof ConstExprSchema>
  | z.output<typeof IndicatorExprSchema>;
type LeafExprInput =
  | z.input<typeof PriceExprSchema>
  | z.input<typeof ConstExprSchema>
  | z.input<typeof IndicatorExprSchema>;
export type StrategyExpr = StrategyExprTree<LeafExpr>;
export type StrategyExprInput = StrategyExprTree<LeafExprInput>;

export const StrategyExprSchema: z.ZodType<StrategyExpr, StrategyExprInput> =
  z.lazy(() =>
    z.discriminatedUnion("type", [
      PriceExprSchema,
      ConstExprSchema,
      IndicatorExprSchema,
      z
        .object({
          offset: OffsetSchema,
          series: z.enum(STRATEGY_SERIES_REFS),
          type: z.literal("series"),
        })
        .strict(),
      z
        .object({
          left: StrategyExprSchema,
          op: z.enum(STRATEGY_MATH_OPS),
          right: StrategyExprSchema,
          type: z.literal("math"),
        })
        .strict(),
      z
        .object({
          length: LengthSchema,
          of: StrategyExprSchema,
          offset: OffsetSchema,
          type: z.literal("change"),
        })
        .strict(),
      z
        .object({
          length: LengthSchema.min(STRATEGY_DSL_MIN_DEVIATION_LENGTH),
          of: StrategyExprSchema,
          type: z.literal("returnStdev"),
        })
        .strict(),
      z
        .object({
          lag: z.number().int().min(0).max(STRATEGY_DSL_MAX_LENGTH),
          length: LengthSchema.min(3),
          type: z.literal("regression"),
          x: StrategyExprSchema,
          y: StrategyExprSchema,
        })
        .strict(),
      z
        .object({
          minCount: LengthSchema,
          monthsAhead: z.number().int().min(0).max(11),
          of: StrategyExprSchema,
          type: z.literal("seasonal"),
        })
        .strict(),
    ])
  );

/** Any expression tree, parsed or input form (leaves are told apart by their `type`). */
type AnyStrategyExpr = StrategyExprTree<{
  type: "price" | "const" | "indicator";
}>;

/** The sub-expressions of `expr` (none for a leaf). */
export const strategyExprChildren = (
  expr: AnyStrategyExpr
): readonly AnyStrategyExpr[] => {
  switch (expr.type) {
    case "math":
      return [expr.left, expr.right];
    case "change":
    case "returnStdev":
    case "seasonal":
      return [expr.of];
    case "regression":
      return [expr.y, expr.x];
    default:
      return [];
  }
};

/** Nesting depth (a leaf is 1) and node count of an expression. */
export const strategyExprSize = (
  expr: AnyStrategyExpr
): Readonly<{ depth: number; nodes: number }> => {
  let depth = 0;
  let nodes = 1;
  for (const child of strategyExprChildren(expr)) {
    const size = strategyExprSize(child);
    depth = Math.max(depth, size.depth);
    nodes += size.nodes;
  }
  return { depth: depth + 1, nodes };
};

/** Every series ref an expression reads (`series` nodes), in tree order. */
export const strategyExprSeries = (
  expr: AnyStrategyExpr
): StrategySeriesRef[] => [
  ...(expr.type === "series" ? [expr.series] : []),
  ...strategyExprChildren(expr).flatMap(strategyExprSeries),
];

const EXPR_DEPTH_MESSAGE = `An expression may nest at most ${STRATEGY_DSL_MAX_EXPR_DEPTH} levels`;

/** Child keys of each nested expression type (raw input; other types are leaves). */
const RAW_EXPR_CHILD_KEYS: ReadonlyMap<unknown, readonly string[]> = new Map([
  ["change", ["of"]],
  ["math", ["left", "right"]],
  ["regression", ["y", "x"]],
  ["returnStdev", ["of"]],
  ["seasonal", ["of"]],
]);

/**
 * Whether raw (unparsed) expression input nests deeper than STRATEGY_DSL_MAX_EXPR_DEPTH. Iterative
 * and stops at the first node past the limit, so any input depth is safe (the recursive parse is
 * not: a deep enough input overflows the stack).
 */
export const rawStrategyExprTooDeep = (value: unknown): boolean => {
  const stack: [unknown, number][] = [[value, 1]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [node, depth] = item;
    if (typeof node !== "object" || node === null) continue;
    if (depth > STRATEGY_DSL_MAX_EXPR_DEPTH) return true;
    // A missing child is pushed as undefined and skipped above.
    for (const key of RAW_EXPR_CHILD_KEYS.get(Reflect.get(node, "type")) ?? [])
      stack.push([Reflect.get(node, key), depth + 1]);
  }
  return false;
};

/**
 * `schema` behind an iterative depth check of the raw expressions `exprs(value)` picks from its
 * input, so the recursive parse cannot overflow the stack. The issue sits at the schema's path.
 */
const depthGuarded = <S extends z.ZodType>(
  schema: S,
  exprs: (value: unknown) => readonly unknown[]
): S =>
  z.preprocess((value, context) => {
    if (exprs(value).some(rawStrategyExprTooDeep))
      context.addIssue({ code: "custom", message: EXPR_DEPTH_MESSAGE });
    return value;
  }, schema) as unknown as S;

/**
 * The node limit of a condition or a selection score. Depth needs no check here: the raw depth
 * guard in front of each parse already refused deeper input.
 */
const exprNodesIssue = (
  exprs: readonly AnyStrategyExpr[]
): string | undefined =>
  exprs.reduce((nodes, expr) => nodes + strategyExprSize(expr).nodes, 0) >
  STRATEGY_DSL_MAX_EXPR_NODES
    ? `A condition may hold at most ${STRATEGY_DSL_MAX_EXPR_NODES} expression nodes`
    : undefined;

export const StrategyConditionSchema = depthGuarded(
  z
    .object({
      left: StrategyExprSchema,
      /**
       * Optional with no default. When true the condition holds at most once per level: a bar
       * where it holds is dropped when the same right value (exact) already made it hold on an
       * earlier bar. Only with crossesAbove, crossesBelow, breaksAbove and breaksBelow.
       */
      oncePerLevel: z.boolean().optional(),
      op: z.enum(STRATEGY_OPERATORS),
      right: StrategyExprSchema,
    })
    .strict()
    .refine(
      (condition) =>
        condition.oncePerLevel !== true ||
        STRATEGY_EVENT_OPERATORS.includes(condition.op),
      {
        message:
          "oncePerLevel works only with crossesAbove, crossesBelow, breaksAbove and breaksBelow",
        path: ["oncePerLevel"],
      }
    )
    .superRefine((condition, context) => {
      const issue = exprNodesIssue([condition.left, condition.right]);
      if (issue !== undefined)
        context.addIssue({ code: "custom", message: issue });
    }),
  // new Object() makes a missing or non-object condition read as no sides (the parse refuses it).
  (value) => [
    Reflect.get(new Object(value), "left"),
    Reflect.get(new Object(value), "right"),
  ]
);

export const STRATEGY_IV_RANK_MIN_LENGTH = 20;
export const STRATEGY_IV_RANK_DEFAULT_LENGTH = 252;
export const STRATEGY_VOL_REGIME_DEFAULT_TREND_LENGTH = 200;

const PercentileSchema = z.number().min(0).max(100);
const RatioSchema = z.number().gt(0).max(10);

/**
 * Entry filter: IV rank of the traded symbol's implied-volatility index (STRATEGY_IV_INDEX), 0 to
 * 100: 100 × (v − min) / (max − min) over the last `length` index values, the current one included.
 * Passes when the rank is within [min, max]. No rank (fewer values, max equal to min, or no index
 * value on the bar date) means no entry.
 */
export const IvRankFilterSchema = z
  .object({
    length: z
      .number()
      .int()
      .min(STRATEGY_IV_RANK_MIN_LENGTH)
      .max(STRATEGY_DSL_MAX_LENGTH)
      .default(STRATEGY_IV_RANK_DEFAULT_LENGTH),
    max: PercentileSchema.optional(),
    min: PercentileSchema.optional(),
    type: z.literal("ivRank"),
  })
  .strict()
  .refine((filter) => filter.min !== undefined || filter.max !== undefined, {
    message: "ivRank needs min, max or both",
  })
  .refine(
    (filter) =>
      filter.min === undefined ||
      filter.max === undefined ||
      filter.min <= filter.max,
    { message: "ivRank min must not be above max", path: ["min"] }
  );

/**
 * Entry filter: VIX / VIX3M on the bar date is within [minRatio, maxRatio] (below 1 is contango).
 * A missing value of either index on that date means no entry.
 */
export const VixTermStructureFilterSchema = z
  .object({
    maxRatio: RatioSchema.optional(),
    minRatio: RatioSchema.optional(),
    type: z.literal("vixTermStructure"),
  })
  .strict()
  .refine(
    (filter) => filter.minRatio !== undefined || filter.maxRatio !== undefined,
    { message: "vixTermStructure needs minRatio, maxRatio or both" }
  )
  .refine(
    (filter) =>
      filter.minRatio === undefined ||
      filter.maxRatio === undefined ||
      filter.minRatio <= filter.maxRatio,
    {
      message: "vixTermStructure minRatio must not be above maxRatio",
      path: ["minRatio"],
    }
  );

/**
 * Entry filter, a calm-market regime: on the bar date VIX ≤ maxVix, VIX / VIX3M ≤ maxTermRatio and
 * the SPY close is above its `trendLength`-day simple average. Any missing value means no entry.
 */
export const VolRegimeFilterSchema = z
  .object({
    maxTermRatio: RatioSchema,
    maxVix: z.number().gt(0).max(200),
    trendLength: LengthSchema.default(STRATEGY_VOL_REGIME_DEFAULT_TREND_LENGTH),
    type: z.literal("volRegime"),
  })
  .strict();

/**
 * Entry filter on the trading calendar of the bars (dates without a bar are holidays; outside the
 * bar dates every weekday is a trading day).
 * - turnOfMonth: trading-day offsets around a month end, -1 the last trading day of a month and 1
 *   the first of the next; passes on the bars in [fromDay, toDay].
 * - opexWeek: from the last trading day before the Monday-to-Friday week of the monthly expiration
 *   (third Friday, or the trading day before it when it is a holiday) through the expiration day.
 * - months: bars in the listed calendar months (1 is January).
 */
export const CalendarWindowFilterSchema = z.discriminatedUnion("window", [
  z
    .object({
      fromDay: z.number().int().min(-10).max(-1),
      toDay: z.number().int().min(1).max(10),
      type: z.literal("calendarWindow"),
      window: z.literal("turnOfMonth"),
    })
    .strict(),
  z
    .object({
      type: z.literal("calendarWindow"),
      window: z.literal("opexWeek"),
    })
    .strict(),
  z
    .object({
      months: z
        .array(z.number().int().min(1).max(12))
        .min(1)
        .max(12)
        .refine((values) => new Set(values).size === values.length, {
          message: "Months must not repeat",
        }),
      type: z.literal("calendarWindow"),
      window: z.literal("months"),
    })
    .strict(),
]);

/** Indicators that need high, low or volume, which a one-value-per-date series does not have. */
const NON_CLOSE_INDICATORS: Readonly<Record<string, true>> = {
  adx: true,
  atr: true,
  rvol: true,
};

const closeOnly = (expr: StrategyExpr): boolean => {
  if (expr.type === "const") return true;
  if (expr.type === "price") return expr.field === "close";
  if (expr.type === "indicator")
    return expr.source === "close" && NON_CLOSE_INDICATORS[expr.name] !== true;
  return false;
};

/**
 * Entry filter on another daily series (cross-asset): `condition` is evaluated on that series, its
 * indicators over the series' own dates, then each side takes the latest value dated on or before
 * the bar date. Crosses compare with the previous bar. A series is one value per date, so only the
 * close price, constants and close-sourced indicators other than atr, adx and rvol are allowed
 * (no series, math, change, returnStdev, regression or seasonal expressions). `series` may be a
 * relative ref ($tr, $iv, $future) of the traded symbol.
 */
export const SeriesFilterSchema = z
  .object({
    condition: StrategyConditionSchema,
    series: z.enum(STRATEGY_SERIES_REFS),
    type: z.literal("series"),
  })
  .strict()
  .refine(
    (filter) =>
      closeOnly(filter.condition.left) && closeOnly(filter.condition.right),
    {
      message:
        "A series condition reads the series close only: use the close price and close-sourced indicators other than atr, adx and rvol",
      path: ["condition"],
    }
  )
  .refine(
    (filter) =>
      filter.condition.oncePerLevel === undefined &&
      [filter.condition.left, filter.condition.right].every(
        (expr) => expr.type !== "indicator" || expr.timeframe === undefined
      ),
    {
      message:
        "A series condition takes no oncePerLevel or timeframe: the series has one value per date",
      path: ["condition"],
    }
  );

/** One entry filter. Filters gate entries only; exits are never blocked. */
export const StrategyFilterSchema = z.discriminatedUnion("type", [
  SectorQuadrantFilterSchema,
  IvRankFilterSchema,
  VixTermStructureFilterSchema,
  VolRegimeFilterSchema,
  CalendarWindowFilterSchema,
  SeriesFilterSchema,
]);

/** One to STRATEGY_DSL_MAX_FILTERS entry filters; Autopilot campaigns use the same list. */
export const StrategyFiltersSchema = z
  .array(StrategyFilterSchema)
  .min(1)
  .max(STRATEGY_DSL_MAX_FILTERS);

export const STRATEGY_OPTION_STRUCTURES = [
  "callDebitVertical",
  "putDebitVertical",
  "putCreditVertical",
  "callCreditVertical",
] as const;
/** Debit verticals pay to open; credit verticals collect a credit. */
export const STRATEGY_OPTION_IS_DEBIT: Readonly<
  Record<(typeof STRATEGY_OPTION_STRUCTURES)[number], boolean>
> = {
  callCreditVertical: false,
  callDebitVertical: true,
  putCreditVertical: false,
  putDebitVertical: true,
};
/** Most equity at risk per trade, in percent. */
export const STRATEGY_OPTIONS_MAX_LOSS_PCT = 2;

const DeltaSchema = z.number().min(0.05).max(0.95);

/**
 * Defined-risk option vertical traded on the definition's entry and exit signals. The options
 * runner picks the standard monthly expiry nearest `dte.target` with at least `dte.min` days,
 * places the legs `widthSigma` × ATM IV × √T × spot apart (at least one strike step), closes at
 * `profitTakePct` or when DTE ≤ `exitDte`, and buys floor(maxLossPct% of equity / max loss per
 * contract) contracts. longDelta (debit, runner default 0.5) and shortDelta (credit, runner
 * default 0.25) have no schema default, so the stored definition keeps only what was written.
 */
export const StrategyOptionsSchema = z
  .object({
    dte: z
      .object({
        min: z.number().int().min(1).max(400),
        target: z.number().int().min(7).max(400),
      })
      .strict()
      .refine((dte) => dte.min <= dte.target, {
        message: "dte.min must not be above dte.target",
        path: ["min"],
      }),
    exitDte: z.number().int().min(0).max(400).optional(),
    longDelta: DeltaSchema.optional(),
    maxLossPct: z
      .number()
      .gt(0)
      .max(STRATEGY_OPTIONS_MAX_LOSS_PCT, {
        message: `maxLossPct must be at most ${STRATEGY_OPTIONS_MAX_LOSS_PCT} (percent of equity per trade)`,
      }),
    profitTakePct: z.number().min(1).max(100).optional(),
    shortDelta: DeltaSchema.optional(),
    structure: z.enum(STRATEGY_OPTION_STRUCTURES),
    widthSigma: z.number().min(0.1).max(3),
  })
  .strict()
  .refine(
    (options) =>
      STRATEGY_OPTION_IS_DEBIT[options.structure]
        ? options.shortDelta === undefined
        : options.longDelta === undefined,
    {
      message:
        "Debit verticals take longDelta and credit verticals take shortDelta",
      path: ["structure"],
    }
  )
  .refine(
    (options) =>
      options.exitDte === undefined || options.exitDte < options.dte.min,
    {
      message: "exitDte must be below dte.min, or a new spread closes at once",
      path: ["exitDte"],
    }
  );

/** Underlyings an options portfolio may trade: the Core 7 ETFs (each has an IV index and a future twin). */
export const STRATEGY_OPTION_SYMBOLS = [
  "SPY",
  "QQQ",
  "DIA",
  "IWM",
  "GLD",
  "SLV",
  "USO",
] as const;
export const STRATEGY_PORTFOLIO_POLICIES = ["roll", "flat", "window"] as const;
export const STRATEGY_PORTFOLIO_CADENCES = ["daily", "monthEnd"] as const;
export const STRATEGY_PORTFOLIO_MAX_LEGS = 3;
export const STRATEGY_PORTFOLIO_MAX_SHIFT = 5;

const ConditionListSchema = z
  .array(StrategyConditionSchema)
  .max(STRATEGY_DSL_MAX_CONDITIONS);

/** One more leg on every portfolio symbol: its own entry, exit, filters and option vertical. */
export const StrategyPortfolioLegSchema = z
  .object({
    entry: z.object({ all: ConditionListSchema.min(1) }).strict(),
    exit: z.object({ any: ConditionListSchema }).strict().optional(),
    filters: StrategyFiltersSchema.optional(),
    options: StrategyOptionsSchema,
  })
  .strict();

const SelectionScoreSchema = StrategyExprSchema.superRefine((expr, context) => {
  const issue = exprNodesIssue([expr]);
  if (issue !== undefined) context.addIssue({ code: "custom", message: issue });
});
const DepthGuardedSelectionScoreSchema = depthGuarded(
  SelectionScoreSchema,
  (value) => [value]
);

/**
 * How an options definition trades a set of symbols (docs/vertex-rebuild/strategy-definitions.md,
 * "Portfolio block"). Each (leg, symbol) is one run leg; a signal at bar i opens a spread at the
 * close of bar i + 1.
 * - roll: an entry at each month-end where the leg enters; the spread closes at the next month-end.
 * - flat: one open spread per run leg; entries on `cadence` bars, exits on the first exit signal.
 * - window: one spread per run of entry bars, opened on the first bar, closed after the last.
 * `frame: "monthly"` compiles on month-end total-return bars (roll only). `select` keeps, on each
 * month-end, the `top` entering members by `score` then `tieBreak` (roll only). `shift` reads the
 * window that many bars ahead (window only; calendar filters only).
 */
export const StrategyPortfolioSchema = z
  .object({
    cadence: z.enum(STRATEGY_PORTFOLIO_CADENCES).optional(),
    frame: z.literal("monthly").optional(),
    legs: z
      .array(StrategyPortfolioLegSchema)
      .min(1)
      .max(STRATEGY_PORTFOLIO_MAX_LEGS)
      .optional(),
    policy: z.enum(STRATEGY_PORTFOLIO_POLICIES),
    select: z
      .object({
        score: DepthGuardedSelectionScoreSchema,
        tieBreak: DepthGuardedSelectionScoreSchema.optional(),
        top: z.number().int().min(1).max(STRATEGY_OPTION_SYMBOLS.length),
      })
      .strict()
      .optional(),
    shift: z.number().int().min(1).max(STRATEGY_PORTFOLIO_MAX_SHIFT).optional(),
    symbols: z
      .array(z.enum(STRATEGY_OPTION_SYMBOLS))
      .min(1)
      .max(STRATEGY_OPTION_SYMBOLS.length)
      .refine((symbols) => new Set(symbols).size === symbols.length, {
        message: "Portfolio symbols must not repeat",
      }),
  })
  .strict()
  .refine(
    (portfolio) =>
      (portfolio.policy === "flat") === (portfolio.cadence !== undefined),
    {
      message: "cadence is required with the flat policy and only there",
      path: ["cadence"],
    }
  )
  .refine(
    (portfolio) => portfolio.frame === undefined || portfolio.policy === "roll",
    { message: "frame monthly needs the roll policy", path: ["frame"] }
  )
  .refine(
    (portfolio) =>
      portfolio.select === undefined || portfolio.policy === "roll",
    { message: "select needs the roll policy", path: ["select"] }
  )
  .refine(
    (portfolio) =>
      portfolio.shift === undefined || portfolio.policy === "window",
    { message: "shift needs the window policy", path: ["shift"] }
  );

/**
 * A shifted window reads ahead, which is look-ahead free only for the trading calendar: the entry
 * must be exactly `close > 0`, with no exit and only calendarWindow filters (at least one).
 */
const calendarOnly = (
  leg: Readonly<{
    entry: {
      all: readonly StrategyCondition[];
      any?: readonly StrategyCondition[] | undefined;
    };
    exit?: { any: readonly StrategyCondition[] } | undefined;
    filters?: readonly StrategyFilter[] | undefined;
  }>
): boolean => {
  const [only, ...rest] = leg.entry.all;
  return (
    only !== undefined &&
    rest.length === 0 &&
    (leg.entry.any?.length ?? 0) === 0 &&
    only.op === ">" &&
    only.left.type === "price" &&
    only.left.field === "close" &&
    (only.left.offset ?? 0) === 0 &&
    only.right.type === "const" &&
    only.right.value === 0 &&
    (leg.exit?.any.length ?? 0) === 0 &&
    leg.filters !== undefined &&
    leg.filters.length > 0 &&
    leg.filters.every((filter) => filter.type === "calendarWindow")
  );
};

/** Indicators that read high, low or volume, which monthly total-return bars do not have. */
export const STRATEGY_MONTHLY_UNSUPPORTED_INDICATORS = [
  "atr",
  "adx",
  "rvol",
] as const;
export const STRATEGY_MONTHLY_INDICATOR_MESSAGE =
  "frame monthly bars have high = low = close and no volume: atr, adx and rvol are not available";

const usesBarRangeIndicator = (expr: AnyStrategyExpr): boolean =>
  (expr.type === "indicator" &&
    "name" in expr &&
    typeof expr.name === "string" &&
    (STRATEGY_MONTHLY_UNSUPPORTED_INDICATORS as readonly string[]).includes(
      expr.name
    )) ||
  strategyExprChildren(expr).some(usesBarRangeIndicator);

/** Every condition side of a definition and its legs, and the selection score and tie break. */
const definitionExprs = (
  definition: Readonly<{
    entry: {
      all: readonly StrategyCondition[];
      any?: readonly StrategyCondition[] | undefined;
    };
    exit?: { any: readonly StrategyCondition[] } | undefined;
    portfolio?:
      | Readonly<{
          legs?:
            | readonly Readonly<{
                entry: {
                  all: readonly StrategyCondition[];
                  any?: readonly StrategyCondition[] | undefined;
                };
                exit?: { any: readonly StrategyCondition[] } | undefined;
              }>[]
            | undefined;
          select?:
            | Readonly<{
                score: StrategyExpr;
                tieBreak?: StrategyExpr | undefined;
              }>
            | undefined;
        }>
      | undefined;
  }>
): AnyStrategyExpr[] => {
  const select = definition.portfolio?.select;
  return [
    ...[definition, ...(definition.portfolio?.legs ?? [])].flatMap((part) =>
      [
        ...part.entry.all,
        ...(part.entry.any ?? []),
        ...(part.exit?.any ?? []),
      ].flatMap((condition) => [condition.left, condition.right])
    ),
    ...(select === undefined
      ? []
      : [
          select.score,
          ...(select.tieBreak === undefined ? [] : [select.tieBreak]),
        ]),
  ];
};

const ExitLevelSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("pct"), pct: z.number().gt(0).max(99) }).strict(),
  z
    .object({
      kind: z.literal("atr"),
      length: LengthSchema,
      multiple: z.number().gt(0).max(100),
    })
    .strict(),
]);

const TimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/u, "Expected HH:MM (UTC)");

const ManagementLevelSchema = z.number().gt(0).max(100);

/**
 * Open-position stop management, evaluated at the close of every bar while a position is open
 * (the entry bar included), after that bar's stop and target check. R = entry price - initial
 * stop. breakevenR: once the highest high since entry reaches entry + breakevenR × R, the stop
 * moves up to the entry price. trail: once the highest high reaches entry + activateR × R, the stop
 * moves up to the highest close since entry minus multiple × ATR(length) of that bar. The stop never
 * moves down; a new stop applies from the next bar. Needs a stop loss and no options block.
 */
export const StrategyManagementSchema = z
  .object({
    breakevenR: ManagementLevelSchema.optional(),
    trail: z
      .object({
        activateR: ManagementLevelSchema,
        length: LengthSchema,
        multiple: ManagementLevelSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (management) =>
      management.trail !== undefined || management.breakevenR !== undefined,
    { message: "management needs trail, breakevenR or both" }
  );

export const STRATEGY_DSL_MAX_LEVERAGE = 50;

export const StrategyDefinitionSchema = z
  .object({
    description: z.string().max(2000).optional(),
    /**
     * Entry holds when every `all` condition holds and, when `any` is not empty, at least one
     * `any` condition holds. `any` is optional with no default; `all` may be empty when `any` is not.
     */
    entry: z
      .object({
        all: z.array(StrategyConditionSchema).max(STRATEGY_DSL_MAX_CONDITIONS),
        any: z
          .array(StrategyConditionSchema)
          .max(STRATEGY_DSL_MAX_CONDITIONS)
          .optional(),
      })
      .strict()
      .refine((entry) => entry.all.length + (entry.any?.length ?? 0) > 0, {
        message: "Entry needs at least one condition in entry.all or entry.any",
      }),
    exit: z
      .object({
        any: z
          .array(StrategyConditionSchema)
          .max(STRATEGY_DSL_MAX_CONDITIONS)
          .default([]),
      })
      .strict()
      .default({ any: [] }),
    /** Optional with no default, so definitions without it keep the same canonical JSON. */
    filters: StrategyFiltersSchema.optional(),
    /** Optional with no default (see StrategyManagementSchema). */
    management: StrategyManagementSchema.optional(),
    name: z.string().trim().min(1).max(120),
    /**
     * Defined-risk option vertical traded on the signals. Optional with no default, so definitions
     * without it keep the same canonical JSON. Sizing comes from options.maxLossPct and exits from
     * the exit conditions, profitTakePct and exitDte, so riskPct sizing, stop loss and take profit
     * must be left out.
     */
    options: StrategyOptionsSchema.optional(),
    /**
     * The symbols and the trading policy of an options definition (options only). Optional with no
     * default; without it an options definition trades the run symbol with the flat policy and
     * daily cadence.
     */
    portfolio: StrategyPortfolioSchema.optional(),
    /** Entries happen only on signal bars whose UTC time is in [start, end). Omit for all bars. */
    session: z
      .object({ endUtc: TimeSchema, startUtc: TimeSchema })
      .strict()
      .refine((session) => session.startUtc !== session.endUtc, {
        message: "Session start and end must differ",
      })
      .optional(),
    sizing: z
      .discriminatedUnion("mode", [
        z.object({ mode: z.literal("allIn") }).strict(),
        z
          .object({
            /**
             * Optional with no default: cap the position cost at cash × maxLeverage instead of
             * the cash. The engine charges no financing; the research runner charges it.
             */
            maxLeverage: z
              .number()
              .min(1)
              .max(STRATEGY_DSL_MAX_LEVERAGE)
              .optional(),
            mode: z.literal("riskPct"),
            riskPct: z.number().gt(0).max(100),
          })
          .strict(),
      ])
      .default({ mode: "allIn" }),
    stopLoss: ExitLevelSchema.default({ kind: "none" }),
    takeProfit: ExitLevelSchema.default({
      kind: "none",
    }),
    version: z.literal(STRATEGY_DSL_VERSION),
  })
  .strict()
  .refine(
    (definition) =>
      definition.sizing.mode !== "riskPct" ||
      definition.stopLoss.kind !== "none",
    { message: "Risk-percent sizing needs a stop loss", path: ["sizing"] }
  )
  .refine(
    (definition) =>
      definition.options === undefined || definition.sizing.mode !== "riskPct",
    {
      message:
        "Option strategies size by options.maxLossPct; remove the riskPct sizing",
      path: ["sizing"],
    }
  )
  .refine(
    (definition) =>
      definition.options === undefined ||
      (definition.stopLoss.kind === "none" &&
        definition.takeProfit.kind === "none"),
    {
      message:
        "Option strategies exit by profitTakePct, exitDte and exit conditions; remove the stop loss and take profit",
      path: ["options"],
    }
  )
  .refine(
    (definition) =>
      definition.management === undefined ||
      definition.stopLoss.kind !== "none",
    {
      message: "management moves the stop loss; add a stop loss",
      path: ["management"],
    }
  )
  .refine(
    (definition) =>
      definition.management === undefined || definition.options === undefined,
    {
      message:
        "Option strategies exit by profitTakePct, exitDte and exit conditions; remove management",
      path: ["management"],
    }
  )
  .refine(
    (definition) =>
      definition.portfolio === undefined || definition.options !== undefined,
    {
      message:
        "A portfolio block trades option verticals; add an options block",
      path: ["portfolio"],
    }
  )
  .refine(
    (definition) =>
      definition.portfolio?.shift === undefined ||
      [definition, ...(definition.portfolio.legs ?? [])].every(calendarOnly),
    {
      message:
        "A shifted window reads ahead: every leg needs the entry close > 0, no exit and calendarWindow filters only",
      path: ["portfolio", "shift"],
    }
  )
  .refine(
    (definition) =>
      definition.portfolio?.frame !== "monthly" ||
      !definitionExprs(definition).some(usesBarRangeIndicator),
    {
      message: STRATEGY_MONTHLY_INDICATOR_MESSAGE,
      path: ["portfolio", "frame"],
    }
  );

export type StrategyCondition = z.infer<typeof StrategyConditionSchema>;
export type StrategyDefinition = z.infer<typeof StrategyDefinitionSchema>;
export type StrategyFilter = z.infer<typeof StrategyFilterSchema>;
export type SectorQuadrantFilter = z.infer<typeof SectorQuadrantFilterSchema>;
export type IvRankFilter = z.infer<typeof IvRankFilterSchema>;
export type VixTermStructureFilter = z.infer<
  typeof VixTermStructureFilterSchema
>;
export type VolRegimeFilter = z.infer<typeof VolRegimeFilterSchema>;
export type CalendarWindowFilter = z.infer<typeof CalendarWindowFilterSchema>;
export type SeriesFilter = z.infer<typeof SeriesFilterSchema>;
export type StrategyOptions = z.infer<typeof StrategyOptionsSchema>;
export type StrategyManagement = z.infer<typeof StrategyManagementSchema>;
export type StrategyPortfolio = z.infer<typeof StrategyPortfolioSchema>;
export type StrategyPortfolioLeg = z.infer<typeof StrategyPortfolioLegSchema>;
export type StrategyDefinitionInput = z.input<typeof StrategyDefinitionSchema>;

export type StrategyValidationIssue = Readonly<{
  path: string;
  message: string;
}>;

export type StrategyValidationResult =
  | Readonly<{ ok: true; definition: StrategyDefinition }>
  | Readonly<{ ok: false; issues: readonly StrategyValidationIssue[] }>;

/** Refusal code: this path does not run options blocks (paper hand-off, Autopilot, instant tools). */
export const STRATEGY_OPTIONS_UNSUPPORTED = "STRATEGY_OPTIONS_UNSUPPORTED";
/** Refusal code: options definitions run on daily bars only. */
export const STRATEGY_OPTIONS_TIMEFRAME_UNSUPPORTED =
  "STRATEGY_OPTIONS_TIMEFRAME_UNSUPPORTED";
/** Refusal code: the definition reads daily series that this path does not load. */
export const STRATEGY_SERIES_FILTERS_UNSUPPORTED =
  "STRATEGY_SERIES_FILTERS_UNSUPPORTED";
/** Refusal code: calendar windows count trading days, which intraday bars in UTC misplace. */
export const STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED =
  "STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED";

export type StrategyRefusal = Readonly<{
  code:
    | typeof STRATEGY_OPTIONS_UNSUPPORTED
    | typeof STRATEGY_OPTIONS_TIMEFRAME_UNSUPPORTED
    | typeof STRATEGY_SERIES_FILTERS_UNSUPPORTED
    | typeof STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED;
  message: string;
}>;

export const STRATEGY_OPTIONS_REFUSAL: StrategyRefusal = {
  code: STRATEGY_OPTIONS_UNSUPPORTED,
  message: `${STRATEGY_OPTIONS_UNSUPPORTED}: the options block runs in backtest runs and the options research runner only; paper hand-off, Autopilot and the instant tools refuse it (no orders). Remove "options" to test the underlying signals here.`,
};

export const STRATEGY_OPTIONS_TIMEFRAME_REFUSAL: StrategyRefusal = {
  code: STRATEGY_OPTIONS_TIMEFRAME_UNSUPPORTED,
  message: `${STRATEGY_OPTIONS_TIMEFRAME_UNSUPPORTED}: options definitions run on daily bars (1d) only.`,
};

export const STRATEGY_CALENDAR_INTRADAY_REFUSAL: StrategyRefusal = {
  code: STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED,
  message: `${STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED}: calendarWindow filters run on daily bars only; on intraday bars the UTC date misplaces the exchange session.`,
};

/** Timeframes of one bar per trading day or longer; every other timeframe is intraday. */
export const STRATEGY_DAILY_TIMEFRAMES: readonly string[] = ["1d", "1w"];

/** Series each filter type reads; `$iv` is the traded symbol's IV index. */
const FILTER_SERIES = (
  filter: StrategyFilter
): readonly StrategySeriesRef[] => {
  switch (filter.type) {
    case "ivRank":
      return ["$iv"];
    case "vixTermStructure":
      return ["VIX", "VIX3M"];
    case "volRegime":
      return ["VIX", "VIX3M", "SPY"];
    case "series":
      return [filter.series];
    default:
      return [];
  }
};

/** The parts of a definition that read series (a campaign filter list has filters only). */
export type StrategySeriesReader = Readonly<{
  entry?:
    | Readonly<{
        all: readonly StrategyCondition[];
        any?: readonly StrategyCondition[] | undefined;
      }>
    | undefined;
  exit?: Readonly<{ any: readonly StrategyCondition[] }> | undefined;
  filters?: readonly StrategyFilter[] | undefined;
  options?: StrategyOptions | undefined;
  portfolio?: StrategyPortfolio | undefined;
}>;

/**
 * Every series ref a definition reads, first use first: its filters, the `series` expressions of
 * its conditions and portfolio selection, and the same for each portfolio leg. The options runner
 * also reads the IV index, IRX, SPY and the total-return closes of its symbols (not listed here).
 */
export const strategySeriesRefs = (
  definition: StrategySeriesReader
): StrategySeriesRef[] => {
  const parts: StrategySeriesReader[] = [
    definition,
    ...(definition.portfolio?.legs ?? []),
  ];
  const refs = parts.flatMap((part) => [
    ...(part.filters ?? []).flatMap(FILTER_SERIES),
    ...[
      ...(part.entry?.all ?? []),
      ...(part.entry?.any ?? []),
      ...(part.exit?.any ?? []),
    ].flatMap((condition) => [
      ...strategyExprSeries(condition.left),
      ...strategyExprSeries(condition.right),
    ]),
  ]);
  const select = definition.portfolio?.select;
  if (select !== undefined)
    refs.push(
      ...strategyExprSeries(select.score),
      ...(select.tieBreak === undefined
        ? []
        : strategyExprSeries(select.tieBreak))
    );
  return [...new Set(refs)];
};

/** The series id of `ref` for `symbol`, or undefined when the symbol has no such series. */
export const resolveStrategySeries = (
  ref: StrategySeriesRef,
  symbol: string | undefined
): StrategySeriesId | undefined => {
  const table =
    ref === "$tr"
      ? STRATEGY_TOTAL_RETURN
      : ref === "$iv"
        ? STRATEGY_IV_INDEX
        : ref === "$future"
          ? STRATEGY_FUTURE_TWIN
          : undefined;
  if (table === undefined) return ref as StrategySeriesId;
  return symbol === undefined || !Object.hasOwn(table, symbol)
    ? undefined
    : table[symbol];
};

/** What a server path loads for a run: daily series, and the options runner. */
export type StrategyServerSupport = Readonly<{
  options?: boolean;
  series?: boolean;
}>;

/**
 * Why a server path cannot run a definition or a campaign filter list, or undefined when it can.
 * `support` says what the path loads: without `options` it refuses an options block, without
 * `series` it refuses every filter or expression that reads a daily series (ivRank,
 * vixTermStructure, volRegime, series). Options run on `1d` only. With a `timeframe` that is not
 * daily, calendarWindow filters are refused. sectorQuadrant filters work everywhere.
 */
export const serverStrategyRefusal = (
  definition: StrategySeriesReader,
  timeframe?: string,
  support: StrategyServerSupport = {}
): StrategyRefusal | undefined => {
  if (definition.options !== undefined) {
    if (support.options !== true) return STRATEGY_OPTIONS_REFUSAL;
    if (timeframe !== undefined && timeframe !== "1d")
      return STRATEGY_OPTIONS_TIMEFRAME_REFUSAL;
  }
  if (support.series !== true && strategySeriesRefs(definition).length > 0) {
    const filters = definition.filters ?? [];
    const types = [
      ...new Set(
        filters
          .filter((filter) => FILTER_SERIES(filter).length > 0)
          .map((filter) => filter.type)
      ),
    ];
    const what =
      types.length > 0
        ? `the ${types.join(", ")} filters`
        : "series expressions";
    return {
      code: STRATEGY_SERIES_FILTERS_UNSUPPORTED,
      message: `${STRATEGY_SERIES_FILTERS_UNSUPPORTED}: ${what} need daily series that this path does not load; backtest runs and the research runners load them. sectorQuadrant and calendarWindow filters work here.`,
    };
  }
  const filters = definition.filters ?? [];
  if (
    timeframe !== undefined &&
    !STRATEGY_DAILY_TIMEFRAMES.includes(timeframe) &&
    filters.some((filter) => filter.type === "calendarWindow")
  )
    return STRATEGY_CALENDAR_INTRADAY_REFUSAL;
  return undefined;
};

/** Validates an unknown value. Issue paths use dots, for example "entry.all.0.left.length". */
export const validateStrategyDefinition = (
  value: unknown
): StrategyValidationResult => {
  const parsed = StrategyDefinitionSchema.safeParse(value);
  if (parsed.success) return { definition: parsed.data, ok: true };
  return {
    issues: parsed.error.issues.map((issue) => ({
      message: issue.message,
      path: issue.path.map(String).join("."),
    })),
    ok: false,
  };
};

/** Parses definition text (JSON). Syntax errors are one issue at the root path. */
export const parseStrategyDefinitionText = (
  text: string
): StrategyValidationResult => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      issues: [
        {
          message: "Not valid JSON. Check the quotes, commas and brackets.",
          path: "",
        },
      ],
      ok: false,
    };
  }
  return validateStrategyDefinition(value);
};

const sma = (length: number) => ({
  length,
  name: "sma" as const,
  source: "close" as const,
  type: "indicator" as const,
});

/** Example templates written for Vertex. Each one validates against the schema. */
export const STRATEGY_TEMPLATE_IDS = [
  "smaCross",
  "rsiReversion",
  "donchianBreakout",
  "atrExpansion",
] as const;
export type StrategyTemplateId = (typeof STRATEGY_TEMPLATE_IDS)[number];

export const STRATEGY_TEMPLATES: Readonly<
  Record<StrategyTemplateId, StrategyDefinitionInput>
> = {
  atrExpansion: {
    description:
      "Enter when short-term volatility (ATR 5) rises above long-term volatility (ATR 20) in an uptrend. ATR stop and target; risk 1% of equity per trade.",
    entry: {
      all: [
        {
          left: { length: 5, name: "atr", type: "indicator" },
          op: "crossesAbove",
          right: { length: 20, name: "atr", type: "indicator" },
        },
        { left: { field: "close", type: "price" }, op: ">", right: sma(50) },
      ],
    },
    exit: {
      any: [
        { left: { field: "close", type: "price" }, op: "<", right: sma(20) },
      ],
    },
    name: "ATR expansion",
    sizing: { mode: "riskPct", riskPct: 1 },
    stopLoss: { kind: "atr", length: 14, multiple: 2 },
    takeProfit: { kind: "atr", length: 14, multiple: 4 },
    version: 1,
  },
  donchianBreakout: {
    description:
      "Enter when the close breaks above the highest high of the prior 20 bars. Exit below the lowest low of the prior 10 bars.",
    entry: {
      all: [
        {
          left: { field: "close", type: "price" },
          op: ">",
          right: {
            length: 20,
            name: "highest",
            source: "high",
            type: "indicator",
          },
        },
      ],
    },
    exit: {
      any: [
        {
          left: { field: "close", type: "price" },
          op: "<",
          right: {
            length: 10,
            name: "lowest",
            source: "low",
            type: "indicator",
          },
        },
      ],
    },
    name: "Donchian breakout",
    version: 1,
  },
  rsiReversion: {
    description:
      "Buy when RSI 14 falls below 30 and price is above the 200-bar average. Sell when RSI 14 rises above 55. 8% stop.",
    entry: {
      all: [
        {
          left: { length: 14, name: "rsi", type: "indicator" },
          op: "<",
          right: { type: "const", value: 30 },
        },
        { left: { field: "close", type: "price" }, op: ">", right: sma(200) },
      ],
    },
    exit: {
      any: [
        {
          left: { length: 14, name: "rsi", type: "indicator" },
          op: ">",
          right: { type: "const", value: 55 },
        },
      ],
    },
    name: "RSI reversion",
    stopLoss: { kind: "pct", pct: 8 },
    version: 1,
  },
  smaCross: {
    description:
      "Enter when the 20-bar average crosses above the 50-bar average. Exit when it is at or below it.",
    entry: {
      all: [{ left: sma(20), op: "crossesAbove", right: sma(50) }],
    },
    exit: { any: [{ left: sma(20), op: "<=", right: sma(50) }] },
    name: "SMA cross",
    version: 1,
  },
};
