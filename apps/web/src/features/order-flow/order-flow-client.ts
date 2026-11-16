// What: browser gateway for read-only IBKR order flow (marketData.ticks: trade prints and bid/ask
// quotes; marketData.depth: a one-shot L2 snapshot) and honest operator text for its failures.
// An UNAVAILABLE failure names since when this panel's requests fail and its last successful
// request (createHistoryServiceWatch). Neither call subscribes to a new feed or touches orders.
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
import { sinceClock } from "../../components/portal/portfolio-monitor-model.ts";

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

/** The refusals with a fixed operator text; any other code keeps the server's text. */
const refusalText = (
  context: OrderFlowFailureContext
): Record<string, string> => ({
  ENTITLEMENT: entitlementText(context),
  NOT_CONFIGURED:
    "The IBKR history service endpoint is not configured on this server, so order flow cannot be fetched here.",
  NOT_FOUND: `No IBKR contract matched ${context.symbol} on ${context.exchange}; check the symbol, exchange and contract month.`,
  PACED: `IBKR pacing: the history service shares one request budget with chart bars, so ${WHAT[context.view]} were not fetched. Wait about a minute, then refresh this view.`,
});

/**
 * The text for an UNAVAILABLE failure. It states only what the panel measured: since when its
 * requests fail and when one last succeeded. The panel loads on demand, so it cannot know when the
 * service stopped. The text stays on screen until the view loads again, so it names its own time
 * ("as of"): a later success in another view does not make it false.
 */
const allFailedText = (
  what: string,
  sinceMs: number,
  lastSuccessMs: number | null,
  nowMs: number
): string => {
  const last =
    lastSuccessMs === null
      ? "no successful request in this panel yet"
      : `last successful request ${sinceClock(lastSuccessMs, nowMs)}`;
  return `IBKR history service (QuantVPS IB Gateway), as of ${sinceClock(nowMs, nowMs)}: every request of this panel has failed since ${sinceClock(sinceMs, nowMs)} · ${last} · ${what} not fetched, nothing shown here is estimated · press Refresh to try again`;
};

/**
 * What one order flow panel has seen of the IBKR history service: its last successful request and
 * the first failed request of the current run of failures (browser clock, when the answer arrived).
 * A run starts with an UNAVAILABLE failure. Only a successful request ends it: a failure with
 * another code is no proof that the service works.
 */
export type HistoryServiceWatch = Readonly<{
  /** Wraps one request: a result ends the run of failures and sets the last-success time. */
  watch: <Input, Output>(
    run: (input: Input) => Promise<Output>
  ) => (input: Input) => Promise<Output>;
  /** Operator text for one failed request; an UNAVAILABLE failure starts or continues the run. */
  describe: (
    error: unknown,
    context: OrderFlowFailureContext
  ) => OrderFlowFailure;
}>;

export const createHistoryServiceWatch = (
  now: () => number = Date.now
): HistoryServiceWatch => {
  let lastSuccessMs: number | null = null;
  let failingSinceMs: number | null = null;
  return Object.freeze({
    describe: (error: unknown, context: OrderFlowFailureContext) => {
      const { code, message } = describeMarketDataFailure(error);
      if (code !== "UNAVAILABLE")
        return {
          code,
          detail: message,
          message: refusalText(context)[code] ?? message,
        };
      const nowMs = now();
      const sinceMs = failingSinceMs ?? nowMs;
      failingSinceMs = sinceMs;
      return {
        code,
        detail: message,
        message: allFailedText(
          WHAT[context.view],
          sinceMs,
          lastSuccessMs,
          nowMs
        ),
      };
    },
    watch:
      <Input, Output>(run: (input: Input) => Promise<Output>) =>
      async (input: Input): Promise<Output> => {
        const output = await run(input);
        lastSuccessMs = now();
        failingSinceMs = null;
        return output;
      },
  });
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
