// What: UI lab entries for /charts and /stock/<SYMBOL>: the real ChartsWorkspace and
// StockDetailWorkspace with fake bars, options chain and analytics. /charts reads ?symbol= itself
// (default SPY); the stock entry takes ?symbol= (default SPY), so /lab/stock?symbol=NVDA opens NVDA.
// Order flow uses fictional prints and depth; /lab/charts?depth=entitlement makes the depth snapshot
// fail with ENTITLEMENT (no L2 permission) while the other order flow views still load.
"use client";

import { PageHeader } from "@darkfactory/ui";

import type { BacktestsGateway } from "../../components/portal/agent-ops-client.tsx";
import { ChartsWorkspace } from "../../components/portal/charts-workspace.tsx";
import type { JevVerdictGateway } from "../../components/portal/jev-verdict-client.ts";
import type { MarketDataGateway } from "../../components/portal/market-data-client.ts";
import type { OptionsAnalyticsGateway } from "../../components/portal/options-analytics-client.ts";
import type { OrderFlowGateway } from "../../features/order-flow/order-flow-client.ts";
import {
  createFakeMarketDataGateway,
  createFakeOptionsChainGateway,
} from "../../features/stock-detail/fake-gateways.ts";
import { StockDetailWorkspace } from "../../features/stock-detail/stock-detail-workspace.tsx";
import { labReadOnly } from "../fixtures/core.ts";
import {
  labBarsOutput,
  labDepthEntitlementError,
  labDepthOutput,
  labJevVerdict,
  labOptionsAnalytics,
  labTicksOutput,
} from "../fixtures/market.ts";
import { readLabChoice, readLabSymbol } from "../params.ts";
import type { LabEntry } from "../registry.ts";

const labMarketDataGateway: MarketDataGateway = {
  bars: (input) => Promise.resolve(labBarsOutput(input)),
};

export const labOptionsAnalyticsGateway: OptionsAnalyticsGateway = {
  snapshot: (input) =>
    Promise.resolve(
      labOptionsAnalytics(input.symbol, Number(input.flowHours ?? 24))
    ),
};

/** Empty cached verdict; Ask JEV (refresh) is refused like every lab write. */
export const labJevVerdictGateway: JevVerdictGateway = {
  get: (input) => Promise.resolve(labJevVerdict(input.symbol)),
  refresh: labReadOnly,
};

/** Fictional trade prints, quotes and an L2 book, so every order flow tab renders. */
const labOrderFlowGateway: OrderFlowGateway = {
  depth: (input) => Promise.resolve(labDepthOutput(input)),
  ticks: (input) => Promise.resolve(labTicksOutput(input)),
};

/** Same prints, but the depth snapshot fails like an account without L2 for the venue. */
export const labOrderFlowNoDepthGateway: OrderFlowGateway = {
  depth: () => Promise.reject(labDepthEntitlementError()),
  ticks: labOrderFlowGateway.ticks,
};

/** No backtests in the charts lab: the trade-marker picker shows its empty list. */
const labChartsBacktests: BacktestsGateway = {
  get: labReadOnly,
  list: () => Promise.resolve([]),
};

// The stock page's own dummy gateways (deterministic bars and a Black-Scholes chain).
const labStockMarketData = createFakeMarketDataGateway();
const labStockOptionsChain = createFakeOptionsChainGateway();

export const CHARTS_LAB_ENTRIES: readonly LabEntry[] = [
  {
    group: "Markets & Research",
    id: "charts",
    render: (params) => (
      <div className="space-y-8">
        <PageHeader title="Charts" />
        <ChartsWorkspace
          backtests={labChartsBacktests}
          jevVerdict={labJevVerdictGateway}
          marketData={labMarketDataGateway}
          optionsAnalytics={labOptionsAnalyticsGateway}
          orderFlow={
            readLabChoice(params, "depth", ["ok", "entitlement"], "ok") ===
            "entitlement"
              ? labOrderFlowNoDepthGateway
              : labOrderFlowGateway
          }
        />
      </div>
    ),
    route: "/charts",
    title: "Charts",
  },
  {
    group: "Markets & Research",
    id: "stock",
    render: (params) => {
      const symbol = readLabSymbol(params, "SPY");
      return (
        <div className="space-y-6">
          <PageHeader title={symbol} />
          <StockDetailWorkspace
            marketData={labStockMarketData}
            optionsAnalytics={labOptionsAnalyticsGateway}
            optionsChain={labStockOptionsChain}
            symbol={symbol}
          />
        </div>
      );
    },
    route: "/stock/[symbol]",
    title: "Stock detail",
  },
];
