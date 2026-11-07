import { oc } from "@orpc/contract";
import { z } from "zod";

// Research studies (researchStudies.get): frozen filter studies such as the ADX/RVOL study shown on the
// /backtests page (docs/specs/research/adx-filter.md). The study document lives in Postgres
// (research_studies.summary). It is written by `bun run vertex:research-studies:import`, never through
// oRPC. The web app, the API service and the import CLI share FilterStudySchema, so a document is
// checked when it is stored and again when it is read. Research only: a study result grants no trading
// authority.

export const RESEARCH_STUDY_ID_MAX = 64;
/** Lowercase words joined by single hyphens, for example `adx-rvol-filters`. */
export const RESEARCH_STUDY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const RESEARCH_STUDY_SPEC_MAX = 300;
/** Largest stored study document, in bytes of compact JSON (the database checks the same cap). */
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
const DateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

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
    ran: DateText,
    spec: z.string().min(1).max(RESEARCH_STUDY_SPEC_MAX),
  })
  .strict();
export type FilterStudy = z.infer<typeof FilterStudySchema>;

export const ResearchStudyGetInputSchema = z
  .object({ id: ResearchStudyIdSchema })
  .strict();
export type ResearchStudyGetInput = z.infer<typeof ResearchStudyGetInputSchema>;

export const ResearchStudySchema = z.object({
  id: ResearchStudyIdSchema,
  study: FilterStudySchema,
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
      "Get one frozen research study (for example the ADX/RVOL filter study)",
    tags: ["Research Studies"],
  })
  .input(ResearchStudyGetInputSchema)
  .output(ResearchStudySchema);

export const researchStudiesContract = { get };
