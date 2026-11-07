"use client";

// What: Relationships tab of the watchlist: a heatmap table of Pearson correlations between the
// daily returns of the analysed watchlist symbols (one year of daily bars), with each symbol's
// bars state. The matrix fills in as bars arrive; failed symbols stay listed with a retry.
// Used by: watchlist-workspace.tsx.

import { Panel } from "@darkfactory/ui";

import {
  correlationFill,
  correlationMatrix,
  dailyReturns,
  MIN_CORRELATION_OVERLAP,
  type ReturnSeries,
} from "./watchlist-analytics.ts";
import { BarsStatusList, type WatchlistBars } from "./watchlist-bars.tsx";

export interface WatchlistRelationshipsProps {
  /** Analysed symbols (capped), in watchlist order. */
  readonly symbols: readonly string[];
  /** Symbols on the whole watchlist. */
  readonly totalSymbols: number;
  readonly bars: WatchlistBars;
}

export const WatchlistRelationships = ({
  symbols,
  totalSymbols,
  bars,
}: WatchlistRelationshipsProps) => {
  const series: ReturnSeries[] = [];
  for (const symbol of symbols) {
    const state = bars.states.get(symbol);
    if (state?.type === "ready")
      series.push({ returns: dailyReturns(state.closes), symbol });
  }
  const matrix = correlationMatrix(series);
  const stateTypes = symbols.map(
    (symbol) => bars.states.get(symbol)?.type ?? "loading"
  );
  const loading = stateTypes.includes("loading");
  const partial = stateTypes.some((type) => type !== "ready");

  return (
    <Panel
      description={
        <>
          Correlation of daily close-to-close returns over the last year
          {totalSymbols > symbols.length
            ? ` · first ${symbols.length} of ${totalSymbols} symbols`
            : ""}
          . A pair needs {MIN_CORRELATION_OVERLAP} shared trading days.
        </>
      }
      headingId="watchlist-relationships-heading"
      title="Correlation matrix"
    >
      <div className="space-y-4">
        <BarsStatusList
          bars={bars}
          label="Daily bars by symbol"
          symbols={symbols}
        />
        {series.length < 2 ? (
          <p className="text-muted-foreground text-sm">
            {loading
              ? "Waiting for daily bars of at least two symbols…"
              : "Needs daily bars for at least two symbols."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="border-separate border-spacing-0.5 font-mono text-xs">
              <caption className="sr-only">
                Correlation of daily returns between watchlist symbols
                {partial
                  ? " (partial: some symbols still loading or failed)"
                  : ""}
              </caption>
              <thead>
                <tr>
                  <td />
                  {series.map((column) => (
                    <th
                      className="px-2 py-1 font-medium"
                      key={column.symbol}
                      scope="col"
                    >
                      {column.symbol}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.map((row) => (
                  <tr key={row.symbol}>
                    <th className="px-2 py-1 text-left font-medium" scope="row">
                      {row.symbol}
                    </th>
                    {row.cells.map((cell) => (
                      <td
                        className="min-w-14 rounded-sm px-2 py-1.5 text-center tabular-nums"
                        data-cell={`${cell.row}:${cell.column}`}
                        key={cell.column}
                        style={{ backgroundColor: correlationFill(cell.value) }}
                        title={
                          cell.value === null
                            ? `${cell.row} / ${cell.column}: ${cell.overlap} shared days (needs ${MIN_CORRELATION_OVERLAP} with movement)`
                            : `${cell.row} / ${cell.column}: ${cell.value.toFixed(2)} over ${cell.overlap} days`
                        }
                      >
                        {cell.value === null ? "—" : cell.value.toFixed(2)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-muted-foreground text-xs">
              Blue: move together (+1). Red: move opposite (−1). Pale: little
              relation.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
};
