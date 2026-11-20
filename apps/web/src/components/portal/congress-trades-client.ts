"use client";

import {
  type ApiClient,
  type CongressTradesFeedOutput,
  createApiClient,
} from "@darkfactory/api";
import type { CongressTradesSettings } from "./congress-trades-params.ts";

// Read-only Congress trade feed (congressTrades.feed). No write procedure exists.
// Filters run on the server; empty filters are left out of the request.
export interface CongressTradesGateway {
  readonly feed: (
    settings: CongressTradesSettings
  ) => Promise<CongressTradesFeedOutput>;
}

export const createCongressTradesGateway = (
  client: ApiClient
): CongressTradesGateway => ({
  feed: ({ chamber, days, member, ticker }) =>
    client.congressTrades.feed({
      days,
      ...(chamber === "" ? {} : { chamber }),
      ...(member === "" ? {} : { member }),
      ...(ticker === "" ? {} : { ticker }),
    }),
});

export const createBrowserCongressTradesGateway = (): CongressTradesGateway => {
  let gateway: CongressTradesGateway | undefined;
  return Object.freeze({
    feed: (settings: CongressTradesSettings) => {
      gateway ??= createCongressTradesGateway(
        createApiClient({ baseUrl: window.location.origin })
      );
      return gateway.feed(settings);
    },
  });
};
