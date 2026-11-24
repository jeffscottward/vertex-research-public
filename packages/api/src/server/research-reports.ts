import { createHash } from "node:crypto";
import {
  DatabasePersistenceError,
  type MarketBarSeries,
  type MarketBarsRepository,
  type ResearchReportRecord,
  type ResearchReportsRepository,
} from "@darkfactory/db/server";
import { BAR_SYMBOL_PATTERN } from "@darkfactory/shared/universes";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  RESEARCH_REPORT_REVISIONS_MAX,
  type ResearchReportCategory,
  type ResearchReportDataSource,
  type ResearchReportDatasetName,
  type ResearchReportSummary,
} from "../contracts/research-reports.ts";
import {
  buildResearchReportTechnicals,
  computeFullIndicators,
  type DossierBar,
  evaluateDossierFreshness,
  marketBarColumnsToDossierBars,
} from "../research-report-technicals.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";
import { sanitizeResearchDatasetData } from "./research-reports-privacy.ts";
import { storageNotConfiguredMessage } from "./storage-not-configured.ts";
import { storageReadFailedMessage } from "./storage-request-failed.ts";

// researchReports.*: read-only, operator-only (same gate as quantLab.list). Stored dataset bodies
// are parsed here, at the boundary, and `options-analysis` payloads are sanitized before leaving
// the server (`sanitizeResearchDatasetData`). A body that does not parse is a storage error.
// The `portfolio` dataset is outside the contract and is never read.
// Nightly-refreshed `market_bar_series` (`1d`) provides read-time price data for index ETFs
// (SPY, QQQ, IWM, DIA) and any other dossier with a fresher stored `1d` bar series.

type IndexEtfDossierSpec = Readonly<{
  exchange: string;
  id: "SPY" | "QQQ" | "IWM" | "DIA";
  market: string;
  name: string;
  symbol: "SPY" | "QQQ" | "IWM" | "DIA";
}>;

const INDEX_ETF_DOSSIERS: readonly IndexEtfDossierSpec[] = [
  {
    exchange: "NYSE Arca",
    id: "SPY",
    market: "S&P 500",
    name: "SPDR S&P 500 ETF Trust",
    symbol: "SPY",
  },
  {
    exchange: "NASDAQ",
    id: "QQQ",
    market: "Nasdaq-100",
    name: "Invesco QQQ Trust",
    symbol: "QQQ",
  },
  {
    exchange: "NYSE Arca",
    id: "IWM",
    market: "Russell 2000",
    name: "iShares Russell 2000 ETF",
    symbol: "IWM",
  },
  {
    exchange: "NYSE Arca",
    id: "DIA",
    market: "Dow 30",
    name: "SPDR Dow Jones Industrial Average ETF Trust",
    symbol: "DIA",
  },
];

const INDEX_ETF_BY_ID = new Map<string, IndexEtfDossierSpec>(
  INDEX_ETF_DOSSIERS.map((spec) => [spec.id, spec])
);

const DATASET_TEXT_LABELS: Readonly<
  Record<Exclude<ResearchReportDatasetName, "market" | "technicals">, string>
> = {
  committee: "committee",
  fundamentals: "fundamentals",
  news: "news",
  "options-analysis": "options analysis",
};

const isoDay = (millis: number): string =>
  new Date(millis).toISOString().slice(0, 10);

const metadataText = (
  metadata: Record<string, unknown>,
  key: string
): string | null => {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
};

export const toResearchReportSummary = (
  row: ResearchReportRecord,
  options: Readonly<{
    barDate?: string | null;
    now?: Date;
  }> = {}
): ResearchReportSummary => {
  const storedDate =
    row.sourceUpdatedAt === null
      ? null
      : row.sourceUpdatedAt.toISOString().slice(0, 10);
  const barDate = options.barDate ?? null;
  const useMarketBars =
    barDate !== null && (storedDate === null || barDate > storedDate);
  const dataDate = useMarketBars ? barDate : storedDate;
  const dataSource: ResearchReportDataSource = useMarketBars
    ? "market_bars"
    : "revision";
  return {
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
    dataDate,
    dataRevision: row.dataRevision,
    dataSource,
    exchange: metadataText(row.metadata, "exchange"),
    freshness: evaluateDossierFreshness(dataDate, options.now),
    id: row.id,
    identityStatus: row.identityStatus,
    importedAt: row.importedAt,
    name: row.name,
    providerSymbol: row.providerSymbol,
    sourceUpdatedAt: row.sourceUpdatedAt,
    status: row.status,
    symbol: row.symbol,
  };
};

const toBarBackedSummary = (
  spec: IndexEtfDossierSpec,
  series: MarketBarSeries,
  now: Date
): ResearchReportSummary => {
  const dataDate = isoDay(series.lastT);
  return {
    assetType: "etf",
    companyResearch: null,
    currency: "USD",
    dataDate,
    dataRevision: series.sourceSha256,
    dataSource: "market_bars",
    exchange: spec.exchange,
    freshness: evaluateDossierFreshness(dataDate, now),
    id: spec.id,
    identityStatus: "verified",
    importedAt: series.importedAt,
    name: spec.name,
    providerSymbol: spec.symbol,
    sourceUpdatedAt: new Date(series.lastT),
    status: "ready",
    symbol: spec.symbol,
  };
};

const dailySeriesBySymbol = async (
  marketBars: MarketBarsRepository | undefined
): Promise<ReadonlyMap<string, MarketBarSeries>> => {
  if (marketBars === undefined) return new Map();
  const list = await marketBars.listSeries();
  return new Map(
    list
      .filter((series) => series.timeframe === "1d")
      .map((series) => [series.symbol, series])
  );
};

const findDailyBarSeries = async (
  marketBars: MarketBarsRepository | undefined,
  symbol: string,
  providerSymbol: string
): Promise<MarketBarSeries | null> => {
  if (marketBars === undefined) return null;
  if (BAR_SYMBOL_PATTERN.test(symbol)) {
    const direct = await marketBars.getSeries(symbol, "1d");
    if (direct !== null) return direct;
  }
  if (providerSymbol !== symbol && BAR_SYMBOL_PATTERN.test(providerSymbol)) {
    return await marketBars.getSeries(providerSymbol, "1d");
  }
  return null;
};

const synthesizeBarBackedDataset = (
  spec: IndexEtfDossierSpec,
  series: MarketBarSeries,
  bars: readonly DossierBar[],
  datasetName: ResearchReportDatasetName
): Record<string, unknown> => {
  const last = bars.at(-1);
  const lastDate = last?.date ?? isoDay(series.lastT);
  if (datasetName === "technicals") {
    const indicators = computeFullIndicators(bars);
    return {
      ...(indicators ?? {}),
      asOf: lastDate,
      summary: `Technicals computed from ${bars.length} stored daily bars through ${lastDate}.`,
      title: `${spec.id} technicals`,
      warnings: [],
    };
  }
  if (datasetName === "market") {
    const firstDate = bars[0]?.date ?? isoDay(series.firstT);
    return {
      asOf: lastDate,
      collectedAt: series.importedAt.toISOString(),
      metrics: [
        {
          label: "Stored daily bars",
          period: `${firstDate} to ${lastDate}`,
          value: bars.length,
        },
        {
          label: "Market",
          period: spec.exchange,
          value: spec.market,
        },
      ],
      ...(last === undefined
        ? {}
        : { quote: { asOf: lastDate, price: last.close } }),
      summary: `Daily OHLCV bars for ${spec.name} (${spec.symbol}) from the nightly market_bar_series store.`,
      title: `${spec.id} market data`,
    };
  }
  const label = DATASET_TEXT_LABELS[datasetName];
  return {
    asOf: lastDate,
    summary: `${spec.name} (${spec.symbol}) is an index ETF dossier backed by stored daily bars. No static ${label} snapshot is stored; open Technicals or Market for daily-bar analysis.`,
    title: `${spec.id} ${label}`,
  };
};

const attachIndexEtfCategory = (
  categories: ResearchReportCategory[],
  addedIds: readonly string[]
): ResearchReportCategory[] => {
  if (addedIds.length === 0) return categories;
  const targetIndex = categories.findIndex(
    (category) =>
      category.reportIds.includes("SPY") || category.reportIds.includes("QQQ")
  );
  if (targetIndex >= 0) {
    const target = categories[targetIndex] as ResearchReportCategory;
    const merged = [
      ...target.reportIds,
      ...addedIds.filter((id) => !target.reportIds.includes(id)),
    ];
    return categories.map((category, index) =>
      index === targetIndex ? { ...category, reportIds: merged } : category
    );
  }
  return [
    ...categories,
    {
      description:
        "Core US equity index ETFs backed by nightly-refreshed daily bars.",
      id: "index-etfs",
      label: "Index ETFs",
      reportIds: [...addedIds],
    },
  ];
};

const loadBarBackedIndexEtf = async (
  marketBars: MarketBarsRepository | undefined,
  reportId: string,
  revision: string | undefined
): Promise<Readonly<{
  bars: DossierBar[];
  series: MarketBarSeries;
  spec: IndexEtfDossierSpec;
}> | null> => {
  const spec = INDEX_ETF_BY_ID.get(reportId);
  if (spec === undefined) return null;
  const series = await findDailyBarSeries(marketBars, spec.symbol, spec.symbol);
  if (series === null) return null;
  if (revision !== undefined && revision !== series.sourceSha256) return null;
  const columns = await (marketBars as MarketBarsRepository).loadColumns(
    series.id
  );
  return { bars: marketBarColumnsToDossierBars(columns), series, spec };
};

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
  if (repository === undefined)
    throw errors.STORAGE_ERROR({
      message: storageNotConfiguredMessage("Research report"),
    });
  try {
    return await read(repository);
  } catch (error) {
    if (error instanceof ResearchBodyError)
      throw errors.STORAGE_ERROR({ message: error.message });
    if (error instanceof DatabasePersistenceError)
      throw errors.STORAGE_ERROR({
        message: storageReadFailedMessage("Research report"),
      });
    throw error;
  }
};

const list = api.researchReports.list
  .use(requireOperator)
  .handler(({ context, errors }) =>
    withRepository(context, errors, async (repository) => {
      const now = new Date();
      const [catalog, dailyBars] = await Promise.all([
        repository.listCatalog(),
        dailySeriesBySymbol(context.repositories.marketBars),
      ]);
      const reports = catalog.reports.map((row) => {
        const series =
          dailyBars.get(row.symbol) ?? dailyBars.get(row.providerSymbol);
        return toResearchReportSummary(row, {
          barDate: series === undefined ? null : isoDay(series.lastT),
          now,
        });
      });
      const existingIds = new Set(reports.map((report) => report.id));
      const addedIds: string[] = [];
      for (const spec of INDEX_ETF_DOSSIERS) {
        if (existingIds.has(spec.id)) continue;
        const series = dailyBars.get(spec.symbol);
        if (series === undefined) continue;
        reports.push(toBarBackedSummary(spec, series, now));
        addedIds.push(spec.id);
      }
      const categories = attachIndexEtfCategory(
        catalog.categories.map(({ description, id, label, reportIds }) => ({
          description,
          id,
          label,
          reportIds,
        })),
        addedIds
      );
      return { categories, reports };
    })
  );

const dataset = api.researchReports.dataset
  .use(requireOperator)
  .handler(({ context, errors, input }) =>
    withRepository(context, errors, async (repository) => {
      const report = await repository.getReport(input.reportId);
      if (report === null) {
        const barBacked = await loadBarBackedIndexEtf(
          context.repositories.marketBars,
          input.reportId,
          input.revision
        );
        if (barBacked === null) throw errors.NOT_FOUND();
        const data = synthesizeBarBackedDataset(
          barBacked.spec,
          barBacked.series,
          barBacked.bars,
          input.dataset
        );
        const serialized = JSON.stringify(data);
        return {
          byteLength: Buffer.byteLength(serialized, "utf8"),
          data,
          dataRevision: barBacked.series.sourceSha256,
          dataset: input.dataset,
          reportId: barBacked.spec.id,
          revisions: [barBacked.series.sourceSha256],
          sha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
        };
      }
      const revision = input.revision ?? report.dataRevision;
      const row = await repository.getDataset(
        report.id,
        revision,
        input.dataset
      );
      if (row === null || row.body === null) throw errors.NOT_FOUND();
      return {
        byteLength: row.byteLength,
        data: sanitizeResearchDatasetData(input.dataset, parseBody(row.body)),
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

/**
 * Technicals of one dossier: stored revision technicals plus markers computed from fresher
 * nightly `market_bar_series` (`1d`) bars when no explicit historical revision is pinned, or from
 * the pinned revision's own stored bars. Bars stay on the server; only computed values return.
 */
const technicals = api.researchReports.technicals
  .use(requireOperator)
  .handler(({ context, errors, input }) =>
    withRepository(context, errors, async (repository) => {
      const now = new Date();
      const report = await repository.getReport(input.reportId);
      if (report === null) {
        const barBacked = await loadBarBackedIndexEtf(
          context.repositories.marketBars,
          input.reportId,
          input.revision
        );
        if (barBacked === null) throw errors.NOT_FOUND();
        return {
          ...buildResearchReportTechnicals({
            assetType: "etf",
            liveBars: barBacked.bars,
            liveBarsCollectedAt: barBacked.series.importedAt.toISOString(),
            market: null,
            now,
            technicals: null,
          }),
          dataRevision: barBacked.series.sourceSha256,
          reportId: barBacked.spec.id,
        };
      }
      const revision = input.revision ?? report.dataRevision;
      const stored = await repository.getDataset(
        report.id,
        revision,
        "technicals"
      );
      if (stored === null || stored.body === null) throw errors.NOT_FOUND();
      const market = await repository.getDataset(report.id, revision, "market");
      const liveSeries =
        input.revision === undefined
          ? await findDailyBarSeries(
              context.repositories.marketBars,
              report.symbol,
              report.providerSymbol
            )
          : null;
      const liveBars =
        liveSeries === null
          ? null
          : marketBarColumnsToDossierBars(
              await (
                context.repositories.marketBars as MarketBarsRepository
              ).loadColumns(liveSeries.id)
            );
      return {
        ...buildResearchReportTechnicals({
          assetType: report.assetType,
          liveBars,
          liveBarsCollectedAt:
            liveSeries === null ? null : liveSeries.importedAt.toISOString(),
          market:
            market === null || market.body === null
              ? null
              : parseBody(market.body),
          now,
          technicals: parseBody(stored.body),
        }),
        dataRevision: revision,
        reportId: report.id,
      };
    })
  );

export const researchReportsRouter = {
  companyResearch,
  dataset,
  list,
  technicals,
};
