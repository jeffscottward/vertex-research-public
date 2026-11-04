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

export const researchReportsContract = { companyResearch, dataset, list };
