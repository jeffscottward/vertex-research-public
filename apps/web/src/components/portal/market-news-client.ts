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

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * One line for the page from an oRPC failure: the case and the next step. The workspace that shows
 * it adds the time of the failure.
 */
export const describeMarketNewsFailure = (error: unknown): string => {
  const code = nonEmpty(field(error, "code"));
  const message = nonEmpty(field(error, "message"));
  switch (code) {
    case "UNAUTHORIZED": {
      return "Session expired. Sign in again.";
    }
    case "FORBIDDEN": {
      return "Not permitted for this session.";
    }
    case "STORAGE_ERROR": {
      // The server message names the case (not configured, or a failed database request).
      return `Watchlist not loaded: ${message ?? "storage request failed; retry"}`;
    }
    default: {
      return `${code ?? "ERROR"}: ${message ?? "Request failed; retry"}`;
    }
  }
};
