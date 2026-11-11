"use client";

// What: the /calendar page body. Economic releases come from market-watch-bot's macro events
// (marketContext.get, operator only); earnings dates from SEC 8-K item 2.02 filings for the
// watchlist (marketNews.watchlist, 30-day window). Read-only research; no orders.
// Used by: apps/web/src/app/(portal)/calendar/page.tsx. See: calendar-model.ts, calendar-agenda.tsx.
import type {
  MarketContextOutput,
  MarketNewsWatchlistOutput,
} from "@darkfactory/api";
import { Button, PageHeader, StatusBadge } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { OperatorAccessRequired } from "./agent-ops-client.tsx";
import { CalendarAgenda } from "./calendar-agenda.tsx";
import {
  CALENDAR_NEWS_HOURS,
  type CalendarFilter,
  earningsEntries,
  easternDate,
  economicEntries,
  latestEarningsFilings,
} from "./calendar-model.ts";
import {
  createBrowserMarketFeedsGateway,
  type MarketFeedsGateway,
} from "./market-feeds-workspace.tsx";
import {
  createBrowserMarketNewsGateway,
  describeMarketNewsFailure,
  type MarketNewsGateway,
} from "./market-news-client.ts";
import { formatNewsTime } from "./market-news-workspace.tsx";
import {
  type MarketSourceStatus,
  summarizeMarketStatus,
} from "./market-source-status.ts";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";

type ContextState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; data: MarketContextOutput }>;

type NewsState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; news: MarketNewsWatchlistOutput }>;

export interface CalendarWorkspaceProps {
  readonly contextGateway?: MarketFeedsGateway;
  readonly newsGateway?: MarketNewsGateway;
  /** Clock for the Today marker; the system clock by default. */
  readonly now?: () => Date;
}

const RetryButton = ({ onRetry }: Readonly<{ onRetry: () => void }>) => (
  <Button onClick={onRetry} size="sm" variant="outline">
    <RotateCcw aria-hidden="true" className="size-4" />
    Try again
  </Button>
);

const EconomicNotes = ({
  state,
  onRetry,
}: Readonly<{ state: ContextState; onRetry: () => void }>) => {
  if (state.type === "loading") return null;
  if (state.type === "forbidden")
    return <OperatorAccessRequired feature="market-context" />;
  if (state.type === "error")
    return (
      <div className="space-y-2" data-calendar-source="economic" role="alert">
        <p className="text-sm">
          Economic releases unavailable. {state.message}
        </p>
        <RetryButton onRetry={onRetry} />
      </div>
    );
  const { data } = state;
  const macroMissing = data.macro === null || data.missing.includes("macro");
  return (
    <div className="space-y-1" data-calendar-source="economic">
      <p className="text-muted-foreground text-xs" role="note">
        Economic releases: macro calendar from market-watch-bot on the rig,
        pushed {formatNewsTime(new Date(data.generatedAt))}.
      </p>
      {data.stale ? (
        <p className="text-sm" data-calendar-stale="" role="alert">
          The rig has not pushed for more than 15 minutes. Economic releases may
          be out of date.
        </p>
      ) : null}
      {macroMissing ? (
        <p className="text-sm" data-calendar-missing="" role="alert">
          The rig could not read macro data on its last push, so no economic
          releases are shown.
        </p>
      ) : null}
    </div>
  );
};

const EarningsNotes = ({
  state,
  onRetry,
}: Readonly<{ state: NewsState; onRetry: () => void }>) => {
  if (state.type === "loading") return null;
  if (state.type === "error")
    return (
      <div className="space-y-2" data-calendar-source="earnings" role="alert">
        <p className="text-sm">Earnings filings unavailable. {state.message}</p>
        <RetryButton onRetry={onRetry} />
      </div>
    );
  const { tickers } = state.news;
  const gaps = latestEarningsFilings(tickers)
    .filter((ticker) => ticker.error !== null)
    .map((ticker) => ticker.symbol);
  return (
    <div className="space-y-1" data-calendar-source="earnings">
      <p className="text-muted-foreground text-xs" role="note">
        Earnings dates: SEC EDGAR 8-K item 2.02 (earnings results) filings for
        the 25 newest symbols on your watchlist over the last 30 days. The SEC
        does not publish upcoming report dates. Updated{" "}
        {formatNewsTime(state.news.receivedAt)}.
      </p>
      {tickers.length === 0 ? (
        <p className="text-sm" data-calendar-watchlist-empty="">
          Your watchlist is empty, so no earnings dates are shown.{" "}
          <Link
            className="font-medium underline underline-offset-4"
            href="/watchlist"
            prefetch={false}
          >
            Open watchlist
          </Link>
        </p>
      ) : null}
      {gaps.length === 0 ? null : (
        <p className="text-sm" data-calendar-gaps="" role="alert">
          SEC filings unavailable for {gaps.join(", ")}.
        </p>
      )}
    </div>
  );
};

const contextStatus = (state: ContextState): MarketSourceStatus => {
  if (state.type !== "ready") return state.type;
  const { data } = state;
  if (data.macro === null || data.missing.includes("macro")) return "partial";
  return data.stale ? "stale" : "ready";
};

export const CalendarWorkspace = ({
  contextGateway: suppliedContext,
  newsGateway: suppliedNews,
  now = () => new Date(),
}: CalendarWorkspaceProps) => {
  const [contextGateway] = useState(
    () => suppliedContext ?? createBrowserMarketFeedsGateway()
  );
  const [newsGateway] = useState(
    () => suppliedNews ?? createBrowserMarketNewsGateway()
  );
  const [context, setContext] = useState<ContextState>({ type: "loading" });
  const [news, setNews] = useState<NewsState>({ type: "loading" });
  const [contextReload, setContextReload] = useState(0);
  const [newsReload, setNewsReload] = useState(0);
  const [filter, setFilter] = useState<CalendarFilter>("all");

  useEffect(() => {
    // A Refresh or Retry supersedes this request; its late answer is dropped.
    let current = true;
    void contextReload;
    setContext({ type: "loading" });
    contextGateway.context().then(
      (data) => {
        if (current) setContext({ data, type: "ready" });
      },
      (error: unknown) => {
        if (!current) return;
        const failure = describePortfolioMonitorFailure(error);
        setContext(
          failure.kind === "forbidden"
            ? { type: "forbidden" }
            : { message: `${failure.code}: ${failure.message}`, type: "error" }
        );
      }
    );
    return () => {
      current = false;
    };
  }, [contextGateway, contextReload]);

  useEffect(() => {
    let current = true;
    void newsReload;
    setNews({ type: "loading" });
    // Earnings dates come from 8-K filings only: no headline source is read for the calendar.
    newsGateway.watchlist(CALENDAR_NEWS_HOURS, "filings").then(
      (result) => {
        if (current) setNews({ news: result, type: "ready" });
      },
      (error: unknown) => {
        if (current)
          setNews({ message: describeMarketNewsFailure(error), type: "error" });
      }
    );
    return () => {
      current = false;
    };
  }, [newsGateway, newsReload]);

  const newsStatus: MarketSourceStatus =
    news.type === "ready"
      ? latestEarningsFilings(news.news.tickers).some(
          (ticker) => ticker.error !== null
        )
        ? "partial"
        : "ready"
      : news.type;
  const summary = summarizeMarketStatus([contextStatus(context), newsStatus]);
  const loading = context.type === "loading" || news.type === "loading";
  const entries = [
    ...(context.type === "ready" ? economicEntries(context.data.macro) : []),
    ...(news.type === "ready" ? earningsEntries(news.news.tickers) : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            className="min-h-11"
            disabled={loading}
            onClick={() => {
              setContextReload((count) => count + 1);
              setNewsReload((count) => count + 1);
            }}
            variant="secondary"
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        }
        description="Economic releases and earnings filings for your watchlist on one agenda. Research only; no orders."
        status={
          <StatusBadge
            data-calendar-status={summary.label}
            status={summary.tone}
          >
            {summary.label}
          </StatusBadge>
        }
        title="Calendar"
      />
      <div className="space-y-3">
        <EconomicNotes
          onRetry={() => setContextReload((count) => count + 1)}
          state={context}
        />
        <EarningsNotes
          onRetry={() => setNewsReload((count) => count + 1)}
          state={news}
        />
      </div>
      <CalendarAgenda
        entries={entries}
        filter={filter}
        loading={loading}
        onFilterChange={setFilter}
        today={easternDate(now())}
      />
    </div>
  );
};
