"use client";

// What: the read-only Trade Journal (/journal): KPIs, cumulative realized P&L, a per-symbol table
// and the chronological fill list, from the executions of one IBKR snapshot.
// Nothing here can place, change or cancel an order.
// See: trade-journal-model.ts (math), trade-journal-client.ts (loader), portfolio-monitor-client.ts.
import {
  PORTFOLIO_MONITOR_MAX_ROWS,
  type PortfolioMonitorExecution,
  type PortfolioMonitorOutput,
  type PortfolioMonitorStatus,
} from "@darkfactory/api";
import {
  Button,
  cn,
  EmptyState,
  KpiCard,
  KpiRow,
  Panel,
  Skeleton,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import { NotebookPen, RotateCcw } from "lucide-react";
import { useState } from "react";

import { TickerLink } from "../ticker-link.tsx";
import { OperatorAccessRequired } from "./agent-ops-client.tsx";
import {
  describePortfolioMonitorFailure,
  type PortfolioMonitorFailureKind,
} from "./portfolio-monitor-client.ts";
import { accountDataWithheld } from "./portfolio-monitor-model.ts";
import { CumulativeRealizedChart } from "./trade-journal-chart.tsx";
import {
  createBrowserJournalLoader,
  type JournalSnapshotLoader,
  type JournalSource,
  useLoadOnce,
} from "./trade-journal-client.ts";
import {
  chronologicalFills,
  cumulativeRealized,
  formatMoney,
  formatNumber,
  formatPercent,
  formatSignedMoney,
  journalKpis,
  latestExecutions,
  journalSymbolRows,
  journalTime,
  pnlTextClass,
  sideLabel,
} from "./trade-journal-model.ts";

export const JOURNAL_WINDOW_NOTICE =
  "IBKR only returns the current execution window (fills since the gateway's last reset, usually the current session). Older fills are not shown, so every total here covers this window only.";

const FAILURE_COPY: Readonly<
  Record<Exclude<PortfolioMonitorFailureKind, "forbidden">, string>
> = Object.freeze({
  error: "The journal could not load.",
  "not-configured":
    "The server has no IBKR snapshot service configured (IBKR_MONITOR_URL or VERTEX_PORTFOLIO_URL).",
  unauthorized: "Session expired. Sign in again.",
  unavailable:
    "The IBKR snapshot service or IB Gateway did not answer. Try again shortly.",
});

const JournalFailure = ({
  kind,
  detail,
}: Readonly<{
  kind: Exclude<PortfolioMonitorFailureKind, "forbidden">;
  detail: string | null;
}>) => (
  <div
    className="space-y-1 rounded-md border border-border p-4"
    data-journal-failure={kind}
    role="status"
  >
    <p className="font-medium text-sm">
      {kind === "not-configured" ? "Not configured" : "Journal unavailable"}
    </p>
    <p className="text-muted-foreground text-sm">{FAILURE_COPY[kind]}</p>
    {detail === null ? null : (
      <p className="font-mono text-muted-foreground text-xs">{detail}</p>
    )}
  </div>
);

const JournalKpiRow = ({
  executions,
}: Readonly<{ executions: readonly PortfolioMonitorExecution[] }>) => {
  const kpis = journalKpis(executions);
  return (
    <KpiRow label="Journal totals">
      <KpiCard
        hint={`${kpis.closing} closing`}
        label="Fills"
        value={kpis.fills}
      />
      <KpiCard
        hint="IBKR realized, already net of commissions"
        label="Realized P&L"
        value={
          <span className={pnlTextClass(kpis.realized)}>
            {formatSignedMoney(kpis.realized)}
          </span>
        }
      />
      <KpiCard
        hint="Already included in realized P&L"
        label="Commissions"
        value={formatMoney(kpis.commissions)}
      />
      <KpiCard
        hint={`${kpis.wins} won · ${kpis.losses} lost`}
        label="Win rate"
        value={formatPercent(kpis.winRate)}
      />
      <KpiCard
        label="Avg win"
        value={
          <span className={pnlTextClass(kpis.avgWin)}>
            {formatSignedMoney(kpis.avgWin)}
          </span>
        }
      />
      <KpiCard
        label="Avg loss"
        value={
          <span className={pnlTextClass(kpis.avgLoss)}>
            {formatSignedMoney(kpis.avgLoss)}
          </span>
        }
      />
    </KpiRow>
  );
};

const SymbolTable = ({
  executions,
}: Readonly<{ executions: readonly PortfolioMonitorExecution[] }>) => (
  <TableScroll label="Fills by symbol" minWidth="40rem">
    <Table className="text-sm">
      <TableCaption className="sr-only">Fills by symbol</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Symbol</TableHead>
          <TableHead numeric>Fills</TableHead>
          <TableHead numeric>Bought</TableHead>
          <TableHead numeric>Sold</TableHead>
          <TableHead numeric>Realized</TableHead>
          <TableHead numeric>Commissions</TableHead>
          <TableHead numeric>Win rate</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {journalSymbolRows(executions).map((row) => (
          <TableRow
            data-sectype={row.secType}
            data-symbol={row.symbol}
            key={`${row.secType}:${row.symbol}`}
          >
            <TableCell>
              {row.secType === "STK" || row.secType === "" ? (
                <TickerLink symbol={row.symbol} />
              ) : (
                <span>
                  {row.symbol}{" "}
                  <span className="text-muted-foreground text-xs">
                    {row.secType}
                  </span>
                </span>
              )}
            </TableCell>
            <TableCell numeric>{row.fills}</TableCell>
            <TableCell numeric>{formatNumber(row.bought)}</TableCell>
            <TableCell numeric>{formatNumber(row.sold)}</TableCell>
            <TableCell className={pnlTextClass(row.realized)} numeric>
              {formatSignedMoney(row.realized)}
            </TableCell>
            <TableCell numeric>{formatMoney(row.commissions)}</TableCell>
            <TableCell numeric>{formatPercent(row.winRate)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </TableScroll>
);

const FillTable = ({
  executions,
}: Readonly<{ executions: readonly PortfolioMonitorExecution[] }>) => (
  <TableScroll label="Fills, oldest first" minWidth="52rem">
    <Table className="text-sm">
      <TableCaption className="sr-only">Fills, oldest first</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Symbol</TableHead>
          <TableHead>Side</TableHead>
          <TableHead numeric>Shares</TableHead>
          <TableHead numeric>Price</TableHead>
          <TableHead numeric>Commission</TableHead>
          <TableHead numeric>Realized</TableHead>
          <TableHead>Exchange</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {chronologicalFills(executions).map((execution, index) => (
          <TableRow
            data-exec-id={execution.execId}
            key={`${execution.execId}-${index}`}
          >
            <TableCell className="font-mono text-xs">
              {journalTime(execution.time)}
            </TableCell>
            <TableCell>
              <TickerLink symbol={execution.symbol} />
            </TableCell>
            <TableCell>{sideLabel(execution.side)}</TableCell>
            <TableCell numeric>{formatNumber(execution.shares)}</TableCell>
            <TableCell numeric>{formatMoney(execution.price)}</TableCell>
            <TableCell numeric>{formatMoney(execution.commission)}</TableCell>
            <TableCell className={pnlTextClass(execution.realized)} numeric>
              {formatSignedMoney(execution.realized)}
            </TableCell>
            <TableCell>{execution.exchange}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </TableScroll>
);

const JournalStatusLine = ({
  status,
  withheld,
}: Readonly<{ status: PortfolioMonitorStatus; withheld: string | null }>) => (
  <p
    className="text-muted-foreground text-xs"
    data-journal-connected={status.connected ? "true" : "false"}
    data-journal-withheld={withheld === null ? "false" : "true"}
    role="note"
  >
    {withheld ??
      `Gateway connected · ${
        status.dataAsOf === null
          ? "IBKR has sent no data time yet"
          : `data as of ${status.dataAsOf}`
      }`}
  </p>
);

export const JournalReport = ({
  executions: received,
  status,
  account,
}: Readonly<{
  executions: readonly PortfolioMonitorExecution[];
  status?: PortfolioMonitorStatus;
  account?: PortfolioMonitorOutput["account"];
}>) => {
  // Why fills are not shown (gateway not live, or account mode mismatch); null when they are.
  const withheld =
    status === undefined
      ? null
      : accountDataWithheld({
          status,
          account: account ?? {
            mode: null,
            modeSource: null,
            modeConfirmedAt: null,
            modeError: "not-reported",
            count: 0,
          },
        });
  const statusLine =
    status === undefined ? null : (
      <JournalStatusLine status={status} withheld={withheld} />
    );
  if (received.length === 0)
    return (
      <div className="space-y-3">
        {statusLine}
        <EmptyState
          description={
            withheld ??
            "IBKR reported no fills in the current execution window."
          }
          icon={<NotebookPen />}
          title={withheld === null ? "No fills yet" : "Fills withheld"}
        />
      </div>
    );
  const executions = latestExecutions(received);
  return (
    <div className="space-y-6" data-journal="report">
      {statusLine}
      {received.length >= PORTFOLIO_MONITOR_MAX_ROWS ? (
        <p
          className="text-sm text-warning-foreground"
          data-journal-notice="cap"
          role="note"
        >
          Showing the first {PORTFOLIO_MONITOR_MAX_ROWS} fills; older fills in
          the window were cut off.
        </p>
      ) : null}
      <JournalKpiRow executions={executions} />
      <Panel title="Cumulative realized P&L">
        <CumulativeRealizedChart points={cumulativeRealized(executions)} />
      </Panel>
      <Panel flush title="By symbol">
        <SymbolTable executions={executions} />
      </Panel>
      <Panel
        description="Every fill in the window, oldest first."
        flush
        title="Fills"
      >
        <FillTable executions={executions} />
      </Panel>
    </div>
  );
};

export interface TradeJournalProps {
  /** Test seam; defaults to the browser API client for `source`. */
  readonly load?: JournalSnapshotLoader;
  /** From the server environment; null sends no request and shows "not configured". */
  readonly source: JournalSource | null;
}

export const TradeJournal = ({ source, load: supplied }: TradeJournalProps) => {
  const [load] = useState<JournalSnapshotLoader | null>(() =>
    source === null ? null : (supplied ?? createBrowserJournalLoader(source))
  );
  const [reloadKey, setReloadKey] = useState(0);
  const state = useLoadOnce(load, reloadKey);
  const busy = state.type === "loading";

  const body = (() => {
    if (state.type === "idle")
      return <JournalFailure detail={null} kind="not-configured" />;
    if (state.type === "loading")
      return (
        <div aria-busy="true" className="space-y-4" role="status">
          <span className="sr-only">Loading fills</span>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      );
    if (state.type === "error") {
      const failure = describePortfolioMonitorFailure(state.error);
      if (failure.kind === "forbidden")
        return <OperatorAccessRequired feature="ibkr-monitor" />;
      return (
        <JournalFailure
          detail={`${failure.code}: ${failure.message}`}
          kind={failure.kind}
        />
      );
    }
    return (
      <JournalReport
        account={state.value.account}
        executions={state.value.executions}
        status={state.value.status}
      />
    );
  })();

  return (
    <div className="space-y-4" data-journal-state={state.type}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p
          className="max-w-prose text-muted-foreground text-sm"
          data-journal-notice="window"
          role="note"
        >
          {JOURNAL_WINDOW_NOTICE} Read-only: nothing here can place, change or
          cancel an order.
        </p>
        <Button
          disabled={load === null || busy}
          onClick={() => setReloadKey((key) => key + 1)}
          size="sm"
          variant="outline"
        >
          <RotateCcw
            aria-hidden="true"
            className={cn("size-4", busy && "motion-safe:animate-spin")}
          />
          Refresh
        </Button>
      </div>
      {body}
    </div>
  );
};
