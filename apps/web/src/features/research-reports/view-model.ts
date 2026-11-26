// View-models for the research dossier pages (merge plan P1 part 2): the catalog grouped by
// category, and one report dataset (summary, metrics, sections, sources, warnings, news items).
// Dataset JSON is untrusted stored data with a shape that differs per dataset; every field is read
// defensively and anything unexpected is left out. Research only: no trading permission.
import type {
  ResearchReportDatasetName,
  ResearchReportDatasetOutput,
  ResearchReportSummary,
  ResearchReportsListOutput,
} from "@darkfactory/api";

export const RESEARCH_REPORTS_PATH = "/research/reports";
export const RESEARCH_REPORTS_NOTICE =
  "Research only; a recommendation does not authorize a trade.";

export const DATASET_TABS: readonly Readonly<{
  id: ResearchReportDatasetName;
  label: string;
}>[] = [
  { id: "fundamentals", label: "Fundamentals" },
  { id: "technicals", label: "Technicals" },
  { id: "options-analysis", label: "Options analysis" },
  { id: "committee", label: "Committee" },
  { id: "news", label: "News" },
  { id: "market", label: "Market" },
];

export const DATASET_LABELS: Readonly<
  Record<ResearchReportDatasetName, string>
> = Object.fromEntries(
  DATASET_TABS.map((tab) => [tab.id, tab.label])
) as Record<ResearchReportDatasetName, string>;

export const reportHref = (id: string): string =>
  `${RESEARCH_REPORTS_PATH}/${encodeURIComponent(id)}`;

export type CatalogReportView = Readonly<{
  id: string;
  href: string;
  symbol: string;
  name: string;
  assetType: string;
  status: string;
  updated: string;
  isStale: boolean;
  research: boolean;
}>;

export type CatalogGroupView = Readonly<{
  id: string;
  label: string;
  description: string;
  reports: readonly CatalogReportView[];
}>;

const toCatalogReport = (report: ResearchReportSummary): CatalogReportView => ({
  assetType: report.assetType ?? "Not classified",
  href: reportHref(report.id),
  id: report.id,
  isStale: report.freshness.isStale,
  name: report.name,
  research: report.companyResearch !== null,
  status: report.status,
  symbol: report.symbol,
  updated: report.dataDate ?? "No date recorded",
});

/** Categories in catalog order; reports in no category form a last "Other reports" group. */
export const toCatalogViewModel = (
  output: ResearchReportsListOutput
): readonly CatalogGroupView[] => {
  const byId = new Map(
    output.reports.map((report) => [report.id, toCatalogReport(report)])
  );
  const grouped = new Set<string>();
  const groups: CatalogGroupView[] = output.categories.map((category) => ({
    description: category.description,
    id: category.id,
    label: category.label,
    reports: category.reportIds.flatMap((id) => {
      const report = byId.get(id);
      if (report === undefined) return [];
      grouped.add(id);
      return [report];
    }),
  }));
  const other = [...byId.values()].filter((report) => !grouped.has(report.id));
  if (other.length > 0) {
    groups.push({
      description: "Reports that are in no category.",
      id: "other",
      label: "Other reports",
      reports: other,
    });
  }
  return groups.filter((group) => group.reports.length > 0);
};

export type CatalogSummaryView = Readonly<{
  dossiers: number;
  groups: number;
  research: number;
  stale: number;
  lastUpdated: string;
}>;

/** KPI numbers for the catalog page: reports, shown groups, accepted company research, newest data date and stale count. */
export const toCatalogSummary = (
  output: ResearchReportsListOutput,
  groups: readonly CatalogGroupView[]
): CatalogSummaryView => {
  const newest = output.reports.reduce<string | null>(
    (latest, report) =>
      report.dataDate !== null && (latest === null || report.dataDate > latest)
        ? report.dataDate
        : latest,
    null
  );
  return {
    dossiers: output.reports.length,
    groups: groups.length,
    lastUpdated: newest ?? "No date recorded",
    research: output.reports.filter((report) => report.companyResearch !== null)
      .length,
    stale: output.reports.filter((report) => report.freshness.isStale).length,
  };
};

/** The catalog filter (`?q=`): a case-insensitive match on symbol or name; groups left empty drop out. */
export const filterCatalogGroups = (
  groups: readonly CatalogGroupView[],
  query: string
): readonly CatalogGroupView[] => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return groups;
  return groups.flatMap((group) => {
    const reports = group.reports.filter(
      (report) =>
        report.symbol.toLowerCase().includes(needle) ||
        report.name.toLowerCase().includes(needle)
    );
    return reports.length === 0 ? [] : [{ ...group, reports }];
  });
};

/** Distinct reports across groups (one report may sit in more than one category). */
export const countCatalogReports = (
  groups: readonly CatalogGroupView[]
): number =>
  new Set(groups.flatMap((group) => group.reports.map((report) => report.id)))
    .size;

export type MetricView = Readonly<{
  label: string;
  value: string;
  period: string | null;
}>;
export type SectionView = Readonly<{
  id: string;
  title: string;
  lines: readonly string[];
}>;
export type SourceView = Readonly<{
  id: string;
  title: string;
  href: string | null;
}>;
export type NewsItemView = Readonly<{
  title: string;
  href: string | null;
  date: string | null;
  source: string | null;
  summary: string | null;
}>;

export type DatasetView = Readonly<{
  title: string | null;
  asOf: string | null;
  summary: string | null;
  metrics: readonly MetricView[];
  sections: readonly SectionView[];
  newsItems: readonly NewsItemView[];
  sources: readonly SourceView[];
  warnings: readonly string[];
  revision: string;
  revisionCount: number;
}>;

type Json = Readonly<Record<string, unknown>>;

const record = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const scalarText = (value: unknown): string | null =>
  typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : text(value);

const records = (value: unknown): Json[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const entry = record(item);
        return entry === null ? [] : [entry];
      })
    : [];

const HTTP = /^https?:\/\//u;
const link = (value: unknown): string | null => {
  const url = text(value);
  return url !== null && HTTP.test(url) ? url : null;
};

// Keep synchronized with PRIVATE_RESEARCH_TEXT in packages/api/src/server/research-reports-privacy.ts.
const PRIVATE_OPTIONS_TEXT =
  /(?:^|[^a-z0-9])(?:ibkr|interactive[\s_-]+brokers|broker(?:age|s)?|nlv|net[\s_-]+liquidation|portfolio(?:s)?|account(?:s)?|user[\s_-]*orders?|(?:limit|market|stop|share|pending|open|working|filled|active|resting|placed|submitted)[\s_-]+orders?|(?:order|orders)[\s_-]+(?:pending|filled|working|open|placed|submitted|resting|active)|filled|(?:existing|current)[\s_-]+(?:positions?|holdings?|shares|exposure))(?=$|[^a-z0-9])/iu;

const isBlockedText = (
  value: string | null,
  blockPrivate: boolean
): boolean => {
  if (!blockPrivate || value === null) return false;
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1 $2");
  return PRIVATE_OPTIONS_TEXT.test(normalized);
};

/** Market datasets carry a quote instead of metrics; show its price when it is a number. */
const quoteMetric = (data: Json, blockPrivate: boolean): MetricView[] => {
  const quote = record(data["quote"]);
  const price = quote?.["price"];
  const period = text(quote?.["asOf"]);
  if (typeof price !== "number" || isBlockedText(period, blockPrivate)) {
    return [];
  }
  return [
    {
      label: "Quote price",
      period,
      value: String(price),
    },
  ];
};

const metrics = (data: Json, blockPrivate: boolean): MetricView[] =>
  records(data["metrics"]).flatMap((metric) => {
    const label = text(metric["label"]);
    const value = scalarText(metric["value"]);
    const period = text(metric["period"]);
    if (
      label === null ||
      value === null ||
      isBlockedText(label, blockPrivate) ||
      isBlockedText(value, blockPrivate) ||
      isBlockedText(period, blockPrivate)
    ) {
      return [];
    }
    return [{ label, period, value }];
  });

/**
 * Section ids that hold portfolio or order text and are never shown. The flat APP report's
 * technicals has an `entry` section about a pending share order and the position's exposure.
 */
const PRIVATE_SECTION_IDS: ReadonlySet<string> = new Set(["entry"]);

const sections = (data: Json, blockPrivate: boolean): SectionView[] =>
  records(data["sections"]).flatMap((section, index) => {
    const title = text(section["title"]);
    const id = text(section["id"]);
    if (
      title === null ||
      (id !== null && PRIVATE_SECTION_IDS.has(id.trim().toLowerCase())) ||
      isBlockedText(id, blockPrivate) ||
      isBlockedText(title, blockPrivate)
    ) {
      return [];
    }
    const body = Array.isArray(section["body"]) ? section["body"] : [];
    const bullets = Array.isArray(section["bullets"]) ? section["bullets"] : [];
    const rawLines = [...body, ...bullets].flatMap((line) => {
      const value = scalarText(line);
      return value === null ? [] : [value];
    });
    const lines = rawLines.filter((line) => !isBlockedText(line, blockPrivate));
    if (rawLines.length > 0 && lines.length === 0) return [];
    return [{ id: id ?? `section-${index}`, lines, title }];
  });

const sources = (data: Json, blockPrivate: boolean): SourceView[] =>
  records(data["sources"]).flatMap((source, index) => {
    const title = text(source["title"]);
    const id = text(source["id"]) ?? `source-${index}`;
    const rawUrl = text(source["url"]);
    const href = link(source["url"]);
    if (
      title === null ||
      isBlockedText(title, blockPrivate) ||
      isBlockedText(id, blockPrivate) ||
      isBlockedText(rawUrl, blockPrivate)
    ) {
      return [];
    }
    return [{ href, id, title }];
  });

const newsItems = (data: Json, blockPrivate: boolean): NewsItemView[] =>
  records(data["items"]).flatMap((item) => {
    const title = text(item["title"]);
    const date = text(item["date"]);
    const rawUrl = text(item["url"]);
    const source = text(item["source"]);
    const summary = text(item["summary"]);
    if (
      title === null ||
      isBlockedText(title, blockPrivate) ||
      isBlockedText(date, blockPrivate) ||
      isBlockedText(rawUrl, blockPrivate) ||
      isBlockedText(source, blockPrivate) ||
      isBlockedText(summary, blockPrivate)
    ) {
      return [];
    }
    return [
      {
        date,
        href: link(item["url"]),
        source,
        summary,
        title,
      },
    ];
  });

export const toDatasetViewModel = (
  output: ResearchReportDatasetOutput
): DatasetView => {
  const data = record(output.data) ?? {};
  const blockPrivate = output.dataset === "options-analysis";
  const warnings = Array.isArray(data["warnings"])
    ? data["warnings"].flatMap((warning) => {
        const value = scalarText(warning);
        return value === null || isBlockedText(value, blockPrivate)
          ? []
          : [value];
      })
    : [];
  const rawAsOf = text(data["asOf"]);
  const rawSummary = text(data["summary"]);
  const rawTitle = text(data["title"]);
  return {
    asOf: isBlockedText(rawAsOf, blockPrivate) ? null : rawAsOf,
    metrics: [
      ...quoteMetric(data, blockPrivate),
      ...metrics(data, blockPrivate),
    ],
    newsItems: newsItems(data, blockPrivate),
    revision: output.dataRevision.slice(0, 12),
    revisionCount: output.revisions.length,
    sections: sections(data, blockPrivate),
    sources: sources(data, blockPrivate),
    summary: isBlockedText(rawSummary, blockPrivate) ? null : rawSummary,
    title: isBlockedText(rawTitle, blockPrivate) ? null : rawTitle,
    warnings,
  };
};
