// What: time & sales rows (newest first) and the coverage line for a fetched tick window, with
// clock times in the contract's exchange time zone.
// Used by: components/portal/order-flow-panel.tsx.
import type { SignedTrade, SigningMethod, TradeSide } from "./trade-signing.ts";
import { defined } from "./defined.ts";

export type TimeAndSalesRow = Readonly<{
  key: string;
  t: number;
  time: string;
  price: number;
  size: number;
  side: TradeSide;
  method: SigningMethod;
  bid: number | null;
  ask: number | null;
  venue: string | null;
  conditions: string | null;
}>;

export type TickCoverage = Readonly<{
  count: number;
  first: number | null;
  last: number | null;
  /** "500 trades, 14:02:11-14:03:40 ET" */
  label: string;
}>;

const ZONE_ABBREVIATIONS: Readonly<Record<string, string>> = Object.freeze({
  "America/Chicago": "CT",
  "America/New_York": "ET",
  "US/Central": "CT",
  "US/Eastern": "ET",
  UTC: "UTC",
});

/** An IANA zone Intl accepts, else UTC (IBKR timeZoneId can be null or unknown). */
export const resolveTimeZone = (
  timeZone: string | null | undefined
): string => {
  if (timeZone === null || timeZone === undefined || timeZone === "")
    return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
};

/** Short label for the zone: ET / CT for the US exchange zones, else Intl's short name. */
export const timeZoneLabel = (timeZone: string): string => {
  const known = ZONE_ABBREVIATIONS[timeZone];
  if (known !== undefined) return known;
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  })
    .formatToParts(new Date(0))
    .find((item) => item.type === "timeZoneName");
  return defined(part, "time zone name").value;
};

const clockFormats = new Map<string, Intl.DateTimeFormat>();

/** HH:MM:SS (24 h) of a unix-seconds time in the zone. */
export const formatClock = (t: number, timeZone: string): string => {
  let format = clockFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      second: "2-digit",
      timeZone,
    });
    clockFormats.set(timeZone, format);
  }
  return format.format(new Date(t * 1000));
};

/** Newest print first, as a tape reads. */
export const timeAndSalesRows = (
  trades: readonly SignedTrade[],
  timeZone: string
): TimeAndSalesRow[] =>
  trades
    .map((trade, index) => ({
      ask: trade.ask,
      bid: trade.bid,
      conditions: trade.conditions,
      key: `${trade.t}:${index}`,
      method: trade.method,
      price: trade.price,
      side: trade.side,
      size: trade.size,
      t: trade.t,
      time: formatClock(trade.t, timeZone),
      venue: trade.venue,
    }))
    .reverse();

export const tickCoverage = (
  trades: readonly { t: number }[],
  timeZone: string
): TickCoverage => {
  if (trades.length === 0)
    return { count: 0, first: null, label: "0 trades", last: null };
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const trade of trades) {
    first = Math.min(first, trade.t);
    last = Math.max(last, trade.t);
  }
  const noun = trades.length === 1 ? "trade" : "trades";
  return {
    count: trades.length,
    first,
    label: `${trades.length} ${noun}, ${formatClock(first, timeZone)}-${formatClock(last, timeZone)} ${timeZoneLabel(timeZone)}`,
    last,
  };
};
