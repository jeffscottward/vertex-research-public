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
    slug: slugSchema,
    ticker: tickerSchema,
    start: dateSchema,
    end: dateSchema,
    rules: rulesSchema.default({}),
    capital: z.number().min(1000).max(1e9).default(100_000),
  })
  .strict();

const point = z.object({ t: dateSchema, equity: z.number() }).strict();

export const AcademyBacktestTradeSchema = z
  .object({
    entryT: dateSchema,
    exitT: dateSchema,
    role: z.enum(["position", "cycle", "core"]),
    legs: z.array(z.string().max(80)).max(8),
    units: z.number(),
    spotEntry: z.number(),
    spotExit: z.number(),
    entryNet: z.number(),
    exitValue: z.number(),
    costs: z.number(),
    pnl: z.number(),
    reason: z.enum([
      "profit-target",
      "stop",
      "exit-dte",
      "expiry",
      "core-roll",
      "end",
    ]),
  })
  .strict();

export const AcademyBacktestStatsSchema = z
  .object({
    totalReturn: z.number(),
    cagr: z.number(),
    maxDrawdown: z.number().max(0),
    sharpe: z.number(),
    sortino: z.number().nullable(),
    volatility: z.number().nullable(),
    winRate: z.number().min(0).max(1),
    trades: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
    avgPnl: z.number(),
    profitFactor: z.number().nullable(),
    exposure: z.number().min(0).max(1),
    finalEquity: z.number(),
    benchmarkReturn: z.number(),
    benchmarkMaxDrawdown: z.number().max(0),
  })
  .strict();

export const AcademyBacktestOutputSchema = z
  .object({
    slug: slugSchema,
    ticker: tickerSchema,
    structure: z.string(),
    start: dateSchema,
    end: dateSchema,
    modeled: z.literal(true),
    ivSource: z.enum(["supplied", "rv-model"]),
    assumptions: z.array(z.string().max(400)).max(10),
    rules: z.record(z.string(), z.number()),
    equity: z.array(point).max(ACADEMY_EQUITY_MAX_POINTS),
    benchmark: z.array(point).max(ACADEMY_EQUITY_MAX_POINTS),
    drawdown: z
      .array(z.object({ t: dateSchema, drawdown: z.number() }).strict())
      .max(ACADEMY_EQUITY_MAX_POINTS),
    trades: z.array(AcademyBacktestTradeSchema).max(ACADEMY_TRADES_MAX),
    tradesTotal: z.number().int().nonnegative(),
    stats: AcademyBacktestStatsSchema,
    data: z
      .object({
        source: z.string().max(300),
        bars: z.number().int(),
        first: dateSchema,
        last: dateSchema,
      })
      .strict(),
  })
  .strict();

export const AcademyTickersOutputSchema = z
  .object({
    tickers: z
      .array(
        z
          .object({
            ticker: tickerSchema,
            first: dateSchema,
            last: dateSchema,
            bars: z.number().int(),
          })
          .strict()
      )
      .max(200),
  })
  .strict();

export const AcademyDeployInputSchema = z
  .object({
    slug: slugSchema,
    ticker: tickerSchema,
    allocationPct: z.number().gt(0).max(100),
    riskPerTradePct: z.number().gt(0).max(100),
    tranches: z.number().int().min(1).max(10).default(2),
    rules: rulesSchema.default({}),
    /**
     * Operator-stated NLV. Gates always use the live portfolio feed; when the feed is down, an overridden
     * request is sized from this value and it is recorded in the audit.
     */
    statedNlv: z.number().positive().max(1e10).optional(),
  })
  .strict();

export const AcademyGateCheckSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["pass", "warn", "conflict"]),
    detail: z.string(),
  })
  .strict();

export const AcademyGateOutputSchema = z
  .object({
    verdict: z.enum(["pass", "blocked"]),
    checks: z.array(AcademyGateCheckSchema),
    conflicts: z.array(z.string()),
    premiumPerPositionUsd: z.number(),
    premiumPerPositionPctNlv: z.number(),
    rewardRisk: z.number().nullable(),
    nlv: z.number().nullable(),
    nlvSource: z.enum(["portfolio-monitor", "unavailable"]),
    nlvDetail: z.string().max(300),
    statedNlv: z.number().nullable(),
    openPremiumInNameUsd: z.number(),
    otherAllocationsPct: z.number(),
    /** Max loss of one unit priced at the ticker's last stored close; null without stored bars. */
    unitLossUsd: z.number().nullable(),
    structure: z.string(),
  })
  .strict();

export const AcademyDeployRequestInputSchema = AcademyDeployInputSchema.extend({
  override: z
    .object({
      password: z.string().min(1).max(256),
      acknowledged: z.array(z.string().max(32)).max(20),
      explanation: z.string().max(2000),
    })
    .strict()
    .optional(),
}).strict();

export const AcademyDeployRequestOutputSchema = z
  .object({
    gate: AcademyGateOutputSchema,
    request: z
      .object({
        id: z.string(),
        status: z.string(),
        strategyId: z.string(),
        strategySlug: z.string(),
        mode: z.literal("paper"),
        executionAuthorized: z.literal(false),
        brokerSubmissionAllowed: z.literal(false),
      })
      .strict(),
    override: z
      .object({
        used: z.boolean(),
        auditId: z.string().nullable(),
        rules: z.array(z.string()),
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
    slug: slugSchema,
    title: z.string(),
    summary: z.string(),
    kind: LessonSpecSchema.shape.kind,
    tags: LessonSpecSchema.shape.tags,
    sceneType: z.enum(
      Object.keys(SCENE_ELEMENTS) as [SceneType, ...SceneType[]]
    ),
    structure: z.enum(STRUCTURES).nullable(),
    publishedAt: z.string(),
  })
  .strict();

export const AcademyLessonsOutputSchema = z
  .object({
    course: courseSchema,
    /** Knowledge-base videos of the course, not counting recorded exact duplicates. */
    sourceCount: z.number().int().nonnegative(),
    /** Newest source first. */
    lessons: z.array(AcademyLessonSummarySchema).max(ACADEMY_LESSONS_MAX),
  })
  .strict();

export const AcademyLessonInputSchema = z.object({ slug: slugSchema }).strict();

const lessonLinkSchema = z
  .object({ slug: slugSchema, title: z.string() })
  .strict();

/** One lesson: its spec (the page builds its chart from it), its source and its course neighbours. */
export const AcademyLessonOutputSchema = z
  .object({
    spec: LessonSpecSchema,
    source: LessonSourceSchema,
    previous: lessonLinkSchema.nullable(),
    next: lessonLinkSchema.nullable(),
  })
  .strict();

export const ACADEMY_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Invalid Academy request" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: { status: 404, message: "Lesson or data not found" },
  CONFLICT: { status: 409, message: "Request conflicts with a rule gate" },
  STORAGE_ERROR: { status: 503, message: "Academy storage unavailable" },
} as const;

const academy = oc.errors(ACADEMY_ERRORS);

const lessons = academy
  .route({
    method: "GET",
    path: "/academy/lessons",
    operationId: "academy.lessons",
    summary: "List the lessons of one Academy course (operator-only)",
    tags: ["Academy"],
  })
  .input(AcademyLessonsInputSchema)
  .output(AcademyLessonsOutputSchema);

const lesson = academy
  .route({
    method: "GET",
    path: "/academy/lessons/{slug}",
    operationId: "academy.lesson",
    summary:
      "Read one Academy lesson with its knowledge-base source and course neighbours (operator-only)",
    tags: ["Academy"],
  })
  .input(AcademyLessonInputSchema)
  .output(AcademyLessonOutputSchema);

const tickers = academy
  .route({
    method: "GET",
    path: "/academy/tickers",
    operationId: "academy.tickers",
    summary: "List stored daily bar series usable by Academy backtests",
    tags: ["Academy"],
  })
  .output(AcademyTickersOutputSchema);

const backtest = academy
  .route({
    method: "POST",
    path: "/academy/backtest",
    operationId: "academy.backtest",
    summary:
      "Run a MODELED options backtest of a lesson structure over stored daily bars (research only)",
    tags: ["Academy"],
  })
  .input(AcademyBacktestInputSchema)
  .output(AcademyBacktestOutputSchema);

const deployPreview = academy
  .route({
    method: "POST",
    path: "/academy/deploy/preview",
    operationId: "academy.deployPreview",
    summary:
      "Evaluate the master-rule and owner-cap gates for a lesson deployment (no writes)",
    tags: ["Academy"],
  })
  .input(AcademyDeployInputSchema)
  .output(AcademyGateOutputSchema);

const deployRequest = academy
  .route({
    method: "POST",
    path: "/academy/deploy/request",
    operationId: "academy.deployRequest",
    summary:
      "Create a PAPER deployment request for a lesson strategy; rule overrides need the owner's password and an audited explanation",
    tags: ["Academy"],
  })
  .input(AcademyDeployRequestInputSchema)
  .output(AcademyDeployRequestOutputSchema);

export const academyContract = {
  lessons,
  lesson,
  tickers,
  backtest,
  deployPreview,
  deployRequest,
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
