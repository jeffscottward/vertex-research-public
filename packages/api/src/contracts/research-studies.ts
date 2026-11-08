import { oc } from "@orpc/contract";
import { z } from "zod";

// Research studies (researchStudies.get): frozen research documents in Postgres
// (research_studies.summary). Two kinds share the table, told apart by the document's `kind`:
// - filter studies such as the ADX/RVOL study on the /backtests page (docs/specs/research/adx-filter.md).
//   They carry no `kind` (the seeded document predates it) or `kind: "filter"`.
// - `kind: "qc-port"` backtest studies of the QuantConnect idea ports (docs/specs/strategies/qc-*.md),
//   shown on the strategy library detail of the entry whose slug is the study id.
// Documents are written by `bun run vertex:research-studies:import`, never through oRPC. The web app,
// the API service and the import CLI share ResearchStudyDocumentSchema, so a document is checked when
// it is stored and again when it is read. Research only: a study result grants no trading authority.

export const RESEARCH_STUDY_ID_MAX = 64;
/** Lowercase words joined by single hyphens, for example `adx-rvol-filters`. */
export const RESEARCH_STUDY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const RESEARCH_STUDY_SPEC_MAX = 300;
/**
 * Largest study document, in bytes of compact JSON. The database cap is 320 KiB of jsonb text, which
 * is longer (a space after every ',' and ':'), so a document under this cap always fits.
 */
export const RESEARCH_STUDY_SUMMARY_MAX_BYTES = 262_144;

export const RESEARCH_STUDY_API_ERRORS = {
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "Research study not found", status: 404 },
  STORAGE_ERROR: { message: "Research study storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

export const ResearchStudyIdSchema = z
  .string()
  .min(1)
  .max(RESEARCH_STUDY_ID_MAX)
  .regex(RESEARCH_STUDY_ID_PATTERN);

const Ratio = z.number().nullable();
const Halves = z.tuple([Ratio, Ratio]);
const VariantMetrics = {
  cagr: z.number(),
  maxDrawdown: z.number(),
  sharpe: Ratio,
  sharpeHalves: Halves,
  trades: z.number().int().nonnegative(),
  tradesPerYear: z.number().nonnegative(),
};
// A real calendar date: 2026-02-30 matches the pattern but not a day, and Postgres rejects it.
const DateText = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((text) => {
    const day = new Date(`${text}T00:00:00.000Z`);
    return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(text);
  }, "Expected a calendar date");

/** One filter study document, as printed by services/research/strategies/filter_study_summary.py. */
export const FilterStudySchema = z
  .object({
    daily: z.object({
      costBpsPerSide: z.number(),
      trials: z.number().int().positive(),
      universe: z.array(z.string()).min(1),
      variants: z
        .array(
          z.object({
            ...VariantMetrics,
            deflatedProbability: Ratio,
            filter: z.enum(["none", "adx_above", "adx_below", "adx_falling"]),
            strategy: z.string(),
            verdict: z.string().nullable(),
          })
        )
        .min(1),
      window: z.object({
        days: z.number().int().positive(),
        end: DateText,
        secondHalfStart: DateText,
        start: DateText,
      }),
    }),
    id: ResearchStudyIdSchema,
    intraday: z.object({
      barMinutes: z.number().int().positive(),
      costBpsPerSide: z.number(),
      sensitivity: z.object({
        costBpsPerSide: z.number(),
        verdict: z.string(),
      }),
      spearman: z.object({ firstHalf: Ratio, secondHalf: Ratio }),
      symbol: z.string(),
      variants: z
        .array(
          z.object({
            ...VariantMetrics,
            filter: z.enum(["none", "rvol_above_1"]),
          })
        )
        .min(1),
      verdict: z.string(),
      window: z.object({
        end: DateText,
        secondHalfStart: DateText,
        sessions: z.number().int().positive(),
        start: DateText,
      }),
    }),
    // Absent on the seeded ADX/RVOL document; an absent kind means a filter study.
    kind: z.literal("filter").optional(),
    ran: DateText,
    spec: z.string().min(1).max(RESEARCH_STUDY_SPEC_MAX),
  })
  .strict();
export type FilterStudy = z.infer<typeof FilterStudySchema>;

export const QC_PORT_STUDY_KIND = "qc-port";
/** Most monthly equity points stored for one qc-port study (about 33 years). */
export const QC_PORT_EQUITY_MAX = 400;
export const QC_PORT_RUNS_MAX = 40;
export const QC_PORT_GATES_MAX = 40;
export const QC_PORT_NOTES_MAX = 4000;

// A calendar month, for example 2026-10.
const MonthText = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);
const Fraction = z.number().min(0).max(1);
// Drawdowns are stored as printed (the qc-ports runner prints -0.21, the filter study 0.21); the
// web shows the magnitude.
const Drawdown = z.number().min(-1).max(1);
const Label = z.string().min(1).max(120);

const QcPortGateMetricsSchema = z
  .object({
    maxDrawdown: Drawdown,
    sharpe: Ratio,
    trades: z.number().int().nonnegative(),
  })
  .strict();

/** One backtest run of a qc-port study (one configuration on one symbol set). */
export const QcPortRunSchema = z
  .object({
    cagr: Ratio,
    deflatedSharpe: Fraction.nullable(),
    exposure: Fraction,
    maxDrawdown: Drawdown,
    name: Label,
    sharpe: Ratio,
    skipped: z.number().int().nonnegative(),
    symbols: z.array(z.string().min(1).max(16)).min(1).max(40),
    trades: z.number().int().nonnegative(),
    winRate: Fraction.nullable(),
    // Null when the run spans no complete month.
    worstMonth: z
      .object({ month: MonthText, ret: z.number() })
      .strict()
      .nullable(),
  })
  .strict();
export type QcPortRun = z.infer<typeof QcPortRunSchema>;

/**
 * One qc-port backtest study: the pre-registered spec, its runs, a monthly equity curve (oldest
 * first) and, for reusable gates, the before/after effect on each host strategy. Option prices in
 * these studies are MODELED (Black-Scholes on CBOE vol-index proxies), not quoted.
 */
export const QcPortStudySchema = z
  .object({
    equity: z
      .array(z.object({ t: MonthText, v: z.number().positive() }).strict())
      .max(QC_PORT_EQUITY_MAX)
      .refine(
        (points) =>
          points.every(
            (point, index) =>
              index === 0 || (points[index - 1] as typeof point).t < point.t
          ),
        "Expected equity months in increasing order"
      ),
    gates: z
      .array(
        z
          .object({
            after: QcPortGateMetricsSchema,
            before: QcPortGateMetricsSchema,
            gate: Label,
            host: Label,
          })
          .strict()
      )
      .max(QC_PORT_GATES_MAX)
      .optional(),
    id: ResearchStudyIdSchema,
    kind: z.literal(QC_PORT_STUDY_KIND),
    notes: z.string().max(QC_PORT_NOTES_MAX),
    ran: DateText,
    runs: z.array(QcPortRunSchema).min(1).max(QC_PORT_RUNS_MAX),
    spec: z.string().min(1).max(RESEARCH_STUDY_SPEC_MAX),
    title: z.string().min(1).max(200),
    verdict: z.enum(["PASS", "FAIL"]),
  })
  .strict();
export type QcPortStudy = z.infer<typeof QcPortStudySchema>;

/** Any stored study document; `kind` selects the schema (absent means a filter study). */
export const ResearchStudyDocumentSchema = z.discriminatedUnion("kind", [
  QcPortStudySchema,
  FilterStudySchema,
]);
export type ResearchStudyDocument = z.infer<typeof ResearchStudyDocumentSchema>;

export const isQcPortStudy = (
  study: ResearchStudyDocument
): study is QcPortStudy => study.kind === QC_PORT_STUDY_KIND;

export const ResearchStudyGetInputSchema = z
  .object({ id: ResearchStudyIdSchema })
  .strict();
export type ResearchStudyGetInput = z.infer<typeof ResearchStudyGetInputSchema>;

export const ResearchStudySchema = z.object({
  id: ResearchStudyIdSchema,
  study: ResearchStudyDocumentSchema,
  updatedAt: z.date(),
});
export type ResearchStudy = z.infer<typeof ResearchStudySchema>;

const get = oc
  .errors(RESEARCH_STUDY_API_ERRORS)
  .route({
    method: "GET",
    operationId: "researchStudies.get",
    path: "/research-studies/{id}",
    summary:
      "Get one frozen research study (a filter study such as ADX/RVOL, or a qc-port backtest study)",
    tags: ["Research Studies"],
  })
  .input(ResearchStudyGetInputSchema)
  .output(ResearchStudySchema);

export const researchStudiesContract = { get };
