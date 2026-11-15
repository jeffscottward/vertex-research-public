import type { MarketDailyColumns } from "./market-daily-series.ts";

// The research views of loaded daily series, matching services/research/strategies/qc_ports/data.py:
// - barsOf(id): rows with close > 0 and open, high, low and adj_close present (data.load_bars);
// - closes(id): date -> close for every stored row (data.load_series);
// - series("<ID>:TR"): date -> adj_close of barsOf(ID), the total-return close.
// Pure functions over repository output; no database access.

export const TOTAL_RETURN_SUFFIX = ":TR";

/** Complete daily bars in date order; `close` is the traded close, `adjClose` the total-return close. */
export type MarketDailyBars = Readonly<{
  dates: string[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  adjClose: number[];
}>;

export type MarketDailyViews = Readonly<{
  /** Complete bars of a stored series; undefined when the series is not loaded. */
  barsOf: (id: string) => MarketDailyBars | undefined;
  /** date -> close of every stored row; undefined when the series is not loaded. */
  closes: (id: string) => Map<string, number> | undefined;
  /** A plain id reads closes(id); `<ID>:TR` reads the adjusted close of barsOf(ID). */
  series: (ref: string) => Map<string, number> | undefined;
}>;

/** data.load_bars: keep a row only when close > 0 and open, high, low and adj_close are present. */
export const marketDailyBars = (
  columns: MarketDailyColumns
): MarketDailyBars => {
  const bars: MarketDailyBars = {
    adjClose: [],
    close: [],
    dates: [],
    high: [],
    low: [],
    open: [],
  };
  for (const [index, date] of columns.dates.entries()) {
    const close = columns.close[index] as number;
    const open = columns.open[index] as number | null;
    const high = columns.high[index] as number | null;
    const low = columns.low[index] as number | null;
    const adjClose = columns.adjClose[index] as number | null;
    if (
      !(close > 0) ||
      open === null ||
      high === null ||
      low === null ||
      adjClose === null
    ) {
      continue;
    }
    bars.dates.push(date);
    bars.open.push(open);
    bars.high.push(high);
    bars.low.push(low);
    bars.close.push(close);
    bars.adjClose.push(adjClose);
  }
  return bars;
};

/** data.load_series: date -> close of every stored row. */
export const marketDailyCloses = (
  columns: MarketDailyColumns
): Map<string, number> =>
  new Map(
    columns.dates.map((date, index) => [date, columns.close[index] as number])
  );

/** `<ETF>:TR`: date -> adj_close of the complete bars. */
export const marketDailyTotalReturn = (
  columns: MarketDailyColumns
): Map<string, number> => {
  const bars = marketDailyBars(columns);
  return new Map(
    bars.dates.map((date, index) => [date, bars.adjClose[index] as number])
  );
};

export const createMarketDailyViews = (
  loaded: ReadonlyMap<string, MarketDailyColumns>
): MarketDailyViews => {
  const view =
    <T>(build: (columns: MarketDailyColumns) => T) =>
    (id: string): T | undefined => {
      const columns = loaded.get(id);
      return columns === undefined ? undefined : build(columns);
    };
  const closes = view(marketDailyCloses);
  const totalReturn = view(marketDailyTotalReturn);
  return {
    barsOf: view(marketDailyBars),
    closes,
    series: (ref) =>
      ref.endsWith(TOTAL_RETURN_SUFFIX)
        ? totalReturn(ref.slice(0, -TOTAL_RETURN_SUFFIX.length))
        : closes(ref),
  };
};
