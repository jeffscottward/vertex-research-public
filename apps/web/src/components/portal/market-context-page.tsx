"use client";

// What: the /markets page body: header (status chip from both feeds, Refresh), then volatility
// (ibkr-monitor) and GEX, macro and macro news (market-watch-bot). Read-only public market data.
// Used by: apps/web/src/app/(portal)/markets/page.tsx.
// See: market-context-workspace.tsx, market-feeds-workspace.tsx, market-source-status.ts.
import { Button, PageHeader, StatusBadge } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { useState } from "react";

import {
  type MarketContextGateway,
  MarketContextWorkspace,
} from "./market-context-workspace.tsx";
import {
  type MarketFeedsGateway,
  MarketFeedsWorkspace,
} from "./market-feeds-workspace.tsx";
import {
  type MarketSourceStatus,
  summarizeMarketStatus,
} from "./market-source-status.ts";

export interface MarketContextPageProps {
  readonly contextGateway?: MarketContextGateway;
  readonly feedsGateway?: MarketFeedsGateway;
}

export const MarketContextPage = ({
  contextGateway,
  feedsGateway,
}: MarketContextPageProps) => {
  const [volatility, setVolatility] = useState<MarketSourceStatus>("loading");
  const [feeds, setFeeds] = useState<MarketSourceStatus>("loading");
  // Each workspace reports whether a load (mount, Refresh, timer, Retry) is in flight; both start one.
  const [volatilityBusy, setVolatilityBusy] = useState(true);
  const [feedsBusy, setFeedsBusy] = useState(true);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const summary = summarizeMarketStatus([volatility, feeds]);
  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            className="min-h-11"
            disabled={volatilityBusy || feedsBusy}
            onClick={() => {
              // Hold the button now; each workspace clears its flag when its new load settles.
              setVolatilityBusy(true);
              setFeedsBusy(true);
              setRefreshSignal((count) => count + 1);
            }}
            variant="secondary"
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        }
        description="Volatility, gamma exposure, macro series and macro news. Public data, refreshed every minute; read-only."
        status={
          <StatusBadge data-market-status={summary.label} status={summary.tone}>
            {summary.label}
          </StatusBadge>
        }
        title="Market context"
      />
      <MarketContextWorkspace
        {...(contextGateway === undefined ? {} : { gateway: contextGateway })}
        onBusyChange={setVolatilityBusy}
        onStatusChange={setVolatility}
        refreshSignal={refreshSignal}
      />
      <MarketFeedsWorkspace
        {...(feedsGateway === undefined ? {} : { gateway: feedsGateway })}
        onBusyChange={setFeedsBusy}
        onStatusChange={setFeeds}
        refreshSignal={refreshSignal}
      />
    </div>
  );
};
