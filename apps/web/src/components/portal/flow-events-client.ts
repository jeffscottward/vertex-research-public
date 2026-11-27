"use client";

import {
  type ApiClient,
  createApiClient,
  FLOW_INSTRUMENTS,
  FLOW_SYMBOLS,
  type FlowEventsInput,
  type FlowEventsOutput,
  type FlowSnapshot,
  type FlowSnapshotInput,
  type FlowSymbol,
  type MarketSecType,
} from "@darkfactory/api";

// Display-only reader for stored IBKR flow_events (stacked imbalances, absorption).
// Research input only; no order path.
export interface FlowEventsGateway {
  readonly events: (input: FlowEventsInput) => Promise<FlowEventsOutput>;
}
export interface FlowSnapshotGateway {
  readonly snapshot: (input: FlowSnapshotInput) => Promise<FlowSnapshot>;
}

const FLOW_SYMBOL_SET: Readonly<Record<string, true>> = Object.fromEntries(
  FLOW_SYMBOLS.map((symbol) => [symbol, true] as const)
);

/**
 * Matches a chart request against the collected IBKR flow_events universe: SPY/QQQ are US
 * equities (STK), while ES/NQ are CME futures (FUT or CONTFUT) — preventing an NYSE equity
 * chart for ES (Eversource Energy) from overlaying E-mini S&P 500 futures marks.
 */
export const isFlowInstrument = (
  symbol: string,
  secType: MarketSecType
): symbol is FlowSymbol => {
  if (!Object.hasOwn(FLOW_SYMBOL_SET, symbol)) return false;
  const instrument = FLOW_INSTRUMENTS[symbol as FlowSymbol];
  return instrument.kind === "future"
    ? secType === "FUT" || secType === "CONTFUT"
    : secType === "STK";
};

export const createBrowserFlowEventsGateway = (): FlowEventsGateway => {
  let client: ApiClient | undefined;
  const api = (): ApiClient => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client;
  };
  return Object.freeze({
    events: (input: FlowEventsInput) => api().flow.events(input),
  });
};

export const createBrowserFlowSnapshotGateway = (): FlowSnapshotGateway => {
  let client: ApiClient | undefined;
  const api = (): ApiClient => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client;
  };
  return Object.freeze({
    snapshot: (input: FlowSnapshotInput) => api().flow.snapshot(input),
  });
};
