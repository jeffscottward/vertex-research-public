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
export const StrategyFilterSchema = z
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

/** One to STRATEGY_DSL_MAX_FILTERS entry filters; Autopilot campaigns use the same list. */
export const StrategyFiltersSchema = z
  .array(StrategyFilterSchema)
  .min(1)
  .max(STRATEGY_DSL_MAX_FILTERS);

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
] as const;

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
  z
    .object({
      length: LengthSchema,
      name: z.enum(STRATEGY_INDICATORS),
      offset: OffsetSchema,
      /**
       * Input price for sma, ema, rsi, highest, lowest, zscore and realizedVol. atr, adx and rvol
       * ignore it. For rvol, `length` is the number of previous sessions in the average.
       */
      source: z.enum(STRATEGY_PRICE_FIELDS).default("close"),
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
    .refine(
      (expr) =>
        (expr.name !== "zscore" && expr.name !== "realizedVol") ||
        expr.length >= STRATEGY_DSL_MIN_DEVIATION_LENGTH,
      {
        message: `zscore and realizedVol length must be at least ${STRATEGY_DSL_MIN_DEVIATION_LENGTH}`,
        path: ["length"],
      }
    ),
]);

export const StrategyConditionSchema = z
  .object({
    left: StrategyExprSchema,
    op: z.enum(STRATEGY_OPERATORS),
    right: StrategyExprSchema,
  })
  .strict();

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

export const StrategyDefinitionSchema = z
  .object({
    description: z.string().max(2000).optional(),
    entry: z
      .object({
        all: z
          .array(StrategyConditionSchema)
          .min(1)
          .max(STRATEGY_DSL_MAX_CONDITIONS),
      })
      .strict(),
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
    name: z.string().trim().min(1).max(120),
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
  );

export type StrategyExpr = z.infer<typeof StrategyExprSchema>;
export type StrategyCondition = z.infer<typeof StrategyConditionSchema>;
export type StrategyDefinition = z.infer<typeof StrategyDefinitionSchema>;
export type StrategyFilter = z.infer<typeof StrategyFilterSchema>;
export type StrategyDefinitionInput = z.input<typeof StrategyDefinitionSchema>;

export type StrategyValidationIssue = Readonly<{
  path: string;
  message: string;
}>;

export type StrategyValidationResult =
  | Readonly<{ ok: true; definition: StrategyDefinition }>
  | Readonly<{ ok: false; issues: readonly StrategyValidationIssue[] }>;

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
