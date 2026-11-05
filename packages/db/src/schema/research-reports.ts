// What: research dossiers moved from the vertex-research workspace (merge plan P1): the report
// catalog, its categories, immutable report revisions with their seven datasets, and the accepted
// company-research layer. Bodies are the exact source bytes (UTF-8 JSON text), so the revision
// token (SHA-256 over the seven datasets, see scripts/research-reports/load.ts) stays checkable.
// Privacy: the `portfolio` dataset body is never stored; only its SHA-256 and byte length.
// Research only: nothing here places, changes or cancels an order.
// Used by: packages/db/src/server/research-reports.ts. See: docs/vertex-rebuild/research-reports.md.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const RESEARCH_REPORT_DATASETS = [
  "market",
  "portfolio",
  "fundamentals",
  "news",
  "technicals",
  "options-analysis",
  "committee",
] as const;
export type ResearchReportDataset = (typeof RESEARCH_REPORT_DATASETS)[number];
/** Datasets whose body is never stored or served. */
export const PRIVATE_RESEARCH_REPORT_DATASETS = ["portfolio"] as const;
export const RESEARCH_REVISION_SOURCES = ["revision", "flat"] as const;
export type ResearchRevisionSource = (typeof RESEARCH_REVISION_SOURCES)[number];

const utc = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const researchReports = pgTable(
  "research_reports",
  {
    assetType: text("asset_type"),
    companyResearchAcceptedAt: utc("company_research_accepted_at"),
    companyResearchReportRevision: text("company_research_report_revision"),
    companyResearchRevision: text("company_research_revision"),
    /** Current report revision (the old catalog's dataRevision; APP: the token of its flat files). */
    dataRevision: text("data_revision").notNull(),
    id: text("id").primaryKey(),
    identityStatus: text("identity_status").notNull(),
    importedAt: utc("imported_at").defaultNow().notNull(),
    /** The whole catalog entry as parsed JSON (exchange, mic, currency, sources, capabilities, ...). */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    providerSymbol: text("provider_symbol").notNull(),
    sourceUpdatedAt: utc("source_updated_at"),
    status: text("status").notNull(),
    symbol: text("symbol").notNull(),
  },
  (table) => [
    check(
      "research_reports_id_check",
      sql`${table.id} ~ '^[A-Z0-9]{1,10}$' and ${table.position} >= 0`
    ),
    check(
      "research_reports_revision_check",
      sql`${table.dataRevision} ~ '^[0-9a-f]{64}$' and (${table.companyResearchRevision} is null or ${table.companyResearchRevision} ~ '^[0-9a-f]{64}$') and (${table.companyResearchReportRevision} is null or ${table.companyResearchReportRevision} ~ '^[0-9a-f]{64}$')`
    ),
  ]
);

export const researchReportCategories = pgTable(
  "research_report_categories",
  {
    description: text("description").notNull(),
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    position: integer("position").notNull(),
    reportIds: jsonb("report_ids").$type<string[]>().notNull(),
    sourceIds: jsonb("source_ids").$type<string[]>().notNull(),
  },
  (table) => [
    check(
      "research_report_categories_check",
      sql`char_length(${table.id}) between 1 and 80 and ${table.position} >= 0 and jsonb_typeof(${table.reportIds}) = 'array' and jsonb_typeof(${table.sourceIds}) = 'array'`
    ),
  ]
);

export const researchReportRevisions = pgTable(
  "research_report_revisions",
  {
    dataRevision: text("data_revision").notNull(),
    importedAt: utc("imported_at").defaultNow().notNull(),
    reportId: text("report_id")
      .notNull()
      .references(() => researchReports.id, { onDelete: "cascade" }),
    source: text("source").$type<ResearchRevisionSource>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.reportId, table.dataRevision] }),
    check(
      "research_report_revisions_check",
      sql`${table.dataRevision} ~ '^[0-9a-f]{64}$' and ${table.source} in ('revision', 'flat')`
    ),
  ]
);

export const researchReportDatasets = pgTable(
  "research_report_datasets",
  {
    /** Exact source bytes as UTF-8 text; always null for `portfolio`. */
    body: text("body"),
    byteLength: integer("byte_length").notNull(),
    dataRevision: text("data_revision").notNull(),
    dataset: text("dataset").$type<ResearchReportDataset>().notNull(),
    reportId: text("report_id").notNull(),
    sha256: text("sha256").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.reportId, table.dataRevision, table.dataset],
    }),
    foreignKey({
      columns: [table.reportId, table.dataRevision],
      foreignColumns: [
        researchReportRevisions.reportId,
        researchReportRevisions.dataRevision,
      ],
      name: "research_report_datasets_revision_fk",
    }).onDelete("cascade"),
    check(
      "research_report_datasets_check",
      sql`${table.dataset} in ('market', 'portfolio', 'fundamentals', 'news', 'technicals', 'options-analysis', 'committee') and ${table.sha256} ~ '^[0-9a-f]{64}$' and ${table.byteLength} >= 0`
    ),
    check(
      "research_report_datasets_private_check",
      sql`(${table.dataset} = 'portfolio') = (${table.body} is null)`
    ),
  ]
);

export const researchCompanyResearch = pgTable(
  "research_company_research",
  {
    /** Exact source bytes of revisions/<revision>/<reportId>.json. */
    body: text("body").notNull(),
    importedAt: utc("imported_at").defaultNow().notNull(),
    reportId: text("report_id").notNull(),
    /** SHA-256 of JSON.stringify(dossier), the old manifest's `revision`. */
    revision: text("revision").primaryKey(),
  },
  (table) => [
    index("research_company_research_report_idx").on(table.reportId),
    check(
      "research_company_research_check",
      sql`${table.revision} ~ '^[0-9a-f]{64}$' and ${table.reportId} ~ '^[A-Z0-9]{1,10}$'`
    ),
  ]
);
