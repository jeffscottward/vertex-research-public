"use client";

import type {
  CongressTradeFiling,
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
  CalendarClock,
  ExternalLink,
  FileText,
  RefreshCw,
  RotateCcw,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type CongressTradesGateway,
  createBrowserCongressTradesGateway,
} from "./congress-trades-client.ts";
import { describeResearchLensFailure } from "./research-lenses-client.ts";

// Congress trades: the House Clerk STOCK Act periodic transaction report (PTR) filing feed.
// The transaction rows live in each filing's PDF; the page links them. Research only; no orders.

const WINDOWS: readonly CongressTradeWindow[] = [7, 30, 90];
const DEFAULT_DAYS: CongressTradeWindow = 30;
const ALL_MEMBERS = "";
// The contract allows member names up to 200 characters.
const MAX_MEMBER_LENGTH = 200;
// The feed may carry up to 5000 filings (CONGRESS_TRADES_MAX_ROWS); the page lists them in pages.
export const CONGRESS_TRADES_PAGE_SIZE = 50;
const selectClass =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-48";

export type CongressTradesSettings = Readonly<{
  days: CongressTradeWindow;
  member: string;
}>;

type ParamValue = string | readonly string[] | undefined;

/** Reads `?days=&member=`; anything unknown falls back to the default (30 days, all members). */
export const parseCongressTradesParams = (
  params: Readonly<Record<string, ParamValue>>
): CongressTradesSettings => {
  const { days, member } = params;
  return {
    days: WINDOWS.find((span) => String(span) === days) ?? DEFAULT_DAYS,
    member:
      typeof member === "string" && member.length <= MAX_MEMBER_LENGTH
        ? member
        : ALL_MEMBERS,
  };
};

/** The query string for the settings, without the defaults ("" when both are default). */
export const congressTradesSearch = (
  settings: CongressTradesSettings
): string => {
  const params = new URLSearchParams();
  if (settings.days !== DEFAULT_DAYS) params.set("days", String(settings.days));
  if (settings.member !== ALL_MEMBERS) params.set("member", settings.member);
  const search = params.toString();
  return search === "" ? "" : `?${search}`;
};

type FeedState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; feed: CongressTradesFeedOutput }>;

const latestFiling = (
  filings: readonly CongressTradeFiling[]
): CongressTradeFiling | undefined =>
  filings.reduce<CongressTradeFiling | undefined>(
    (latest, filing) =>
      latest === undefined || filing.filedOn > latest.filedOn ? filing : latest,
    undefined
  );

const pdfLabel = (filing: CongressTradeFiling): string =>
  `PTR ${filing.docId} PDF for ${filing.member}, opens in a new tab`;

const FilingsList = ({
  filings,
}: {
  readonly filings: readonly CongressTradeFiling[];
}) => (
  <>
    {/* Below sm: one compact card per filing, so the PDF link stays on screen. */}
    <ul
      aria-label="Filings, newest first"
      className="divide-y divide-border sm:hidden"
    >
      {filings.map((filing) => (
        <li
          className="flex items-center justify-between gap-3 px-4 py-2"
          key={filing.docId}
        >
          <div className="min-w-0 text-sm">
            <p className="truncate font-medium">{filing.member}</p>
            <p className="font-mono text-muted-foreground text-xs">
              {filing.stateDistrict || "–"} · filed {filing.filedOn}
            </p>
          </div>
          <a
            aria-label={pdfLabel(filing)}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 text-sm underline-offset-2 hover:underline"
            href={filing.pdfUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Report PDF
            <ExternalLink aria-hidden="true" className="size-4" />
          </a>
        </li>
      ))}
    </ul>
    <TableScroll
      className="hidden sm:block"
      label="Periodic transaction report filings"
      minWidth="36rem"
    >
      <Table className="w-full text-sm">
        <TableCaption className="sr-only">
          Periodic transaction report filings, newest first
        </TableCaption>
        <TableHeader>
          <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
            <TableHead scope="col">Filed</TableHead>
            <TableHead scope="col">Member</TableHead>
            <TableHead scope="col">District</TableHead>
            <TableHead scope="col">Report</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filings.map((filing) => (
            <TableRow
              className="border-border border-b align-middle"
              key={filing.docId}
            >
              <TableCell className="font-mono text-xs">
                {filing.filedOn}
              </TableCell>
              <TableHead
                className="whitespace-normal text-left font-medium"
                scope="row"
              >
                {filing.member}
              </TableHead>
              <TableCell className="font-mono text-xs">
                {filing.stateDistrict || "–"}
              </TableCell>
              <TableCell>
                <a
                  aria-label={pdfLabel(filing)}
                  className="inline-flex min-h-11 items-center gap-1 underline-offset-2 hover:underline"
                  href={filing.pdfUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  PTR {filing.docId}
                  <ExternalLink aria-hidden="true" className="size-4" />
                </a>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableScroll>
  </>
);

const FilingsPager = ({
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
      aria-label="Filing pages"
      className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2 text-sm"
    >
      <p aria-live="polite">
        Showing {first + 1}–{first + shown} of {total}
      </p>
      <div className="flex gap-2">
        <Button
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
          size="sm"
          variant="outline"
        >
          Previous
        </Button>
        <Button
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
    return <StatusBadge status="destructive">Unavailable</StatusBadge>;
  const count = state.feed.filings.length;
  return (
    <StatusBadge status="neutral">
      {count} {count === 1 ? "filing" : "filings"}
    </StatusBadge>
  );
};

const FeedKpis = ({
  days,
  feed,
}: {
  readonly days: CongressTradeWindow;
  readonly feed: CongressTradesFeedOutput;
}) => {
  const newest = latestFiling(feed.filings);
  return (
    <KpiRow label={`Filings in the last ${days} days`}>
      <KpiCard
        data-kpi="filings"
        hint={`Filed in the last ${days} days`}
        icon={<FileText />}
        label="Filings"
        value={feed.filings.length.toLocaleString("en-US")}
      />
      <KpiCard
        data-kpi="members"
        hint="With at least one filing"
        icon={<Users />}
        label="Members"
        value={feed.members.length.toLocaleString("en-US")}
      />
      <KpiCard
        data-kpi="latest"
        hint={newest?.member ?? "No filing in this window"}
        icon={<CalendarClock />}
        label="Latest filing"
        value={newest?.filedOn ?? "–"}
      />
    </KpiRow>
  );
};

export interface CongressTradesWorkspaceProps {
  readonly gateway?: CongressTradesGateway;
  /** Settings restored from the URL (`?days=&member=`); the workspace keeps the URL in sync. */
  readonly initial?: CongressTradesSettings;
}

export const CongressTradesWorkspace = ({
  gateway: suppliedGateway,
  initial,
}: CongressTradesWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserCongressTradesGateway()
  );
  const [days, setDays] = useState<CongressTradeWindow>(
    initial?.days ?? DEFAULT_DAYS
  );
  const [member, setMember] = useState(initial?.member ?? ALL_MEMBERS);
  const [page, setPage] = useState(0);
  const [state, setState] = useState<FeedState>({ type: "loading" });
  const latest = useRef(0);

  const load = useCallback(
    async (span: CongressTradeWindow) => {
      latest.current += 1;
      const request = latest.current;
      setState({ type: "loading" });
      const next: FeedState = await gateway.feed(span).then(
        (loaded) => ({ feed: loaded, type: "ready" }),
        (error: unknown) => ({
          message: describeResearchLensFailure(error),
          type: "error",
        })
      );
      // A newer window choice wins over a slower, older response.
      if (request !== latest.current) return;
      setState(next);
      setPage(0);
      // Keep the member filter only while that member still has filings in the window.
      if (next.type === "ready")
        setMember((current) =>
          next.feed.members.includes(current) ? current : ALL_MEMBERS
        );
    },
    [gateway]
  );

  useEffect(() => {
    void load(days);
    return;
  }, [load, days]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const search = congressTradesSearch({ days, member });
    if (url.search === search) return;
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${search}${url.hash}`
    );
  }, [days, member]);

  const feed = state.type === "ready" ? state.feed : null;
  const filings =
    feed === null
      ? []
      : feed.filings.filter(
          (filing) => member === ALL_MEMBERS || filing.member === member
        );
  const pageCount = Math.max(
    1,
    Math.ceil(filings.length / CONGRESS_TRADES_PAGE_SIZE)
  );
  const currentPage = Math.min(page, pageCount - 1);
  const firstIndex = currentPage * CONGRESS_TRADES_PAGE_SIZE;
  const pageRows = filings.slice(
    firstIndex,
    firstIndex + CONGRESS_TRADES_PAGE_SIZE
  );
  const status = <FeedStatus state={state} />;

  const controls = (
    <>
      <label className="flex items-center gap-2 text-sm">
        <span className="whitespace-nowrap">Filed in the last</span>
        <select
          className={selectClass}
          onChange={(event) => {
            setPage(0);
            setDays(Number(event.target.value) as CongressTradeWindow);
          }}
          value={days}
        >
          {WINDOWS.map((span) => (
            <option key={span} value={span}>
              {span} days
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <span>Member</span>
        <select
          className={selectClass}
          disabled={feed === null}
          onChange={(event) => {
            setPage(0);
            setMember(event.target.value);
          }}
          value={member}
        >
          <option value={ALL_MEMBERS}>All members</option>
          {feed?.members.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            disabled={state.type === "loading"}
            onClick={() => void load(days)}
            size="sm"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        }
        status={status}
        title="Congress trades"
      />

      {feed === null ? null : <FeedKpis days={days} feed={feed} />}

      <Panel
        actions={controls}
        flush
        headingId="congress-feed-heading"
        title="Filings"
      >
        {state.type === "loading" ? (
          <p
            aria-busy="true"
            className="p-4 text-muted-foreground text-sm"
            role="status"
          >
            Loading filings…
          </p>
        ) : null}
        {state.type === "error" ? (
          <div className="space-y-2 p-4" role="alert">
            <p className="text-sm">Filings unavailable: {state.message}</p>
            <Button
              className="min-h-11"
              onClick={() => void load(days)}
              size="sm"
              variant="secondary"
            >
              <RotateCcw aria-hidden="true" className="size-4" />
              Try again
            </Button>
          </div>
        ) : null}

        {feed === null ? null : (
          // Named region for the loaded feed only, so "PTR filings" means the answer has arrived.
          <section aria-label="PTR filings">
            <p
              className="border-b px-4 py-2 text-muted-foreground text-xs"
              role="status"
            >
              {filings.length} {filings.length === 1 ? "filing" : "filings"} ·{" "}
              {feed.source} · read{" "}
              {feed.receivedAt.toISOString().slice(0, 16).replace("T", " ")} UTC
            </p>
            {filings.length === 0 ? (
              <p className="p-4 text-sm">
                No periodic transaction reports were filed in the last {days}{" "}
                days.
              </p>
            ) : (
              <>
                <FilingsList filings={pageRows} />
                {pageCount === 1 ? null : (
                  <FilingsPager
                    onPage={setPage}
                    page={currentPage}
                    shown={pageRows.length}
                    total={filings.length}
                  />
                )}
              </>
            )}
          </section>
        )}
        <p className="border-t px-4 py-3 text-muted-foreground text-xs">
          House members report stock and option trades in STOCK Act periodic
          transaction reports (PTRs). A report can arrive up to 45 days after
          the trade. This feed lists the filings from the House Clerk disclosure
          index; the transaction detail (asset, type, date, amount range) is in
          each linked PDF. Research only; no orders.
        </p>
      </Panel>
    </div>
  );
};
