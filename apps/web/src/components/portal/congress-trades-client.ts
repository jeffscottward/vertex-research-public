"use client";

import {
  type ApiClient,
  type CongressTradesFeedOutput,
  type CongressTradeWindow,
  createApiClient,
} from "@darkfactory/api";

// Read-only House STOCK Act PTR filing feed (congressTrades.feed). No write procedure exists.
export interface CongressTradesGateway {
  readonly feed: (
    days: CongressTradeWindow
  ) => Promise<CongressTradesFeedOutput>;
}

export const createCongressTradesGateway = (
  client: ApiClient
): CongressTradesGateway => ({
  feed: (days) => client.congressTrades.feed({ days }),
});

export const createBrowserCongressTradesGateway = (): CongressTradesGateway => {
  let gateway: CongressTradesGateway | undefined;
  return Object.freeze({
    feed: (days: CongressTradeWindow) => {
      gateway ??= createCongressTradesGateway(
        createApiClient({ baseUrl: window.location.origin })
      );
      return gateway.feed(days);
    },
  });
};
