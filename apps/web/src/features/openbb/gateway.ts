import {
  type ApiClient,
  type CongressTradesFeedOutput,
  type CongressTradeWindow,
  createApiClient,
  type OpenbbCotOutput,
  type OpenbbEventsOutput,
  type OpenbbInsiderClustersOutput,
  type OpenbbIvHistoryHorizon,
  type OpenbbIvHistoryOutput,
  type OpenbbMacroOutput,
  type OpenbbSecOutput,
  type OpenbbShortsOutput,
  type OpenbbStatusOutput,
  type OpenbbVolContextOutput,
  type SmartMoneyRankingOutput,
  type SmartMoneySessionWindow,
} from "@darkfactory/api";

// Browser access to the read-only openbb.* and symbol-scoped smart-money procedures (operator session).

/** A request with no answer after this long shows when it started, with Retry. */
export const OPENBB_REQUEST_TIMEOUT_MS = 30_000;

export interface OpenbbGateway {
  readonly congressFeed?: (
    symbol: string,
    days: CongressTradeWindow
  ) => Promise<CongressTradesFeedOutput>;
  readonly cot: (weeks: number) => Promise<OpenbbCotOutput>;
  readonly events: (from: string, to: string) => Promise<OpenbbEventsOutput>;
  readonly insiderClusters?: (
    symbol: string,
    days: 7 | 14 | 30
  ) => Promise<OpenbbInsiderClustersOutput>;
  readonly ivHistory: (
    symbol: string,
    sessions?: OpenbbIvHistoryHorizon
  ) => Promise<OpenbbIvHistoryOutput>;
  /** `ids` limits the reply to the named series; without it every series is returned. */
  readonly macro: (
    from: string,
    ids?: readonly string[]
  ) => Promise<OpenbbMacroOutput>;
  readonly sec: (symbol: string) => Promise<OpenbbSecOutput>;
  readonly shorts: (
    symbol: string,
    days: number
  ) => Promise<OpenbbShortsOutput>;
  readonly smartMoneyRanking?: (
    symbol: string,
    sessions: SmartMoneySessionWindow
  ) => Promise<SmartMoneyRankingOutput>;
  /** Newest run of each ingest job (the blocked-upstream notices of the Markets page). */
  readonly status: () => Promise<OpenbbStatusOutput>;
  readonly volContext: () => Promise<OpenbbVolContextOutput>;
}

/** Narrow gateway slice for components that only read rolling IV rank/percentile history. */
export type IvHistoryGateway = Pick<OpenbbGateway, "ivHistory">;

export const createBrowserOpenbbGateway = (): OpenbbGateway => {
  let client: ApiClient | undefined;
  const ensure = (): ApiClient => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client;
  };
  return Object.freeze({
    congressFeed: (symbol: string, days: CongressTradeWindow) =>
      ensure().congressTrades.feed({ days, ticker: symbol }),
    cot: (weeks: number) => ensure().openbb.cot({ weeks }),
    events: (from: string, to: string) => ensure().openbb.events({ from, to }),
    insiderClusters: (symbol: string, days: 7 | 14 | 30) =>
      ensure().openbb.insiderClusters({ days, symbol }),
    ivHistory: (symbol: string, sessions?: OpenbbIvHistoryHorizon) =>
      ensure().openbb.ivHistory(
        sessions === undefined ? { symbol } : { sessions, symbol }
      ),
    macro: (from: string, ids?: readonly string[]) =>
      ensure().openbb.macro(
        ids === undefined ? { from } : { from, ids: [...ids] }
      ),
    sec: (symbol: string) => ensure().openbb.sec({ symbol }),
    shorts: (symbol: string, days: number) =>
      ensure().openbb.shorts({ days, symbol }),
    smartMoneyRanking: (symbol: string, sessions: SmartMoneySessionWindow) =>
      ensure().smartMoney.ranking({
        sessions,
        sort: "net_bullish",
        ticker: symbol,
      }),
    status: () => ensure().openbb.status({}),
    volContext: () => ensure().openbb.volContext({}),
  });
};
