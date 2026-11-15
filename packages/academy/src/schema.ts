// What: The lesson spec contract. One JSON file per knowledge-base transcript (any Academy course) is
// validated against LessonSpecSchema. The same spec drives the interactive chart, the data tables,
// the rendered video, the WebVTT captions, the backtest preset and the deploy gate inputs.
import { z } from "zod";

import { COURSE_IDS, type CourseId, DEFAULT_COURSE_ID } from "./courses.ts";
import { OPTIONS_ELEMENTS, OPTIONS_FORMULA_IDS } from "./quant/options-ids.ts";
import {
  PORTFOLIO_ELEMENTS,
  PORTFOLIO_FORMULA_IDS,
} from "./quant/portfolio-ids.ts";
import { GROWTH_ELEMENTS, GROWTH_FORMULA_IDS } from "./quant/growth-ids.ts";
import { PROCESS_ELEMENTS, PROCESS_FORMULA_IDS } from "./quant/process-ids.ts";
import {
  STATISTICS_ELEMENTS,
  STATISTICS_FORMULA_IDS,
} from "./quant/statistics-ids.ts";
import { TESTING_ELEMENTS, TESTING_FORMULA_IDS } from "./quant/testing-ids.ts";
import { TRADING_ELEMENTS, TRADING_FORMULA_IDS } from "./quant/trading-ids.ts";
import {
  VOLATILITY_ELEMENTS,
  VOLATILITY_FORMULA_IDS,
} from "./quant/volatility-ids.ts";

export const COLOR_TOKENS = [
  "green",
  "red",
  "blue",
  "amber",
  "violet",
  "cyan",
  "gold",
  "gray",
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

export const REGIME_TAGS = [
  "any",
  "bullish",
  "bearish",
  "range",
  "high-vol",
  "low-vol",
  "regime-change",
  "event",
] as const;
export const INSTRUMENT_TAGS = [
  "single-stock",
  "etf",
  "index-options",
  "0dte",
  "futures",
  "leaps",
  "spreads",
  "covered-calls",
  "cash-secured-puts",
  "hedging",
  "synthetics",
  "volatility",
  "portfolio",
] as const;
export const TIMEFRAME_TAGS = [
  "intraday",
  "days",
  "weeks",
  "months",
  "years",
] as const;
export const RISK_TAGS = [
  "defined",
  "undefined",
  "hedged",
  "stock-like",
  "none",
] as const;

const id = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9]{0,23}$/u, "ids are short camelCase names");
const ref = z.union([z.number(), id]);

export const ParamSchema = z
  .object({
    id,
    label: z.string().min(1).max(40),
    kind: z.enum(["number", "select", "text"]).default("number"),
    default: z.union([z.number(), z.string()]),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    unit: z
      .enum(["$", "%", "days", "x", "contracts", "shares", "pts", "trades"])
      .optional(),
    options: z.array(z.string().min(1).max(24)).max(12).optional(),
    help: z.string().max(200).optional(),
  })
  .strict();
export type LessonParam = z.infer<typeof ParamSchema>;

export const LegSchema = z
  .object({
    kind: z.enum(["call", "put", "stock"]),
    side: z.enum(["long", "short"]),
    /** Contracts for options (x100 shares), lots of 100 shares for stock. */
    qty: ref.default(1),
    strike: ref.optional(),
    dte: ref.optional(),
    /** Optional per-leg implied volatility in percent; defaults to the iv param. */
    iv: ref.optional(),
    label: z.string().max(32).optional(),
  })
  .strict();
export type Leg = z.infer<typeof LegSchema>;

const legs = z.array(LegSchema).min(1).max(6);

/**
 * Element ids per quant mode (seeded models that are not option positions: random processes,
 * portfolios, factors, volatility models, trading rules). Each group file in quant/ owns its modes.
 */
export const QUANT_MODE_ELEMENTS = {
  ...PROCESS_ELEMENTS,
  ...GROWTH_ELEMENTS,
  ...PORTFOLIO_ELEMENTS,
  ...STATISTICS_ELEMENTS,
  ...TESTING_ELEMENTS,
  ...VOLATILITY_ELEMENTS,
  ...TRADING_ELEMENTS,
  ...OPTIONS_ELEMENTS,
} as const;
export type QuantMode = keyof typeof QUANT_MODE_ELEMENTS;
export const QUANT_MODES = Object.keys(QUANT_MODE_ELEMENTS) as [
  QuantMode,
  ...QuantMode[],
];

export const SceneSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("payoff"),
      legs,
      view: z.enum(["2d", "3d"]).default("2d"),
    })
    .strict(),
  z
    .object({
      type: z.literal("compare"),
      a: z.object({ label: z.string().max(32), legs }).strict(),
      b: z.object({ label: z.string().max(32), legs }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("greeks"),
      legs,
      greek: z.enum(["delta", "gamma", "theta", "vega"]).default("delta"),
    })
    .strict(),
  z
    .object({
      type: z.literal("distribution"),
      legs: z.array(LegSchema).max(6).default([]),
    })
    .strict(),
  z.object({ type: z.literal("ivrv") }).strict(),
  z
    .object({
      type: z.literal("gex"),
      view: z.enum(["2d", "3d"]).default("2d"),
    })
    .strict(),
  z
    .object({
      type: z.literal("portfolio"),
      mode: z.enum(["equity", "recovery", "allocation"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("pricepath"),
      legs,
      events: z
        .array(
          z
            .object({
              day: z.number().int().min(0),
              label: z.string().min(1).max(40),
              color: z.enum(COLOR_TOKENS),
            })
            .strict()
        )
        .max(6)
        .default([]),
      /**
       * Optional story of the price: % moves from the entry price at given days. The path passes
       * through each waypoint (linear in log price) with noise scaled by realized volatility.
       */
      waypoints: z
        .array(
          z
            .object({
              day: z.number().int().min(0),
              movePct: z.number().min(-90).max(500),
            })
            .strict()
        )
        .max(12)
        .default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal("quant"),
      mode: z.enum(QUANT_MODES),
    })
    .strict(),
]);
export type Scene = z.infer<typeof SceneSchema>;
export type SceneType = Scene["type"];

/** Drawable element ids per scene type. Steps reveal these in order. */
export const SCENE_ELEMENTS: Readonly<Record<SceneType, readonly string[]>> = {
  payoff: [
    "axes",
    "spot",
    "strikes",
    "legs",
    "expiry",
    "now",
    "zones",
    "breakeven",
    "maxProfit",
    "maxLoss",
    "surface",
  ],
  compare: ["axes", "spot", "a", "b", "diff", "breakeven"],
  greeks: ["axes", "spot", "delta", "gamma", "theta", "vega", "strikes"],
  distribution: [
    "axes",
    "spot",
    "pdf",
    "band1",
    "band2",
    "breakeven",
    "pop",
    "ev",
  ],
  ivrv: ["axes", "price", "rv", "iv", "vrp"],
  gex: ["axes", "bars", "spot", "flip", "callWall", "putWall", "surface"],
  portfolio: [
    "axes",
    "paths",
    "median",
    "drawdown",
    "curve",
    "marker",
    "core",
    "options",
    "cash",
    "maxLoss",
  ],
  pricepath: ["axes", "price", "strikes", "events", "pnl", "spot"],
  quant: [...new Set(Object.values(QUANT_MODE_ELEMENTS).flat())],
};

/** Element ids a lesson's scene draws (a quant scene: its mode's elements). */
export const sceneElements = (scene: Scene): readonly string[] =>
  scene.type === "quant"
    ? QUANT_MODE_ELEMENTS[scene.mode]
    : SCENE_ELEMENTS[scene.type];

export const StepSchema = z
  .object({
    caption: z.string().min(8).max(160),
    element: z.string().min(1).max(24),
    color: z.enum(COLOR_TOKENS),
    /** Scrubber range as fractions of the horizon (0 = entry, 1 = horizon) animated during the step. */
    time: z
      .tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
      .optional(),
    seconds: z.number().min(2).max(10).default(4.5),
  })
  .strict();
export type LessonStep = z.infer<typeof StepSchema>;

const BASE_FORMULA_IDS = [
  "blackScholes",
  "delta",
  "gamma",
  "theta",
  "vega",
  "putCallParity",
  "breakevenCall",
  "breakevenPut",
  "verticalMaxProfit",
  "expectedMove",
  "probabilityOfProfit",
  "expectedValue",
  "realizedVol",
  "vrp",
  "gex",
  "kelly",
  "recovery",
  "positionSize",
  "extrinsic",
  "annualizedYield",
] as const;
export type BaseFormulaId = (typeof BASE_FORMULA_IDS)[number];

export const FORMULA_IDS = [
  ...BASE_FORMULA_IDS,
  ...PROCESS_FORMULA_IDS,
  ...GROWTH_FORMULA_IDS,
  ...PORTFOLIO_FORMULA_IDS,
  ...STATISTICS_FORMULA_IDS,
  ...TESTING_FORMULA_IDS,
  ...VOLATILITY_FORMULA_IDS,
  ...TRADING_FORMULA_IDS,
  ...OPTIONS_FORMULA_IDS,
] as const;
export type FormulaId = (typeof FORMULA_IDS)[number];

export const STRUCTURES = [
  "long_call",
  "long_put",
  "call_debit_spread",
  "put_debit_spread",
  "put_credit_spread",
  "call_credit_spread",
  "iron_condor",
  "iron_butterfly",
  "long_straddle",
  "short_strangle",
  "covered_call",
  "cash_secured_put",
  "collar",
  "protective_put",
  "pmcc",
  "deep_itm_call",
  "synthetic_long",
  "ratio_call_spread",
  "calendar_call",
] as const;
export type StructureId = (typeof STRUCTURES)[number];

export const BacktestPresetSchema = z
  .object({
    structure: z.enum(STRUCTURES),
    tickers: z
      .array(z.string().regex(/^[A-Z][A-Z0-9.^-]{0,9}$/u))
      .min(1)
      .max(5),
    scenario: z
      .object({
        label: z.string().min(3).max(60),
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
      })
      .strict(),
    /** Structure rule values; unknown keys are refused by the engine. */
    rules: z.record(z.string(), z.number()).default({}),
    note: z.string().max(240).optional(),
  })
  .strict();
export type BacktestPreset = z.infer<typeof BacktestPresetSchema>;

export const LessonSpecSchema = z
  .object({
    /** Course of the lesson (courses.ts); Define Your Risk specs omit it. */
    course: z.enum(COURSE_IDS).default(DEFAULT_COURSE_ID),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u)
      .max(60),
    sourceId: z.string().min(5).max(20),
    title: z.string().min(4).max(90),
    summary: z.string().min(20).max(400),
    kind: z.enum(["strategy", "concept"]),
    tags: z
      .object({
        regime: z.array(z.enum(REGIME_TAGS)).min(1).max(3),
        instruments: z.array(z.enum(INSTRUMENT_TAGS)).max(5),
        timeframe: z.enum(TIMEFRAME_TAGS),
        risk: z.enum(RISK_TAGS),
        topics: z.array(z.string().min(2).max(24)).max(6).default([]),
      })
      .strict(),
    scene: SceneSchema,
    params: z.array(ParamSchema).min(1).max(16),
    steps: z.array(StepSchema).min(3).max(9),
    formulas: z.array(z.enum(FORMULA_IDS)).min(1).max(6),
    takeaways: z.array(z.string().min(8).max(200)).min(2).max(5),
    caveats: z.array(z.string().min(8).max(240)).max(4).default([]),
    backtest: BacktestPresetSchema.optional(),
  })
  .strict()
  .superRefine((lesson, context) => {
    const ids = new Set(lesson.params.map((param) => param.id));
    if (ids.size !== lesson.params.length)
      context.addIssue({ code: "custom", message: "param ids must be unique" });
    const elements = sceneElements(lesson.scene);
    const drawer =
      lesson.scene.type === "quant"
        ? `quant mode ${lesson.scene.mode}`
        : `scene ${lesson.scene.type}`;
    for (const [index, step] of lesson.steps.entries()) {
      if (!elements.includes(step.element))
        context.addIssue({
          code: "custom",
          path: ["steps", index, "element"],
          message: `element ${step.element} is not drawn by ${drawer}`,
        });
    }
    if (lesson.kind === "strategy" && lesson.backtest === undefined)
      context.addIssue({
        code: "custom",
        message: "strategy lessons need a backtest preset",
      });
    if (lesson.kind === "concept" && lesson.backtest !== undefined)
      context.addIssue({
        code: "custom",
        message: "concept lessons have no backtest preset",
      });
    const legsOf = (scene: Scene): Leg[] =>
      scene.type === "compare"
        ? [...scene.a.legs, ...scene.b.legs]
        : "legs" in scene
          ? scene.legs
          : [];
    for (const leg of legsOf(lesson.scene)) {
      for (const value of [leg.qty, leg.strike, leg.dte, leg.iv]) {
        if (typeof value === "string" && !ids.has(value))
          context.addIssue({
            code: "custom",
            message: `leg references unknown param ${value}`,
          });
      }
      if (
        leg.kind !== "stock" &&
        (leg.strike === undefined || leg.dte === undefined)
      )
        context.addIssue({
          code: "custom",
          message: "option legs need strike and dte",
        });
    }
  });
export type LessonSpec = z.infer<typeof LessonSpecSchema>;
/** A spec as authored (TypeScript spec modules: defaults may be omitted). */
export type LessonSpecInput = z.input<typeof LessonSpecSchema>;

/** Transcript and source data taken from the knowledge base (not authored). */
export type LessonSource = Readonly<{
  /** Course whose knowledge base holds the source (sources.json entries omit it: dyr). */
  course: CourseId;
  sourceId: string;
  url: string;
  caption: string;
  publishedAt: string;
  durationSeconds: number;
  /**
   * Sentences with start times estimated from word position over the audio duration (dyr), or
   * speech-to-text segments with their own start times (courses with `timestamps: "segments"`).
   */
  transcript: readonly Readonly<{ start: number; text: string }>[];
  duplicateOf?: string;
}>;

/** Publish date of a source: a date (YYYY-MM-DD) or a UTC timestamp, as the knowledge base has it. */
const PUBLISHED_AT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/u;

/**
 * A knowledge-base source of one course, as stored in Postgres (academy_lesson_sources) and served by
 * academy.lesson. The limits match the table's checks (packages/db/src/schema/academy-content.ts).
 */
export const LessonSourceSchema = z
  .object({
    course: z.enum(COURSE_IDS),
    sourceId: z.string().regex(/^[A-Za-z0-9_-]{5,20}$/u),
    url: z
      .string()
      .regex(/^https:\/\//u)
      .max(500),
    caption: z.string().max(5000),
    publishedAt: z.string().regex(PUBLISHED_AT),
    durationSeconds: z.number().min(0).max(86_400),
    transcript: z
      .array(z.object({ start: z.number().min(0), text: z.string() }).strict())
      .max(2000),
    duplicateOf: z.string().min(1).max(20).optional(),
  })
  .strict();

export type Lesson = LessonSpec & Readonly<{ source: LessonSource }>;

export type LessonSummary = Readonly<{
  course: CourseId;
  slug: string;
  title: string;
  summary: string;
  kind: LessonSpec["kind"];
  tags: LessonSpec["tags"];
  sceneType: SceneType;
  structure: StructureId | null;
  publishedAt: string;
}>;
