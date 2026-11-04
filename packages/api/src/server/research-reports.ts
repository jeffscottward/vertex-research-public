import {
  DatabasePersistenceError,
  type ResearchReportRecord,
  type ResearchReportsRepository,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  RESEARCH_REPORT_REVISIONS_MAX,
  type ResearchReportSummary,
} from "../contracts/research-reports.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// researchReports.*: read-only, operator-only (same gate as quantLab.list). Stored dataset bodies
// are the exact imported JSON text; they are parsed here, at the boundary. A body that does not
// parse is a storage error. The `portfolio` dataset is outside the contract and is never read.

const metadataText = (
  metadata: Record<string, unknown>,
  key: string
): string | null => {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
};

export const toResearchReportSummary = (
  row: ResearchReportRecord
): ResearchReportSummary => ({
  assetType: row.assetType,
  companyResearch:
    row.companyResearchRevision === null ||
    row.companyResearchAcceptedAt === null
      ? null
      : {
          acceptedAt: row.companyResearchAcceptedAt,
          reportRevision: row.companyResearchReportRevision,
          revision: row.companyResearchRevision,
        },
  currency: metadataText(row.metadata, "currency"),
  dataRevision: row.dataRevision,
  exchange: metadataText(row.metadata, "exchange"),
  id: row.id,
  identityStatus: row.identityStatus,
  importedAt: row.importedAt,
  name: row.name,
  providerSymbol: row.providerSymbol,
  sourceUpdatedAt: row.sourceUpdatedAt,
  status: row.status,
  symbol: row.symbol,
});

class ResearchBodyError extends Error {}

const parseBody = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    throw new ResearchBodyError("stored research JSON does not parse");
  }
};

const api = implement(appContract).$context<ApiContext>();
type Errors = Readonly<{
  STORAGE_ERROR: (options?: { message?: string }) => Error;
}>;

/** Runs a read with the repository, mapping storage failures once. */
const withRepository = async <T>(
  context: ApiContext,
  errors: Errors,
  read: (repository: ResearchReportsRepository) => Promise<T>
): Promise<T> => {
  const repository = context.repositories.researchReports;
  if (repository === undefined) throw errors.STORAGE_ERROR();
  try {
    return await read(repository);
  } catch (error) {
    if (error instanceof ResearchBodyError)
      throw errors.STORAGE_ERROR({ message: error.message });
    if (error instanceof DatabasePersistenceError) throw errors.STORAGE_ERROR();
    throw error;
  }
};

const list = api.researchReports.list
  .use(requireOperator)
  .handler(({ context, errors }) =>
    withRepository(context, errors, async (repository) => {
      const catalog = await repository.listCatalog();
      return {
        categories: catalog.categories.map(
          ({ description, id, label, reportIds }) => ({
            description,
            id,
            label,
            reportIds,
          })
        ),
        reports: catalog.reports.map(toResearchReportSummary),
      };
    })
  );

const dataset = api.researchReports.dataset
  .use(requireOperator)
  .handler(({ context, errors, input }) =>
    withRepository(context, errors, async (repository) => {
      const report = await repository.getReport(input.reportId);
      if (report === null) throw errors.NOT_FOUND();
      const revision = input.revision ?? report.dataRevision;
      const row = await repository.getDataset(
        report.id,
        revision,
        input.dataset
      );
      if (row === null || row.body === null) throw errors.NOT_FOUND();
      return {
        byteLength: row.byteLength,
        data: parseBody(row.body),
        dataRevision: revision,
        dataset: input.dataset,
        reportId: report.id,
        revisions: (await repository.listRevisions(report.id)).slice(
          -RESEARCH_REPORT_REVISIONS_MAX
        ),
        sha256: row.sha256,
      };
    })
  );

const companyResearch = api.researchReports.companyResearch
  .use(requireOperator)
  .handler(({ context, errors, input }) =>
    withRepository(context, errors, async (repository) => {
      const report = await repository.getReport(input.reportId);
      const summary = report === null ? null : toResearchReportSummary(report);
      const head = summary?.companyResearch ?? null;
      if (head === null) throw errors.NOT_FOUND();
      const row = await repository.getCompanyResearch(head.revision);
      if (row === null || row.reportId !== input.reportId) {
        throw errors.NOT_FOUND();
      }
      return {
        acceptedAt: head.acceptedAt,
        data: parseBody(row.body),
        reportId: input.reportId,
        reportRevision: head.reportRevision,
        revision: head.revision,
      };
    })
  );

export const researchReportsRouter = { companyResearch, dataset, list };
