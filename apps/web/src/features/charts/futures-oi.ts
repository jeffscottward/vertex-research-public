import type { DisplayCandle, SeriesPane } from "./types.ts";

// Page rules of the "OI change" pane under the ES and NQ daily candles: which request shows it,
// how a stored CME figure joins a candle, and when a change is drawn. Pure functions; all dates
// are UTC calendar dates (a daily candle time is 00:00 UTC of its trade date).

export const FUTURES_OI_SERIES = { ES: "CME_ES_OI", NQ: "CME_NQ_OI" } as const;
export type FuturesOiMarket = keyof typeof FUTURES_OI_SERIES;
export type FuturesOiPoint = Readonly<{ date: string; value: number }>;
export type FuturesOiBar = Readonly<{
  // Stored trade date that has a shown candle.
  date: string;
  // Candle time (ms).
  timestamp: number;
  figure: number;
  // Null: no bar is drawn.
  change: number | null;
  // Stored date before this one.
  previousDate: string | null;
  noChange: "first" | "gap" | "expiry" | null;
}>;

const DAY_MS = 86_400_000;
// The read starts before the first candle, so the first candle has a stored day to compare with.
const FROM_DAYS_BEFORE = 10;
const QUARTERLY_MONTHS = [2, 5, 8, 11] as const;
// The renderer accepts at most this number of points in one pane.
const PANE_POINT_LIMIT = 4096;
const SEC_TYPES: readonly string[] = ["CONTFUT", "FUT"];
const CONTRACTS = new Intl.NumberFormat("en-US");
const CHANGE = new Intl.NumberFormat("en-US", { signDisplay: "exceptZero" });

const isMarket = (symbol: string): symbol is FuturesOiMarket =>
  Object.hasOwn(FUTURES_OI_SERIES, symbol);

/** The future whose figures the request can show, or null. A dated contract also matches. */
export const futuresOiMarket = (request: {
  symbol: string;
  secType: string;
  exchange: string | null;
}): FuturesOiMarket | null =>
  isMarket(request.symbol) &&
  SEC_TYPES.includes(request.secType) &&
  request.exchange === "CME"
    ? request.symbol
    : null;

/** True for unmerged daily candles (not the 1W or 1M merge of daily bars). */
export const futuresOiDaily = (barSize: string, merged: boolean): boolean =>
  barSize === "1 day" && !merged;

/** UTC calendar date (`YYYY-MM-DD`) of a candle time. */
export const candleDate = (timestamp: number): string =>
  new Date(timestamp).toISOString().slice(0, 10);

const dateTime = (date: string): number => Date.parse(`${date}T00:00:00Z`);

/** Start date of the series read: 10 days before the first candle; null without candles. */
export const futuresOiFrom = (
  candles: readonly DisplayCandle[]
): string | null => {
  const [first] = candles;
  return first === undefined
    ? null
    : candleDate(first.timestamp - FROM_DAYS_BEFORE * DAY_MS);
};

const thirdFriday = (year: number, month: number): string => {
  const weekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const firstFriday = 1 + ((5 - weekday + 7) % 7);
  return candleDate(Date.UTC(year, month, firstFriday + 14));
};

/** True when a quarterly expiry (third Friday of Mar, Jun, Sep, Dec) is on or after `previousDate` and before `date`. */
export const quarterlyExpiryBetween = (
  previousDate: string,
  date: string
): boolean => {
  const firstYear = Number(previousDate.slice(0, 4));
  const lastYear = Number(date.slice(0, 4));
  for (let year = firstYear; year <= lastYear; year += 1)
    for (const month of QUARTERLY_MONTHS) {
      const expiry = thirdFriday(year, month);
      if (expiry >= previousDate && expiry < date) return true;
    }
  return false;
};

/**
 * One entry per stored date that has a shown candle. A change is drawn only against the trading
 * day before: not for the first stored date, not across a quarterly expiry (the expired contract
 * leaves the total) and not when a shown candle lies between the two stored dates.
 *
 * `points` can start after the first stored date of the series (the read has a from-date), so
 * `firstDate` names that date. A point without an earlier point is "first" only on `firstDate`;
 * on another date the figures before it are missing, which is a gap.
 */
export const futuresOiBars = (
  candles: readonly DisplayCandle[],
  points: readonly FuturesOiPoint[],
  firstDate: string | null
): FuturesOiBar[] => {
  const index = new Map(
    candles.map((candle, position) => [candle.timestamp, position])
  );
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.flatMap((point, position): FuturesOiBar[] => {
    const timestamp = dateTime(point.date);
    const at = index.get(timestamp);
    if (at === undefined) return [];
    const base = { date: point.date, figure: point.value, timestamp };
    const previous = sorted[position - 1];
    if (previous === undefined)
      return [
        {
          ...base,
          change: null,
          noChange: point.date === firstDate ? "first" : "gap",
          previousDate: null,
        },
      ];
    const none = { ...base, change: null, previousDate: previous.date };
    if (quarterlyExpiryBetween(previous.date, point.date))
      return [{ ...none, noChange: "expiry" }];
    const candleBefore = candles[at - 1];
    if (
      candleBefore !== undefined &&
      candleBefore.timestamp > dateTime(previous.date)
    )
      return [{ ...none, noChange: "gap" }];
    return [
      {
        ...base,
        change: point.value - previous.value,
        noChange: null,
        previousDate: previous.date,
      },
    ];
  });
};

/** The histogram pane of the drawn changes; null when no bar has a change. */
export const futuresOiPane = (
  bars: readonly FuturesOiBar[]
): SeriesPane | null => {
  const points = bars.flatMap(({ change, timestamp }) =>
    change === null ? [] : [{ timestamp, value: change }]
  );
  return points.length === 0
    ? null
    : {
        points: points.slice(-PANE_POINT_LIMIT),
        precision: 0,
        title: "OI change",
      };
};

/** Number of shown candles after the newest stored date. */
export const candlesAfter = (
  candles: readonly DisplayCandle[],
  newestDate: string
): number => {
  const newest = dateTime(newestDate);
  return candles.filter((candle) => candle.timestamp > newest).length;
};

export const formatContracts = (value: number): string =>
  CONTRACTS.format(value);

export const formatChange = (value: number): string => CHANGE.format(value);
