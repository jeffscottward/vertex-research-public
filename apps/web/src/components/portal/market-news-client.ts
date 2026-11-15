"use client";

import {
  type ApiClient,
  createApiClient,
  type MarketNewsHours,
  type MarketNewsInclude,
  type MarketNewsWatchlistOutput,
} from "@darkfactory/api";

// Read-only news monitor (marketNews.watchlist) for the signed-in user's watchlist.
// `include: "filings"` reads 8-K filings only (the calendar), skipping every headline source.
export interface MarketNewsGateway {
  readonly watchlist: (
    hours: MarketNewsHours,
    include?: MarketNewsInclude
  ) => Promise<MarketNewsWatchlistOutput>;
}

export const createMarketNewsGateway = (
  client: ApiClient
): MarketNewsGateway => ({
  watchlist: (hours, include = "all") =>
    client.marketNews.watchlist({ hours, include }),
});

export const createBrowserMarketNewsGateway = (): MarketNewsGateway => {
  let gateway: MarketNewsGateway | undefined;
  const current = (): MarketNewsGateway => {
    gateway ??= createMarketNewsGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    watchlist: (hours: MarketNewsHours, include?: MarketNewsInclude) =>
      current().watchlist(hours, include),
  });
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

/** One line for the page from an oRPC failure. */
export const describeMarketNewsFailure = (error: unknown): string => {
  switch (field(error, "code")) {
    case "UNAUTHORIZED": {
      return "Session expired. Sign in again.";
    }
    case "FORBIDDEN": {
      return "Not permitted for this session.";
    }
    case "STORAGE_ERROR": {
      return "Watchlist storage unavailable.";
    }
    default: {
      return "Request failed. Retry.";
    }
  }
};
