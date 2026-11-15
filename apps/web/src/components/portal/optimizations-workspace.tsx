"use client";

import type {
  OptimizationGetOutput,
  OptimizationSummaryOutput,
} from "@darkfactory/api";
import {
  Button,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { useCallback, useEffect, useState } from "react";

import {
  createBrowserOptimizationsGateway,
  describeAgentOpsFailure,
  formatTimestamp,
  InfoGlyph,
  isOperatorAccessDenied,
  OperatorAccessRequired,
  type OptimizationsGateway,
} from "./agent-ops-client.tsx";
import {
  DSR_HELP,
  OptimizationDetail,
  PBO_HELP,
} from "./optimizations-detail.tsx";
import {
  formatMarkets,
  formatProbability,
  formatScore,
  isOptimizationTab,
  METHOD_LABELS,
  type OptimizationTab,
  VALIDATION_LABELS,
} from "./optimizations-model.ts";

export interface OptimizationsWorkspaceProps {
  readonly gateway?: OptimizationsGateway;
  // undefined reads ?id= and ?strategy= from the address bar; null means none.
  readonly initialOptimizationId?: string | null;
  readonly initialStrategyId?: string | null;
}

type ListState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; rows: OptimizationSummaryOutput[] }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "forbidden" }>;

type DetailState =
  | Readonly<{ type: "closed" }>
  | Readonly<{ type: "loading"; id: string }>
  | Readonly<{ type: "ready"; detail: OptimizationGetOutput }>
  | Readonly<{ type: "error"; id: string; message: string }>;

const readParam = (name: string): string | null => {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get(name);
  return value === null || value === "" ? null : value;
};

const readInitialTab = (): OptimizationTab => {
  const value = readParam("tab");
  return isOptimizationTab(value) ? value : "overview";
};

// Keeps ?id= and ?tab= in the address bar so a detail view can be linked and restored; ?strategy= stays.
const writeLocation = (id: string | null, tab: OptimizationTab): void => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id === null) {
    url.searchParams.delete("id");
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("id", id);
    if (tab === "overview") {
      url.searchParams.delete("tab");
    } else url.searchParams.set("tab", tab);
  }
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
};

const headCell = "py-1 pr-3 font-normal";
// TableHead sets text-foreground on the cell, so column headers restate the muted colour.
const columnHeadCell = `${headCell} text-muted-foreground`;

export const OptimizationsWorkspace = ({
  gateway: suppliedGateway,
  initialOptimizationId,
  initialStrategyId,
}: OptimizationsWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserOptimizationsGateway()
  );
  const [strategyId] = useState(() =>
    initialStrategyId === undefined ? readParam("strategy") : initialStrategyId
  );
  const [state, setState] = useState<ListState>({ type: "loading" });
  const [detail, setDetail] = useState<DetailState>({ type: "closed" });
  const [tab, setTab] = useState<OptimizationTab>(readInitialTab);
  const selectTab = useCallback(
    (next: OptimizationTab) => {
      setTab(next);
      if (detail.type === "ready")
        return writeLocation(detail.detail.optimization.id, next);
      return;
    },
    [detail]
  );
  const close = useCallback(() => {
    setDetail({ type: "closed" });
    setTab("overview");
    return writeLocation(null, "overview");
  }, []);

  const load = useCallback(async () => {
    setState({ type: "loading" });
    try {
      return setState({
        rows: await gateway.list(strategyId === null ? {} : { strategyId }),
        type: "ready",
      });
    } catch (error) {
      return setState(
        isOperatorAccessDenied(error)
          ? { type: "forbidden" }
          : { message: describeAgentOpsFailure(error), type: "error" }
      );
    }
  }, [gateway, strategyId]);

  const open = useCallback(
    async (id: string, fromLink = false) => {
      if (!fromLink) {
        setTab("overview");
        writeLocation(id, "overview");
      }
      setDetail({ id, type: "loading" });
      try {
        return setDetail({ detail: await gateway.get(id), type: "ready" });
      } catch (error) {
        return setDetail({
          id,
          message: describeAgentOpsFailure(error),
          type: "error",
        });
      }
    },
    [gateway]
  );

  useEffect(() => {
    void load();
    const id =
      initialOptimizationId === undefined
        ? readParam("id")
        : initialOptimizationId;
    if (id !== null && id !== "") void open(id, true);
    return;
  }, [load, open, initialOptimizationId]);

  if (state.type === "forbidden")
    return <OperatorAccessRequired feature="optimizations" />;

  return (
    <div className="space-y-6">
      <p className="text-sm" data-autopilot-link="">
        <a
          className="inline-flex min-h-11 items-center underline underline-offset-2"
          href="/autopilot"
        >
          Autopilot campaigns
        </a>
      </p>
      {detail.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading optimization…
        </p>
      ) : detail.type === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm">{detail.message}</p>
          <Button
            onClick={() => setDetail({ type: "closed" })}
            type="button"
            variant="secondary"
          >
            Close
          </Button>
        </div>
      ) : detail.type === "ready" ? (
        <OptimizationDetail
          detail={detail.detail}
          onClose={close}
          onTab={selectTab}
          tab={tab}
        />
      ) : null}
      {strategyId === null ? null : (
        <p className="text-xs" data-strategy-filter={strategyId}>
          <span className="text-muted-foreground">Strategy filter</span>
          <span className="ml-2 font-mono">
            {state.type === "ready"
              ? (state.rows[0]?.strategyName ?? strategyId)
              : strategyId}
          </span>
          <a
            className="ml-3 inline-flex min-h-11 items-center underline underline-offset-2"
            href="/optimizations"
          >
            Show all
          </a>
        </p>
      )}
      {state.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading optimizations…
        </p>
      ) : state.type === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm">{state.message}</p>
          <Button onClick={() => void load()} type="button" variant="secondary">
            Retry
          </Button>
        </div>
      ) : state.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No optimizer runs.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table
            className="w-full min-w-[60rem] text-sm"
            data-click-private=""
            data-optimizations-table=""
          >
            <TableCaption className="sr-only">Optimizer runs</TableCaption>
            <TableHeader>
              <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
                <TableHead className={columnHeadCell} scope="col">
                  Strategy
                </TableHead>
                <TableHead className={columnHeadCell} scope="col">
                  Method
                </TableHead>
                <TableHead className={columnHeadCell} scope="col">
                  Markets
                </TableHead>
                <TableHead className={columnHeadCell} scope="col">
                  Validation
                </TableHead>
                <TableHead
                  className={`${headCell} text-right text-muted-foreground`}
                  scope="col"
                >
                  Trials
                  <InfoGlyph text="Trials the optimizer ran; fewer may be stored." />
                </TableHead>
                <TableHead
                  className={`${headCell} text-right text-muted-foreground`}
                  scope="col"
                >
                  Best score
                  <InfoGlyph text="Robust objective of the selected trial as recorded (mean across markets minus a dispersion penalty)." />
                </TableHead>
                <TableHead
                  className={`${headCell} text-right text-muted-foreground`}
                  scope="col"
                >
                  DSR
                  <InfoGlyph text={DSR_HELP} />
                </TableHead>
                <TableHead
                  className={`${headCell} text-right text-muted-foreground`}
                  scope="col"
                >
                  PBO
                  <InfoGlyph text={PBO_HELP} />
                </TableHead>
                <TableHead className={columnHeadCell} scope="col">
                  Created (UTC)
                </TableHead>
                <TableHead className={columnHeadCell} scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.rows.map((row) => {
                return (
                  <TableRow
                    className="border-border border-b [&>td]:align-top [&>th]:align-top"
                    data-optimization-id={row.id}
                    key={row.id}
                  >
                    <TableHead
                      className="h-auto whitespace-normal py-1 pr-3 font-normal"
                      scope="row"
                    >
                      {row.strategyName ?? (
                        <span className="text-muted-foreground">Unlinked</span>
                      )}
                      <span className="block text-muted-foreground text-xs">
                        {row.taskTitle ?? row.taskId}
                      </span>
                    </TableHead>
                    <TableCell className="py-1 pr-3 text-xs" data-col="method">
                      {METHOD_LABELS[row.method] ?? row.method}
                    </TableCell>
                    <TableCell
                      className="py-1 pr-3 font-mono text-xs"
                      data-col="markets"
                      title={row.markets.join(", ")}
                    >
                      {formatMarkets(row.markets)}
                    </TableCell>
                    <TableCell
                      className="py-1 pr-3 text-xs"
                      data-col="validation"
                    >
                      {VALIDATION_LABELS[row.validation.mode] ??
                        row.validation.mode}
                    </TableCell>
                    <TableCell
                      className="py-1 pr-3 text-right font-mono text-xs"
                      data-col="trials"
                    >
                      {row.trialCount}
                    </TableCell>
                    <TableCell
                      className="py-1 pr-3 text-right font-mono text-xs"
                      data-col="best"
                    >
                      {formatScore(row.best?.score)}
                    </TableCell>
                    <TableCell
                      className="py-1 pr-3 text-right font-mono text-xs"
                      data-col="dsr"
                      title={row.diagnostics?.deflatedSharpeReason ?? undefined}
                    >
                      {formatProbability(
                        row.diagnostics?.deflatedSharpe?.probability
                      )}
                    </TableCell>
                    <TableCell
                      className="py-1 pr-3 text-right font-mono text-xs"
                      data-col="pbo"
                      title={row.diagnostics?.pboReason ?? undefined}
                    >
                      {formatProbability(row.diagnostics?.pbo?.pbo)}
                    </TableCell>
                    <TableCell className="py-1 pr-3 font-mono text-muted-foreground text-xs">
                      {formatTimestamp(row.createdAt)}
                    </TableCell>
                    <TableCell className="py-1 text-right">
                      <Button
                        aria-label={`Open ${row.strategyName ?? row.taskTitle ?? row.id}`}
                        onClick={() => void open(row.id)}
                        type="button"
                        variant="secondary"
                      >
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};
