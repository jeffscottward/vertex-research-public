"use client";

import {
  type ApiClient,
  type CongressTradesFeedOutput,
  createApiClient,
  type OpenbbChanges13fOutput,
  type OpenbbInsiderClustersOutput,
  type OpenbbStatusOutput,
  type SmartMoneyRankingOutput,
} from "@darkfactory/api";
import type { SmartMoneySettings } from "./smart-money-params.ts";

// Read-only smart-money client: separate reads for QuantData large options premium, SEC Form 4
// insider cluster buys, House/Senate Congress PTR disclosures, SEC 13F quarter-over-quarter
// changes, and per-source OpenBB/Flow freshness status. No write procedure exists.
export interface SmartMoneyGateway {
  readonly changes13f?: (ticker: string) => Promise<OpenbbChanges13fOutput>;
  readonly congressFeed?: (ticker: string) => Promise<CongressTradesFeedOutput>;
  readonly insiderClusters?: (
    ticker: string
  ) => Promise<OpenbbInsiderClustersOutput>;
  readonly ranking: (
    settings: SmartMoneySettings
  ) => Promise<SmartMoneyRankingOutput>;
  readonly status?: () => Promise<OpenbbStatusOutput>;
}

export const createSmartMoneyGateway = (
  client: ApiClient
): Required<SmartMoneyGateway> => ({
  changes13f: (ticker) =>
    client.openbb.changes13f({
      change: "all",
      limit: 50,
      ...(ticker === "" ? {} : { ticker }),
    }),
  congressFeed: (ticker) =>
    client.congressTrades.feed({
      days: 30,
      ...(ticker === "" ? {} : { ticker }),
    }),
  insiderClusters: (ticker) =>
    client.openbb.insiderClusters({
      days: 7,
      ...(ticker === "" ? {} : { symbol: ticker }),
    }),
  ranking: ({ sessions, sort, ticker }) =>
    client.smartMoney.ranking({
      sessions,
      sort,
      ...(ticker === "" ? {} : { ticker }),
    }),
  status: () => client.openbb.status({}),
});

export const createBrowserSmartMoneyGateway =
  (): Required<SmartMoneyGateway> => {
    let gateway: Required<SmartMoneyGateway> | undefined;
    const ensure = (): Required<SmartMoneyGateway> => {
      gateway ??= createSmartMoneyGateway(
        createApiClient({ baseUrl: window.location.origin })
      );
      return gateway;
    };
    return Object.freeze({
      changes13f: (ticker: string) => ensure().changes13f(ticker),
      congressFeed: (ticker: string) => ensure().congressFeed(ticker),
      insiderClusters: (ticker: string) => ensure().insiderClusters(ticker),
      ranking: (settings: SmartMoneySettings) => ensure().ranking(settings),
      status: () => ensure().status(),
    });
  };
