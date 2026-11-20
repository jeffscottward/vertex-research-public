"use client";

import {
  type ApiClient,
  createApiClient,
  type SmartMoneyRankingOutput,
} from "@darkfactory/api";
import type { SmartMoneySettings } from "./smart-money-params.ts";

// Read-only smart-money ranking (smartMoney.ranking). No write procedure exists.
// The server sorts and filters; an empty ticker is left out of the request.
export interface SmartMoneyGateway {
  readonly ranking: (
    settings: SmartMoneySettings
  ) => Promise<SmartMoneyRankingOutput>;
}

export const createSmartMoneyGateway = (
  client: ApiClient
): SmartMoneyGateway => ({
  ranking: ({ sessions, sort, ticker }) =>
    client.smartMoney.ranking({
      sessions,
      sort,
      ...(ticker === "" ? {} : { ticker }),
    }),
});

export const createBrowserSmartMoneyGateway = (): SmartMoneyGateway => {
  let gateway: SmartMoneyGateway | undefined;
  return Object.freeze({
    ranking: (settings: SmartMoneySettings) => {
      gateway ??= createSmartMoneyGateway(
        createApiClient({ baseUrl: window.location.origin })
      );
      return gateway.ranking(settings);
    },
  });
};
