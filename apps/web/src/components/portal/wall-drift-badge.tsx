"use client";

// What: the GEX wall x net drift read badge (gex-wall-drift-rules.v1) of the /flow and /stock
// pages, and the stock page loader of flow.control net drift. Where the read applies, every
// missing or stale input shows "No data" with its reason, never a blank.
// Research only: the read describes what was observed and is never a trade signal.
// Doc: docs/vertex-rebuild/designs/gex-wall-drift-confluence/design.md.
import type { FlowControl, FlowControlInput } from "@darkfactory/api";
import { StatusBadge } from "@darkfactory/ui";
import { useEffect, useId, useState } from "react";

import {
  isWallDriftTicker,
  stockWallDriftView,
  WALL_DRIFT_HELP,
  WALL_DRIFT_STUDY_STATUS,
  type WallDriftAnalyticsState,
  type WallDriftControlState,
  type WallDriftView,
  wallDriftGroupOf,
} from "../../features/flow/wall-drift-view-model.ts";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";

export const WallDriftBadge = ({
  heading = "h3",
  view,
}: Readonly<{ heading?: "h2" | "h3"; view: WallDriftView }>) => {
  const headingId = useId();
  const Heading = heading;
  const reason =
    view.collectorNote === null
      ? view.reason
      : `${view.reason} · collector: ${view.collectorNote}`;
  return (
    <section
      aria-labelledby={headingId}
      className="grid min-h-40 content-start gap-1 rounded-md border border-border px-3 py-2"
      data-wall-drift={view.read}
      data-wall-drift-code={view.code ?? ""}
      data-wall-drift-ticker={view.ticker ?? ""}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Heading className="font-medium text-sm" id={headingId}>
          Wall × drift{view.ticker === null ? "" : ` · ${view.ticker}`}
        </Heading>
        <StatusBadge status={view.tone}>{view.label}</StatusBadge>
      </div>
      <p className="text-muted-foreground text-xs">
        {WALL_DRIFT_STUDY_STATUS} · research only
      </p>
      <p
        className="min-h-4 text-muted-foreground text-xs tabular-nums"
        data-wall-drift-context=""
      >
        {view.context}
      </p>
      <p
        className="line-clamp-2 min-h-8 text-muted-foreground text-xs tabular-nums"
        data-wall-drift-reason=""
        title={reason}
      >
        {reason}
      </p>
      <details className="text-muted-foreground text-xs">
        <summary className="min-h-11 w-fit cursor-pointer content-center">
          About this read
        </summary>
        <p className="pb-1" data-wall-drift-full-reason="">
          {reason}
        </p>
        <p className="pb-1">{WALL_DRIFT_HELP}</p>
        <p data-wall-drift-inputs="">{view.inputs}</p>
      </details>
    </section>
  );
};

type FlowControlLoader = (input: FlowControlInput) => Promise<FlowControl>;

const systemNow = (): Date => new Date();

/** The read is re-checked this often, so a graded read turns "No data" once its inputs age out. */
const RECHECK_MS = 60_000;

/**
 * The stock page read for an operator on SPY, SPX, QQQ or NDX: options analytics GEX plus
 * flow.control net drift. Other accounts and symbols get no badge and send no request (net drift
 * is operator-only vendor data and exists for these four tickers only).
 */
export const StockWallDrift = ({
  analytics,
  enabled,
  loadControl,
  now = systemNow,
  symbol,
}: Readonly<{
  analytics: WallDriftAnalyticsState;
  enabled: boolean;
  loadControl: FlowControlLoader | undefined;
  now?: () => Date;
  symbol: string;
}>) => {
  const ticker = enabled && isWallDriftTicker(symbol) ? symbol : null;
  const [state, setState] = useState<WallDriftControlState>(() =>
    loadControl === undefined
      ? { kind: "failed", message: "this page does not load flow.control" }
      : { kind: "loading" }
  );
  const [checkedAt, setCheckedAt] = useState(now);
  // A new analytics answer reloads the drift so both inputs are of the same time.
  const receivedAt =
    analytics.kind === "ready" ? analytics.analytics.receivedAt : null;
  useEffect(() => {
    // No request while options analytics loads or failed: missing levels decide the read first.
    if (ticker === null || loadControl === undefined || receivedAt === null)
      return;
    let live = true;
    // A reload keeps the last answer on screen; the rule's age limit still marks it stale.
    setState((current) =>
      current.kind === "ready" ? current : { kind: "loading" }
    );
    loadControl({ group: wallDriftGroupOf(ticker) }).then(
      (control) => {
        if (!live) return;
        setState({ control, kind: "ready" });
        setCheckedAt(now());
      },
      (reason: unknown) => {
        if (!live) return;
        const described = describePortfolioMonitorFailure(reason);
        setState({
          kind: "failed",
          message: `${described.code}: ${described.message}`,
        });
        setCheckedAt(now());
      }
    );
    return () => {
      live = false;
    };
  }, [ticker, loadControl, now, receivedAt]);
  useEffect(() => {
    if (ticker === null) return;
    const timer = setInterval(() => setCheckedAt(now()), RECHECK_MS);
    return () => clearInterval(timer);
  }, [ticker, now]);
  if (ticker === null) return null;
  return (
    <WallDriftBadge
      view={stockWallDriftView(ticker, analytics, state, checkedAt)}
    />
  );
};
