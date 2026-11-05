import { and, asc, count, eq, inArray, notInArray, sql } from "drizzle-orm";

import {
  RESEARCH_REPORT_DATASETS,
  type ResearchReportDataset,
  type ResearchRevisionSource,
  researchCompanyResearch,
  researchReportCategories,
  researchReportDatasets,
  researchReportRevisions,
  researchReports,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  DatabasePersistenceError,
  databaseErrorDetails,
} from "./repositories.ts";

// Research dossiers (merge plan P1). The importer (scripts/research-reports/) verifies every
// revision token before it calls replaceCatalog. Revisions, datasets and company-research bodies
// are immutable: a stored row is never rewritten, so a rerun only adds what is new. The catalog
// (reports and categories) is replaced as a whole. Research only; no order path.

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REPORT_ID_PATTERN = /^[A-Z0-9]{1,10}$/u;
// Dataset bodies reach about 1 MB; small chunks keep each statement well under protocol limits.
const BODY_CHUNK_ROWS = 8;

export type ResearchReportRecord = typeof researchReports.$inferSelect;
export type ResearchReportCategoryRecord =
  typeof researchReportCategories.$inferSelect;

export type ResearchReportInput = Readonly<{
  id: string;
  symbol: string;
  providerSymbol: string;
  name: string;
  assetType: string | null;
  status: string;
  identityStatus: string;
  dataRevision: string;
  metadata: Record<string, unknown>;
  companyResearch: Readonly<{
    revision: string;
    /** Report revision the research was accepted against; null for the flat (original) report. */
    reportRevision: string | null;
    acceptedAt: Date;
  }> | null;
  sourceUpdatedAt: Date | null;
}>;

export type ResearchCategoryInput = Readonly<{
  id: string;
  label: string;
  description: string;
  reportIds: readonly string[];
  sourceIds: readonly string[];
}>;

export type ResearchDatasetInput = Readonly<{
  dataset: ResearchReportDataset;
  sha256: string;
  byteLength: number;
  /** Exact UTF-8 source text; must be null for `portfolio`. */
  body: string | null;
}>;

export type ResearchRevisionInput = Readonly<{
  reportId: string;
  dataRevision: string;
  source: ResearchRevisionSource;
  datasets: readonly ResearchDatasetInput[];
}>;

export type ResearchCompanyResearchInput = Readonly<{
  revision: string;
  reportId: string;
  body: string;
}>;

export type ResearchCatalogImport = Readonly<{
  reports: readonly ResearchReportInput[];
  categories: readonly ResearchCategoryInput[];
  revisions: readonly ResearchRevisionInput[];
  companyResearch: readonly ResearchCompanyResearchInput[];
}>;

export type ResearchReportCounts = Readonly<{
  reports: number;
  categories: number;
  revisions: number;
  datasets: number;
  privateDatasets: number;
  companyResearch: number;
  acceptedCompanyResearch: number;
}>;

export type ResearchImportResult = Readonly<{
  revisionsAdded: number;
  datasetsAdded: number;
  companyResearchAdded: number;
  reportsRemoved: number;
  counts: ResearchReportCounts;
}>;

export type ResearchDatasetRecord = Readonly<{
  reportId: string;
  dataRevision: string;
  dataset: ResearchReportDataset;
  sha256: string;
  byteLength: number;
  body: string | null;
}>;

export type ResearchCompanyResearchRecord = Readonly<{
  revision: string;
  reportId: string;
  body: string;
}>;

export type ResearchReportsRepository = Readonly<{
  listCatalog: () => Promise<{
    reports: ResearchReportRecord[];
    categories: ResearchReportCategoryRecord[];
  }>;
  getReport: (id: string) => Promise<ResearchReportRecord | null>;
  listRevisions: (reportId: string) => Promise<string[]>;
  getDataset: (
    reportId: string,
    dataRevision: string,
    dataset: ResearchReportDataset
  ) => Promise<ResearchDatasetRecord | null>;
  getCompanyResearch: (
    revision: string
  ) => Promise<ResearchCompanyResearchRecord | null>;
  counts: () => Promise<ResearchReportCounts>;
  /** Refuses (and rolls back) when stored reports would leave the catalog, unless allowRemoval. */
  replaceCatalog: (
    input: ResearchCatalogImport,
    options?: Readonly<{ allowRemoval?: boolean }>
  ) => Promise<ResearchImportResult>;
}>;

export class ResearchReportsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchReportsInputError";
  }
}

const fail = (message: string): never => {
  throw new ResearchReportsInputError(message);
};

const validateDatasets = (revision: ResearchRevisionInput): void => {
  const names = revision.datasets.map((entry) => entry.dataset);
  if (
    names.length !== RESEARCH_REPORT_DATASETS.length ||
    RESEARCH_REPORT_DATASETS.some((name) => !names.includes(name))
  ) {
    fail(
      `${revision.reportId}/${revision.dataRevision}: needs each of the seven datasets once`
    );
  }
  for (const entry of revision.datasets) {
    const privateDataset = entry.dataset === "portfolio";
    if (
      !(
        SHA256_PATTERN.test(entry.sha256) &&
        Number.isSafeInteger(entry.byteLength)
      ) ||
      entry.byteLength < 0 ||
      privateDataset !== (entry.body === null)
    ) {
      fail(
        `${revision.reportId}/${revision.dataRevision}/${entry.dataset}: invalid digest, length or body (portfolio bodies are never stored)`
      );
    }
  }
};

const validateReportIds = (input: ResearchCatalogImport): Set<string> => {
  if (input.reports.length === 0) fail("catalog has no reports");
  const reportIds = new Set<string>();
  for (const report of input.reports) {
    if (!REPORT_ID_PATTERN.test(report.id)) {
      fail(`report id ${report.id} must match ^[A-Z0-9]{1,10}$`);
    }
    if (reportIds.has(report.id)) fail(`duplicate report ${report.id}`);
    reportIds.add(report.id);
    if (!SHA256_PATTERN.test(report.dataRevision)) {
      fail(`${report.id}: dataRevision must be 64 hex characters`);
    }
  }
  return reportIds;
};

const validateRevisions = (
  input: ResearchCatalogImport,
  reportIds: ReadonlySet<string>
): Set<string> => {
  const revisionKeys = new Set<string>();
  for (const revision of input.revisions) {
    if (!reportIds.has(revision.reportId)) {
      fail(`revision for unknown report ${revision.reportId}`);
    }
    if (!SHA256_PATTERN.test(revision.dataRevision)) {
      fail(`${revision.reportId}: revision token must be 64 hex characters`);
    }
    const key = `${revision.reportId}/${revision.dataRevision}`;
    if (revisionKeys.has(key)) fail(`duplicate revision ${key}`);
    revisionKeys.add(key);
    validateDatasets(revision);
  }
  return revisionKeys;
};

/** Company-research revision -> report id; each revision once. */
const validateCompanyResearch = (
  input: ResearchCatalogImport
): Map<string, string> => {
  const research = new Map<string, string>();
  for (const entry of input.companyResearch) {
    const valid =
      SHA256_PATTERN.test(entry.revision) &&
      REPORT_ID_PATTERN.test(entry.reportId);
    if (!valid) {
      fail(`company research ${entry.reportId}/${entry.revision} is invalid`);
    }
    if (research.has(entry.revision)) {
      fail(`duplicate company research ${entry.revision}`);
    }
    research.set(entry.revision, entry.reportId);
  }
  return research;
};

/** Throws ResearchReportsInputError unless the import is internally consistent. */
export const validateResearchCatalogImport = (
  input: ResearchCatalogImport
): void => {
  const reportIds = validateReportIds(input);
  const revisionKeys = validateRevisions(input, reportIds);
  const research = validateCompanyResearch(input);
  for (const report of input.reports) {
    if (!revisionKeys.has(`${report.id}/${report.dataRevision}`)) {
      fail(`${report.id}: current revision ${report.dataRevision} is missing`);
    }
    if (
      report.companyResearch !== null &&
      research.get(report.companyResearch.revision) !== report.id
    ) {
      fail(`${report.id}: accepted company research body is missing`);
    }
  }
  for (const category of input.categories) {
    for (const id of category.reportIds) {
      if (!reportIds.has(id)) fail(`category ${category.id}: unknown ${id}`);
    }
  }
};

const chunks = <T>(rows: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let start = 0; start < rows.length; start += size) {
    out.push(rows.slice(start, start + size));
  }
  return out;
};

const readCounts = async (
  database: DatabaseExecutor
): Promise<ResearchReportCounts> => {
  const total = async (
    table:
      | typeof researchReports
      | typeof researchReportCategories
      | typeof researchReportRevisions
      | typeof researchCompanyResearch
  ): Promise<number> => {
    const [row] = await database.select({ n: count() }).from(table);
    return row?.n ?? 0;
  };
  const [datasets] = await database
    .select({
      all: count(),
      hidden:
        sql<number>`count(*) filter (where ${researchReportDatasets.body} is null)`.mapWith(
          Number
        ),
    })
    .from(researchReportDatasets);
  const [accepted] = await database
    .select({ n: count(researchReports.companyResearchRevision) })
    .from(researchReports);
  return {
    acceptedCompanyResearch: accepted?.n ?? 0,
    categories: await total(researchReportCategories),
    companyResearch: await total(researchCompanyResearch),
    datasets: datasets?.all ?? 0,
    privateDatasets: datasets?.hidden ?? 0,
    reports: await total(researchReports),
    revisions: await total(researchReportRevisions),
  };
};

/** Replaces the report catalog and categories; returns how many reports left the catalog. */
const writeCatalog = async (
  tx: DatabaseExecutor,
  input: ResearchCatalogImport,
  importedAt: Date
): Promise<number> => {
  const ids = input.reports.map((report) => report.id);
  const removed = await tx
    .delete(researchReports)
    .where(notInArray(researchReports.id, ids))
    .returning({ id: researchReports.id });
  for (const [position, report] of input.reports.entries()) {
    const research = report.companyResearch;
    const row = {
      assetType: report.assetType,
      companyResearchAcceptedAt: research?.acceptedAt ?? null,
      companyResearchReportRevision: research?.reportRevision ?? null,
      companyResearchRevision: research?.revision ?? null,
      dataRevision: report.dataRevision,
      id: report.id,
      identityStatus: report.identityStatus,
      importedAt,
      metadata: report.metadata,
      name: report.name,
      position,
      providerSymbol: report.providerSymbol,
      sourceUpdatedAt: report.sourceUpdatedAt,
      status: report.status,
      symbol: report.symbol,
    };
    await tx
      .insert(researchReports)
      .values(row)
      .onConflictDoUpdate({ set: row, target: researchReports.id });
  }
  await tx.delete(researchReportCategories);
  if (input.categories.length > 0) {
    await tx.insert(researchReportCategories).values(
      input.categories.map((category, position) => ({
        description: category.description,
        id: category.id,
        label: category.label,
        position,
        reportIds: [...category.reportIds],
        sourceIds: [...category.sourceIds],
      }))
    );
  }
  return removed.length;
};

const datasetSignature = (
  rows: readonly Readonly<{
    dataset: string;
    sha256: string;
    byteLength: number;
  }>[]
): string =>
  rows
    .map((row) => `${row.dataset}:${row.sha256}:${row.byteLength}`)
    .sort()
    .join(",");

/** Refuses an already stored revision whose source or datasets differ from the input. */
const checkStoredRevision = async (
  tx: DatabaseExecutor,
  revision: ResearchRevisionInput
): Promise<void> => {
  const key = and(
    eq(researchReportRevisions.reportId, revision.reportId),
    eq(researchReportRevisions.dataRevision, revision.dataRevision)
  );
  const [stored] = await tx
    .select({ source: researchReportRevisions.source })
    .from(researchReportRevisions)
    .where(key)
    .limit(1);
  const datasets = await tx
    .select({
      byteLength: researchReportDatasets.byteLength,
      dataset: researchReportDatasets.dataset,
      sha256: researchReportDatasets.sha256,
    })
    .from(researchReportDatasets)
    .where(
      and(
        eq(researchReportDatasets.reportId, revision.reportId),
        eq(researchReportDatasets.dataRevision, revision.dataRevision)
      )
    );
  if (
    stored?.source !== revision.source ||
    datasetSignature(datasets) !== datasetSignature(revision.datasets)
  ) {
    fail(
      `${revision.reportId}/${revision.dataRevision}: stored revision differs from the source`
    );
  }
};

/** Adds revisions that are not stored yet, with their datasets. A stored revision must match. */
const insertRevisions = async (
  tx: DatabaseExecutor,
  revisions: readonly ResearchRevisionInput[],
  importedAt: Date
): Promise<Readonly<{ revisions: number; datasets: number }>> => {
  let added = 0;
  let datasets = 0;
  for (const revision of revisions) {
    const inserted = await tx
      .insert(researchReportRevisions)
      .values({
        dataRevision: revision.dataRevision,
        importedAt,
        reportId: revision.reportId,
        source: revision.source,
      })
      .onConflictDoNothing()
      .returning({ dataRevision: researchReportRevisions.dataRevision });
    if (inserted.length === 0) {
      await checkStoredRevision(tx, revision);
      continue;
    }
    added += 1;
    for (const part of chunks(revision.datasets, BODY_CHUNK_ROWS)) {
      await tx.insert(researchReportDatasets).values(
        part.map((entry) => ({
          body: entry.body,
          byteLength: entry.byteLength,
          dataRevision: revision.dataRevision,
          dataset: entry.dataset,
          reportId: revision.reportId,
          sha256: entry.sha256,
        }))
      );
      datasets += part.length;
    }
  }
  return { datasets, revisions: added };
};

/** Each accepted head must be stored for its own report (an older import may hold the revision). */
const checkAcceptedHeads = async (
  tx: DatabaseExecutor,
  reports: readonly ResearchReportInput[]
): Promise<void> => {
  const heads = reports.flatMap((report) =>
    report.companyResearch === null
      ? []
      : [{ id: report.id, revision: report.companyResearch.revision }]
  );
  if (heads.length === 0) return;
  const stored = await tx
    .select({
      reportId: researchCompanyResearch.reportId,
      revision: researchCompanyResearch.revision,
    })
    .from(researchCompanyResearch)
    .where(
      inArray(
        researchCompanyResearch.revision,
        heads.map((head) => head.revision)
      )
    );
  const owners = new Map(stored.map((row) => [row.revision, row.reportId]));
  for (const head of heads) {
    if (owners.get(head.revision) !== head.id) {
      fail(
        `${head.id}: accepted company research ${head.revision} is stored for another report`
      );
    }
  }
};

/** Postgres failures on the read path become DatabasePersistenceError (503 at the API). */
const readOrPersistenceError = async <T>(work: Promise<T>): Promise<T> => {
  try {
    return await work;
  } catch (error) {
    if (typeof databaseErrorDetails(error).code === "string") {
      throw new DatabasePersistenceError("research reports read");
    }
    throw error;
  }
};

export const createResearchReportsRepository = (
  database: DatabaseExecutor,
  now: () => Date = () => new Date()
): ResearchReportsRepository => ({
  counts: () => readOrPersistenceError(readCounts(database)),
  getCompanyResearch: async (revision) => {
    const [row] = await readOrPersistenceError(
      database
        .select({
          body: researchCompanyResearch.body,
          reportId: researchCompanyResearch.reportId,
          revision: researchCompanyResearch.revision,
        })
        .from(researchCompanyResearch)
        .where(eq(researchCompanyResearch.revision, revision))
        .limit(1)
    );
    return row ?? null;
  },
  getDataset: async (reportId, dataRevision, dataset) => {
    const [row] = await readOrPersistenceError(
      database
        .select({
          body: researchReportDatasets.body,
          byteLength: researchReportDatasets.byteLength,
          dataRevision: researchReportDatasets.dataRevision,
          dataset: researchReportDatasets.dataset,
          reportId: researchReportDatasets.reportId,
          sha256: researchReportDatasets.sha256,
        })
        .from(researchReportDatasets)
        .where(
          and(
            eq(researchReportDatasets.reportId, reportId),
            eq(researchReportDatasets.dataRevision, dataRevision),
            eq(researchReportDatasets.dataset, dataset)
          )
        )
        .limit(1)
    );
    return row ?? null;
  },
  getReport: async (id) => {
    const [row] = await readOrPersistenceError(
      database
        .select()
        .from(researchReports)
        .where(eq(researchReports.id, id))
        .limit(1)
    );
    return row ?? null;
  },
  listCatalog: async () => ({
    categories: await readOrPersistenceError(
      database
        .select()
        .from(researchReportCategories)
        .orderBy(asc(researchReportCategories.position))
    ),
    reports: await readOrPersistenceError(
      database
        .select()
        .from(researchReports)
        .orderBy(asc(researchReports.position))
    ),
  }),
  // Revisions of one import share importedAt; within one import the order is by token.
  listRevisions: async (reportId) =>
    (
      await readOrPersistenceError(
        database
          .select({ dataRevision: researchReportRevisions.dataRevision })
          .from(researchReportRevisions)
          .where(eq(researchReportRevisions.reportId, reportId))
          .orderBy(
            asc(researchReportRevisions.importedAt),
            asc(researchReportRevisions.dataRevision)
          )
      )
    ).map((row) => row.dataRevision),
  replaceCatalog: async (input, options = {}) => {
    validateResearchCatalogImport(input);
    const importedAt = now();
    return await database.transaction(async (tx) => {
      const reportsRemoved = await writeCatalog(tx, input, importedAt);
      if (reportsRemoved > 0 && options.allowRemoval !== true) {
        fail(
          `${reportsRemoved} stored report(s) are not in the catalog; pass allowRemoval to delete them`
        );
      }
      const added = await insertRevisions(tx, input.revisions, importedAt);
      let companyResearchAdded = 0;
      for (const part of chunks(input.companyResearch, BODY_CHUNK_ROWS)) {
        const inserted = await tx
          .insert(researchCompanyResearch)
          .values(part.map((entry) => ({ ...entry, importedAt })))
          .onConflictDoNothing()
          .returning({ revision: researchCompanyResearch.revision });
        companyResearchAdded += inserted.length;
      }
      await checkAcceptedHeads(tx, input.reports);
      return {
        companyResearchAdded,
        counts: await readCounts(tx),
        datasetsAdded: added.datasets,
        reportsRemoved,
        revisionsAdded: added.revisions,
      };
    });
  },
});
