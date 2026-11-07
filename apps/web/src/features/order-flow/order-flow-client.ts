// What: browser gateway for read-only IBKR order flow (marketData.ticks: trade prints and bid/ask
// quotes; marketData.depth: a one-shot L2 snapshot) and honest operator text for its failures.
// Neither call subscribes to a new feed or touches orders.
// Used by: components/portal/order-flow-panel.tsx, components/portal/charts-workspace.tsx.
"use client";

import {
  type ApiClient,
  createApiClient,
  type MarketDepthInput,
  type MarketDepthOutput,
  type MarketTicksInput,
  type MarketTicksOutput,
} from "@darkfactory/api";

import { describeMarketDataFailure } from "../../components/portal/market-data-client.ts";

export interface OrderFlowGateway {
  readonly depth: (input: MarketDepthInput) => Promise<MarketDepthOutput>;
  readonly ticks: (input: MarketTicksInput) => Promise<MarketTicksOutput>;
}

export const createBrowserOrderFlowGateway = (): OrderFlowGateway => {
  let client: ApiClient | undefined;
  const api = (): ApiClient => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client;
  };
  return Object.freeze({
    depth: (input: MarketDepthInput) => api().marketData.depth(input),
    ticks: (input: MarketTicksInput) => api().marketData.ticks(input),
  });
};

/** ticks: time & sales, footprint, delta; depth: order book; bars: TPO (30-minute bars). */
export type OrderFlowView = "ticks" | "depth" | "bars";

export type OrderFlowFailureContext = Readonly<{
  view: OrderFlowView;
  symbol: string;
  exchange: string;
}>;

export type OrderFlowFailure = Readonly<{
  code: string;
  /** What the operator should understand; never a guessed price. */
  message: string;
  /** The server's own text, kept for diagnosis. */
  detail: string;
}>;

const WHAT: Readonly<Record<OrderFlowView, string>> = Object.freeze({
  bars: "30-minute bars for the TPO profile",
  depth: "the order book",
  ticks: "trade prints",
});

const entitlementText = ({
  view,
  symbol,
  exchange,
}: OrderFlowFailureContext): string => {
  if (view === "depth")
    return `The IBKR account has no L2 market depth permission for ${symbol} on ${exchange}. The known market data subscriptions are not active for this exchange or venue, so no book is shown and no prices are inferred.`;
  if (view === "ticks")
    return `The IBKR account lacks the market data permission IBKR needs to send historical trade prints for ${symbol} on ${exchange}. The known subscriptions are not active for this venue, so no tape, footprint or delta is shown.`;
  return `The IBKR account lacks the market data permission for ${symbol} history on ${exchange}, so no TPO profile is shown.`;
};

/** Maps oRPC market data errors to operator text for one order flow view. */
export const describeOrderFlowFailure = (
  error: unknown,
  context: OrderFlowFailureContext
): OrderFlowFailure => {
  const { code, message } = describeMarketDataFailure(error);
  const what = WHAT[context.view];
  const text: Record<string, string> = {
    ENTITLEMENT: entitlementText(context),
    NOT_CONFIGURED:
      "The IBKR history service endpoint is not configured on this server, so order flow cannot be fetched here.",
    NOT_FOUND: `No IBKR contract matched ${context.symbol} on ${context.exchange}; check the symbol, exchange and contract month.`,
    PACED: `IBKR pacing: the history service shares one request budget with chart bars, so ${what} were not fetched. Wait about a minute, then refresh this view.`,
    UNAVAILABLE: `The IBKR history service (QuantVPS IB Gateway) is unavailable right now, so ${what} could not be fetched. Nothing shown here is estimated.`,
  };
  return { code, detail: message, message: text[code] ?? message };
};

/** Longest pacing wait the panel sits through on its own; IBKR's 10 min back-off is not retried. */
export const PACED_RETRY_MAX_SECONDS = 90;
/** The history service's minimum spacing (10 s) plus slack, when it names no wait. */
export const PACED_RETRY_DEFAULT_SECONDS = 12;

/**
 * How long to wait before one automatic retry of a paced request, in ms, or null when the
 * failure is not pacing or the reported wait is too long to sit through.
 */
export const pacedRetryDelayMs = (failure: OrderFlowFailure): number | null => {
  if (failure.code !== "PACED") return null;
  const match = /retry in (\d+) s/.exec(failure.detail);
  const seconds =
    match === null ? PACED_RETRY_DEFAULT_SECONDS : Number(match[1]);
  return seconds > PACED_RETRY_MAX_SECONDS ? null : Math.max(seconds, 1) * 1000;
};
