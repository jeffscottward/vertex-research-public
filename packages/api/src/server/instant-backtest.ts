import type {
  MarketBarColumns,
  MarketBarSeries,
  MarketBarsRepository,
} from "@darkfactory/db/server";
import {
  BACKTEST_UNIVERSES,
  DEFAULT_BACKTEST_UNIVERSE_ID,
} from "@darkfactory/shared/universes";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import { BACKTEST_RUN_DEFAULT_CAPITAL } from "../contracts/backtest-runs.ts";
import type { EngineComparisonTiming } from "../contracts/engine-comparison.ts";
import {
  INSTANT_BACKTEST_EQUITY_MAX_POINTS,
  type InstantBacktestRunInput,
  type InstantBacktestSeries,
} from "../contracts/instant-backtest.ts";
import {
  barDate,
  measureWall,
  typescriptSide,
  type WallTime,
} from "../engine-comparison.ts";
import {
  downsampleIndexes,
  InstantBacktestInputError,
  type InstantRunResult,
  runInstantBacktest,
} from "../instant-backtest-engine.ts";
import type { ApiContext } from "./context.ts";
import { comparisonQueueFor } from "./engine-comparison.ts";
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

/** Error text of a comparison that could not be queued; the TypeScript result stands. */
export const COMPARISON_QUEUE_ERROR = "Nautilus comparison could not be queued";

/**
 * Queues the instant backtest on Nautilus when engine comparison is on: the same rule over the
 * same bars (the whole series). Returns the timing for the answer, or undefined when off.
 */
const queueInstantComparison = async (
  context: ApiContext & Readonly<{ principal: { userId: string } }>,
  input: InstantBacktestRunInput,
  series: MarketBarSeries,
  columns: MarketBarColumns,
  result: InstantRunResult,
  wall: WallTime
): Promise<EngineComparisonTiming | undefined> => {
  const queue = comparisonQueueFor(context, context.principal.userId);
  if (queue === null) return undefined;
  const timing = { host: queue.host, ...wall };
  try {
    const groupId = await queue.enqueue({
      feature: "instant",
      runs: [
        {
          label: `${input.symbol} ${input.timeframe} ${input.rule.kind}`,
          spec: {
            costBps: input.costBps,
            from: barDate(columns.t[0] as number),
            initialCapital: BACKTEST_RUN_DEFAULT_CAPITAL,
            rule: input.rule,
            stopLossPct: input.stopLossPct,
            symbol: series.symbol,
            takeProfitPct: input.takeProfitPct,
            timeframe: series.timeframe,
            to: barDate(columns.t.at(-1) as number),
          },
          typescript: typescriptSide(result, wall, queue.host),
        },
      ],
    });
    return { ...timing, groupId };
  } catch {
    return { ...timing, error: COMPARISON_QUEUE_ERROR, groupId: null };
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

const instantBacktestUniverses = api.instantBacktest.universes
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
    return {
      defaultUniverseId: DEFAULT_BACKTEST_UNIVERSE_ID,
      universes: BACKTEST_UNIVERSES.map((universe) => ({
        description: universe.description,
        id: universe.id,
        label: universe.label,
        members: universe.members.map((member) => ({
          market: member.market,
          storedTimeframes: rows
            .filter((row) => row.symbol === member.symbol)
            .map((row) => row.timeframe),
          symbol: member.symbol,
          twin: member.twin,
        })),
      })),
    };
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
    let wall: WallTime;
    try {
      const measured = measureWall(
        () => performance.now(),
        () =>
          runInstantBacktest(loaded.columns, {
            costBps: input.costBps,
            rule: input.rule,
            stopLossPct: input.stopLossPct,
            takeProfitPct: input.takeProfitPct,
          })
      );
      result = measured.value;
      wall = measured;
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
    const comparison = await queueInstantComparison(
      context,
      input,
      series,
      loaded.columns,
      result,
      {
        wallMs: wall.wallMs,
        ...(wall.wallNote === undefined ? {} : { wallNote: wall.wallNote }),
      }
    );
    return {
      ...(comparison === undefined ? {} : { comparison }),
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
  universes: instantBacktestUniverses,
};
