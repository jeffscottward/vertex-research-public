"use client";

import {
  MARKET_NEWS_HOURS,
  type MarketNewsFiling,
  type MarketNewsHeadline,
  type MarketNewsHeadlineTag,
  type MarketNewsHours,
  type MarketNewsTicker,
  type MarketNewsWatchlistOutput,
} from "@darkfactory/api";
import {
  Badge,
  Button,
  EmptyState,
  KpiCard,
  KpiRow,
  PageHeader,
  Panel,
  StatusBadge,
} from "@darkfactory/ui";
import { FileText, ListChecks, Newspaper, RotateCcw, Tags } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { TickerLink } from "../ticker-link.tsx";
import {
  createBrowserMarketNewsGateway,
  describeMarketNewsFailure,
  type MarketNewsGateway,
} from "./market-news-client.ts";

// News monitor: Yahoo Finance headlines and SEC 8-K filings for each watchlist ticker. Item labels
// and keyword tags are adapted from day-trader-skill trader-news (MIT). Research only; no orders.

const MARKET_NEWS_WINDOW_LABELS: Readonly<Record<MarketNewsHours, string>> = {
  24: "last 24 hours",
  72: "last 3 days",
  168: "last 7 days",
  720: "last 30 days",
};

/** `?days=` value for each window; 3 days (72 hours) when the URL names none or an unknown one. */
const MARKET_NEWS_DAYS: Readonly<Record<MarketNewsHours, number>> = {
  24: 1,
  72: 3,
  168: 7,
  720: 30,
};

const DEFAULT_MARKET_NEWS_HOURS: MarketNewsHours = 72;

export const parseNewsDays = (value: string | undefined): MarketNewsHours =>
  MARKET_NEWS_HOURS.find(
    (hours) => String(MARKET_NEWS_DAYS[hours]) === value
  ) ?? DEFAULT_MARKET_NEWS_HOURS;

// Keeps ?days= in the address bar so a window can be linked and restored; the default drops it.
const writeNewsDays = (hours: MarketNewsHours): void => {
  const url = new URL(window.location.href);
  if (hours === DEFAULT_MARKET_NEWS_HOURS) url.searchParams.delete("days");
  else url.searchParams.set("days", String(MARKET_NEWS_DAYS[hours]));
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
};

export const MARKET_NEWS_TAG_LABELS: Readonly<
  Record<MarketNewsHeadlineTag, string>
> = {
  analyst: "Analyst",
  deal: "Deal / M&A",
  earnings: "Earnings",
  executive: "Executive",
  guidance: "Guidance",
  legal: "Legal / regulatory",
  offering: "Offering",
};

/** "2026-10-13 20:02 UTC": one zone for every reader, so times compare at a glance. */
export const formatNewsTime = (value: Date): string =>
  `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const EXTERNAL_LINK =
  "min-h-11 content-center break-words font-medium underline-offset-2 hover:underline";

const FilingRow = ({ filing }: { readonly filing: MarketNewsFiling }) => (
  <li
    className={
      filing.important
        ? "rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-1"
        : "rounded-md border border-border px-3 py-1"
    }
    data-important={filing.important ? "true" : "false"}
  >
    <a
      className={`block ${EXTERNAL_LINK}`}
      href={filing.url}
      rel="noopener noreferrer"
      target="_blank"
    >
      {filing.title}
    </a>
    <p className="flex flex-wrap items-center gap-2 pb-1 text-muted-foreground text-xs">
      {filing.important ? <Badge variant="default">Important</Badge> : null}
      <span>{filing.form}</span>
      <span>{formatNewsTime(filing.filedAt)}</span>
      {filing.items.length === 0 ? null : (
        <span>
          Items:{" "}
          {filing.items.map((item) => `${item.code} ${item.label}`).join(", ")}
        </span>
      )}
    </p>
  </li>
);

const HeadlineRow = ({
  headline,
}: {
  readonly headline: MarketNewsHeadline;
}) => (
  <li className="border-border border-b pb-1 last:border-b-0">
    <a
      className={`block ${EXTERNAL_LINK}`}
      href={headline.url}
      rel="noopener noreferrer"
      target="_blank"
    >
      {headline.title}
    </a>
    <p className="flex flex-wrap items-center gap-2 pb-1 text-muted-foreground text-xs">
      <span>{formatNewsTime(headline.publishedAt)}</span>
      {headline.publisher === null ? null : <span>{headline.publisher}</span>}
      {headline.tags.map((tag) => (
        <Badge key={tag} variant="secondary">
          {MARKET_NEWS_TAG_LABELS[tag]}
        </Badge>
      ))}
    </p>
  </li>
);

/** Newest headlines shown per ticker before "Show all". */
export const HEADLINE_PREVIEW_COUNT = 5;

/** The server prefixes each failure with its source: "filings: …" or "headlines: …". */
const splitSourceErrors = (
  errors: readonly string[]
): Readonly<{
  filings: string | null;
  headlines: string | null;
  other: string[];
}> => {
  const detail = (source: string): string | null => {
    const hit = errors.find((error) => error.startsWith(`${source}: `));
    return hit === undefined ? null : hit.slice(source.length + 2);
  };
  return {
    filings: detail("filings"),
    headlines: detail("headlines"),
    other: errors.filter(
      (error) =>
        !(error.startsWith("filings: ") || error.startsWith("headlines: "))
    ),
  };
};

const TickerSection = ({
  ticker,
  windowLabel,
}: {
  readonly ticker: MarketNewsTicker;
  readonly windowLabel: string;
}) => {
  const [showAll, setShowAll] = useState(false);
  const important = ticker.filings.filter((filing) => filing.important).length;
  const failures = splitSourceErrors(ticker.errors);
  const extra = ticker.headlines.length - HEADLINE_PREVIEW_COUNT;
  const shown = showAll
    ? ticker.headlines
    : ticker.headlines.slice(0, HEADLINE_PREVIEW_COUNT);
  return (
    <Panel
      className="rounded-none border-0 shadow-none"
      contentClassName="space-y-3"
      data-news-symbol={ticker.symbol}
      description={`${ticker.headlines.length} headlines · ${ticker.filings.length} 8-K${important === 0 ? "" : ` (${important} important)`}`}
      headingId={`news-${ticker.symbol}`}
      headingLevel={3}
      title={<TickerLink className="text-base" symbol={ticker.symbol} />}
    >
      <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
        <div className="min-w-0 space-y-2">
          <h4 className="font-medium text-sm">8-K filings</h4>
          {failures.filings === null ? null : (
            <p className="text-sm">
              8-K filings unavailable: {failures.filings}
            </p>
          )}
          {failures.filings === null && ticker.filings.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No 8-K filings in the {windowLabel}.
            </p>
          ) : null}
          {ticker.filings.length === 0 ? null : (
            <ul className="space-y-2">
              {ticker.filings.map((filing) => (
                <FilingRow filing={filing} key={filing.url} />
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0 space-y-2">
          <h4 className="font-medium text-sm">Headlines</h4>
          {failures.headlines === null ? null : (
            <p className="text-sm">
              Headlines unavailable: {failures.headlines}
            </p>
          )}
          {failures.headlines === null && ticker.headlines.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No headlines in the {windowLabel}.
            </p>
          ) : null}
          {ticker.headlines.length === 0 ? null : (
            <ul className="space-y-1">
              {shown.map((headline) => (
                <HeadlineRow headline={headline} key={headline.url} />
              ))}
            </ul>
          )}
          {extra > 0 ? (
            <Button
              aria-expanded={showAll}
              className="min-h-11"
              onClick={() => setShowAll((value) => !value)}
              size="sm"
              variant="ghost"
            >
              {showAll
                ? `Show the newest ${HEADLINE_PREVIEW_COUNT} only`
                : `Show all ${ticker.headlines.length} headlines`}
            </Button>
          ) : null}
        </div>
      </div>
      {failures.other.length === 0 ? null : (
        <p className="text-muted-foreground text-xs">
          Source gaps: {failures.other.join("; ")}
        </p>
      )}
    </Panel>
  );
};

type NewsState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; news: MarketNewsWatchlistOutput }>;

export interface MarketNewsWorkspaceProps {
  readonly gateway?: MarketNewsGateway;
  /** `?days=` from the request (1, 3, 7 or 30); anything else opens the 3-day window. */
  readonly initialDays?: string;
}

const NewsStatus = ({ state }: { readonly state: NewsState }) => {
  if (state.type === "loading")
    return <StatusBadge status="info">Loading</StatusBadge>;
  if (state.type === "error")
    return <StatusBadge status="destructive">Unavailable</StatusBadge>;
  const { tickers } = state.news;
  if (tickers.length === 0)
    return <StatusBadge status="neutral">No symbols</StatusBadge>;
  const gaps = tickers.some((ticker) => ticker.errors.length > 0);
  return (
    <StatusBadge status={gaps ? "warning" : "success"}>
      {tickers.length} {tickers.length === 1 ? "symbol" : "symbols"} watched
    </StatusBadge>
  );
};

const NewsKpis = ({
  news,
  windowLabel,
}: {
  readonly news: MarketNewsWatchlistOutput;
  readonly windowLabel: string;
}) => {
  const count = (pick: (ticker: MarketNewsTicker) => number): number =>
    news.tickers.reduce((total, ticker) => total + pick(ticker), 0);
  const gaps = count((ticker) => (ticker.errors.length > 0 ? 1 : 0));
  const important = count(
    (ticker) => ticker.filings.filter((filing) => filing.important).length
  );
  return (
    <KpiRow label="News summary">
      <KpiCard
        data-kpi="symbols"
        hint={gaps === 0 ? "All sources answered" : `${gaps} with source gaps`}
        icon={<Tags />}
        label="Symbols"
        value={news.tickers.length}
      />
      <KpiCard
        data-kpi="headlines"
        hint={`In the ${windowLabel}`}
        icon={<Newspaper />}
        label="Headlines"
        value={count((ticker) => ticker.headlines.length)}
      />
      <KpiCard
        data-kpi="filings"
        hint={`${important} important`}
        icon={<FileText />}
        label="8-K filings"
        value={count((ticker) => ticker.filings.length)}
      />
    </KpiRow>
  );
};

export const MarketNewsWorkspace = ({
  gateway: suppliedGateway,
  initialDays,
}: MarketNewsWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserMarketNewsGateway()
  );
  const [hours, setHours] = useState<MarketNewsHours>(() =>
    parseNewsDays(initialDays)
  );
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<NewsState>({ type: "loading" });

  useEffect(() => {
    // A newer window or retry supersedes this request; its late answer is dropped.
    let current = true;
    setState({ type: "loading" });
    gateway.watchlist(hours).then(
      (news) => {
        if (current) setState({ news, type: "ready" });
      },
      (error: unknown) => {
        if (current)
          setState({
            message: describeMarketNewsFailure(error),
            type: "error",
          });
      }
    );
    return () => {
      current = false;
    };
  }, [gateway, hours, reload]);

  const windowLabel = MARKET_NEWS_WINDOW_LABELS[hours];
  const chooseWindow = (next: MarketNewsHours) => {
    setHours(next);
    writeNewsDays(next);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            className="min-h-11"
            disabled={state.type === "loading"}
            onClick={() => setReload((count) => count + 1)}
            variant="secondary"
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        }
        description="Yahoo Finance headlines and SEC 8-K filings for the 25 newest symbols on your watchlist. Research only; no orders."
        status={<NewsStatus state={state} />}
        title="News monitor"
      />
      {state.type === "ready" && state.news.tickers.length > 0 ? (
        <NewsKpis news={state.news} windowLabel={windowLabel} />
      ) : null}
      <Panel
        actions={
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Window</span>
            <select
              className="min-h-11 rounded-md border border-border bg-background px-2"
              onChange={(event) =>
                chooseWindow(Number(event.target.value) as MarketNewsHours)
              }
              value={hours}
            >
              {MARKET_NEWS_HOURS.map((option) => (
                <option key={option} value={option}>
                  {MARKET_NEWS_WINDOW_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
        }
        description="Important 8-K items (earnings, officer changes, impairments, delisting and similar) are highlighted."
        flush
        headingId="news-watchlist"
        title="Watchlist news"
      >
        {state.type === "loading" ? (
          <p
            aria-busy="true"
            className="p-4 text-muted-foreground text-sm"
            role="status"
          >
            Loading news…
          </p>
        ) : null}
        {state.type === "error" ? (
          <div className="space-y-2 p-4" role="alert">
            <p className="text-sm">News unavailable: {state.message}</p>
            <Button
              className="min-h-11"
              onClick={() => setReload((count) => count + 1)}
              size="sm"
              variant="secondary"
            >
              <RotateCcw aria-hidden="true" className="size-4" />
              Try again
            </Button>
          </div>
        ) : null}
        {state.type === "ready" && state.news.tickers.length === 0 ? (
          <div className="p-4">
            <EmptyState
              action={
                <Button asChild className="min-h-11">
                  <Link href="/watchlist" prefetch={false}>
                    Open watchlist
                  </Link>
                </Button>
              }
              description="Add symbols to your watchlist to see their headlines and 8-K filings here."
              icon={<ListChecks />}
              title="Your watchlist is empty"
            />
          </div>
        ) : null}
        {state.type === "ready" && state.news.tickers.length > 0 ? (
          <>
            <div className="divide-y">
              {state.news.tickers.map((ticker) => (
                <TickerSection
                  key={ticker.symbol}
                  ticker={ticker}
                  windowLabel={windowLabel}
                />
              ))}
            </div>
            <p className="border-t px-4 py-3 text-muted-foreground text-xs">
              Sources: Yahoo Finance headline RSS and SEC EDGAR 8-K feeds,
              cached for 5 minutes. Updated{" "}
              {formatNewsTime(state.news.receivedAt)}.
            </p>
          </>
        ) : null}
      </Panel>
    </div>
  );
};
