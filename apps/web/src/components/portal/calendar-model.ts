// What: the /calendar agenda model: economic releases (market-watch-bot macro events from
// marketContext.get) and earnings dates read from SEC 8-K item 2.02 ("earnings results") filings
// (marketNews.watchlist), merged, sorted and grouped by day. Pure functions; no I/O.
// Used by: calendar-workspace.tsx, calendar-agenda.tsx, market-news-workspace.tsx (Earnings dates).
import type {
  MarketContextOutput,
  MarketNewsFiling,
  MarketNewsHours,
  MarketNewsTicker,
} from "@darkfactory/api";

/** 8-K item 2.02: results of operations and financial condition (an earnings release). */
const EARNINGS_8K_ITEM = "2.02";

/** The calendar asks the news monitor for its widest window, so a quarter's releases show. */
export const CALENDAR_NEWS_HOURS: MarketNewsHours = 720;

export const CALENDAR_FILTERS = ["all", "economic", "earnings"] as const;
export type CalendarFilter = (typeof CALENDAR_FILTERS)[number];

export const CALENDAR_FILTER_LABELS: Readonly<Record<CalendarFilter, string>> =
  {
    all: "All",
    earnings: "Earnings",
    economic: "Economic",
  };

export type CalendarEntry =
  | Readonly<{
      kind: "economic";
      key: string;
      date: string;
      time: string | null;
      name: string;
    }>
  | Readonly<{
      kind: "earnings";
      key: string;
      date: string;
      time: string;
      symbol: string;
      title: string;
      url: string;
    }>;

export interface CalendarDay {
  readonly date: string;
  readonly entries: readonly CalendarEntry[];
}

export interface TickerEarnings {
  /** The SEC filings source failure for this symbol, without its "filings:" prefix. */
  readonly error: string | null;
  /** Newest 8-K item 2.02 filing in the loaded window; null when there is none. */
  readonly filing: MarketNewsFiling | null;
  readonly symbol: string;
}

export const isEarningsFiling = (filing: MarketNewsFiling): boolean =>
  filing.items.some((item) => item.code === EARNINGS_8K_ITEM);

const FILINGS_ERROR_PREFIX = "filings:";

/** Latest earnings filing per ticker, in the order the news monitor returned the tickers. */
export const latestEarningsFilings = (
  tickers: readonly MarketNewsTicker[]
): TickerEarnings[] =>
  tickers.map((ticker) => ({
    error:
      ticker.errors
        .find((error) => error.startsWith(FILINGS_ERROR_PREFIX))
        ?.slice(FILINGS_ERROR_PREFIX.length)
        .trim() ?? null,
    filing: ticker.filings
      .filter(isEarningsFiling)
      .reduce<MarketNewsFiling | null>(
        (latest, filing) =>
          latest === null || filing.filedAt > latest.filedAt ? filing : latest,
        null
      ),
    symbol: ticker.symbol,
  }));

// Economic releases are published in New York time, so filings are placed on the same clock.
const EASTERN = "America/New_York";
const EASTERN_DATE = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: EASTERN,
  year: "numeric",
});
const EASTERN_TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: EASTERN,
});

/** New York calendar day (YYYY-MM-DD) of an instant. */
export const easternDate = (value: Date): string => EASTERN_DATE.format(value);

/** New York wall-clock time of an instant, "16:05 ET". */
export const easternTime = (value: Date): string =>
  `${EASTERN_TIME.format(value)} ET`;

const DAY_LABEL = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  weekday: "short",
  year: "numeric",
});

/** "2026-11-06" -> "Fri, Nov 6, 2026" (the date itself, in no particular zone). */
export const formatCalendarDay = (date: string): string =>
  DAY_LABEL.format(new Date(`${date}T00:00:00.000Z`));

/** Economic releases the rig reported; none when the macro section is missing. */
export const economicEntries = (
  macro: MarketContextOutput["macro"]
): CalendarEntry[] =>
  (macro?.events ?? []).map((event) => ({
    date: event.date,
    key: `economic:${event.date}:${event.time ?? ""}:${event.name}`,
    kind: "economic",
    name: event.name,
    time: event.time,
  }));

/** Every 8-K item 2.02 filing in the loaded window, dated on the New York clock. */
export const earningsEntries = (
  tickers: readonly MarketNewsTicker[]
): CalendarEntry[] =>
  tickers.flatMap((ticker) =>
    ticker.filings.filter(isEarningsFiling).map((filing) => ({
      date: easternDate(filing.filedAt),
      key: `earnings:${ticker.symbol}:${filing.url}`,
      kind: "earnings" as const,
      symbol: ticker.symbol,
      time: easternTime(filing.filedAt),
      title: filing.title,
      url: filing.url,
    }))
  );

/** Drops repeats (the same release or filing twice), sorts and groups the entries by day. */
export const groupCalendarDays = (
  entries: readonly CalendarEntry[]
): CalendarDay[] => {
  const unique = new Map(entries.map((entry) => [entry.key, entry]));
  // Oldest day first; within a day untimed entries, then by time, economic before earnings.
  const sorted = [...unique.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.time ?? "")
        .replace(" ET", "")
        .localeCompare((b.time ?? "").replace(" ET", "")) ||
      b.kind.localeCompare(a.kind) ||
      (a.kind === "economic" ? a.name : a.symbol).localeCompare(
        b.kind === "economic" ? b.name : b.symbol
      )
  );
  const days = new Map<string, CalendarEntry[]>();
  for (const entry of sorted) {
    const day = days.get(entry.date);
    if (day === undefined) days.set(entry.date, [entry]);
    else day.push(entry);
  }
  return [...days].map(([date, dayEntries]) => ({
    date,
    entries: dayEntries,
  }));
};

export const filterCalendarEntries = (
  entries: readonly CalendarEntry[],
  filter: CalendarFilter
): CalendarEntry[] =>
  filter === "all"
    ? [...entries]
    : entries.filter((entry) => entry.kind === filter);
