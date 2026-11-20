"use client";

import {
  type ApiClient,
  createApiClient,
  type MarketNewsHours,
  type MarketNewsInclude,
  type MarketNewsWatchlistOutput,
} from "@darkfactory/api";

import { utcClock } from "../status-time.ts";

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
 * A failed marketNews.watchlist request for the page. `message` names the case without a "press
 * Try again" step; `retryable` says whether the same request can work when it is sent again.
 */
export interface MarketNewsFailure {
  readonly message: string;
  readonly retryable: boolean;
}

// The API ends the message of a failure that a retry can fix with "; retry" (for example
// "Watchlist storage: database request failed; retry"). The page shows that step once, as
// "press Try again", so the suffix is cut here.
const RETRY_SUFFIX = /;\s*retry$/u;

/**
 * The case of an oRPC failure and whether a retry can help. A new sign-in or another account is
 * needed for UNAUTHORIZED and FORBIDDEN, and the operator for storage that is not configured: the
 * page must not ask the user to try those again.
 */
export const describeMarketNewsFailure = (
  error: unknown
): MarketNewsFailure => {
  const code = nonEmpty(field(error, "code"));
  const message = nonEmpty(field(error, "message"));
  switch (code) {
    case "UNAUTHORIZED": {
      return { message: "Session expired. Sign in again.", retryable: false };
    }
    case "FORBIDDEN": {
      return { message: "Not permitted for this session.", retryable: false };
    }
    case "STORAGE_ERROR": {
      // The page and the API deploy together, so a server text must end with "; retry" when a
      // retry can help; a STORAGE_ERROR text without it is not retryable.
      // The server message names the subsystem, the case and its own next step: "; retry" for a
      // failed database request, "; ask the operator" for storage that is not configured.
      if (message === null)
        return { message: "Watchlist storage request failed", retryable: true };
      return RETRY_SUFFIX.test(message)
        ? { message: message.replace(RETRY_SUFFIX, ""), retryable: true }
        : { message, retryable: false };
    }
    default: {
      // Any other failure (transport, upstream, server error): a retry is the next step.
      const cause = message?.replace(RETRY_SUFFIX, "") ?? "Request failed";
      return { message: `${code ?? "ERROR"}: ${cause}`, retryable: true };
    }
  }
};

/**
 * Status line of a workspace whose marketNews.watchlist request failed: state, cause, time and,
 * only when a retry can help, the next step. `subject` is what was not loaded ("News").
 */
export const marketNewsFailureLine = (
  subject: string,
  failure: MarketNewsFailure & { readonly failedAt: number }
): string =>
  `${subject} not loaded: ${failure.message} · ${utcClock(failure.failedAt)}${failure.retryable ? " · press Try again" : ""}`;
