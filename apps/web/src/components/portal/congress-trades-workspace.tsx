"use client";

import type {
  CongressTradesFeedOutput,
  CongressTradeWindow,
} from "@darkfactory/api";
import {
  Button,
  KpiCard,
  KpiRow,
  PageHeader,
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
import {
  ExternalLink,
  FileWarning,
  ListOrdered,
  RefreshCw,
  RotateCcw,
  Users,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { writeQuery } from "./backtest-lab-query.ts";
import {
  type CongressTradesGateway,
  createBrowserCongressTradesGateway,
} from "./congress-trades-client.ts";
import {
  ALL_CHAMBERS,
  ALL_MEMBERS,
  ALL_TICKERS,
  CHAMBERS,
  type CongressChamberFilter,
  type CongressTradesSettings,
  DEFAULT_DAYS,
  normalizeTicker,
  WINDOWS,
} from "./congress-trades-params.ts";
import { loadFailedLabel } from "../status-time.ts";
import { describeResearchLensFailure } from "./research-lenses-client.ts";

// Congress trades: House and Senate STOCK Act periodic transaction report (PTR) rows, parsed
// by the rig into a database ledger. Filings the parser could not read are listed with a link.
// Filters run on the server. Research only; no orders.

// The feed may carry up to 5000 trades (CONGRESS_TRADES_MAX_ROWS); the page lists them in pages.
export const CONGRESS_TRADES_PAGE_SIZE = 50;
const selectClass =
  "h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm sm:w-40 sm:flex-none";
const inputClass =
  "h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 font-mono text-sm uppercase sm:w-28";
const linkClass =
  "inline-flex min-h-11 items-center gap-1 underline-offset-2 hover:underline";
// Shown in a cell when the filing did not report the value.
const NOT_REPORTED = "—";

type Trade = CongressTradesFeedOutput["trades"][number];
type Filing = CongressTradesFeedOutput["filings"][number];
type Coverage = CongressTradesFeedOutput["coverage"][number];
type Chamber = Trade["chamber"];

type FeedState =
  | Readonly<{ type: "loading" }>
  // `failedAt`: epoch milliseconds, set when the request fails (the badge shows it).
  | Readonly<{ type: "error"; message: string; failedAt: number }>
  | Readonly<{ type: "ready"; feed: CongressTradesFeedOutput }>;

const CHAMBER_LABELS: Readonly<Record<Chamber, string>> = {
  house: "House",
  senate: "Senate",
};

const HOLDER_LABELS: Readonly<Record<NonNullable<Trade["holder"]>, string>> = {
  dependent: "Dependent",
  joint: "Joint",
  self: "Self",
  spouse: "Spouse",
};

const TYPE_LABELS: Readonly<Record<Trade["transactionType"], string>> = {
  exchange: "Exchange",
  other: "Other",
  purchase: "Purchase",
  sale: "Sale",
  sale_partial: "Partial sale",
};

const REASON_LABELS: Readonly<Record<NonNullable<Filing["reason"]>, string>> = {
  layout_unknown: "Layout not recognized",
  no_transactions: "No transaction rows",
  scanned_image: "Scanned image, no text",
};

/** Unparsed filings by reason, e.g. "Scanned image, no text: 4"; "None in this window" when 0. */
export const unparsedByReason = (
  unparsed: CongressTradesFeedOutput["unparsed"]
): string => {
  const parts = Object.entries(REASON_LABELS)
    .map(([reason, label]) => {
      const count = unparsed.byReason[reason as keyof typeof REASON_LABELS];
      return count > 0 ? `${label}: ${count.toLocaleString("en-US")}` : "";
    })
    .filter((part) => part !== "");
  return parts.length === 0 ? "None in this window" : parts.join(" · ");
};

const utcMinute = (value: Date): string =>
  `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const coverageText = (row: Coverage): string => {
  const name = CHAMBER_LABELS[row.chamber];
  // lastOkAt is the end of the newest ok or partial run.
  if (row.lastOkAt === null) return `${name}: no successful run`;
  const when = utcMinute(row.lastOkAt);
  return row.overdue
    ? `${name}: overdue since ${when}`
    : `${name}: updated ${when}`;
};

const sourceLabel = (member: string, filedOn: string): string =>
  `Filing: ${member} ${filedOn}, opens in a new tab`;

const CoverageLine = ({
  coverage,
}: {
  readonly coverage: readonly Coverage[];
}) => (
  <ul
    aria-label="Data coverage by chamber"
    className="flex flex-wrap gap-2 border-b px-4 py-2 text-xs"
  >
    {coverage.map((row) => (
      <li key={row.chamber}>
        <StatusBadge status={row.overdue ? "warning" : "neutral"}>
          {coverageText(row)}
        </StatusBadge>
      </li>
    ))}
  </ul>
);

const TradesTable = ({ trades }: { readonly trades: readonly Trade[] }) => (
  <TableScroll label="Congress trades" minWidth="68rem">
    <Table className="w-full text-sm">
      <TableCaption className="sr-only">
        Congress trades, newest filing first
      </TableCaption>
      <TableHeader>
        <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
          <TableHead scope="col">Filed</TableHead>
          <TableHead scope="col">Member</TableHead>
          <TableHead scope="col">Chamber</TableHead>
          <TableHead scope="col">Holder</TableHead>
          <TableHead scope="col">Ticker</TableHead>
          <TableHead scope="col">Asset</TableHead>
          <TableHead scope="col">Type</TableHead>
          <TableHead scope="col">Amount</TableHead>
          <TableHead scope="col">Traded</TableHead>
          <TableHead scope="col">Delay</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((trade) => (
          <TableRow
            className="border-border border-b align-middle"
            key={`${trade.chamber}-${trade.docId}-${trade.rowNumber}`}
          >
            <TableCell className="whitespace-nowrap font-mono text-xs">
              <a
                aria-label={sourceLabel(trade.member, trade.filedOn)}
                className={linkClass}
                href={trade.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                {trade.filedOn}
                <ExternalLink aria-hidden="true" className="size-4" />
              </a>
            </TableCell>
            <TableHead
              className="h-auto whitespace-normal text-left font-medium"
              scope="row"
            >
              {trade.member}
              {trade.amends ? (
                <StatusBadge className="ml-2" status="info">
                  Amendment
                </StatusBadge>
              ) : null}
            </TableHead>
            <TableCell>{CHAMBER_LABELS[trade.chamber]}</TableCell>
            <TableCell>
              {trade.holder === null
                ? NOT_REPORTED
                : HOLDER_LABELS[trade.holder]}
            </TableCell>
            <TableCell className="font-mono text-xs">
              {trade.ticker ?? NOT_REPORTED}
            </TableCell>
            <TableCell className="max-w-64 whitespace-normal">
              {trade.asset}
            </TableCell>
            <TableCell>{TYPE_LABELS[trade.transactionType]}</TableCell>
            <TableCell className="whitespace-nowrap font-mono text-xs">
              {trade.amountLabel}
            </TableCell>
            <TableCell className="whitespace-nowrap font-mono text-xs">
              {trade.transactionDate ?? NOT_REPORTED}
            </TableCell>
            <TableCell className="whitespace-nowrap font-mono text-xs">
              {trade.delayDays === null ? NOT_REPORTED : `${trade.delayDays} d`}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </TableScroll>
);

const UnparsedFilings = ({
  filings,
}: {
  readonly filings: readonly Filing[];
}) => (
  <section aria-labelledby="congress-unparsed-heading" className="border-t">
    <h3
      className="px-4 pt-3 font-medium text-sm"
      id="congress-unparsed-heading"
    >
      Unparsed filings
    </h3>
    {filings.length === 0 ? (
      <p className="px-4 py-3 text-muted-foreground text-sm">
        Every filing in this window was parsed.
      </p>
    ) : (
      <TableScroll label="Unparsed filings" minWidth="36rem">
        <Table className="w-full text-sm">
          <TableCaption className="sr-only">
            Filings the parser could not read, with the reason and a source link
          </TableCaption>
          <TableHeader>
            <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
              <TableHead scope="col">Member</TableHead>
              <TableHead scope="col">Filed</TableHead>
              <TableHead scope="col">Reason</TableHead>
              <TableHead scope="col">Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filings.map((filing) => (
              <TableRow
                className="border-border border-b align-middle"
                key={`${filing.chamber}-${filing.docId}`}
              >
                <TableHead
                  className="h-auto whitespace-normal text-left font-medium"
                  scope="row"
                >
                  {filing.member}
                </TableHead>
                <TableCell className="font-mono text-xs">
                  {filing.filedOn}
                </TableCell>
                <TableCell>
                  {filing.reason === null
                    ? NOT_REPORTED
                    : REASON_LABELS[filing.reason]}
                </TableCell>
                <TableCell>
                  <a
                    aria-label={sourceLabel(filing.member, filing.filedOn)}
                    className={linkClass}
                    href={filing.url}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {CHAMBER_LABELS[filing.chamber]} {filing.docId}
                    <ExternalLink aria-hidden="true" className="size-4" />
                  </a>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
    )}
  </section>
);

const TradesPager = ({
  onPage,
  page,
  shown,
  total,
}: {
  readonly onPage: (page: number) => void;
  readonly page: number;
  readonly shown: number;
  readonly total: number;
}) => {
  const first = page * CONGRESS_TRADES_PAGE_SIZE;
  return (
    <nav
      aria-label="Trade pages"
      className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2 text-sm"
    >
      <p aria-live="polite">
        Showing {first + 1}–{first + shown} of {total}
      </p>
      <div className="flex gap-2">
        <Button
          className="min-h-11"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
          size="sm"
          variant="outline"
        >
          Previous
        </Button>
        <Button
          className="min-h-11"
          disabled={first + shown >= total}
          onClick={() => onPage(page + 1)}
          size="sm"
          variant="outline"
        >
          Next
        </Button>
      </div>
    </nav>
  );
};

const FeedStatus = ({ state }: { readonly state: FeedState }) => {
  if (state.type === "loading")
    return <StatusBadge status="info">Loading</StatusBadge>;
  if (state.type === "error")
    return (
      <StatusBadge status="destructive">
        {loadFailedLabel(state.failedAt)}
      </StatusBadge>
    );
  const count = state.feed.trades.length;
  return (
    <StatusBadge status="neutral">
      {count} {count === 1 ? "trade" : "trades"}
    </StatusBadge>
  );
};

const FeedKpis = ({
  days,
  feed,
}: {
  readonly days: CongressTradeWindow;
  readonly feed: CongressTradesFeedOutput;
}) => (
  <KpiRow label={`Congress trades filed in the last ${days} days`}>
    <KpiCard
      data-kpi="trades"
      hint={`Filed in the last ${days} days`}
      icon={<ListOrdered />}
      label="Trades"
      value={feed.trades.length.toLocaleString("en-US")}
    />
    <KpiCard
      data-kpi="members"
      hint="With a filing that matches these filters"
      icon={<Users />}
      label="Members"
      value={feed.members.length.toLocaleString("en-US")}
    />
    <KpiCard
      data-kpi="unparsed"
      hint={unparsedByReason(feed.unparsed)}
      icon={<FileWarning />}
      label="Unparsed filings"
      value={feed.unparsed.total.toLocaleString("en-US")}
    />
  </KpiRow>
);

export interface CongressTradesWorkspaceProps {
  readonly gateway?: CongressTradesGateway;
  /** Settings restored from the URL (`?days=&chamber=&ticker=&member=`); the workspace keeps the URL in sync. */
  readonly initial?: CongressTradesSettings;
}

export const CongressTradesWorkspace = ({
  gateway: suppliedGateway,
  initial,
}: CongressTradesWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserCongressTradesGateway()
  );
  const [settings, setSettings] = useState<CongressTradesSettings>(() => ({
    chamber: initial?.chamber ?? ALL_CHAMBERS,
    days: initial?.days ?? DEFAULT_DAYS,
    member: initial?.member ?? ALL_MEMBERS,
    ticker: initial?.ticker ?? ALL_TICKERS,
  }));
  const [tickerDraft, setTickerDraft] = useState(settings.ticker);
  const [page, setPage] = useState(0);
  const [state, setState] = useState<FeedState>({ type: "loading" });
  // The member list from the last loaded feed; it stays while a new load runs or fails,
  // so the member select is never disabled and a filter can always be cleared.
  const [knownMembers, setKnownMembers] = useState<readonly string[]>([]);
  const latest = useRef(0);

  const load = useCallback(
    async (query: CongressTradesSettings) => {
      latest.current += 1;
      const request = latest.current;
      setState({ type: "loading" });
      const next: FeedState = await gateway.feed(query).then(
        (loaded) => ({ feed: loaded, type: "ready" }),
        (error: unknown) => ({
          failedAt: Date.now(),
          message: describeResearchLensFailure(error),
          type: "error",
        })
      );
      // A newer filter choice wins over a slower, older response.
      if (request !== latest.current) return;
      setState(next);
      setPage(0);
      if (next.type === "ready") setKnownMembers(next.feed.members);
    },
    [gateway]
  );

  useEffect(() => {
    void load(settings);
    return;
  }, [load, settings]);

  useEffect(() => {
    // Only this page's keys change; foreign params such as ?theme= survive.
    writeQuery(settings, {
      chamber: ALL_CHAMBERS,
      days: DEFAULT_DAYS,
      member: ALL_MEMBERS,
      ticker: ALL_TICKERS,
    });
  }, [settings]);

  const update = (changes: Partial<CongressTradesSettings>) => {
    setPage(0);
    setSettings((current) => ({ ...current, ...changes }));
  };

  const applyTicker = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ticker = normalizeTicker(tickerDraft);
    setTickerDraft(ticker);
    if (ticker !== settings.ticker) update({ ticker });
  };

  const feed = state.type === "ready" ? state.feed : null;
  const trades = feed?.trades ?? [];
  // Always list the chosen member, also before the first load and after an error.
  const members = [
    ...new Set(
      settings.member === ALL_MEMBERS
        ? knownMembers
        : [settings.member, ...knownMembers]
    ),
  ];
  const unparsed =
    feed?.filings.filter((filing) => filing.status === "unparsed") ?? [];
  const pageCount = Math.max(
    1,
    Math.ceil(trades.length / CONGRESS_TRADES_PAGE_SIZE)
  );
  const currentPage = Math.min(page, pageCount - 1);
  const firstIndex = currentPage * CONGRESS_TRADES_PAGE_SIZE;
  const pageRows = trades.slice(
    firstIndex,
    firstIndex + CONGRESS_TRADES_PAGE_SIZE
  );

  const controls = (
    <div className="flex w-full flex-wrap items-center gap-3">
      <label className="flex w-full items-center gap-2 text-sm sm:w-auto">
        <span className="whitespace-nowrap">Filed in the last</span>
        <select
          className={selectClass}
          onChange={(event) =>
            update({ days: Number(event.target.value) as CongressTradeWindow })
          }
          value={settings.days}
        >
          {WINDOWS.map((span) => (
            <option key={span} value={span}>
              {span} days
            </option>
          ))}
        </select>
      </label>
      <label className="flex w-full items-center gap-2 text-sm sm:w-auto">
        <span>Chamber</span>
        <select
          className={selectClass}
          onChange={(event) =>
            update({ chamber: event.target.value as CongressChamberFilter })
          }
          value={settings.chamber}
        >
          <option value={ALL_CHAMBERS}>Both chambers</option>
          {CHAMBERS.map((name) => (
            <option key={name} value={name}>
              {CHAMBER_LABELS[name]}
            </option>
          ))}
        </select>
      </label>
      <form
        aria-label="Ticker filter"
        className="flex w-full items-center gap-2 text-sm sm:w-auto"
        onSubmit={applyTicker}
      >
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <span>Ticker</span>
          <input
            autoCapitalize="characters"
            className={inputClass}
            maxLength={16}
            onChange={(event) => setTickerDraft(event.target.value)}
            placeholder="All"
            spellCheck={false}
            type="text"
            value={tickerDraft}
          />
        </label>
        <Button className="min-h-11" size="sm" type="submit" variant="outline">
          Apply
        </Button>
      </form>
      <label className="flex w-full items-center gap-2 text-sm sm:w-auto">
        <span>Member</span>
        <select
          className={selectClass}
          onChange={(event) => update({ member: event.target.value })}
          value={settings.member}
        >
          <option value={ALL_MEMBERS}>All members</option>
          {members.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            disabled={state.type === "loading"}
            onClick={() => void load(settings)}
            size="sm"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        }
        description="House and Senate members' STOCK Act trades (PTRs), newest filing first, with a link to each source filing. Research only."
        status={<FeedStatus state={state} />}
        title="Congress trades"
      />

      {feed === null ? null : <FeedKpis days={settings.days} feed={feed} />}

      <Panel flush headingId="congress-feed-heading" title="Trades">
        <div className="border-b px-4 py-3">{controls}</div>
        {state.type === "loading" ? (
          <p
            aria-busy="true"
            className="p-4 text-muted-foreground text-sm"
            role="status"
          >
            Loading trades…
          </p>
        ) : null}
        {state.type === "error" ? (
          <div className="space-y-2 p-4" role="alert">
            <p className="text-sm">Trades not loaded: {state.message}</p>
            <Button
              className="min-h-11"
              onClick={() => void load(settings)}
              size="sm"
              variant="secondary"
            >
              <RotateCcw aria-hidden="true" className="size-4" />
              Try again
            </Button>
          </div>
        ) : null}

        {feed === null ? null : (
          // Named region for the loaded feed only, so "Congress trade feed" means the answer has arrived.
          <section aria-label="Congress trade feed">
            <CoverageLine coverage={feed.coverage} />
            <p
              className="border-b px-4 py-2 text-muted-foreground text-xs"
              role="status"
            >
              {trades.length} {trades.length === 1 ? "trade" : "trades"} ·{" "}
              {feed.source} · read {utcMinute(feed.receivedAt)}
            </p>
            {trades.length === 0 ? (
              <p className="p-4 text-sm">
                No parsed trades match these filters in the last {settings.days}{" "}
                days.
              </p>
            ) : (
              <>
                <TradesTable trades={pageRows} />
                {pageCount === 1 ? null : (
                  <TradesPager
                    onPage={setPage}
                    page={currentPage}
                    shown={pageRows.length}
                    total={trades.length}
                  />
                )}
              </>
            )}
            <UnparsedFilings filings={unparsed} />
          </section>
        )}
        <p className="border-t px-4 py-3 text-muted-foreground text-xs">
          Members of the House and Senate report stock and option trades in
          STOCK Act periodic transaction reports (PTRs). A report can arrive up
          to 45 days after the trade; the delay column shows the gap. Amounts
          are the ranges the filing reports. A cell with {NOT_REPORTED} means
          the filing did not report the value. Filings the parser could not read
          are listed with a link to the source. Research only; no orders.
        </p>
      </Panel>
    </div>
  );
};
