import type {
  OpenbbCotOutput,
  OpenbbEventsOutput,
  OpenbbMacroOutput,
  OpenbbShortsOutput,
  OpenbbVolContextOutput,
} from "@darkfactory/api";

// Pure view models of the OpenBB panels (/markets, /flow, /stock/[symbol] filings tab).
// docs/vertex-rebuild/openbb.md. Research input only, never a trade signal.

export const MISSING = "—";
export const NOT_COLLECTED = "Not yet collected";

/** Main COT category per report type: leveraged funds (TFF), managed money (disaggregated). */
const COT_MAIN_CATEGORY = {
  disaggregated: "managed_money",
  tff: "leveraged_funds",
} as const;
/** Reports back for the COT change column. */
export const COT_CHANGE_WEEKS = 4;
/** Weeks of COT history the panel requests (the change needs 4 earlier reports, holidays shift). */
export const COT_REQUEST_WEEKS = 8;
/** Days the report COT_CHANGE_WEEKS rows earlier may be off 28 days (holiday weeks move it). */
const COT_CHANGE_TOLERANCE_DAYS = 3;
/** History the macro table requests; it shows each series' newest point. */
export const MACRO_HISTORY_DAYS = 400;
export const EVENTS_AHEAD_DAYS = 14;
const SHORT_VOLUME_SESSIONS = 20;

const NY_DATE = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});
const COMPACT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

/** New York calendar date of `now`, shifted by `days`. */
export const nyDate = (now: Date, days = 0): string =>
  new Date(Date.parse(`${NY_DATE.format(now)}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

export const formatNumber = (value: number | null, digits = 2): string =>
  value === null ? MISSING : value.toFixed(digits);
/** A decimal (0.153) as a percent (15.3%). */
export const formatPercent = (value: number | null, digits = 1): string =>
  value === null ? MISSING : `${(value * 100).toFixed(digits)}%`;
export const formatCompact = (value: number | null): string =>
  value === null ? MISSING : COMPACT.format(value);
export const formatSignedCompact = (value: number | null): string =>
  value === null ? MISSING : `${value > 0 ? "+" : ""}${COMPACT.format(value)}`;

/** A macro value in its unit; dollar series (TGA, SOMA, WALCL) compact as $1.2T. */
export const formatMacroValue = (value: number | null, unit: string): string =>
  value === null
    ? MISSING
    : unit === "usd"
      ? `$${COMPACT.format(value)}`
      : `${value.toFixed(2)} ${unit}`;

/** Newest date of a list, or null when empty. */
export const newestDate = (dates: readonly string[]): string | null =>
  [...dates].sort().at(-1) ?? null;

export type VxCurveRow = Readonly<{
  contractMonth: string;
  latest: number | null;
  earlier: number | null;
  change: number | null;
}>;

/** Latest and 5-sessions-earlier VX curve side by side, by contract month. */
export const vxCurveRows = (
  curve: OpenbbVolContextOutput["vxCurve"]
): VxCurveRow[] => {
  const latest = new Map(
    (curve.latest?.points ?? []).map((point) => [
      point.contractMonth,
      point.price,
    ])
  );
  const earlier = new Map(
    (curve.earlier?.points ?? []).map((point) => [
      point.contractMonth,
      point.price,
    ])
  );
  return [...new Set([...latest.keys(), ...earlier.keys()])]
    .sort()
    .map((contractMonth) => {
      const now = latest.get(contractMonth) ?? null;
      const before = earlier.get(contractMonth) ?? null;
      return {
        change: now === null || before === null ? null : now - before,
        contractMonth,
        earlier: before,
        latest: now,
      };
    });
};

export type IvTableRow = Readonly<{
  underlying: string;
  asOf: string;
  atmIv30d: number | null;
  ivPercentile: number | null;
  sessions: number;
  skew25d: number | null;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
}>;

/** Core 7 IV rows with the 25-delta skew (put IV minus call IV). */
export const ivTableRows = (
  rows: OpenbbVolContextOutput["ivDaily"]
): IvTableRow[] =>
  rows.map((row) => ({
    asOf: row.asOf,
    atmIv30d: row.atmIv30d,
    callWall: row.callWall,
    gammaFlip: row.gammaFlip,
    ivPercentile: row.ivPercentile,
    putWall: row.putWall,
    sessions: row.sessions,
    skew25d:
      row.putIv25d30d === null || row.callIv25d30d === null
        ? null
        : row.putIv25d30d - row.callIv25d30d,
    underlying: row.underlying,
  }));

export type CotSummaryRow = Readonly<{
  market: string;
  category: string;
  reportDate: string;
  net: number;
  change: number | null;
}>;

const daysBetween = (later: string, earlier: string): number =>
  (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) /
  86_400_000;

/**
 * Latest net per market (main category) and its change against the report COT_CHANGE_WEEKS rows
 * earlier, accepted only when that report is 28 ± 3 days older; else the change is null.
 */
export const cotSummary = (rows: OpenbbCotOutput["rows"]): CotSummaryRow[] => {
  const byMarket = new Map<string, OpenbbCotOutput["rows"]>();
  for (const row of rows) {
    if (row.category !== COT_MAIN_CATEGORY[row.reportType]) continue;
    byMarket.set(row.market, [...(byMarket.get(row.market) ?? []), row]);
  }
  return [...byMarket.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([market, marketRows]) => {
      const newestFirst = [...marketRows].sort((a, b) =>
        b.reportDate.localeCompare(a.reportDate)
      );
      const latest = newestFirst[0] as (typeof newestFirst)[number];
      const earlier = newestFirst[COT_CHANGE_WEEKS];
      const aligned =
        earlier !== undefined &&
        Math.abs(
          daysBetween(latest.reportDate, earlier.reportDate) -
            7 * COT_CHANGE_WEEKS
        ) <= COT_CHANGE_TOLERANCE_DAYS;
      return {
        category: latest.category,
        change: aligned ? latest.net - earlier.net : null,
        market,
        net: latest.net,
        reportDate: latest.reportDate,
      };
    });
};

export type MacroRow = Readonly<{
  id: string;
  name: string;
  unit: string;
  value: number | null;
  asOf: string | null;
}>;

/** Newest value and its date of every macro series. */
export const macroRows = (series: OpenbbMacroOutput["series"]): MacroRow[] =>
  series.map((row) => {
    const last = row.points.at(-1);
    return {
      asOf: last?.date ?? null,
      id: row.id,
      name: row.name,
      unit: row.unit,
      value: last?.value ?? null,
    };
  });

/** Events from `today` through EVENTS_AHEAD_DAYS days ahead. */
export const upcomingEvents = (
  events: OpenbbEventsOutput["events"],
  today: string
): OpenbbEventsOutput["events"] => {
  const until = nyDate(new Date(`${today}T12:00:00Z`), EVENTS_AHEAD_DAYS);
  return events.filter((event) => event.date >= today && event.date <= until);
};

export type OtcWeekRow = Readonly<{
  weekStart: string;
  ats: number;
  nonAts: number;
}>;

/** Weekly off-exchange shares (ATS and non-ATS), newest week first. */
export const otcWeeks = (
  rows: OpenbbShortsOutput["otcWeekly"]
): OtcWeekRow[] => {
  const weeks = new Map<string, { ats: number; nonAts: number }>();
  for (const row of rows) {
    const week = weeks.get(row.weekStart) ?? { ats: 0, nonAts: 0 };
    if (row.venue === "ats") week.ats += row.shares;
    else week.nonAts += row.shares;
    weeks.set(row.weekStart, week);
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([weekStart, week]) => ({ ...week, weekStart }));
};

/** The newest SHORT_VOLUME_SESSIONS daily short volume rows, newest first. */
export const recentShortVolume = (
  rows: OpenbbShortsOutput["shortVolume"]
): OpenbbShortsOutput["shortVolume"] =>
  [...rows]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, SHORT_VOLUME_SESSIONS);
