"use client";

// What: the /markets page body: header (status chip from both feeds, Refresh), an optional slot under
// the header (the breadth-90 signal card), then volatility
// (ibkr-monitor) and GEX, macro and macro news (market-watch-bot). Read-only public market data.
// Used by: apps/web/src/app/(portal)/markets/page.tsx.
// See: market-context-workspace.tsx, market-feeds-workspace.tsx, market-source-status.ts.
import { Button, PageHeader, StatusBadge } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { type ReactNode, useState } from "react";

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
  /** Rendered directly under the header, above both workspaces (the breadth-90 signal card). */
  readonly belowHeader?: ReactNode;
  readonly contextGateway?: MarketContextGateway;
  readonly feedsGateway?: MarketFeedsGateway;
}

export const MarketContextPage = ({
  belowHeader,
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
            // Each workspace reports its own busy flag when the new load starts and settles; the
            // page does not preset it, so a load that settles before that render cannot leave the
            // button stuck disabled. Late responses are ignored inside each workspace.
            onClick={() => setRefreshSignal((count) => count + 1)}
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
      {belowHeader}
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
