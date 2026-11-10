// Test-only: a vertex-history 1.3.0 stand-in for the merged-bars call sites (merged-bars.ts). A fetch
// that answers history URLs with a bars document echoing the request and passes every other URL to
// the site's Yahoo fake.

import type { MarketBar } from "../contracts/market-data.ts";
import type { DeployStatusConfig, DeployStatusFetch } from "./deploy-status.ts";

export const HISTORY_CONFIG: DeployStatusConfig = Object.freeze({
  token: "h".repeat(43),
  url: "https://quantvps.tailnet.test:8443/vertex-history/v1",
});

/** One IBKR bar; `v` as the service sends it (US stock volume in lots of 100). */
export const historyBar = (t: number, c: number, v = 10): MarketBar => ({
  c,
  h: c + 1,
  l: c - 1,
  o: c,
  t,
  v,
});

export type HistoryExtra = Readonly<{ stale?: boolean; longName?: string }>;

/** A vertex-history-bars-v1 response for the request in `url`. */
export const historyResponse = (
  url: string,
  bars: readonly MarketBar[],
  extra: HistoryExtra = {}
): Response => {
  const params = new URL(url).searchParams;
  const end = params.get("endDateTime");
  const exchange = params.get("exchange") ?? "SMART";
  return Response.json({
    as_of: null,
    bars,
    cache: {
      age_seconds: 0,
      hit: false,
      stale: extra.stale === true,
      ttl_seconds: 3600,
    },
    client_id: 77,
    contract: {
      conId: 1,
      currency: "USD",
      exchange,
      lastTradeDateOrContractMonth: null,
      localSymbol: params.get("symbol"),
      longName: extra.longName ?? null,
      matches: 1,
      multiplier: null,
      secType: params.get("secType"),
      timeZoneId: "US/Eastern",
    },
    count: bars.length,
    fetched_at: "2026-11-10T20:00:00Z",
    request: {
      barSize: params.get("barSize"),
      contractMonth: null,
      currency: params.get("currency"),
      duration: params.get("duration"),
      exchange,
      secType: params.get("secType"),
      symbol: params.get("symbol"),
      useRTH: params.get("useRTH") === "1",
      whatToShow: params.get("whatToShow"),
      ...(end === null ? {} : { endDateTime: end }),
    },
    schema: "vertex-history-bars-v1",
    source: "ibkr-gateway",
  });
};

/** Routes history URLs to `history` (recording them) and every other URL to `other`. */
export const withHistory = (
  history: (url: string) => Response,
  other: DeployStatusFetch
) => {
  const urls: string[] = [];
  const fetch: DeployStatusFetch = async (url, init) => {
    if (!url.startsWith(HISTORY_CONFIG.url)) return other(url, init);
    urls.push(url);
    return history(url);
  };
  return { fetch, urls };
};
