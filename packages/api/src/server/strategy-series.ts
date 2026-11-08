import {
  createMarketDailyViews,
  type MarketDailyColumns,
  type MarketDailySeriesRepository,
  TOTAL_RETURN_SUFFIX,
} from "@darkfactory/db/server";

import { canonicalJson, sha256Hex } from "../canonical-json.ts";
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
// never read) and keep the whole history before `from` (indicator warm-up). A missing series
// fails the run (StrategySeriesDataError). The SHA-256 of the loaded rows lets a later step check
// that the store did not change. Research only.

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
    if (id === undefined)
      throw new StrategySeriesDataError(`${ref} of ${symbol}`);
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

/**
 * Loads the store rows of `ids` up to `to` (inclusive). Throws StrategySeriesDataError for the
 * first id the store does not have, or when no store is wired.
 */
export const loadStrategySeriesRows = async (
  repository: MarketDailySeriesRepository | undefined,
  ids: readonly string[],
  to?: string
): Promise<StrategySeriesRows> => {
  if (repository === undefined) {
    throw new StrategySeriesDataError(ids.join(", "));
  }
  const loaded = await repository.loadSeries(
    ids,
    to === undefined ? {} : { to }
  );
  const rows = new Map<string, MarketDailyColumns>();
  for (const id of ids) {
    const columns = loaded.get(id);
    if (columns === undefined) throw new StrategySeriesDataError(id);
    rows.set(id, columns);
  }
  return rows;
};

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
  const rows = await loadStrategySeriesRows(repository, ids, to);
  return { ids, rows, sha256: await strategySeriesRowsSha256(rows) };
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
