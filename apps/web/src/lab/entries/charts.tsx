// What: UI lab entry for /charts: the real ChartsWorkspace with fake bars and options analytics.
// The workspace reads ?symbol= itself (default SPY), so /lab/charts?symbol=NVDA opens NVDA.
"use client";

import { PageHeader } from "@darkfactory/ui";

import type { BacktestsGateway } from "../../components/portal/agent-ops-client.tsx";
import { ChartsWorkspace } from "../../components/portal/charts-workspace.tsx";
import type { MarketDataGateway } from "../../components/portal/market-data-client.ts";
import type { OptionsAnalyticsGateway } from "../../components/portal/options-analytics-client.ts";
import { labReadOnly } from "../fixtures/core.ts";
import { labBarsOutput, labOptionsAnalytics } from "../fixtures/market.ts";
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

/** No backtests in the charts lab: the trade-marker picker shows its empty list. */
const labChartsBacktests: BacktestsGateway = {
  get: labReadOnly,
  list: () => Promise.resolve([]),
};

export const CHARTS_LAB_ENTRIES: readonly LabEntry[] = [
  {
    group: "Markets & Research",
    id: "charts",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Charts" />
        <ChartsWorkspace
          backtests={labChartsBacktests}
          marketData={labMarketDataGateway}
          optionsAnalytics={labOptionsAnalyticsGateway}
        />
      </div>
    ),
    route: "/charts",
    title: "Charts",
  },
];
