"use client";

import type {
  CongressTradesFeedOutput,
  OpenbbInsiderClustersOutput,
  SmartMoneyRankingOutput,
} from "@darkfactory/api";
import {
  Button,
  Panel,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { OpenbbGateway } from "./gateway.ts";

// Symbol-scoped smart-money sections rendered on the stock page Filings tab
// (docs/vertex-rebuild/designs/smart-money/plan-pr6.md). Each section loads independently so a
// failure in QuantData, Form 4 clusters, or Congress never blocks SEC filings or FTD panels.
// Research only: no blended score, no trade signals, no orders.

type LoadState<T> =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; data: T }>;

const COMPACT_USD = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 1,
  notation: "compact",
  style: "currency",
});
const SIGNED_USD = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 1,
  notation: "compact",
  signDisplay: "exceptZero",
  style: "currency",
});
const COMPACT_COUNT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});
const ET_STAMP = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "short",
  timeZone: "America/New_York",
});

const navLinkClass =
  "inline-flex min-h-11 items-center text-sm underline underline-offset-4";
const numberCell = "whitespace-nowrap text-right font-mono text-xs";

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isSafeHttpsUrl = (url: string): boolean => url.startsWith("https://");

const useIsolatedLoad = <T,>(
  loader: () => Promise<T>,
  key: string
): Readonly<{ reload: () => void; state: LoadState<T> }> => {
  const [state, setState] = useState<LoadState<T>>({ type: "loading" });
  const latest = useRef(0);
  const run = useCallback(async () => {
    latest.current += 1;
    const request = latest.current;
    setState({ type: "loading" });
    let next: LoadState<T>;
    try {
      next = { data: await loader(), type: "ready" };
    } catch (error: unknown) {
      next = { message: errorText(error), type: "error" };
    }
    if (request !== latest.current) return;
    setState(next);
  }, [loader]);

  useEffect(() => {
    void run();
    return;
  }, [run, key]);

  return { reload: () => void run(), state };
};

const IsolatedError = ({
  label,
  message,
  onRetry,
}: Readonly<{ label: string; message: string; onRetry: () => void }>) => (
  <div className="space-y-2 p-4" role="alert">
    <p className="text-sm">
      {label} not loaded: {message}
    </p>
    <Button
      className="min-h-11"
      onClick={onRetry}
      size="sm"
      variant="secondary"
    >
      <RotateCcw aria-hidden="true" className="size-4" />
      Try again
    </Button>
  </div>
);

const StockOptionsPremiumSection = ({
  load,
  symbol,
}: Readonly<{
  load: () => Promise<SmartMoneyRankingOutput>;
  symbol: string;
}>) => {
  const { reload, state } = useIsolatedLoad(load, symbol);
  const row = state.type === "ready" ? (state.data.rows[0] ?? null) : null;
  return (
    <div data-smart-money-block="options-premium">
      <Panel
        flush
        headingId="stock-smart-money-premium"
        title="Large options premium (QuantData, 5 sessions)"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          {state.type === "ready" ? (
            <StatusBadge
              className="h-auto max-w-full whitespace-normal text-left"
              status={
                state.data.coverage.state === "stale" ? "warning" : "neutral"
              }
            >
              {state.data.coverage.state === "stale"
                ? "QuantData intraday capture overdue"
                : state.data.delay}
            </StatusBadge>
          ) : (
            <span className="text-muted-foreground text-xs">
              QuantData gainers-losers, trades &gt;= $100,000 each
            </span>
          )}
          <a
            className={navLinkClass}
            href={`/smart-money?ticker=${encodeURIComponent(symbol)}`}
          >
            Open in Smart money
          </a>
        </div>
        {state.type === "loading" ? (
          <p
            aria-busy="true"
            className="p-4 text-muted-foreground text-sm"
            role="status"
          >
            Loading {symbol} large options premium
          </p>
        ) : null}
        {state.type === "error" ? (
          <IsolatedError
            label={`${symbol} large options premium`}
            message={state.message}
            onRetry={reload}
          />
        ) : null}
        {state.type === "ready" && row === null ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            No large options trades (&gt;= $100,000 each) recorded for {symbol}{" "}
            in the newest 5 stored sessions.
          </p>
        ) : null}
        {row === null ? null : (
          <TableScroll
            label={`${symbol} large options premium`}
            minWidth="40rem"
          >
            <Table>
              <TableCaption className="sr-only">
                {symbol} large options premium over the newest 5 sessions
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">Market rank</TableHead>
                  <TableHead className="text-right">Net premium</TableHead>
                  <TableHead className="text-right">Bullish</TableHead>
                  <TableHead className="text-right">Bearish</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Trades</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className={numberCell}>#{row.rank}</TableCell>
                  <TableCell className={numberCell}>
                    {SIGNED_USD.format(row.netPremium)}
                  </TableCell>
                  <TableCell className={numberCell}>
                    {COMPACT_USD.format(row.bullishPremium)}
                  </TableCell>
                  <TableCell className={numberCell}>
                    {COMPACT_USD.format(row.bearishPremium)}
                  </TableCell>
                  <TableCell className={numberCell}>
                    {COMPACT_USD.format(row.premium)}
                  </TableCell>
                  <TableCell className={numberCell}>{row.tradeCount}</TableCell>
                  <TableCell className={numberCell}>
                    {row.sessionsPresent}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TableScroll>
        )}
        <p className="border-t px-4 py-3 text-muted-foreground text-xs">
          Source: QuantData gainers-losers (intraday, about every 15 minutes
          while options trade). Bullish and bearish follow QuantData&apos;s
          trade-side classes. Research only; not a trade signal.
        </p>
      </Panel>
    </div>
  );
};

const StockInsiderClustersSection = ({
  load,
  symbol,
}: Readonly<{
  load: () => Promise<OpenbbInsiderClustersOutput>;
  symbol: string;
}>) => {
  const { reload, state } = useIsolatedLoad(load, symbol);
  return (
    <div data-smart-money-block="insider-clusters">
      <Panel
        flush
        headingId="stock-smart-money-insiders"
        title="Insider cluster buys (SEC Form 4, 30 days)"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          {state.type === "ready" ? (
            <StatusBadge
              className="h-auto max-w-full whitespace-normal text-left"
              status={state.data.coverage.overdue ? "warning" : "neutral"}
            >
              {state.data.coverage.overdue
                ? "Form 4 index overdue"
                : state.data.coverage.newestCompleteDay === null
                  ? "Form 4 index current"
                  : `Form 4 complete through ${state.data.coverage.newestCompleteDay}`}
            </StatusBadge>
          ) : (
            <span className="text-muted-foreground text-xs">
              SEC EDGAR Form 4 daily index (previous business day)
            </span>
          )}
          <a className={navLinkClass} href="/insider-clusters">
            View all insider clusters
          </a>
        </div>
        {state.type === "loading" ? (
          <p
            aria-busy="true"
            className="p-4 text-muted-foreground text-sm"
            role="status"
          >
            Loading {symbol} insider cluster buys
          </p>
        ) : null}
        {state.type === "error" ? (
          <IsolatedError
            label={`${symbol} insider cluster buys`}
            message={state.message}
            onRetry={reload}
          />
        ) : null}
        {state.type === "ready" && state.data.clusters.length === 0 ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            No insider cluster buy (3+ distinct insiders buying within 10 days)
            for {symbol} in the last 30 days.
          </p>
        ) : null}
        {state.type === "ready" && state.data.clusters.length > 0 ? (
          <TableScroll
            label={`${symbol} insider cluster buys`}
            minWidth="40rem"
          >
            <Table>
              <TableCaption className="sr-only">
                {symbol} insider cluster buys in the last 30 days
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Issuer</TableHead>
                  <TableHead className="text-right">Insiders</TableHead>
                  <TableHead className="text-right">Filings</TableHead>
                  <TableHead className="text-right">Shares</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>First accepted</TableHead>
                  <TableHead>Last accepted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.data.clusters.map((cluster) => (
                  <TableRow key={cluster.issuerCik}>
                    <TableCell className="text-sm">
                      {cluster.issuerName ?? `CIK ${cluster.issuerCik}`}
                    </TableCell>
                    <TableCell className={numberCell}>
                      {cluster.persons}
                    </TableCell>
                    <TableCell className={numberCell}>
                      {cluster.filings.length}
                    </TableCell>
                    <TableCell className={numberCell}>
                      {COMPACT_COUNT.format(cluster.shares)}
                    </TableCell>
                    <TableCell className={numberCell}>
                      {cluster.valueIncomplete
                        ? `${COMPACT_USD.format(cluster.value)} partial`
                        : COMPACT_USD.format(cluster.value)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {ET_STAMP.format(new Date(cluster.firstAcceptedAt))} ET
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {ET_STAMP.format(new Date(cluster.lastAcceptedAt))} ET
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        ) : null}
        <p className="border-t px-4 py-3 text-muted-foreground text-xs">
          Source: SEC EDGAR Form 4 daily index (previous business day; insiders
          file within 2 business days). Research only; not a trade signal.
        </p>
      </Panel>
    </div>
  );
};

const StockCongressTradesSection = ({
  load,
  symbol,
}: Readonly<{
  load: () => Promise<CongressTradesFeedOutput>;
  symbol: string;
}>) => {
  const { reload, state } = useIsolatedLoad(load, symbol);
  return (
    <div data-smart-money-block="congress-trades">
      <Panel
        flush
        headingId="stock-smart-money-congress"
        title="Congress trades (House and Senate PTRs, 90 days)"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          {state.type === "ready" ? (
            <div className="flex flex-wrap items-center gap-2">
              {state.data.coverage.map((entry) => (
                <StatusBadge
                  className="h-auto max-w-full whitespace-normal text-left"
                  key={entry.chamber}
                  status={entry.overdue ? "warning" : "neutral"}
                >
                  {entry.chamber === "house" ? "House" : "Senate"}:{" "}
                  {entry.overdue ? "overdue" : "current"}
                </StatusBadge>
              ))}
              <span className="text-muted-foreground text-xs">
                {state.data.unparsed.total} unparsed filings in window
              </span>
            </div>
          ) : (
            <span className="text-muted-foreground text-xs">
              U.S. House Clerk and Senate eFD STOCK Act PTR disclosures
            </span>
          )}
          <a
            className={navLinkClass}
            href={`/congress-trades?ticker=${encodeURIComponent(symbol)}&days=90`}
          >
            View all {symbol} Congress trades
          </a>
        </div>
        {state.type === "loading" ? (
          <p
            aria-busy="true"
            className="p-4 text-muted-foreground text-sm"
            role="status"
          >
            Loading {symbol} Congress trades
          </p>
        ) : null}
        {state.type === "error" ? (
          <IsolatedError
            label={`${symbol} Congress trades`}
            message={state.message}
            onRetry={reload}
          />
        ) : null}
        {state.type === "ready" && state.data.trades.length === 0 ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            No Congress periodic transaction reports filed for {symbol} in the
            last 90 days.
          </p>
        ) : null}
        {state.type === "ready" && state.data.trades.length > 0 ? (
          <TableScroll label={`${symbol} Congress trades`} minWidth="44rem">
            <Table>
              <TableCaption className="sr-only">
                {symbol} Congress trades filed in the last 90 days
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Filed</TableHead>
                  <TableHead>Member</TableHead>
                  <TableHead>Chamber</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead className="text-right">Delay</TableHead>
                  <TableHead>Filing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.data.trades.slice(0, 25).map((trade) => (
                  <TableRow
                    key={`${trade.chamber}:${trade.docId}:${trade.rowNumber}`}
                  >
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {trade.filedOn}
                    </TableCell>
                    <TableCell className="text-sm">{trade.member}</TableCell>
                    <TableCell className="text-xs">
                      {trade.chamber === "house" ? "House" : "Senate"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {trade.transactionType}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {trade.amountLabel}
                    </TableCell>
                    <TableCell className={numberCell}>
                      {trade.delayDays === null
                        ? "Not reported"
                        : `${trade.delayDays} d`}
                    </TableCell>
                    <TableCell>
                      {isSafeHttpsUrl(trade.url) ? (
                        <a
                          className="inline-flex min-h-11 items-center font-mono underline underline-offset-2"
                          href={trade.url}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          PTR
                        </a>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          No link
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        ) : null}
        <p className="border-t px-4 py-3 text-muted-foreground text-xs">
          Source: House Clerk and Senate eFD STOCK Act filings (up to 45 days
          after trade). Research only; not a trade signal.
        </p>
      </Panel>
    </div>
  );
};

const StockOptionsPremiumLoader = ({
  fn,
  symbol,
}: Readonly<{
  fn: NonNullable<OpenbbGateway["smartMoneyRanking"]>;
  symbol: string;
}>) => {
  const load = useCallback(() => fn(symbol, 5), [fn, symbol]);
  return <StockOptionsPremiumSection load={load} symbol={symbol} />;
};

const StockInsiderClustersLoader = ({
  fn,
  symbol,
}: Readonly<{
  fn: NonNullable<OpenbbGateway["insiderClusters"]>;
  symbol: string;
}>) => {
  const load = useCallback(() => fn(symbol, 30), [fn, symbol]);
  return <StockInsiderClustersSection load={load} symbol={symbol} />;
};

const StockCongressTradesLoader = ({
  fn,
  symbol,
}: Readonly<{
  fn: NonNullable<OpenbbGateway["congressFeed"]>;
  symbol: string;
}>) => {
  const load = useCallback(() => fn(symbol, 90), [fn, symbol]);
  return <StockCongressTradesSection load={load} symbol={symbol} />;
};

export const StockSmartMoneySections = ({
  gateway,
  symbol,
}: Readonly<{ gateway: OpenbbGateway; symbol: string }>) => {
  const { congressFeed, insiderClusters, smartMoneyRanking } = gateway;
  if (
    smartMoneyRanking === undefined &&
    insiderClusters === undefined &&
    congressFeed === undefined
  )
    return null;

  return (
    <div className="space-y-6" data-smart-money="stock-sections">
      {smartMoneyRanking === undefined ? null : (
        <StockOptionsPremiumLoader fn={smartMoneyRanking} symbol={symbol} />
      )}
      {insiderClusters === undefined ? null : (
        <StockInsiderClustersLoader fn={insiderClusters} symbol={symbol} />
      )}
      {congressFeed === undefined ? null : (
        <StockCongressTradesLoader fn={congressFeed} symbol={symbol} />
      )}
    </div>
  );
};
