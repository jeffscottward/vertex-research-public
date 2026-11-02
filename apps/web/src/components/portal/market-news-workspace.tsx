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
import { Badge, Button, EmptyState } from "@darkfactory/ui";
import { ListChecks, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

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
    <section
      aria-labelledby={`news-${ticker.symbol}`}
      className="min-w-0 space-y-3 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          className="font-mono font-semibold text-lg"
          id={`news-${ticker.symbol}`}
        >
          {ticker.symbol}
        </h2>
        <p className="text-muted-foreground text-xs">
          {ticker.headlines.length} headlines · {ticker.filings.length} 8-K
          {important === 0 ? "" : ` (${important} important)`}
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
        <div className="min-w-0 space-y-2">
          <h3 className="font-medium text-sm">8-K filings</h3>
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
          <h3 className="font-medium text-sm">Headlines</h3>
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
    </section>
  );
};

type NewsState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; news: MarketNewsWatchlistOutput }>;

export interface MarketNewsWorkspaceProps {
  readonly gateway?: MarketNewsGateway;
}

export const MarketNewsWorkspace = ({
  gateway: suppliedGateway,
}: MarketNewsWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserMarketNewsGateway()
  );
  const [hours, setHours] = useState<MarketNewsHours>(72);
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

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-muted-foreground text-sm">
        Yahoo Finance headlines and SEC 8-K filings for the 25 newest symbols on
        your watchlist. Important 8-K items (earnings, officer changes,
        impairments, delisting and similar) are highlighted. Research only; no
        orders.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm">
          <span className="block">Window</span>
          <select
            className="min-h-11 rounded-md border border-border bg-background px-2"
            onChange={(event) =>
              setHours(Number(event.target.value) as MarketNewsHours)
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
        <Button
          className="min-h-11"
          disabled={state.type === "loading"}
          onClick={() => setReload((count) => count + 1)}
          variant="secondary"
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          Refresh
        </Button>
      </div>

      {state.type === "loading" ? (
        <p
          aria-busy="true"
          className="text-muted-foreground text-sm"
          role="status"
        >
          Loading news…
        </p>
      ) : null}
      {state.type === "error" ? (
        <div className="space-y-2" role="alert">
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
      ) : null}
      {state.type === "ready" && state.news.tickers.length > 0 ? (
        <div className="space-y-4">
          {state.news.tickers.map((ticker) => (
            <TickerSection
              key={ticker.symbol}
              ticker={ticker}
              windowLabel={windowLabel}
            />
          ))}
          <p className="text-muted-foreground text-xs">
            Sources: Yahoo Finance headline RSS and SEC EDGAR 8-K feeds, cached
            for 5 minutes. Updated {formatNewsTime(state.news.receivedAt)}.
          </p>
        </div>
      ) : null}
    </div>
  );
};
