"use client";

import type { OpenbbInsiderClustersOutput } from "@darkfactory/api";
import {
  Button,
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
  ChevronDown,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { writeQuery } from "./backtest-lab-query.ts";
import {
  createBrowserInsiderClustersGateway,
  type InsiderClustersGateway,
} from "./insider-clusters-client.ts";
import {
  DEFAULT_DAYS,
  type InsiderClustersSettings,
  type InsiderClusterWindow,
  WINDOWS,
} from "./insider-clusters-params.ts";
import { describeResearchLensFailure } from "./research-lenses-client.ts";

// Insider cluster buys: issuers where 3 or more insiders bought on the open market
// within 10 days, from SEC EDGAR Form 4 filings. Research only; no orders.

const selectClass =
  "h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm sm:w-40 sm:flex-none";
const linkClass =
  "inline-flex min-h-11 items-center gap-1 underline-offset-2 hover:underline";
const NOT_REPORTED = "—";

type Cluster = OpenbbInsiderClustersOutput["clusters"][number];
type ClusterFiling = Cluster["filings"][number];
type Coverage = OpenbbInsiderClustersOutput["coverage"];

type FeedState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; feed: OpenbbInsiderClustersOutput }>;

/** "2026-10-13 15:00 UTC" for an ISO timestamp. */
const utcMinute = (value: string): string =>
  `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`;

const shareFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const usdFormat = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});

/** USD value; "≥" prefix when some rows had no price, so the sum is a lower bound. */
export const valueText = (value: number, incomplete: boolean): string =>
  `${incomplete ? "≥ " : ""}${usdFormat.format(value)}`;

/** The coverage line for the Form 4 index. */
export const coverageText = (coverage: Coverage): string => {
  if (coverage.overdue)
    return coverage.lastOkAt === null
      ? "Form 4: overdue · no good run yet"
      : `Form 4: overdue · last good run ${utcMinute(coverage.lastOkAt)}`;
  return `Form 4: index complete through ${coverage.newestCompleteDay ?? NOT_REPORTED}`;
};

const planText = (plan: boolean | null): string => {
  if (plan === null) return NOT_REPORTED;
  return plan ? "Yes" : "No";
};

const FilingsList = ({
  filings,
  issuer,
}: {
  readonly filings: readonly ClusterFiling[];
  readonly issuer: string;
}) => (
  <Table className="w-full text-sm">
    <TableCaption className="sr-only">Form 4 filings for {issuer}</TableCaption>
    <TableHeader>
      <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
        <TableHead scope="col">Accepted</TableHead>
        <TableHead scope="col">Owners</TableHead>
        <TableHead scope="col">10b5-1</TableHead>
        <TableHead className="text-right" scope="col">
          Shares
        </TableHead>
        <TableHead className="text-right" scope="col">
          Value
        </TableHead>
        <TableHead scope="col">Source</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {filings.map((filing) => (
        <TableRow
          className="border-border border-b align-middle"
          key={filing.accessionNumber}
        >
          <TableCell className="whitespace-nowrap font-mono text-xs">
            {utcMinute(filing.acceptedAt)}
          </TableCell>
          <TableCell>
            <ul>
              {filing.owners.map((owner) => (
                <li key={owner.cik}>
                  {owner.name}
                  {owner.title === null ? null : (
                    <span className="text-muted-foreground">
                      {" "}
                      · {owner.title}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </TableCell>
          <TableCell>{planText(filing.plan10b51)}</TableCell>
          <TableCell className="text-right font-mono">
            {shareFormat.format(filing.shares)}
          </TableCell>
          <TableCell className="text-right font-mono">
            {valueText(filing.value, filing.valueIncomplete)}
          </TableCell>
          <TableCell>
            <a
              aria-label={`EDGAR filing ${filing.accessionNumber}, opens in a new tab`}
              className={linkClass}
              href={filing.url}
              rel="noreferrer"
              target="_blank"
            >
              EDGAR filing
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

const ClusterRows = ({
  cluster,
  expanded,
  onToggle,
}: {
  readonly cluster: Cluster;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) => {
  const issuer = cluster.issuerName ?? `CIK ${cluster.issuerCik}`;
  const detailId = `insider-cluster-${cluster.issuerCik}`;
  return (
    <>
      <TableRow className="border-border border-b align-middle">
        <TableCell>
          <button
            aria-controls={detailId}
            aria-expanded={expanded}
            className="inline-flex min-h-11 min-w-11 items-center gap-2 text-left"
            onClick={onToggle}
            type="button"
          >
            {expanded ? (
              <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
            )}
            <span>
              {issuer}
              {cluster.issuerSymbol === null ? null : (
                <span className="ml-2 font-mono text-muted-foreground text-xs">
                  {cluster.issuerSymbol}
                </span>
              )}
            </span>
          </button>
        </TableCell>
        <TableCell className="text-right font-mono">
          {cluster.persons}
        </TableCell>
        <TableCell className="whitespace-nowrap font-mono text-xs">
          {utcMinute(cluster.firstAcceptedAt)}
        </TableCell>
        <TableCell className="whitespace-nowrap font-mono text-xs">
          {utcMinute(cluster.lastAcceptedAt)}
        </TableCell>
        <TableCell className="text-right font-mono">
          {shareFormat.format(cluster.shares)}
        </TableCell>
        <TableCell className="text-right font-mono">
          {valueText(cluster.value, cluster.valueIncomplete)}
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow className="border-border border-b" id={detailId}>
          <TableCell className="bg-muted/30 p-2" colSpan={6}>
            <FilingsList filings={cluster.filings} issuer={issuer} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
};

const ClustersTable = ({
  clusters,
}: {
  readonly clusters: readonly Cluster[];
}) => {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (cik: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(cik)) next.add(cik);
      return next;
    });
  return (
    <TableScroll label="Insider cluster buys" minWidth="52rem">
      <Table className="w-full text-sm">
        <TableCaption className="sr-only">
          Insider cluster buys; expand a row to list its Form 4 filings
        </TableCaption>
        <TableHeader>
          <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
            <TableHead scope="col">Issuer</TableHead>
            <TableHead className="text-right" scope="col">
              Persons
            </TableHead>
            <TableHead scope="col">First accepted</TableHead>
            <TableHead scope="col">Last accepted</TableHead>
            <TableHead className="text-right" scope="col">
              Shares
            </TableHead>
            <TableHead className="text-right" scope="col">
              Value (USD)
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {clusters.map((cluster) => (
            <ClusterRows
              cluster={cluster}
              expanded={open.has(cluster.issuerCik)}
              key={cluster.issuerCik}
              onToggle={() => toggle(cluster.issuerCik)}
            />
          ))}
        </TableBody>
      </Table>
    </TableScroll>
  );
};

const FeedStatus = ({ state }: { readonly state: FeedState }) => {
  if (state.type === "loading")
    return <StatusBadge status="info">Loading</StatusBadge>;
  if (state.type === "error")
    return <StatusBadge status="destructive">Load failed</StatusBadge>;
  const count = state.feed.clusters.length;
  return (
    <StatusBadge status="neutral">
      {count} {count === 1 ? "cluster" : "clusters"}
    </StatusBadge>
  );
};

export type InsiderClustersWorkspaceProps = Readonly<{
  gateway?: InsiderClustersGateway;
  initial?: InsiderClustersSettings;
}>;

export const InsiderClustersWorkspace = ({
  gateway: suppliedGateway,
  initial,
}: InsiderClustersWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserInsiderClustersGateway()
  );
  const [settings, setSettings] = useState<InsiderClustersSettings>(() => ({
    days: initial?.days ?? DEFAULT_DAYS,
  }));
  const [state, setState] = useState<FeedState>({ type: "loading" });
  const latest = useRef(0);

  const load = useCallback(
    async (query: InsiderClustersSettings) => {
      latest.current += 1;
      const request = latest.current;
      setState({ type: "loading" });
      const next: FeedState = await gateway.clusters(query).then(
        (loaded) => ({ feed: loaded, type: "ready" }),
        (error: unknown) => ({
          message: describeResearchLensFailure(error),
          type: "error",
        })
      );
      // A newer window choice wins over a slower, older response.
      if (request !== latest.current) return;
      setState(next);
    },
    [gateway]
  );

  useEffect(() => {
    void load(settings);
    return;
  }, [load, settings]);

  useEffect(() => {
    // Only this page's key changes; foreign params such as ?theme= survive.
    writeQuery(settings, { days: DEFAULT_DAYS });
  }, [settings]);

  const feed = state.type === "ready" ? state.feed : null;

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
        description="Issuers where 3 or more insiders bought shares on the open market within 10 days. Source: SEC EDGAR Form 4."
        status={<FeedStatus state={state} />}
        title="Insider cluster buys"
      />

      <Panel flush headingId="insider-clusters-heading" title="Clusters">
        <div className="border-b px-4 py-3">
          <label className="flex w-full items-center gap-2 text-sm sm:w-auto">
            <span className="whitespace-nowrap">Accepted in the last</span>
            <select
              className={selectClass}
              onChange={(event) =>
                setSettings({
                  days: Number(event.target.value) as InsiderClusterWindow,
                })
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
        </div>
        {state.type === "loading" ? (
          <p
            aria-busy="true"
            className="p-4 text-muted-foreground text-sm"
            role="status"
          >
            Loading cluster buys…
          </p>
        ) : null}
        {state.type === "error" ? (
          <div className="space-y-2 p-4" role="alert">
            <p className="text-sm">Cluster buys not loaded: {state.message}</p>
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
          <section aria-label="Insider cluster feed">
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
              <StatusBadge
                status={feed.coverage.overdue ? "warning" : "neutral"}
              >
                {coverageText(feed.coverage)}
              </StatusBadge>
              <span className="text-muted-foreground">
                {feed.delay} · {feed.source} · read {utcMinute(feed.receivedAt)}
              </span>
            </div>
            {feed.clusters.length === 0 ? (
              <p className="p-4 text-sm">
                No cluster buys in the last {feed.days} days.
              </p>
            ) : (
              <ClustersTable clusters={feed.clusters} />
            )}
          </section>
        )}
        <p className="border-t px-4 py-3 text-muted-foreground text-xs">
          Open-market purchases (transaction code P) reported on SEC Form 4. A
          value with ≥ is a lower bound: some rows had no price. 10b5-1 shows
          whether the filing marks a pre-arranged trading plan; {NOT_REPORTED}{" "}
          means not reported. Research only; no orders.
        </p>
      </Panel>
    </div>
  );
};
