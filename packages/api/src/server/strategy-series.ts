import {
  createMarketDailyViews,
  type MarketDailyColumns,
  type MarketDailySeriesRepository,
  TOTAL_RETURN_SUFFIX,
} from "@darkfactory/db/server";

import { canonicalJson, sha256Hex } from "../canonical-json.ts";
import { InstantBacktestInputError } from "../instant-backtest-engine.ts";
import { optionsDefinitionSeriesIds } from "../options-engine/portfolio.ts";
import {
  resolveStrategySeries,
  type StrategyDefinition,
  type StrategySeriesReader,
  strategySeriesRefs,
} from "../strategy-dsl.ts";
import {
  type StrategySeriesInput,
  StrategySeriesDataError,
} from "../strategy-dsl-compile.ts";

// Daily series of a server run, loaded from the series store (market_daily_series). Equity runs
// get the StrategySeriesInput of the refs their definition reads, resolved for the run symbol
// (`<ETF>:TR` is the adjusted close of the ETF row). Options runs get the store rows the options
// runner reads (optionsDefinitionSeriesIds). Rows are cut at the run's `to` (later values are
// never read) and keep the whole history before `from` (indicator warm-up). A series the store
// does not have throws StrategySeriesDataError (the data may still arrive), a ref the symbol has
// no series for throws StrategySeriesSymbolError and a missing store StrategySeriesStoreError.
// The SHA-256 of the loaded rows lets a later step check that the store did not change. Research
// only.

/** The definition reads a relative series (`$iv`, `$tr`, `$future`) the run symbol does not have. */
export class StrategySeriesSymbolError extends InstantBacktestInputError {
  constructor(ref: string, symbol: string) {
    super(`Series data is not available for ${ref} of ${symbol}`);
    this.name = "StrategySeriesSymbolError";
  }
}

/** The definition reads daily series, but no series store is wired on this server. */
export class StrategySeriesStoreError extends InstantBacktestInputError {
  constructor(ids: readonly string[]) {
    super(
      `The daily series store is not available on this server (needed for ${ids.join(", ")})`
    );
    this.name = "StrategySeriesStoreError";
  }
}

/** Store rows by series id, in load order. */
export type StrategySeriesRows = ReadonlyMap<string, MarketDailyColumns>;

export type LoadedStrategySeries = Readonly<{
  /** Store ids in load order. */
  ids: readonly string[];
  rows: StrategySeriesRows;
  /** SHA-256 of the rows as canonical JSON (strategySeriesRowsSha256). */
  sha256: string;
}>;

/** Resolved series ids of every ref the definition reads; a ref the symbol has none of fails. */
const resolvedSeriesIds = (
  definition: StrategySeriesReader,
  symbol: string
): string[] =>
  strategySeriesRefs(definition).map((ref) => {
    const id = resolveStrategySeries(ref, symbol);
    if (id === undefined) throw new StrategySeriesSymbolError(ref, symbol);
    return id;
  });

/**
 * Store ids a run of `definition` on `symbol` reads: the options runner's ids for an options
 * definition, else the refs resolved for the symbol (`<ETF>:TR` reads `<ETF>`). Empty when the
 * definition reads no series.
 */
export const strategySeriesStoreIds = (
  definition: StrategySeriesReader,
  symbol: string
): string[] =>
  definition.options === undefined
    ? [
        ...new Set(
          resolvedSeriesIds(definition, symbol).map((id) =>
            id.endsWith(TOTAL_RETURN_SUFFIX)
              ? id.slice(0, -TOTAL_RETURN_SUFFIX.length)
              : id
          )
        ),
      ]
    : optionsDefinitionSeriesIds(definition as StrategyDefinition, symbol);

/** SHA-256 of store rows as canonical JSON (id -> columns, keys sorted). */
export const strategySeriesRowsSha256 = async (
  rows: StrategySeriesRows
): Promise<string> => await sha256Hex(canonicalJson(Object.fromEntries(rows)));

/** The columns of one series up to `to` (inclusive); the same object when nothing is later. */
const cutColumns = (
  columns: MarketDailyColumns,
  to: string | undefined
): MarketDailyColumns => {
  if (to === undefined || (columns.dates.at(-1) ?? "") <= to) return columns;
  let end = 0;
  while (end < columns.dates.length && (columns.dates[end] as string) <= to)
    end += 1;
  return {
    adjClose: columns.adjClose.slice(0, end),
    close: columns.close.slice(0, end),
    dates: columns.dates.slice(0, end),
    high: columns.high.slice(0, end),
    low: columns.low.slice(0, end),
    open: columns.open.slice(0, end),
  };
};

/**
 * The rows of `ids` from loaded store rows, each cut at `to` (inclusive), in `ids` order. Throws
 * StrategySeriesDataError for the first id that is not loaded.
 */
export const cutStrategySeriesRows = (
  loaded: ReadonlyMap<string, MarketDailyColumns>,
  ids: readonly string[],
  to?: string
): StrategySeriesRows => {
  const rows = new Map<string, MarketDailyColumns>();
  for (const id of ids) {
    const columns = loaded.get(id);
    if (columns === undefined) throw new StrategySeriesDataError(id);
    rows.set(id, cutColumns(columns, to));
  }
  return rows;
};

/**
 * Loads the store rows of `ids` up to `to` (inclusive). Throws StrategySeriesDataError for the
 * first id the store does not have, StrategySeriesStoreError when no store is wired.
 */
export const loadStrategySeriesRows = async (
  repository: MarketDailySeriesRepository | undefined,
  ids: readonly string[],
  to?: string
): Promise<StrategySeriesRows> => {
  if (repository === undefined) throw new StrategySeriesStoreError(ids);
  const loaded = await repository.loadSeries(
    ids,
    to === undefined ? {} : { to }
  );
  return cutStrategySeriesRows(loaded, ids);
};

/** Loads the series one run of `definition` on `symbol` reads, up to `to`; null when none. */
export type StrategySeriesLoader = (
  definition: StrategySeriesReader,
  symbol: string,
  to: string
) => Promise<LoadedStrategySeries | null>;

/** The rows with their SHA-256. */
const withSha = async (
  ids: readonly string[],
  rows: StrategySeriesRows
): Promise<LoadedStrategySeries> => ({
  ids,
  rows,
  sha256: await strategySeriesRowsSha256(rows),
});

/**
 * The rows a run of `definition` on `symbol` reads, up to `to`, with their SHA-256; null when the
 * definition reads no series (then no store is needed).
 */
export const loadStrategySeries = async (
  repository: MarketDailySeriesRepository | undefined,
  definition: StrategySeriesReader,
  symbol: string,
  to?: string
): Promise<LoadedStrategySeries | null> => {
  const ids = strategySeriesStoreIds(definition, symbol);
  if (ids.length === 0) return null;
  return await withSha(ids, await loadStrategySeriesRows(repository, ids, to));
};

/**
 * A loader for several runs that loads the store once: every id of `ids` up to `to` (the latest
 * `to` of the runs), on the first run that reads series. Each run gets its own ids cut at its own
 * `to`, which equals loading them alone (loadStrategySeries) from the same store state.
 */
export const sharedStrategySeriesLoader = (
  repository: MarketDailySeriesRepository | undefined,
  ids: readonly string[],
  to: string
): StrategySeriesLoader => {
  let shared: Promise<ReadonlyMap<string, MarketDailyColumns>> | undefined;
  return async (definition, symbol, runTo) => {
    const runIds = strategySeriesStoreIds(definition, symbol);
    if (runIds.length === 0) return null;
    if (repository === undefined) throw new StrategySeriesStoreError(runIds);
    shared ??= repository.loadSeries(ids, { to });
    return await withSha(
      runIds,
      cutStrategySeriesRows(await shared, runIds, runTo)
    );
  };
};

/**
 * The series input of an equity run: date -> value of every ref the definition reads, resolved
 * for `symbol` (`<ETF>:TR` is the adjusted close of the complete ETF bars, a plain id every
 * stored close). The rows must hold every store id (loadStrategySeries).
 */
export const strategySeriesInput = (
  definition: StrategySeriesReader,
  symbol: string,
  rows: StrategySeriesRows
): StrategySeriesInput => {
  const views = createMarketDailyViews(rows);
  const context: Record<string, Record<string, number>> = {};
  for (const id of resolvedSeriesIds(definition, symbol)) {
    const values = views.series(id);
    if (values === undefined) throw new StrategySeriesDataError(id);
    context[id] = Object.fromEntries(values);
  }
  return { context, symbol };
};

/**
 * The inputs SHA-256 of a run: the bar series hash alone when the run reads no series, else the
 * hash of both (the report's and the Nautilus claim's seriesSha256).
 */
export const runInputsSha256 = async (
  barsSha256: string,
  seriesSha256: string | null
): Promise<string> =>
  seriesSha256 === null
    ? barsSha256
    : await sha256Hex(
        canonicalJson({ bars: barsSha256, series: seriesSha256 })
      );
