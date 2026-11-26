"use client";

// What: the /markets page body: header (status chip from regime + both feeds, Refresh), the unified
// market regime section (QQQ, SPY, IWM, DIA), an optional slot under it (owner market notes and
// the breadth-90 signal card), then volatility (ibkr-monitor) and GEX, macro and macro news
// (market-watch-bot). Read-only public market data.
// Used by: apps/web/src/app/(portal)/markets/page.tsx.
// See: market-regime-section.tsx, market-context-workspace.tsx, market-feeds-workspace.tsx, market-source-status.ts.
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
  type MarketRegimeGateway,
  MarketRegimeSection,
} from "./market-regime-section.tsx";
import {
  type MarketSourceStatus,
  summarizeMarketStatus,
} from "./market-source-status.ts";

export interface MarketContextPageProps {
  /** Rendered under the regime section, above both workspaces (owner market notes, breadth-90). */
  readonly belowHeader?: ReactNode;
  readonly contextGateway?: MarketContextGateway;
  readonly feedsGateway?: MarketFeedsGateway;
  /** Clock for the S&P 500 quote age; the lab passes its fixed time. */
  readonly now?: () => Date;
  readonly regimeGateway?: MarketRegimeGateway;
}

export const MarketContextPage = ({
  belowHeader,
  contextGateway,
  feedsGateway,
  now,
  regimeGateway,
}: MarketContextPageProps) => {
  const [regime, setRegime] = useState<MarketSourceStatus>("loading");
  const [volatility, setVolatility] = useState<MarketSourceStatus>("loading");
  const [feeds, setFeeds] = useState<MarketSourceStatus>("loading");
  // Each section reports whether a load (mount, Refresh, timer, Retry) is in flight; all start one.
  const [regimeBusy, setRegimeBusy] = useState(true);
  const [volatilityBusy, setVolatilityBusy] = useState(true);
  const [feedsBusy, setFeedsBusy] = useState(true);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const summary = summarizeMarketStatus([regime, volatility, feeds]);
  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            className="min-h-11"
            disabled={regimeBusy || volatilityBusy || feedsBusy}
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
      <MarketRegimeSection
        {...(regimeGateway === undefined ? {} : { gateway: regimeGateway })}
        onBusyChange={setRegimeBusy}
        onStatusChange={setRegime}
        refreshSignal={refreshSignal}
      />
      {belowHeader}
      <MarketContextWorkspace
        {...(contextGateway === undefined ? {} : { gateway: contextGateway })}
        {...(now === undefined ? {} : { now })}
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
