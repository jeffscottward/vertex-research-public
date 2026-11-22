// What: the load state each /markets workspace reports to the page header, and the header chip
// that sums both up (volatility from ibkr-monitor; GEX, macro and news from market-watch-bot).
// Used by: market-context-workspace.tsx, market-feeds-workspace.tsx, market-context-page.tsx.
import type {
  MarketContextOutput,
  MarketVolatilityOutput,
} from "@darkfactory/api";

export type MarketSourceStatus =
  | "loading"
  | "ready"
  | "partial"
  | "stale"
  | "error"
  | "forbidden";

export type MarketStatusTone =
  | "neutral"
  | "success"
  | "warning"
  | "info"
  | "destructive";

export interface MarketStatusSummary {
  readonly label: string;
  readonly tone: MarketStatusTone;
}

/** Maximum age of an S&P 500 quote while the session is open (15 min) or closed (96 h). */
export const SPX_OPEN_STALE_MS = 15 * 60_000;
export const SPX_CLOSED_STALE_MS = 96 * 60 * 60_000;

/** True when an S&P 500 quote has a parseable timestamp older than the session age limit. */
export const isSpxQuoteStale = (
  spx: MarketVolatilityOutput["spx"],
  nowMs: number = Date.now()
): boolean => {
  if (spx === null || spx.quoteTime === null) return false;
  const quoteMs = Date.parse(spx.quoteTime);
  if (!Number.isFinite(quoteMs)) return false;
  const limitMs = spx.sessionOpen ? SPX_OPEN_STALE_MS : SPX_CLOSED_STALE_MS;
  return nowMs - quoteMs > limitMs;
};

/** Volatility answered: partial when a source failed, stale when any series or S&P quote is stale. */
export const volatilitySourceStatus = (
  data: MarketVolatilityOutput,
  nowMs: number = Date.now()
): MarketSourceStatus => {
  if (data.sourceErrors.length > 0) return "partial";
  const series = [data.vix, data.vixeq, data.vvix, data.spread];
  return series.some((reading) => reading?.stale === true) ||
    isSpxQuoteStale(data.spx, nowMs)
    ? "stale"
    : "ready";
};

/** Feeds answered: partial when the rig could not read a section, stale when it stopped pushing. */
export const feedsSourceStatus = (
  data: MarketContextOutput
): MarketSourceStatus => {
  if (data.missing.length > 0) return "partial";
  return data.stale ? "stale" : "ready";
};

const failed = (status: MarketSourceStatus): boolean =>
  status === "error" || status === "forbidden";

/** One chip for the page: loading wins, then access, failures and gaps, staleness, then live. */
export const summarizeMarketStatus = (
  sources: readonly MarketSourceStatus[]
): MarketStatusSummary => {
  if (sources.includes("loading")) return { label: "Loading", tone: "info" };
  if (sources.every((status) => status === "forbidden"))
    return { label: "Operator only", tone: "neutral" };
  if (sources.every(failed))
    return { label: "Unavailable", tone: "destructive" };
  if (sources.some(failed) || sources.includes("partial"))
    return { label: "Partial", tone: "warning" };
  if (sources.includes("stale")) return { label: "Stale", tone: "warning" };
  return { label: "Live", tone: "success" };
};
