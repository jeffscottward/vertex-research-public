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

/** A qc-port spec path; the captured slug is the study id (and the strategy library slug). */
export const QC_PORT_SPEC_PATTERN =
  /^docs\/specs\/strategies\/(qc-[a-z0-9-]+)\.md$/u;

/**
 * The pre-registered pass rule, stored with the study so the verdict can be recomputed. All
 * bounds are strict: the primary run (runs[0]) passes when its Sharpe is above minSharpe, its
 * deflated Sharpe is above minDeflatedSharpe, its drawdown magnitude is below maxDrawdown and,
 * with beatBaseline, its Sharpe is above the Sharpe of runs[1] (a baseline without a Sharpe is
 * beaten by any primary Sharpe).
 */
export const QcPortCriteriaSchema = z
  .object({
    beatBaseline: z.boolean(),
    maxDrawdown: z.number().gt(0).max(1),
    minDeflatedSharpe: Fraction,
    minSharpe: z.number(),
  })
  .strict();
export type QcPortCriteria = z.infer<typeof QcPortCriteriaSchema>;

/** Where a qc-port study came from, so a stored result can be traced and re-run. */
export const QcPortProvenanceSchema = z
  .object({
    // Full git commit SHA of the code that ran the study.
    codeRevision: z.string().regex(/^[0-9a-f]{40}$/u),
    // SHA-256 of the input data manifest.
    dataSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    // Backtest engine and version, for example "nautilus_trader 1.221.0".
    engine: z.string().min(1).max(120),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u),
  })
  .strict();
export type QcPortProvenance = z.infer<typeof QcPortProvenanceSchema>;

/** The verdict the criteria give for these runs (runs[0] is the primary run, runs[1] the baseline). */
export const qcPortVerdict = (
  runs: readonly QcPortRun[],
  criteria: QcPortCriteria
): "PASS" | "FAIL" => {
  const [primary, baseline] = runs;
  if (primary === undefined) return "FAIL";
  const { deflatedSharpe, maxDrawdown, sharpe } = primary;
  const passes =
    sharpe !== null &&
    sharpe > criteria.minSharpe &&
    deflatedSharpe !== null &&
    deflatedSharpe > criteria.minDeflatedSharpe &&
    Math.abs(maxDrawdown) < criteria.maxDrawdown &&
    (!criteria.beatBaseline ||
      baseline?.sharpe === null ||
      (baseline !== undefined && sharpe > baseline.sharpe));
  return passes ? "PASS" : "FAIL";
};

/**
 * One qc-port backtest study: the pre-registered spec, its runs, a monthly equity curve (oldest
 * first) and, for reusable gates, the before/after effect on each host strategy. Option prices in
 * these studies are MODELED (Black-Scholes on CBOE vol-index proxies), not quoted. The schema
 * recomputes the verdict from runs and criteria and rejects a document whose verdict differs.
 */
export const QcPortStudySchema = z
  .object({
    criteria: QcPortCriteriaSchema,
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
    provenance: QcPortProvenanceSchema,
    ran: DateText,
    runs: z.array(QcPortRunSchema).min(1).max(QC_PORT_RUNS_MAX),
    spec: z.string().regex(QC_PORT_SPEC_PATTERN).max(RESEARCH_STUDY_SPEC_MAX),
    title: z.string().min(1).max(200),
    verdict: z.enum(["PASS", "FAIL"]),
  })
  .strict()
  .superRefine((study, context) => {
    const slug = QC_PORT_SPEC_PATTERN.exec(study.spec)?.[1];
    if (slug !== study.id)
      context.addIssue({
        code: "custom",
        message: `Expected id to equal the spec slug ${slug}`,
        path: ["id"],
      });
    if (study.criteria.beatBaseline && study.runs.length < 2) {
      context.addIssue({
        code: "custom",
        message: "beatBaseline needs a baseline run (runs[1])",
        path: ["runs"],
      });
      return;
    }
    const expected = qcPortVerdict(study.runs, study.criteria);
    if (study.verdict !== expected)
      context.addIssue({
        code: "custom",
        message: `Expected verdict ${expected}: runs[0] against the stored criteria`,
        path: ["verdict"],
      });
  });
export type QcPortStudy = z.infer<typeof QcPortStudySchema>;

export const STRATEGY_BACKTEST_STUDY_KIND = "strategy-backtest";
export const STRATEGY_BACKTEST_RULES_MAX = 30;
export const STRATEGY_BACKTEST_GAPS_MAX = 30;
export const STRATEGY_BACKTEST_FORMS_MAX = 4;
// Runs per form: one study may hold several strategies on many markets (5 strategies x 14 markets).
export const STRATEGY_BACKTEST_RUNS_MAX = 80;
export const STRATEGY_BACKTEST_ROBUSTNESS_MAX = 20;
export const STRATEGY_BACKTEST_SENSITIVITY_MAX = 80;
export const STRATEGY_BACKTEST_COMPARISON_MAX = 30;
export const STRATEGY_BACKTEST_EQUITY_MAX = 400;
export const STRATEGY_BACKTEST_NOTES_MAX = 4000;

/** A strategy spec path; the captured slug is the study id (and the strategy library slug). */
export const STRATEGY_BACKTEST_SPEC_PATTERN =
  /^docs\/specs\/strategies\/([a-z0-9-]+)\.md$/u;

/** Non-empty text without leading or trailing whitespace, at most `max` characters. */
const Trimmed = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (text) => text.trim() === text,
      "Expected no leading or trailing whitespace"
    );
// A drawdown of a strategy-backtest study: a negative fraction, or 0 for none.
const Loss = z.number().min(-1).max(0);
// A compound annual growth rate cannot lose more than everything.
const Cagr = z.number().min(-1);

/** One backtest run of one form of the strategy on one symbol. */
export const StrategyBacktestRunSchema = z
  .object({
    buyHoldCagr: Cagr.nullable(),
    buyHoldSharpe: z.number().nullable(),
    cagr: Cagr,
    exposure: Fraction,
    from: DateText,
    market: Trimmed(60),
    maxDrawdown: Loss,
    // Out-of-sample results (the later part of a time split); null when the run has no out-of-sample part.
    oosCagr: Cagr.nullable(),
    oosSharpe: z.number().nullable(),
    // Null when the run has no losing trade.
    profitFactor: z.number().nonnegative().nullable(),
    sharpe: z.number(),
    symbol: Trimmed(40),
    to: DateText,
    trades: z.number().int().nonnegative(),
    winRate: Fraction,
  })
  .strict()
  .refine((run) => run.from <= run.to, {
    message: "Expected from on or before to",
    path: ["to"],
  });
export type StrategyBacktestRun = z.infer<typeof StrategyBacktestRunSchema>;

/** One way of trading the strategy: as stated on the underlying, or the Vertex options form. */
export const StrategyBacktestFormSchema = z
  .object({
    description: Trimmed(600),
    key: z.enum(["underlying", "options"]),
    label: Trimmed(120),
    runs: z
      .array(StrategyBacktestRunSchema)
      .min(1)
      .max(STRATEGY_BACKTEST_RUNS_MAX),
  })
  .strict();
export type StrategyBacktestForm = z.infer<typeof StrategyBacktestFormSchema>;

/** Where a strategy-backtest study came from, so a stored result can be traced and re-run. */
export const StrategyBacktestProvenanceSchema = z
  .object({
    // Git commit SHA (7 to 40 hex characters) of the code that ran the study.
    commit: z.string().regex(/^[0-9a-f]{7,40}$/u),
    // Hash of the input data, for example "sha256:3f1c…".
    dataHash: Trimmed(80),
    // Backtest engine and version, for example "nautilus_trader 1.221.0".
    engine: Trimmed(80),
    runId: Trimmed(80),
  })
  .strict();
export type StrategyBacktestProvenance = z.infer<
  typeof StrategyBacktestProvenanceSchema
>;

/**
 * One strategy backtest study, for example a strategy taken from a video: the rules as stated with
 * their source, the gaps and the defaults chosen, the backtest runs of each form (as stated and the
 * Vertex options form), robustness checks, parameter sensitivity, a comparison with buy-and-hold and
 * library strategies, and a monthly equity and drawdown curve. Numbers are fractions (0.12 = 12 %);
 * drawdowns are negative fractions or 0. The verdict is the researcher's (edge, no edge or needs
 * more data); it grants no trading authority.
 */
export const StrategyBacktestStudySchema = z
  .object({
    comparison: z
      .array(
        z
          .object({
            cagr: Cagr,
            kind: z.enum(["buy-and-hold", "library", "strategy"]),
            maxDrawdown: Loss,
            name: Trimmed(80),
            sharpe: z.number(),
          })
          .strict()
      )
      .max(STRATEGY_BACKTEST_COMPARISON_MAX),
    equity: z
      .array(
        z
          .object({
            drawdown: Loss,
            month: MonthText,
            // Return since the start (0 = the starting equity).
            value: z.number().min(-1),
          })
          .strict()
      )
      .min(2)
      .max(STRATEGY_BACKTEST_EQUITY_MAX)
      .refine(
        (points) =>
          points.every(
            (point, index) =>
              index === 0 ||
              (points[index - 1] as typeof point).month < point.month
          ),
        "Expected equity months in increasing order"
      ),
    equityLabel: Trimmed(200),
    forms: z
      .array(StrategyBacktestFormSchema)
      .min(1)
      .max(STRATEGY_BACKTEST_FORMS_MAX)
      .refine(
        (forms) => new Set(forms.map((form) => form.key)).size === forms.length,
        "Expected each form key once"
      ),
    gaps: z
      .array(z.object({ choice: Trimmed(400), gap: Trimmed(300) }).strict())
      .max(STRATEGY_BACKTEST_GAPS_MAX),
    id: ResearchStudyIdSchema,
    kind: z.literal(STRATEGY_BACKTEST_STUDY_KIND),
    notes: z.string().max(STRATEGY_BACKTEST_NOTES_MAX),
    provenance: StrategyBacktestProvenanceSchema,
    ran: DateText,
    robustness: z
      .array(
        z
          .object({
            check: Trimmed(80),
            // null: informational, neither a pass nor a fail.
            pass: z.boolean().nullable(),
            result: Trimmed(300),
          })
          .strict()
      )
      .max(STRATEGY_BACKTEST_ROBUSTNESS_MAX),
    rules: z
      .array(
        z
          .object({
            item: Trimmed(60),
            rule: Trimmed(400),
            source: Trimmed(200),
          })
          .strict()
      )
      .min(1)
      .max(STRATEGY_BACKTEST_RULES_MAX),
    sensitivity: z
      .array(
        z
          .object({
            cagr: Cagr,
            maxDrawdown: Loss,
            param: Trimmed(60),
            sharpe: z.number(),
            trades: z.number().int().nonnegative(),
            value: Trimmed(40),
          })
          .strict()
      )
      .max(STRATEGY_BACKTEST_SENSITIVITY_MAX),
    source: z
      .object({
        label: Trimmed(200),
        url: z.url({ protocol: /^https$/u }).max(300),
      })
      .strict(),
    spec: z
      .string()
      .regex(STRATEGY_BACKTEST_SPEC_PATTERN)
      .max(RESEARCH_STUDY_SPEC_MAX),
    title: Trimmed(200),
    verdict: z.enum(["edge", "no-edge", "needs-more-data"]),
    verdictReason: Trimmed(1000),
  })
  .strict()
  .superRefine((study, context) => {
    const slug = STRATEGY_BACKTEST_SPEC_PATTERN.exec(study.spec)?.[1];
    if (slug !== study.id)
      context.addIssue({
        code: "custom",
        message: `Expected id to equal the spec slug ${slug}`,
        path: ["id"],
      });
  });
export type StrategyBacktestStudy = z.infer<typeof StrategyBacktestStudySchema>;

/** Any stored study document; `kind` selects the schema (absent means a filter study). */
export const ResearchStudyDocumentSchema = z.discriminatedUnion("kind", [
  QcPortStudySchema,
  StrategyBacktestStudySchema,
  FilterStudySchema,
]);
export type ResearchStudyDocument = z.infer<typeof ResearchStudyDocumentSchema>;

export const isQcPortStudy = (
  study: ResearchStudyDocument
): study is QcPortStudy => study.kind === QC_PORT_STUDY_KIND;

export const isStrategyBacktestStudy = (
  study: ResearchStudyDocument
): study is StrategyBacktestStudy =>
  study.kind === STRATEGY_BACKTEST_STUDY_KIND;

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
