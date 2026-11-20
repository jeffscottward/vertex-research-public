import { COURSE_IDS } from "@darkfactory/academy/courses";
import {
  LessonSourceSchema,
  LessonSpecSchema,
  SCENE_ELEMENTS,
  type SceneType,
  STRUCTURES,
} from "@darkfactory/academy/schema";
import { oc } from "@orpc/contract";
import { z } from "zod";
import { EngineComparisonTimingSchema } from "./engine-comparison.ts";

// Vertex Academy. Three procedure groups:
// - lessons, lesson: read the lesson catalog, operator-only (the transcripts are private). A course's
//   `store` (courses.ts) says where its lessons live: "package" (Define Your Risk, shipped in
//   @darkfactory/academy) or "database" (QuantFinanceToGo, Postgres academy_lesson_specs and
//   academy_lesson_sources, loaded by `bun run vertex:academy:import`). Both answer the same shape.
// - backtest: a MODELED options backtest of one lesson's structure over stored daily bars. Option prices
//   come from Black-Scholes, never from historical quotes; every output says so. Research only.
// - deploy: evaluates the master-rule and owner-cap gates and creates a PAPER deployment request in the
//   existing deployment-requests flow (status "requested", awaiting the owner's approval). A rule
//   conflict needs the owner's password AND a typed explanation naming each broken rule; the override
//   is written to audit_records. Nothing here routes, submits or places orders.

export const ACADEMY_EQUITY_MAX_POINTS = 1000;
export const ACADEMY_TRADES_MAX = 400;

const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u)
  .max(60);
const tickerSchema = z.string().regex(/^[A-Z][A-Z0-9.^-]{0,9}$/u);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const rulesSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,23}$/u), z.number().finite())
  .refine((rules) => Object.keys(rules).length <= 24, "at most 24 rules");

export const AcademyBacktestInputSchema = z
  .object({
    capital: z.number().min(1000).max(1e9).default(100_000),
    end: dateSchema,
    rules: rulesSchema.default({}),
    slug: slugSchema,
    start: dateSchema,
    ticker: tickerSchema,
  })
  .strict();

const point = z.object({ equity: z.number(), t: dateSchema }).strict();

export const AcademyBacktestTradeSchema = z
  .object({
    costs: z.number(),
    entryNet: z.number(),
    entryT: dateSchema,
    exitT: dateSchema,
    exitValue: z.number(),
    legs: z.array(z.string().max(80)).max(8),
    pnl: z.number(),
    reason: z.enum([
      "profit-target",
      "stop",
      "exit-dte",
      "expiry",
      "core-roll",
      "end",
    ]),
    role: z.enum(["position", "cycle", "core"]),
    spotEntry: z.number(),
    spotExit: z.number(),
    units: z.number(),
  })
  .strict();

export const AcademyBacktestStatsSchema = z
  .object({
    avgPnl: z.number(),
    benchmarkMaxDrawdown: z.number().max(0),
    benchmarkReturn: z.number(),
    cagr: z.number(),
    exposure: z.number().min(0).max(1),
    finalEquity: z.number(),
    maxDrawdown: z.number().max(0),
    profitFactor: z.number().nullable(),
    sharpe: z.number(),
    sortino: z.number().nullable(),
    totalReturn: z.number(),
    trades: z.number().int().nonnegative(),
    volatility: z.number().nullable(),
    winRate: z.number().min(0).max(1),
    wins: z.number().int().nonnegative(),
  })
  .strict();

export const AcademyBacktestOutputSchema = z
  .object({
    assumptions: z.array(z.string().max(400)).max(10),
    benchmark: z.array(point).max(ACADEMY_EQUITY_MAX_POINTS),
    /** Engine comparison (dual run) timing and group; absent when comparison is off. */
    comparison: EngineComparisonTimingSchema.optional(),
    data: z
      .object({
        bars: z.number().int(),
        first: dateSchema,
        last: dateSchema,
        source: z.string().max(300),
      })
      .strict(),
    drawdown: z
      .array(z.object({ drawdown: z.number(), t: dateSchema }).strict())
      .max(ACADEMY_EQUITY_MAX_POINTS),
    end: dateSchema,
    equity: z.array(point).max(ACADEMY_EQUITY_MAX_POINTS),
    ivSource: z.enum(["supplied", "rv-model"]),
    modeled: z.literal(true),
    rules: z.record(z.string(), z.number()),
    slug: slugSchema,
    start: dateSchema,
    stats: AcademyBacktestStatsSchema,
    structure: z.string(),
    ticker: tickerSchema,
    trades: z.array(AcademyBacktestTradeSchema).max(ACADEMY_TRADES_MAX),
    tradesTotal: z.number().int().nonnegative(),
  })
  .strict();

export const AcademyTickersOutputSchema = z
  .object({
    tickers: z
      .array(
        z
          .object({
            bars: z.number().int(),
            first: dateSchema,
            last: dateSchema,
            ticker: tickerSchema,
          })
          .strict()
      )
      .max(200),
  })
  .strict();

export const AcademyDeployInputSchema = z
  .object({
    allocationPct: z.number().gt(0).max(100),
    riskPerTradePct: z.number().gt(0).max(100),
    rules: rulesSchema.default({}),
    slug: slugSchema,
    /**
     * Operator-stated NLV. Gates always use the live portfolio feed; when the feed is down, an overridden
     * request is sized from this value and it is recorded in the audit.
     */
    statedNlv: z.number().positive().max(1e10).optional(),
    ticker: tickerSchema,
    tranches: z.number().int().min(1).max(10).default(2),
  })
  .strict();

export const AcademyGateCheckSchema = z
  .object({
    detail: z.string(),
    id: z.string(),
    status: z.enum(["pass", "warn", "conflict"]),
    title: z.string(),
  })
  .strict();

export const AcademyGateOutputSchema = z
  .object({
    checks: z.array(AcademyGateCheckSchema),
    conflicts: z.array(z.string()),
    nlv: z.number().nullable(),
    nlvDetail: z.string().max(300),
    nlvSource: z.enum(["portfolio-monitor", "unavailable"]),
    openPremiumInNameUsd: z.number(),
    otherAllocationsPct: z.number(),
    premiumPerPositionPctNlv: z.number(),
    premiumPerPositionUsd: z.number(),
    rewardRisk: z.number().nullable(),
    statedNlv: z.number().nullable(),
    structure: z.string(),
    /** Max loss of one unit priced at the ticker's last stored close; null without stored bars. */
    unitLossUsd: z.number().nullable(),
    verdict: z.enum(["pass", "blocked"]),
  })
  .strict();

export const AcademyDeployRequestInputSchema = AcademyDeployInputSchema.extend({
  override: z
    .object({
      acknowledged: z.array(z.string().max(32)).max(20),
      explanation: z.string().max(2000),
      password: z.string().min(1).max(256),
    })
    .strict()
    .optional(),
}).strict();

export const AcademyDeployRequestOutputSchema = z
  .object({
    gate: AcademyGateOutputSchema,
    override: z
      .object({
        auditId: z.string().nullable(),
        rules: z.array(z.string()),
        used: z.boolean(),
      })
      .strict(),
    request: z
      .object({
        brokerSubmissionAllowed: z.literal(false),
        executionAuthorized: z.literal(false),
        id: z.string(),
        mode: z.literal("paper"),
        status: z.string(),
        strategyId: z.string(),
        strategySlug: z.string(),
      })
      .strict(),
  })
  .strict();

const courseSchema = z.enum(COURSE_IDS);
export const ACADEMY_LESSONS_MAX = 500;

export const AcademyLessonsInputSchema = z
  .object({ course: courseSchema })
  .strict();

/** A lesson card of a course gallery (LessonSummary of @darkfactory/academy). */
export const AcademyLessonSummarySchema = z
  .object({
    course: courseSchema,
    kind: LessonSpecSchema.shape.kind,
    publishedAt: z.string(),
    sceneType: z.enum(
      Object.keys(SCENE_ELEMENTS) as [SceneType, ...SceneType[]]
    ),
    slug: slugSchema,
    structure: z.enum(STRUCTURES).nullable(),
    summary: z.string(),
    tags: LessonSpecSchema.shape.tags,
    title: z.string(),
  })
  .strict();

export const AcademyLessonsOutputSchema = z
  .object({
    course: courseSchema,
    /** Newest source first. */
    lessons: z.array(AcademyLessonSummarySchema).max(ACADEMY_LESSONS_MAX),
    /** Knowledge-base videos of the course, not counting recorded exact duplicates. */
    sourceCount: z.number().int().nonnegative(),
  })
  .strict();

export const AcademyLessonInputSchema = z.object({ slug: slugSchema }).strict();

const lessonLinkSchema = z
  .object({ slug: slugSchema, title: z.string() })
  .strict();

/** One lesson: its spec (the page builds its chart from it), its source and its course neighbours. */
export const AcademyLessonOutputSchema = z
  .object({
    next: lessonLinkSchema.nullable(),
    previous: lessonLinkSchema.nullable(),
    source: LessonSourceSchema,
    spec: LessonSpecSchema,
  })
  .strict();

export const ACADEMY_ERRORS = {
  BAD_REQUEST: { message: "Invalid Academy request", status: 400 },
  CONFLICT: { message: "Request conflicts with a rule gate", status: 409 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "Lesson or data not found", status: 404 },
  STORAGE_ERROR: {
    message: "Academy storage request failed. Nothing was changed. Try again.",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const academy = oc.errors(ACADEMY_ERRORS);

const lessons = academy
  .route({
    method: "GET",
    operationId: "academy.lessons",
    path: "/academy/lessons",
    summary: "List the lessons of one Academy course (operator-only)",
    tags: ["Academy"],
  })
  .input(AcademyLessonsInputSchema)
  .output(AcademyLessonsOutputSchema);

const lesson = academy
  .route({
    method: "GET",
    operationId: "academy.lesson",
    path: "/academy/lessons/{slug}",
    summary:
      "Read one Academy lesson with its knowledge-base source and course neighbours (operator-only)",
    tags: ["Academy"],
  })
  .input(AcademyLessonInputSchema)
  .output(AcademyLessonOutputSchema);

const tickers = academy
  .route({
    method: "GET",
    operationId: "academy.tickers",
    path: "/academy/tickers",
    summary: "List stored daily bar series usable by Academy backtests",
    tags: ["Academy"],
  })
  .output(AcademyTickersOutputSchema);

const backtest = academy
  .route({
    method: "POST",
    operationId: "academy.backtest",
    path: "/academy/backtest",
    summary:
      "Run a MODELED options backtest of a lesson structure over stored daily bars (research only)",
    tags: ["Academy"],
  })
  .input(AcademyBacktestInputSchema)
  .output(AcademyBacktestOutputSchema);

const deployPreview = academy
  .route({
    method: "POST",
    operationId: "academy.deployPreview",
    path: "/academy/deploy/preview",
    summary:
      "Evaluate the master-rule and owner-cap gates for a lesson deployment (no writes)",
    tags: ["Academy"],
  })
  .input(AcademyDeployInputSchema)
  .output(AcademyGateOutputSchema);

const deployRequest = academy
  .route({
    method: "POST",
    operationId: "academy.deployRequest",
    path: "/academy/deploy/request",
    summary:
      "Create a PAPER deployment request for a lesson strategy; rule overrides need the owner's password and an audited explanation",
    tags: ["Academy"],
  })
  .input(AcademyDeployRequestInputSchema)
  .output(AcademyDeployRequestOutputSchema);

export const academyContract = {
  backtest,
  deployPreview,
  deployRequest,
  lesson,
  lessons,
  tickers,
};

export type AcademyLessonsOutput = z.infer<typeof AcademyLessonsOutputSchema>;
export type AcademyLessonOutput = z.infer<typeof AcademyLessonOutputSchema>;
export type AcademyBacktestInput = z.input<typeof AcademyBacktestInputSchema>;
export type AcademyBacktestOutput = z.infer<typeof AcademyBacktestOutputSchema>;
export type AcademyTickersOutput = z.infer<typeof AcademyTickersOutputSchema>;
export type AcademyDeployInput = z.input<typeof AcademyDeployInputSchema>;
export type AcademyGateOutput = z.infer<typeof AcademyGateOutputSchema>;
export type AcademyDeployRequestInput = z.input<
  typeof AcademyDeployRequestInputSchema
>;
export type AcademyDeployRequestParsedInput = z.infer<
  typeof AcademyDeployRequestInputSchema
>;
export type AcademyDeployRequestOutput = z.infer<
  typeof AcademyDeployRequestOutputSchema
>;
