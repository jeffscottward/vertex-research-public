// What: the load state each /markets workspace reports to the page header, and the header chip
// that sums both up (volatility from ibkr-monitor; GEX, macro and news from market-watch-bot).
// Used by: market-context-workspace.tsx, market-feeds-workspace.tsx, market-context-page.tsx.

export type MarketSourceStatus =
  | "loading"
  | "ready"
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

const failed = (status: MarketSourceStatus): boolean =>
  status === "error" || status === "forbidden";

/** One chip for the page: loading wins, then access, failures, staleness, then live. */
export const summarizeMarketStatus = (
  sources: readonly MarketSourceStatus[]
): MarketStatusSummary => {
  if (sources.includes("loading")) return { label: "Loading", tone: "info" };
  if (sources.every((status) => status === "forbidden"))
    return { label: "Operator only", tone: "neutral" };
  if (sources.every(failed))
    return { label: "Unavailable", tone: "destructive" };
  if (sources.some(failed)) return { label: "Partial", tone: "warning" };
  if (sources.includes("stale")) return { label: "Stale", tone: "warning" };
  return { label: "Live", tone: "success" };
};
