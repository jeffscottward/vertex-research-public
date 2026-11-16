import { oc } from "@orpc/contract";
import { z } from "zod";

// Research dossiers moved from the vertex-research workspace (merge plan P1): the 58-report
// catalog, each report's datasets by revision, and the accepted company-research layer.
// Read-only and operator-only. Rows are written by the local importer
// (`bun run vertex:research-reports:import`), never through oRPC. The `portfolio` dataset holds
// private broker data and is never stored or served. Research only: no trading permission.

export const RESEARCH_REPORT_PUBLIC_DATASETS = [
  "market",
  "fundamentals",
  "news",
  "technicals",
  "options-analysis",
  "committee",
] as const;
export const RESEARCH_REPORTS_MAX = 200;
export const RESEARCH_REPORT_CATEGORIES_MAX = 100;
export const RESEARCH_REPORT_REVISIONS_MAX = 100;

export const RESEARCH_REPORTS_API_ERRORS = {
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "Research report not found", status: 404 },
  STORAGE_ERROR: {
    message: "Research report storage unavailable",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const ReportIdSchema = z.string().regex(/^[A-Z0-9]{1,10}$/u);
const RevisionSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const ResearchReportDatasetNameSchema = z.enum(
  RESEARCH_REPORT_PUBLIC_DATASETS
);
export type ResearchReportDatasetName = z.infer<
  typeof ResearchReportDatasetNameSchema
>;

export const ResearchReportSummarySchema = z.object({
  assetType: z.string().nullable(),
  companyResearch: z
    .object({
      acceptedAt: z.date(),
      reportRevision: RevisionSchema.nullable(),
      revision: RevisionSchema,
    })
    .nullable(),
  currency: z.string().nullable(),
  dataRevision: RevisionSchema,
  exchange: z.string().nullable(),
  id: ReportIdSchema,
  identityStatus: z.string(),
  importedAt: z.date(),
  name: z.string(),
  providerSymbol: z.string(),
  sourceUpdatedAt: z.date().nullable(),
  status: z.string(),
  symbol: z.string(),
});
export type ResearchReportSummary = z.infer<typeof ResearchReportSummarySchema>;

export const ResearchReportCategorySchema = z.object({
  description: z.string(),
  id: z.string().min(1).max(80),
  label: z.string(),
  reportIds: z.array(ReportIdSchema).max(RESEARCH_REPORTS_MAX),
});
export type ResearchReportCategory = z.infer<
  typeof ResearchReportCategorySchema
>;

export const ResearchReportsListInputSchema = z.object({}).strict();
export const ResearchReportsListOutputSchema = z.object({
  categories: z
    .array(ResearchReportCategorySchema)
    .max(RESEARCH_REPORT_CATEGORIES_MAX),
  reports: z.array(ResearchReportSummarySchema).max(RESEARCH_REPORTS_MAX),
});
export type ResearchReportsListOutput = z.infer<
  typeof ResearchReportsListOutputSchema
>;

export const ResearchReportDatasetInputSchema = z
  .object({
    dataset: ResearchReportDatasetNameSchema,
    reportId: ReportIdSchema,
    /** Defaults to the report's current revision. */
    revision: RevisionSchema.optional(),
  })
  .strict();
export const ResearchReportDatasetOutputSchema = z.object({
  byteLength: z.number().int().nonnegative(),
  /** Parsed dataset JSON exactly as imported (shape differs per dataset and per report). */
  data: z.unknown(),
  dataRevision: RevisionSchema,
  dataset: ResearchReportDatasetNameSchema,
  reportId: ReportIdSchema,
  /** Stored revisions of the report (newest 100), oldest import first; one import orders by token. */
  revisions: z.array(RevisionSchema).max(RESEARCH_REPORT_REVISIONS_MAX),
  sha256: RevisionSchema,
});
export type ResearchReportDatasetOutput = z.infer<
  typeof ResearchReportDatasetOutputSchema
>;

export const ResearchReportCompanyResearchInputSchema = z
  .object({ reportId: ReportIdSchema })
  .strict();
export const ResearchReportCompanyResearchOutputSchema = z.object({
  acceptedAt: z.date(),
  /** Parsed company-research dossier JSON exactly as imported. */
  data: z.unknown(),
  reportId: ReportIdSchema,
  reportRevision: RevisionSchema.nullable(),
  revision: RevisionSchema,
});
export type ResearchReportCompanyResearchOutput = z.infer<
  typeof ResearchReportCompanyResearchOutputSchema
>;

export const ResearchReportTechnicalsInputSchema = z
  .object({
    reportId: ReportIdSchema,
    /** Defaults to the report's current revision. */
    revision: RevisionSchema.optional(),
  })
  .strict();

const Price = z.number().finite();
const DateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const ResearchReportTrendCheckSchema = z.object({
  key: z.enum([
    "closeAboveSma20",
    "closeAboveSma50",
    "closeAboveSma150",
    "closeAboveSma200",
    "sma50AboveSma150",
    "sma50AboveSma200",
    "sma150AboveSma200",
    "sma200Rising20Sessions",
  ]),
  /** Null when the stored dataset has no boolean for this check. */
  passed: z.boolean().nullable(),
});
export type ResearchReportTrendCheck = z.infer<
  typeof ResearchReportTrendCheckSchema
>;

const IndicatorValues = {
  asOf: DateText.nullable(),
  atr14: Price.nullable(),
  latestClose: Price.nullable(),
  rsi14: Price.nullable(),
  sampleCount: z.number().int().nonnegative().nullable(),
  sma20: Price.nullable(),
  sma50: Price.nullable(),
  sma150: Price.nullable(),
  sma200: Price.nullable(),
};

/** Indicator values as the dossier stored them (fields of another shape are null). */
export const ResearchReportStoredTechnicalsSchema = z.object({
  ...IndicatorValues,
  maximumObservedHigh: z
    .object({
      date: DateText.nullable(),
      drawdownPct: Price.nullable(),
      price: Price,
    })
    .nullable(),
  range52Week: z
    .object({
      high: Price,
      highDate: DateText.nullable(),
      low: Price,
      lowDate: DateText.nullable(),
      sampleCount: Price.nullable(),
    })
    .nullable(),
  sma200Slope: z
    .object({
      change: Price,
      changePct: Price.nullable(),
      fromDate: DateText.nullable(),
      toDate: DateText.nullable(),
    })
    .nullable(),
  trendChecks: z.array(ResearchReportTrendCheckSchema).max(8),
});
export type ResearchReportStoredTechnicals = z.infer<
  typeof ResearchReportStoredTechnicalsSchema
>;

/** The same values recomputed from the revision's stored daily bars. */
export const ResearchReportTechnicalsRecomputedSchema = z.object({
  ...IndicatorValues,
  sampleCount: z.number().int().nonnegative(),
});
export type ResearchReportTechnicalsRecomputed = z.infer<
  typeof ResearchReportTechnicalsRecomputedSchema
>;

export const ResearchReportTechnicalsCheckSchema = z.object({
  /** Fields whose stored and recomputed values are not exactly equal. */
  mismatches: z.array(z.string()).max(9),
  status: z.enum(["match", "mismatch", "unavailable"]),
});
export type ResearchReportTechnicalsCheck = z.infer<
  typeof ResearchReportTechnicalsCheckSchema
>;

export const ResearchReportPivotSchema = z.object({
  confirmedOn: DateText,
  date: DateText,
  kind: z.enum(["support", "resistance"]),
  price: Price,
});
export type ResearchReportPivot = z.infer<typeof ResearchReportPivotSchema>;

const FibonacciLevel = z.object({ price: Price, ratio: Price });
export const ResearchReportFibonacciSchema = z.object({
  direction: z.enum(["up", "down"]),
  levels: z.array(FibonacciLevel).max(7),
  nearestAbove: FibonacciLevel.nullable(),
  nearestBelow: FibonacciLevel.nullable(),
  swingHigh: z.object({ date: DateText, price: Price }),
  swingLow: z.object({ date: DateText, price: Price }),
  window: z.number().int().positive(),
});
export type ResearchReportFibonacci = z.infer<
  typeof ResearchReportFibonacciSchema
>;

export const ResearchReportWeinsteinSchema = z.object({
  completeWeeks: z.number().int().positive(),
  label: z.string(),
  sma30: Price,
  /** Percentage change of the 30-week SMA over the last 4 complete weeks. */
  sma30ChangePct: Price,
  stage: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .nullable(),
  /** The Friday of the last complete week. */
  weekEnding: DateText,
  weeklyClose: Price,
});
export type ResearchReportWeinstein = z.infer<
  typeof ResearchReportWeinsteinSchema
>;

const VolumeBin = z.object({
  high: Price,
  low: Price,
  volume: z.number().int().nonnegative(),
});
export const ResearchReportVolumeProfileSchema = z.object({
  bins: z.array(VolumeBin).max(50),
  binWidth: Price,
  closeLocation: z.enum(["above", "inside", "below"]),
  endDate: DateText,
  high: Price,
  low: Price,
  poc: VolumeBin,
  sessions: z.number().int().positive(),
  startDate: DateText,
  totalVolume: z.number().int().nonnegative(),
  valueAreaHigh: Price,
  valueAreaLow: Price,
  valueAreaVolumePct: Price,
});
export type ResearchReportVolumeProfile = z.infer<
  typeof ResearchReportVolumeProfileSchema
>;

export const ResearchReportTechnicalsOutputSchema = z.object({
  bars: z
    .object({
      /** `collectedAt` of the market dataset; weeks count as complete up to this time. */
      collectedAt: z.string().nullable(),
      count: z.number().int().positive(),
      firstDate: DateText,
      lastDate: DateText,
    })
    .nullable(),
  check: ResearchReportTechnicalsCheckSchema,
  dataRevision: RevisionSchema,
  fibonacci: ResearchReportFibonacciSchema.nullable(),
  /** Rules and windows of the computed markers (method version 1, 2026-11-16). */
  method: z.object({
    fibonacciWindowSessions: z.number().int().positive(),
    pivotLookbackSessions: z.number().int().positive(),
    version: z.number().int().positive(),
    volumeProfile: z.object({
      bins: z.number().int().positive(),
      minimumSessions: z.number().int().positive(),
      sessions: z.number().int().positive(),
      valueAreaPct: Price,
    }),
    weinstein: z.object({
      flatBandPct: Price,
      minimumWeeks: z.number().int().positive(),
      slopeWeeks: z.number().int().positive(),
      smaWeeks: z.number().int().positive(),
    }),
  }),
  pivots: z
    .object({
      candidateResistance: ResearchReportPivotSchema.nullable(),
      candidateSupport: ResearchReportPivotSchema.nullable(),
      items: z.array(ResearchReportPivotSchema).max(120),
      lookbackSessions: z.number().int().positive(),
    })
    .nullable(),
  recomputed: ResearchReportTechnicalsRecomputedSchema.nullable(),
  reportId: ReportIdSchema,
  stored: ResearchReportStoredTechnicalsSchema,
  volumeProfile: ResearchReportVolumeProfileSchema.nullable(),
  warnings: z.array(z.string()).max(10),
  weinstein: ResearchReportWeinsteinSchema.nullable(),
});
export type ResearchReportTechnicals = z.infer<
  typeof ResearchReportTechnicalsOutputSchema
>;

const base = oc.errors(RESEARCH_REPORTS_API_ERRORS);
const TAGS = ["Research reports"];

const list = base
  .route({
    method: "GET",
    operationId: "researchReports.list",
    path: "/research-reports",
    summary: "List the research report catalog and its categories",
    tags: TAGS,
  })
  .input(ResearchReportsListInputSchema)
  .output(ResearchReportsListOutputSchema);

const dataset = base
  .route({
    method: "GET",
    operationId: "researchReports.dataset",
    path: "/research-reports/{reportId}/datasets/{dataset}",
    summary:
      "Read one dataset of a research report (current revision by default; portfolio is never served)",
    tags: TAGS,
  })
  .input(ResearchReportDatasetInputSchema)
  .output(ResearchReportDatasetOutputSchema);

const companyResearch = base
  .route({
    method: "GET",
    operationId: "researchReports.companyResearch",
    path: "/research-reports/{reportId}/company-research",
    summary: "Read the accepted company research of a research report",
    tags: TAGS,
  })
  .input(ResearchReportCompanyResearchInputSchema)
  .output(ResearchReportCompanyResearchOutputSchema);

const technicals = base
  .route({
    method: "GET",
    operationId: "researchReports.technicals",
    path: "/research-reports/{reportId}/technicals",
    summary:
      "Read a research report's stored technicals with pivots, Weinstein stage, Fibonacci levels and volume profile computed from its stored daily bars",
    tags: TAGS,
  })
  .input(ResearchReportTechnicalsInputSchema)
  .output(ResearchReportTechnicalsOutputSchema);

export const researchReportsContract = {
  companyResearch,
  dataset,
  list,
  technicals,
};
