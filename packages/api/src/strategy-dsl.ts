import { z } from "zod";

import {
  SECTOR_ROTATION_QUADRANTS,
  SECTOR_ROTATION_SECTORS,
} from "./contracts/sector-rotation.ts";

// Strategy definition format (version 1): a small declarative strategy, long unless `side` is
// "short". Entry needs every entry condition on the signal bar; exit needs any exit condition.
// Conditions compare two expressions (price fields, constants or indicators). An optional
// `intraday` block trades a New York regular session and is flat at its close. The definition
// compiles to the signal arrays of the instant backtest engine. Research and backtest use only;
// it never creates orders.

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

/**
 * Indicators of the intraday session: they need an `intraday` block (StrategyIntradaySchema) and
 * read only the regular-session bars of the current New York session day (NaN outside it).
 * - vwap: sum(typical × volume) / sum(volume) since the session's first regular bar, typical =
 *   (high + low + close) / 3; the running mean of typical prices while the summed volume is 0 or
 *   the bars have no volume.
 * - sessionReturn: price at `to` / price at `from` - 1, from the bar closing at `to` through the
 *   session end. `from` "prevClose" is the last regular close of the previous session day, "open"
 *   the open of today's first regular bar, "HH:MM" the close of today's bar closing then; `to` is
 *   the close of today's bar closing at `to`. NaN when a price is missing.
 * - noiseBand: for each bar, sigma = mean of |close / session open - 1| at the same minutes since
 *   the session open over the previous `length` session days that have a bar then (NaN until
 *   there are `length`). upper = max(session open, previous close) × (1 + multiple × sigma),
 *   lower = min(session open, previous close) × (1 - multiple × sigma); `multiple` defaults to 1.
 */
export const STRATEGY_SESSION_INDICATORS = [
  "vwap",
  "sessionReturn",
  "noiseBand",
] as const;
export const STRATEGY_NOISE_BANDS = ["upper", "lower"] as const;
export const STRATEGY_NOISE_BAND_MAX_LENGTH = 60;
/** sessionReturn anchors besides a time of day. */
export const STRATEGY_SESSION_ANCHORS = ["prevClose", "open"] as const;

const NEW_YORK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;
const NewYorkTimeSchema = z
  .string()
  .regex(NEW_YORK_TIME, "Expected HH:MM (New York)");

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

/** A classic indicator: `length` bars (or days with timeframe "1d") of one price source. */
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
  .refine(
    (expr) =>
      expr.name !== "rvol" || expr.length <= STRATEGY_DSL_MAX_RVOL_SESSIONS,
    {
      message: `rvol length must be at most ${STRATEGY_DSL_MAX_RVOL_SESSIONS} sessions`,
      path: ["length"],
    }
  )
  .refine((expr) => expr.name !== "rvol" || expr.timeframe === undefined, {
    message: "rvol has no timeframe; it already compares whole sessions",
    path: ["timeframe"],
  })
  .refine(
    (expr) =>
      (expr.name !== "zscore" && expr.name !== "realizedVol") ||
      expr.length >= STRATEGY_DSL_MIN_DEVIATION_LENGTH,
    {
      message: `zscore and realizedVol length must be at least ${STRATEGY_DSL_MIN_DEVIATION_LENGTH}`,
      path: ["length"],
    }
  );

/** Session indicators (STRATEGY_SESSION_INDICATORS) take no length, source, offset or timeframe. */
const VwapExprSchema = z
  .object({ name: z.literal("vwap"), type: z.literal("indicator") })
  .strict();

const SessionReturnExprSchema = z
  .object({
    from: z.union([z.enum(STRATEGY_SESSION_ANCHORS), NewYorkTimeSchema]),
    name: z.literal("sessionReturn"),
    to: NewYorkTimeSchema,
    type: z.literal("indicator"),
  })
  .strict()
  .refine((expr) => !NEW_YORK_TIME.test(expr.from) || expr.from < expr.to, {
    message: "sessionReturn from must be before to",
    path: ["from"],
  });

const NoiseBandExprSchema = z
  .object({
    band: z.enum(STRATEGY_NOISE_BANDS),
    length: z.number().int().min(1).max(STRATEGY_NOISE_BAND_MAX_LENGTH),
    /** Optional with no default; absent means 1. */
    multiple: z.number().gt(0).max(100).optional(),
    name: z.literal("noiseBand"),
    type: z.literal("indicator"),
  })
  .strict();

export const StrategyExprSchema = z.discriminatedUnion("type", [
  z
    .object({
      field: z.enum(STRATEGY_PRICE_FIELDS),
      offset: OffsetSchema,
      type: z.literal("price"),
    })
    .strict(),
  z
    .object({
      type: z.literal("const"),
      value: z.number().min(-1e12).max(1e12),
    })
    .strict(),
  z.discriminatedUnion("name", [
    IndicatorExprSchema,
    VwapExprSchema,
    SessionReturnExprSchema,
    NoiseBandExprSchema,
  ]),
]);

/** A classic indicator expression (not a session indicator). */
export type StrategyIndicatorExpr = z.infer<typeof IndicatorExprSchema>;
/** vwap, sessionReturn or noiseBand (STRATEGY_SESSION_INDICATORS). */
export type StrategySessionIndicatorExpr =
  | z.infer<typeof VwapExprSchema>
  | z.infer<typeof SessionReturnExprSchema>
  | z.infer<typeof NoiseBandExprSchema>;

const SESSION_INDICATOR_NAMES: readonly string[] = STRATEGY_SESSION_INDICATORS;

/** True for vwap, sessionReturn and noiseBand (they need an intraday block). */
export const isSessionIndicator = (
  expr: z.infer<typeof StrategyExprSchema>
): expr is StrategySessionIndicatorExpr =>
  expr.type === "indicator" && SESSION_INDICATOR_NAMES.includes(expr.name);

export const StrategyConditionSchema = z
  .object({
    left: StrategyExprSchema,
    /**
     * Optional with no default. When true the condition holds at most once per level: a bar where
     * it holds is dropped when the same right value (exact) already made it hold on an earlier bar.
     * Only with crossesAbove, crossesBelow, breaksAbove and breaksBelow.
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
  );

/**
 * Daily series that filters may read (Core 7 ETFs, futures, volatility and rate indices, and
 * EY_TNX_RATIO: Shiller earnings yield lagged 6 months over the 10-year yield). Each series is one
 * value per date (the close).
 */
export const STRATEGY_SERIES_IDS = [
  "SPY",
  "QQQ",
  "DIA",
  "IWM",
  "GLD",
  "SLV",
  "USO",
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

/** Implied-volatility index of each traded symbol, read by the ivRank filter. */
export const STRATEGY_IV_INDEX: Readonly<Record<string, StrategySeriesId>> = {
  DIA: "VXD",
  GLD: "GVZ",
  IWM: "RVX",
  QQQ: "VXN",
  SLV: "VXSLV",
  SPY: "VIX",
  USO: "OVX",
};

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

const closeOnly = (expr: z.infer<typeof StrategyExprSchema>): boolean => {
  if (expr.type === "const") return true;
  if (expr.type === "price") return expr.field === "close";
  // Session indicators read a regular session of intraday bars, which a series does not have.
  if (isSessionIndicator(expr)) return false;
  return expr.source === "close" && NON_CLOSE_INDICATORS[expr.name] !== true;
};

/**
 * Entry filter on another daily series (cross-asset): `condition` is evaluated on that series, its
 * indicators over the series' own dates, then each side takes the latest value dated on or before
 * the bar date. Crosses compare with the previous bar. A series is one value per date, so only the
 * close price and close-sourced indicators other than atr, adx and rvol are allowed.
 */
export const SeriesFilterSchema = z
  .object({
    condition: StrategyConditionSchema,
    series: z.enum(STRATEGY_SERIES_IDS),
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
        (expr) =>
          expr.type !== "indicator" ||
          isSessionIndicator(expr) ||
          expr.timeframe === undefined
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
/** Session minutes of a decision grid: 1 to a whole 6.5-hour session. */
export const STRATEGY_INTRADAY_MAX_DECISION_MINUTES = 390;
export const STRATEGY_SIDES = ["long", "short"] as const;
export const STRATEGY_VOL_TARGET_MIN_LENGTH = 2;
export const STRATEGY_VOL_TARGET_MAX_LENGTH = 252;

/**
 * Intraday session (New York time). A bar closes at its time + the bar duration (the most common
 * spacing of bars on one New York date, ties to the smaller). Regular bars open at or after `open`
 * and close at or before `close`; other bars never enter, never hold a position and are NaN in the
 * session indicators. Entries only on regular bars closing in [entryFrom, entryTo] and, with
 * `decisionEvery`, a whole number of those minutes after `open`; exit conditions only on regular
 * bars on that grid. Stops and targets stay live. A position open at the close of the last regular
 * bar of its session day exits at that close (market on close); that bar takes no entry.
 */
export const StrategyIntradaySchema = z
  .object({
    close: NewYorkTimeSchema,
    /** Optional with no default: minutes of the decision grid. */
    decisionEvery: z
      .number()
      .int()
      .min(1)
      .max(STRATEGY_INTRADAY_MAX_DECISION_MINUTES)
      .optional(),
    entryFrom: NewYorkTimeSchema,
    entryTo: NewYorkTimeSchema,
    open: NewYorkTimeSchema,
    timezone: z.literal("America/New_York"),
  })
  .strict()
  .refine((session) => session.open < session.close, {
    message: "intraday open must be before close",
    path: ["close"],
  })
  .refine(
    (session) =>
      session.open < session.entryFrom &&
      session.entryFrom <= session.entryTo &&
      session.entryTo < session.close,
    {
      message:
        "The entry window must be inside the session: open < entryFrom <= entryTo < close",
      path: ["entryFrom"],
    }
  );

/**
 * Volatility-target sizing: at each entry, notional = equity × min(maxLeverage, targetPct / 100 /
 * sigma), sigma = sample standard deviation of the last `length` completed session-day
 * close-to-close returns (the close of a day is its last regular bar; without an intraday block
 * every bar of a New York date counts). No sigma yet means no entry.
 */
const VolTargetSizingSchema = z
  .object({
    length: z
      .number()
      .int()
      .min(STRATEGY_VOL_TARGET_MIN_LENGTH)
      .max(STRATEGY_VOL_TARGET_MAX_LENGTH),
    maxLeverage: z.number().gt(0).max(STRATEGY_DSL_MAX_LEVERAGE),
    mode: z.literal("volTarget"),
    targetPct: z.number().gt(0).max(100),
  })
  .strict();

type DefinitionExprs = Readonly<{
  entry: Readonly<{
    all: readonly StrategyCondition[];
    any?: readonly StrategyCondition[] | undefined;
  }>;
  exit: Readonly<{ any: readonly StrategyCondition[] }>;
}>;

/** Paths and names of the session indicators in the entry and exit conditions. */
const sessionIndicatorUses = (
  definition: DefinitionExprs
): [(string | number)[], string][] => {
  const groups: [(string | number)[], readonly StrategyCondition[]][] = [
    [["entry", "all"], definition.entry.all],
    [["entry", "any"], definition.entry.any ?? []],
    [["exit", "any"], definition.exit.any],
  ];
  return groups.flatMap(([path, conditions]) =>
    conditions.flatMap((condition, index) =>
      (["left", "right"] as const).flatMap(
        (side): [(string | number)[], string][] => {
          const expr = condition[side];
          return isSessionIndicator(expr)
            ? [[[...path, index, side], expr.name]]
            : [];
        }
      )
    )
  );
};

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
    /** Optional with no default (see StrategyIntradaySchema). */
    intraday: StrategyIntradaySchema.optional(),
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
    /** Entries happen only on signal bars whose UTC time is in [start, end). Omit for all bars. */
    session: z
      .object({ endUtc: TimeSchema, startUtc: TimeSchema })
      .strict()
      .refine((session) => session.startUtc !== session.endUtc, {
        message: "Session start and end must differ",
      })
      .optional(),
    /**
     * Optional with no default; absent means long. "short" sells at the entry and buys back at
     * the exit: stops sit above the entry and targets below it.
     */
    side: z.enum(STRATEGY_SIDES).optional(),
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
        VolTargetSizingSchema,
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
      definition.options === undefined ||
      definition.sizing.mode !== "volTarget",
    {
      message:
        "Option strategies size by options.maxLossPct; remove the volTarget sizing",
      path: ["sizing"],
    }
  )
  .refine(
    (definition) =>
      definition.side !== "short" || definition.management === undefined,
    {
      message:
        "management raises a long stop; a short definition takes no management",
      path: ["management"],
    }
  )
  .refine(
    (definition) =>
      definition.side !== "short" || definition.options === undefined,
    {
      message:
        "Option strategies take their direction from options.structure; remove side",
      path: ["side"],
    }
  )
  .refine(
    (definition) =>
      definition.intraday === undefined || definition.options === undefined,
    {
      message: "Option strategies run on daily bars; remove the intraday block",
      path: ["intraday"],
    }
  )
  .refine(
    (definition) =>
      definition.intraday === undefined ||
      (definition.filters ?? []).every(
        (filter) => filter.type !== "calendarWindow"
      ),
    {
      message:
        "calendarWindow filters run on daily bars only; remove them or the intraday block",
      path: ["filters"],
    }
  )
  .superRefine((definition, context) => {
    if (definition.intraday !== undefined) return;
    for (const [path, name] of sessionIndicatorUses(definition))
      context.addIssue({
        code: "custom",
        message: `${name} reads the intraday session; add an intraday block`,
        path,
      });
  });

export type StrategyExpr = z.infer<typeof StrategyExprSchema>;
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
export type StrategyIntraday = z.infer<typeof StrategyIntradaySchema>;
export type StrategyDefinitionInput = z.input<typeof StrategyDefinitionSchema>;

export type StrategyValidationIssue = Readonly<{
  path: string;
  message: string;
}>;

export type StrategyValidationResult =
  | Readonly<{ ok: true; definition: StrategyDefinition }>
  | Readonly<{ ok: false; issues: readonly StrategyValidationIssue[] }>;

/** Refusal code: the options block runs only in the options research runner. */
export const STRATEGY_OPTIONS_UNSUPPORTED = "STRATEGY_OPTIONS_UNSUPPORTED";
/** Refusal code: the filter reads daily series that the server does not load. */
export const STRATEGY_SERIES_FILTERS_UNSUPPORTED =
  "STRATEGY_SERIES_FILTERS_UNSUPPORTED";
/** Refusal code: calendar windows count trading days, which intraday bars in UTC misplace. */
export const STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED =
  "STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED";
/** Refusal code: the intraday block needs intraday bars (a daily or weekly run refuses it). */
export const STRATEGY_INTRADAY_DAILY_UNSUPPORTED =
  "STRATEGY_INTRADAY_DAILY_UNSUPPORTED";

export type StrategyRefusal = Readonly<{
  code:
    | typeof STRATEGY_OPTIONS_UNSUPPORTED
    | typeof STRATEGY_SERIES_FILTERS_UNSUPPORTED
    | typeof STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED
    | typeof STRATEGY_INTRADAY_DAILY_UNSUPPORTED;
  message: string;
}>;

export const STRATEGY_OPTIONS_REFUSAL: StrategyRefusal = {
  code: STRATEGY_OPTIONS_UNSUPPORTED,
  message: `${STRATEGY_OPTIONS_UNSUPPORTED}: the options block runs only in the options research runner; an equity backtest refuses it. Remove "options" to test the underlying signals.`,
};

export const STRATEGY_CALENDAR_INTRADAY_REFUSAL: StrategyRefusal = {
  code: STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED,
  message: `${STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED}: calendarWindow filters run on daily bars only; on intraday bars the UTC date misplaces the exchange session.`,
};

export const STRATEGY_INTRADAY_DAILY_REFUSAL: StrategyRefusal = {
  code: STRATEGY_INTRADAY_DAILY_UNSUPPORTED,
  message: `${STRATEGY_INTRADAY_DAILY_UNSUPPORTED}: the intraday block needs intraday bars (two or more bars on one New York date); a daily or weekly run refuses it.`,
};

/** Timeframes of one bar per trading day or longer; every other timeframe is intraday. */
export const STRATEGY_DAILY_TIMEFRAMES: readonly string[] = ["1d", "1w"];

/** Filter types that read external daily series (no server loader yet). */
const READS_SERIES: Readonly<Record<StrategyFilter["type"], boolean>> = {
  calendarWindow: false,
  ivRank: true,
  sectorQuadrant: false,
  series: true,
  vixTermStructure: true,
  volRegime: true,
};

/**
 * Why the server engines (instant backtest, run queue and Nautilus worker, Autopilot, paper
 * hand-off) cannot run a definition or a campaign filter list, or undefined when they can. They
 * run equity strategies and load sector points only, so they refuse an options block and the
 * ivRank, vixTermStructure, volRegime and series filters. With a `timeframe` that is not daily
 * they also refuse calendarWindow filters, and with a daily one an intraday block.
 * sectorQuadrant filters work everywhere.
 */
export const serverStrategyRefusal = (
  definition: Readonly<{
    filters?: readonly StrategyFilter[] | undefined;
    intraday?: StrategyIntraday | undefined;
    options?: StrategyOptions | undefined;
  }>,
  timeframe?: string
): StrategyRefusal | undefined => {
  if (definition.options !== undefined) return STRATEGY_OPTIONS_REFUSAL;
  const filters = definition.filters ?? [];
  const types = [
    ...new Set(
      filters.map((filter) => filter.type).filter((type) => READS_SERIES[type])
    ),
  ];
  if (types.length > 0)
    return {
      code: STRATEGY_SERIES_FILTERS_UNSUPPORTED,
      message: `${STRATEGY_SERIES_FILTERS_UNSUPPORTED}: the ${types.join(", ")} filters need daily series that the server does not load; only the research runners pass them. sectorQuadrant and calendarWindow filters work here.`,
    };
  if (timeframe === undefined) return undefined;
  const daily = STRATEGY_DAILY_TIMEFRAMES.includes(timeframe);
  if (!daily && filters.some((filter) => filter.type === "calendarWindow"))
    return STRATEGY_CALENDAR_INTRADAY_REFUSAL;
  if (daily && definition.intraday !== undefined)
    return STRATEGY_INTRADAY_DAILY_REFUSAL;
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
