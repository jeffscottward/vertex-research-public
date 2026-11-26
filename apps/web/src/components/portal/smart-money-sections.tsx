"use client";

import type {
  CongressTrade,
  CongressTradesFeedOutput,
  OpenbbChanges13fOutput,
  OpenbbInsiderClustersOutput,
  OpenbbSourceStatus,
  OpenbbStatusOutput,
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

// Independent per-source smart-money panels and freshness strip for /smart-money
// (docs/vertex-rebuild/designs/smart-money/plan-pr6.md). Each source keeps its own list,
// delay label, and error state; there is never a blended score. Research only: no orders.

export type SectionLoadState<T> =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; data: T }>;

const linkClass =
  "inline-flex min-h-11 items-center font-mono underline-offset-2 hover:underline";
const navLinkClass =
  "inline-flex min-h-11 items-center text-sm underline underline-offset-4";
const numberCell = "whitespace-nowrap text-right font-mono text-xs";

const COMPACT_USD = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 1,
  notation: "compact",
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

const formatUsd = (value: number | null): string =>
  value === null ? "Not reported" : COMPACT_USD.format(value);

const formatCount = (value: number | null): string =>
  value === null ? "Not reported" : COMPACT_COUNT.format(value);

const formatEtStamp = (value: Date | string): string =>
  `${ET_STAMP.format(value instanceof Date ? value : new Date(value))} ET`;

const isSafeHttpsUrl = (url: string): boolean => url.startsWith("https://");

const SMART_MONEY_STRIP_SOURCES: readonly Readonly<{
  kind: OpenbbSourceStatus["kind"];
  source: string;
}>[] = [
  { kind: "flow", source: "market_premium" },
  { kind: "openbb", source: "sec-form4" },
  { kind: "openbb", source: "congress-house" },
  { kind: "openbb", source: "congress-senate" },
  { kind: "openbb", source: "sec-13f" },
];

const freshnessBadgeText = (source: OpenbbSourceStatus): string => {
  if (!source.overdue) return `${source.label}: current`;
  if (source.overdueSince !== null)
    return `${source.label}: overdue since ${formatEtStamp(source.overdueSince)}`;
  if (source.lastOkAt === null)
    return `${source.label}: overdue (no usable run yet)`;
  return source.reason === null
    ? `${source.label}: overdue`
    : `${source.label}: overdue (${source.reason})`;
};

export const SmartMoneyFreshnessStrip = ({
  state,
}: Readonly<{ state: SectionLoadState<OpenbbStatusOutput> }>) => {
  if (state.type === "loading") {
    return (
      <section
        aria-label="Source freshness"
        className="text-muted-foreground text-xs"
      >
        <p aria-busy="true" role="status">
          Checking per-source freshness
        </p>
      </section>
    );
  }
  if (state.type === "error") {
    return (
      <section aria-label="Source freshness" role="alert">
        <p className="text-muted-foreground text-xs">
          Source freshness status not loaded: {state.message}
        </p>
      </section>
    );
  }
  const items = SMART_MONEY_STRIP_SOURCES.flatMap(({ kind, source }) => {
    const match = state.data.sources.find(
      (entry) => entry.kind === kind && entry.source === source
    );
    return match === undefined ? [] : [match];
  });
  if (items.length === 0) return null;
  return (
    <section aria-label="Source freshness" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {items.map((source) => (
          <StatusBadge
            className="h-auto max-w-full whitespace-normal text-left"
            key={`${source.kind}:${source.source}`}
            status={source.overdue ? "warning" : "neutral"}
          >
            {freshnessBadgeText(source)}
          </StatusBadge>
        ))}
      </div>
    </section>
  );
};

const SectionError = ({
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

export const SmartMoneyInsiderClustersPanel = ({
  onRetry,
  state,
  ticker,
}: Readonly<{
  onRetry: () => void;
  state: SectionLoadState<OpenbbInsiderClustersOutput>;
  ticker: string;
}>) => (
  <Panel
    flush
    headingId="smart-money-insiders-heading"
    title="Insider cluster buys (SEC Form 4)"
  >
    {state.type === "loading" ? (
      <p
        aria-busy="true"
        className="p-4 text-muted-foreground text-sm"
        role="status"
      >
        Loading insider cluster buys
      </p>
    ) : null}
    {state.type === "error" ? (
      <SectionError
        label="Insider cluster buys"
        message={state.message}
        onRetry={onRetry}
      />
    ) : null}
    {state.type === "ready" ? (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
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
            <span className="text-muted-foreground text-xs">
              {state.data.delay}
            </span>
          </div>
          <a className={navLinkClass} href="/insider-clusters">
            View all insider clusters
          </a>
        </div>
        {state.data.clusters.length === 0 ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            {ticker === ""
              ? "No insider cluster buys in the last 7 days."
              : `No insider cluster buys for ${ticker} in the last 7 days.`}
          </p>
        ) : (
          <TableScroll label="Insider cluster buys" minWidth="44rem">
            <Table>
              <TableCaption className="sr-only">
                Insider cluster buys (SEC Form 4, last 7 days)
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Ticker</TableHead>
                  <TableHead>Issuer</TableHead>
                  <TableHead className="text-right">Insiders</TableHead>
                  <TableHead className="text-right">Filings</TableHead>
                  <TableHead className="text-right">Shares</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Last accepted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.data.clusters.slice(0, 20).map((cluster) => (
                  <TableRow key={cluster.issuerCik}>
                    <TableCell>
                      {cluster.issuerSymbol === null ? (
                        <span className="text-muted-foreground text-xs">
                          No ticker
                        </span>
                      ) : (
                        <a
                          className={linkClass}
                          href={`/stock/${encodeURIComponent(cluster.issuerSymbol)}`}
                        >
                          {cluster.issuerSymbol}
                        </a>
                      )}
                    </TableCell>
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
                      {formatCount(cluster.shares)}
                    </TableCell>
                    <TableCell className={numberCell}>
                      {cluster.valueIncomplete
                        ? `${formatUsd(cluster.value)} partial`
                        : formatUsd(cluster.value)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {formatEtStamp(cluster.lastAcceptedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        )}
      </div>
    ) : null}
    <p className="border-t px-4 py-3 text-muted-foreground text-xs">
      Three or more distinct reporting persons buying on the open market (Form 4
      code P) within 10 calendar days. Source: SEC EDGAR daily index (previous
      business day). Research only; not a trade signal.
    </p>
  </Panel>
);

const congressEmptyText = (purchasesOnly: boolean, ticker: string): string => {
  const kind = purchasesOnly ? "purchases" : "trades";
  return ticker === ""
    ? `No Congress ${kind} filed in the last 30 days.`
    : `No Congress ${kind} for ${ticker} filed in the last 30 days.`;
};

const TYPE_LABELS: Readonly<Record<CongressTrade["transactionType"], string>> =
  {
    exchange: "Exchange",
    other: "Other",
    purchase: "Purchase",
    sale: "Sale",
    sale_partial: "Partial sale",
  };

const CHAMBER_TEXT: Readonly<Record<"house" | "senate", string>> = {
  house: "House",
  senate: "Senate",
};

export const SmartMoneyCongressPanel = ({
  onModeChange,
  onRetry,
  purchasesOnly,
  state,
  ticker,
}: Readonly<{
  onModeChange: (purchasesOnly: boolean) => void;
  onRetry: () => void;
  purchasesOnly: boolean;
  state: SectionLoadState<CongressTradesFeedOutput>;
  ticker: string;
}>) => {
  const fullHref =
    ticker === ""
      ? "/congress-trades?days=30"
      : `/congress-trades?ticker=${encodeURIComponent(ticker)}&days=30`;
  const rows =
    state.type === "ready"
      ? (purchasesOnly
          ? state.data.trades.filter(
              (trade) => trade.transactionType === "purchase"
            )
          : state.data.trades
        ).slice(0, 25)
      : [];

  return (
    <Panel
      flush
      headingId="smart-money-congress-heading"
      title="Congress trades (House and Senate PTRs)"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div
          aria-label="Congress trade type filter"
          className="flex flex-wrap items-center gap-2"
          role="group"
        >
          <Button
            aria-pressed={purchasesOnly}
            className="min-h-11"
            onClick={() => onModeChange(true)}
            size="sm"
            variant={purchasesOnly ? "default" : "outline"}
          >
            Purchases
          </Button>
          <Button
            aria-pressed={!purchasesOnly}
            className="min-h-11"
            onClick={() => onModeChange(false)}
            size="sm"
            variant={purchasesOnly ? "outline" : "default"}
          >
            All trades
          </Button>
        </div>
        <a className={navLinkClass} href={fullHref}>
          View all Congress trades
        </a>
      </div>
      {state.type === "loading" ? (
        <p
          aria-busy="true"
          className="p-4 text-muted-foreground text-sm"
          role="status"
        >
          Loading Congress disclosures
        </p>
      ) : null}
      {state.type === "error" ? (
        <SectionError
          label="Congress trades"
          message={state.message}
          onRetry={onRetry}
        />
      ) : null}
      {state.type === "ready" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
            {state.data.coverage.map((entry) => (
              <StatusBadge
                className="h-auto max-w-full whitespace-normal text-left"
                key={entry.chamber}
                status={entry.overdue ? "warning" : "neutral"}
              >
                {entry.overdue
                  ? `${CHAMBER_TEXT[entry.chamber]}: overdue`
                  : `${CHAMBER_TEXT[entry.chamber]}: current`}
              </StatusBadge>
            ))}
            <span className="text-muted-foreground text-xs">
              Last 30 days · {state.data.unparsed.total} unparsed filings
            </span>
          </div>
          {rows.length === 0 ? (
            <p className="px-4 py-3 text-muted-foreground text-sm">
              {congressEmptyText(purchasesOnly, ticker)}
            </p>
          ) : (
            <TableScroll label="Congress trades" minWidth="48rem">
              <Table>
                <TableCaption className="sr-only">
                  Congress periodic transaction reports filed in the last 30
                  days
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Filed</TableHead>
                    <TableHead>Member</TableHead>
                    <TableHead>Chamber</TableHead>
                    <TableHead>Ticker</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead className="text-right">Delay</TableHead>
                    <TableHead>Filing</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((trade) => (
                    <TableRow
                      key={`${trade.chamber}:${trade.docId}:${trade.rowNumber}`}
                    >
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {trade.filedOn}
                      </TableCell>
                      <TableCell className="text-sm">{trade.member}</TableCell>
                      <TableCell className="text-xs">
                        {CHAMBER_TEXT[trade.chamber]}
                      </TableCell>
                      <TableCell>
                        {trade.ticker === null ? (
                          <span className="text-muted-foreground text-xs">
                            No ticker
                          </span>
                        ) : (
                          <a
                            className={linkClass}
                            href={`/stock/${encodeURIComponent(trade.ticker)}`}
                          >
                            {trade.ticker}
                          </a>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {TYPE_LABELS[trade.transactionType]}
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
                            className={linkClass}
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
          )}
        </div>
      ) : null}
      <p className="border-t px-4 py-3 text-muted-foreground text-xs">
        Source: U.S. House Clerk and Senate eFD STOCK Act PTR filings. Members
        may file up to 45 days after a trade. Research only; not a trade signal.
      </p>
    </Panel>
  );
};

const optionText = (optionType: string): string =>
  optionType === "" ? "Stock" : optionType;

export const SmartMoney13fChangesPanel = ({
  onRetry,
  state,
  ticker,
}: Readonly<{
  onRetry: () => void;
  state: SectionLoadState<OpenbbChanges13fOutput>;
  ticker: string;
}>) => (
  <Panel
    flush
    headingId="smart-money-13f-heading"
    title="13F quarter-over-quarter changes (SEC Form 13F-HR)"
  >
    {state.type === "loading" ? (
      <p
        aria-busy="true"
        className="p-4 text-muted-foreground text-sm"
        role="status"
      >
        Loading 13F quarter-over-quarter changes
      </p>
    ) : null}
    {state.type === "error" ? (
      <SectionError
        label="13F changes"
        message={state.message}
        onRetry={onRetry}
      />
    ) : null}
    {state.type === "ready" ? (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <StatusBadge
            className="h-auto max-w-full whitespace-normal text-left"
            status={state.data.coverage.overdue ? "warning" : "neutral"}
          >
            {state.data.coverage.overdue
              ? "SEC 13F: overdue"
              : `SEC 13F: ${state.data.coverage.filersWithTwoBooks} of ${state.data.coverage.totalFilers} filers with consecutive books`}
          </StatusBadge>
          <span className="text-muted-foreground text-xs">
            {state.data.delay}
          </span>
        </div>
        {state.data.changes.length === 0 ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            {ticker === ""
              ? "No 13F quarter-over-quarter changes stored across consecutive full books yet."
              : `No tracked 13F quarter-over-quarter changes for ${ticker} across consecutive full books.`}
          </p>
        ) : (
          <TableScroll
            label="13F quarter-over-quarter changes"
            minWidth="52rem"
          >
            <Table>
              <TableCaption className="sr-only">
                13F quarter-over-quarter changes across tracked filers
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Filer</TableHead>
                  <TableHead>Ticker</TableHead>
                  <TableHead>Issuer</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead>Option</TableHead>
                  <TableHead className="text-right">
                    Shares now / before
                  </TableHead>
                  <TableHead className="text-right">
                    Value now / before
                  </TableHead>
                  <TableHead>Periods</TableHead>
                  <TableHead>Filed</TableHead>
                  <TableHead className="text-right">Delay</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.data.changes.slice(0, 25).map((row) => (
                  <TableRow
                    key={`${row.filerCik}:${row.cusip}:${row.optionType}`}
                  >
                    <TableCell className="text-sm">{row.filerName}</TableCell>
                    <TableCell>
                      {row.symbol === null ? (
                        <span className="text-muted-foreground text-xs">
                          No ticker
                        </span>
                      ) : (
                        <a
                          className={linkClass}
                          href={`/stock/${encodeURIComponent(row.symbol)}`}
                        >
                          {row.symbol}
                        </a>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{row.issuer}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.change}
                    </TableCell>
                    <TableCell className="text-xs">
                      {optionText(row.optionType)}
                    </TableCell>
                    <TableCell className={numberCell}>
                      {formatCount(row.shares)} /{" "}
                      {formatCount(row.previousShares)}
                    </TableCell>
                    <TableCell className={numberCell}>
                      {formatUsd(row.value)} / {formatUsd(row.previousValue)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {row.period} vs {row.previousPeriod}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {row.filedOn}
                    </TableCell>
                    <TableCell className={numberCell}>
                      {row.delayDays} d
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        )}
      </div>
    ) : null}
    <p className="border-t px-4 py-3 text-muted-foreground text-xs">
      Source: SEC Form 13F-HR full quarterly books (due 45 days after quarter
      end). Unchanged positions are omitted from this market-wide list. Research
      only; not a trade signal.
    </p>
  </Panel>
);
