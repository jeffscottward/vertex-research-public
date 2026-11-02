import type {
  MarketBarColumns,
  MarketBarSeries,
  MarketBarsRepository,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  INSTANT_BACKTEST_EQUITY_MAX_POINTS,
  type InstantBacktestSeries,
} from "../contracts/instant-backtest.ts";
import {
  downsampleIndexes,
  InstantBacktestInputError,
  type InstantRunResult,
  runInstantBacktest,
} from "../instant-backtest-engine.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// Instant backtest procedures. Bars load once per series version into a small in-process cache of
// typed arrays, so a parameter change costs only the engine run. Research only; no order path.

// Bounded by series count and by bytes (5 Float64 columns per bar). A load in flight is shared, so
// concurrent misses for one series read the bars once.
const CACHE_MAX_SERIES = 4;
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const BYTES_PER_BAR = 6 * Float64Array.BYTES_PER_ELEMENT;

type CachedColumns = Readonly<{
  version: string;
  bytes: number;
  columns: Promise<MarketBarColumns>;
}>;

const columnCache = new Map<string, CachedColumns>();

export const clearInstantBacktestCacheForTesting = (): void => {
  columnCache.clear();
};

type InstantBacktestErrorFactories = Readonly<{
  NOT_FOUND: () => Error;
  BAD_REQUEST: (options?: { message?: string }) => Error;
  STORAGE_ERROR: () => Error;
}>;

const versionOf = (series: MarketBarSeries): string =>
  `${series.sourceSha256}|${series.importedAt.toISOString()}|${series.barCount}`;

const toSeriesOutput = (series: MarketBarSeries): InstantBacktestSeries => ({
  barCount: series.barCount,
  firstT: series.firstT,
  importedAt: series.importedAt.toISOString(),
  lastT: series.lastT,
  source: series.source,
  sourceSha256: series.sourceSha256,
  symbol: series.symbol,
  timeframe: series.timeframe,
});

const repositoryFor = (
  context: ApiContext,
  failures: InstantBacktestErrorFactories
): MarketBarsRepository => {
  const repository = context.repositories.marketBars;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

/** Returns cached columns for the current series version, loading them on a miss. */
export const columnsFor = async (
  repository: MarketBarsRepository,
  series: MarketBarSeries
): Promise<{ columns: MarketBarColumns; hit: boolean }> => {
  const version = versionOf(series);
  const cached = columnCache.get(series.id);
  columnCache.delete(series.id);
  if (cached?.version === version) {
    columnCache.set(series.id, cached);
    return { columns: await cached.columns, hit: true };
  }
  const entry: CachedColumns = {
    bytes: series.barCount * BYTES_PER_BAR,
    columns: repository.loadColumns(series.id),
    version,
  };
  columnCache.set(series.id, entry);
  let total = 0;
  for (const value of columnCache.values()) total += value.bytes;
  // Map order is least recently used first; the new entry is last and always stays.
  for (const [key, value] of columnCache) {
    const withinLimits =
      columnCache.size <= CACHE_MAX_SERIES && total <= CACHE_MAX_BYTES;
    if (key === series.id || withinLimits) break;
    columnCache.delete(key);
    total -= value.bytes;
  }
  try {
    return { columns: await entry.columns, hit: false };
  } catch (error) {
    if (columnCache.get(series.id) === entry) columnCache.delete(series.id);
    throw error;
  }
};

const api = implement(appContract).$context<ApiContext>();

const instantBacktestSeries = api.instantBacktest.series
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = errors as unknown as InstantBacktestErrorFactories;
    const repository = repositoryFor(context, failures);
    let rows: MarketBarSeries[];
    try {
      rows = await repository.listSeries();
    } catch {
      throw failures.STORAGE_ERROR();
    }
    return { series: rows.map(toSeriesOutput) };
  });

const instantBacktestRun = api.instantBacktest.run
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as InstantBacktestErrorFactories;
    const repository = repositoryFor(context, failures);
    const loadStarted = performance.now();
    let series: MarketBarSeries | null;
    try {
      series = await repository.getSeries(input.symbol, input.timeframe);
    } catch {
      throw failures.STORAGE_ERROR();
    }
    if (series === null) throw failures.NOT_FOUND();
    let loaded: { columns: MarketBarColumns; hit: boolean };
    try {
      loaded = await columnsFor(repository, series);
    } catch {
      throw failures.STORAGE_ERROR();
    }
    const computeStarted = performance.now();
    let result: InstantRunResult;
    try {
      result = runInstantBacktest(loaded.columns, {
        costBps: input.costBps,
        rule: input.rule,
        stopLossPct: input.stopLossPct,
        takeProfitPct: input.takeProfitPct,
      });
    } catch (error) {
      if (error instanceof InstantBacktestInputError) {
        throw failures.BAD_REQUEST({ message: error.message });
      }
      throw error;
    }
    const indexes = downsampleIndexes(
      result.equity.length,
      INSTANT_BACKTEST_EQUITY_MAX_POINTS
    );
    const equity = indexes.map((index) => ({
      equity: result.equity[index] as number,
      t: loaded.columns.t[index] as number,
    }));
    const finished = performance.now();
    return {
      equity,
      series: toSeriesOutput(series),
      stats: result.stats,
      timing: {
        cache: loaded.hit ? ("hit" as const) : ("miss" as const),
        computeMs: finished - computeStarted,
        loadMs: computeStarted - loadStarted,
      },
    };
  });

export const instantBacktestRouter = {
  run: instantBacktestRun,
  series: instantBacktestSeries,
};
