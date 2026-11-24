// What: Jigsaw-style Live DOM ladder panel for ES and NQ on /flow (flow.liveDomStream).
// Streams uncached CME L2 resting depth and unsettled per-price traded volume over a bounded
// oRPC SSE lease with client-side pulling/stacking queue deltas, server-side Reset vol (`since`),
// axis lock + re-center, pause/resume, hidden-tab auto-pause, exponential backoff, keyboard row
// inspection, and truthful recorded fallback.
// Research only: describes the resting book and executed tape; never places orders or arms trading.
// Used by: apps/web/src/components/portal/flow-workspace.tsx.
// See: apps/web/src/features/flow/live-dom-view-model.ts;
// docs/vertex-rebuild/designs/vertex-viz-live-dom/design.md.
"use client";

import type {
  FlowLiveDom,
  FlowLiveDomCadenceMs,
  FlowLiveDomStreamEvent,
  FlowLiveDomWindowSeconds,
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
import { Crosshair, Lock, Pause, Play, RotateCcw, Unlock } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type BookSizesByTick,
  buildLiveDomDisplayRows,
  buildLiveDomKpis,
  buildLiveDomStatusBanner,
  captureBookSizes,
  domSymbolOf,
  frameCenterTick,
  inspectLiveDomRow,
  LIVE_DOM_CADENCE_OPTIONS,
  LIVE_DOM_WINDOW_OPTIONS,
  type LiveDomConnectionPhase,
  type LiveDomDisplayRow,
  type LiveDomStreamRequest,
  liveDomTitle,
  nextDomBackoffMs,
  shouldResetDomClientState,
} from "../../features/flow/live-dom-view-model.ts";
import type { FlowSymbol } from "../../features/flow/view-model.ts";
import { FLOW_SELECT_CLASS } from "./flow-control-panel.tsx";

export interface LiveDomStreamGateway {
  readonly liveDomStream: (
    input: LiveDomStreamRequest,
    options?: Readonly<{ signal?: AbortSignal }>
  ) => Promise<AsyncIterable<FlowLiveDomStreamEvent>>;
}

export interface FlowLiveDomPanelProps {
  readonly gateway: LiveDomStreamGateway;
  readonly now?: () => number;
  readonly symbol: FlowSymbol;
}

const waitAbortable = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const deltaColorClass = (delta: number): string => {
  if (delta > 0) return "text-[var(--color-success)]";
  if (delta < 0) return "text-[var(--color-destructive)]";
  return "text-muted-foreground";
};

const isTerminalAuthError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error) {
    const code = error.code;
    if (code === "UNAUTHORIZED" || code === "FORBIDDEN") return true;
  }
  if ("status" in error) {
    const status = error.status;
    if (status === 401 || status === 403) return true;
  }
  return false;
};

const nextRowKey = (
  key: string,
  currentIndex: number,
  rowCount: number
): number | "clear" | null => {
  if (key === "ArrowUp") return Math.max(0, currentIndex - 1);
  if (key === "ArrowDown") return Math.min(rowCount - 1, currentIndex + 1);
  if (key === "Home") return 0;
  if (key === "End") return rowCount - 1;
  if (key === "Escape") return "clear";
  return null;
};

const DomLegend = () => (
  <div
    className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-muted-foreground text-xs"
    data-live-dom-legend=""
  >
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-3.5 rounded-xs"
        style={{
          backgroundColor:
            "color-mix(in oklab, var(--color-info) 45%, transparent)",
        }}
      />
      <span>Resting bid</span>
    </span>
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-3.5 rounded-xs"
        style={{
          backgroundColor:
            "color-mix(in oklab, var(--color-warning) 45%, transparent)",
        }}
      />
      <span>Resting ask</span>
    </span>
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-3.5 rounded-xs"
        style={{
          backgroundColor:
            "color-mix(in oklab, var(--color-success) 55%, transparent)",
        }}
      />
      <span>Bought at ask (Ask T)</span>
    </span>
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-3.5 rounded-xs"
        style={{
          backgroundColor:
            "color-mix(in oklab, var(--color-destructive) 55%, transparent)",
        }}
      />
      <span>Sold at bid (Bid T)</span>
    </span>
    <span>
      POC = highest traded volume price · 3x = aggressive imbalance (&ge; 15)
    </span>
  </div>
);

const DomLadderRow = ({
  displayRow,
  isFirstRow,
  isSelected,
  onKeyDown,
  onSelect,
  rowRef,
}: Readonly<{
  displayRow: LiveDomDisplayRow;
  isFirstRow: boolean;
  isSelected: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => void;
  onSelect: () => void;
  rowRef: (node: HTMLTableRowElement | null) => void;
}>) => {
  const { row } = displayRow;
  const insideDivider = row.isBestBid
    ? "border-t-2 border-t-[var(--color-warning)]"
    : "";
  const rowHighlight = isSelected
    ? "bg-accent/50"
    : row.isPoc
      ? "bg-muted/40"
      : "";

  return (
    <TableRow
      aria-current={isSelected ? "true" : undefined}
      aria-label={displayRow.ariaLabel}
      data-selected={isSelected ? "true" : undefined}
      className={`cursor-pointer font-mono text-xs tabular-nums focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px] ${insideDivider} ${rowHighlight}`}
      data-live-dom-row={String(row.tickIndex)}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      ref={rowRef}
      tabIndex={isSelected || isFirstRow ? 0 : -1}
    >
      <TableCell
        className={`hidden w-14 text-right sm:table-cell ${deltaColorClass(displayRow.bidDelta)}`}
        data-live-dom-bid-delta=""
      >
        {displayRow.bidDeltaText}
      </TableCell>
      <TableCell className="relative w-20 text-right" data-live-dom-bid="">
        {displayRow.bidBarPct > 0 ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-1 right-1 rounded-xs"
            style={{
              backgroundColor:
                "color-mix(in oklab, var(--color-info) 30%, transparent)",
              width: `${displayRow.bidBarPct}%`,
            }}
          />
        ) : null}
        <span
          className={`relative z-10 ${row.isBestBid ? "font-semibold text-foreground" : "text-foreground"}`}
        >
          {displayRow.bidSizeText}
        </span>
      </TableCell>
      <TableCell
        className="relative hidden w-18 text-right md:table-cell"
        data-live-dom-bid-trade=""
      >
        {displayRow.bidTradeBarPct > 0 ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-1 right-1 rounded-xs"
            style={{
              backgroundColor:
                "color-mix(in oklab, var(--color-destructive) 25%, transparent)",
              width: `${displayRow.bidTradeBarPct}%`,
            }}
          />
        ) : null}
        <span
          className={`relative z-10 ${row.imbalance === "sell" ? "font-semibold text-[var(--color-destructive)]" : "text-foreground"}`}
        >
          {displayRow.bidTradeText}
          {row.imbalance === "sell" ? " 3x" : ""}
        </span>
      </TableCell>
      <TableHead
        className="h-auto w-32 whitespace-normal bg-muted/25 text-center font-semibold text-foreground"
        scope="row"
      >
        <span className="inline-flex items-center justify-center gap-1">
          <span>{displayRow.priceText}</span>
          {row.isBestAsk ? (
            <span className="rounded-xs border border-border px-1 font-medium font-sans text-[10px] text-muted-foreground">
              ASK
            </span>
          ) : null}
          {row.isBestBid ? (
            <span className="rounded-xs border border-border px-1 font-medium font-sans text-[10px] text-muted-foreground">
              BID
            </span>
          ) : null}
          {row.isLastTrade ? (
            <span className="rounded-xs bg-[var(--color-success)] px-1 font-sans font-semibold text-[10px] text-background">
              LTP
            </span>
          ) : null}
          {row.isPoc ? (
            <span className="rounded-xs bg-[var(--color-warning)] px-1 font-sans font-semibold text-[10px] text-background">
              POC
            </span>
          ) : null}
        </span>
      </TableHead>
      <TableCell
        className="relative hidden w-18 text-left md:table-cell"
        data-live-dom-ask-trade=""
      >
        {displayRow.askTradeBarPct > 0 ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-1 left-1 rounded-xs"
            style={{
              backgroundColor:
                "color-mix(in oklab, var(--color-success) 25%, transparent)",
              width: `${displayRow.askTradeBarPct}%`,
            }}
          />
        ) : null}
        <span
          className={`relative z-10 ${row.imbalance === "buy" ? "font-semibold text-[var(--color-success)]" : "text-foreground"}`}
        >
          {displayRow.askTradeText}
          {row.imbalance === "buy" ? " 3x" : ""}
        </span>
      </TableCell>
      <TableCell className="relative w-20 text-left" data-live-dom-ask="">
        {displayRow.askBarPct > 0 ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-1 left-1 rounded-xs"
            style={{
              backgroundColor:
                "color-mix(in oklab, var(--color-warning) 30%, transparent)",
              width: `${displayRow.askBarPct}%`,
            }}
          />
        ) : null}
        <span
          className={`relative z-10 ${row.isBestAsk ? "font-semibold text-foreground" : "text-foreground"}`}
        >
          {displayRow.askSizeText}
        </span>
      </TableCell>
      <TableCell
        className={`hidden w-14 text-left sm:table-cell ${deltaColorClass(displayRow.askDelta)}`}
        data-live-dom-ask-delta=""
      >
        {displayRow.askDeltaText}
      </TableCell>
      <TableCell className="min-w-36" data-live-dom-volume="">
        <div className="flex items-center justify-between gap-2">
          <div className="relative h-4 flex-1 overflow-hidden rounded-xs bg-muted/40">
            {displayRow.volBuyBarPct > 0 ? (
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0"
                style={{
                  backgroundColor:
                    "color-mix(in oklab, var(--color-success) 60%, transparent)",
                  width: `${displayRow.volBuyBarPct}%`,
                }}
              />
            ) : null}
            {displayRow.volSellBarPct > 0 ? (
              <span
                aria-hidden="true"
                className="absolute inset-y-0"
                style={{
                  backgroundColor:
                    "color-mix(in oklab, var(--color-destructive) 60%, transparent)",
                  left: `${displayRow.volBuyBarPct}%`,
                  width: `${displayRow.volSellBarPct}%`,
                }}
              />
            ) : null}
            {displayRow.volUnsignedBarPct > 0 ? (
              <span
                aria-hidden="true"
                className="absolute inset-y-0 bg-muted-foreground/45"
                style={{
                  left: `${displayRow.volBuyBarPct + displayRow.volSellBarPct}%`,
                  width: `${displayRow.volUnsignedBarPct}%`,
                }}
              />
            ) : null}
          </div>
          <span className="w-12 text-right font-medium text-foreground">
            {displayRow.tradedTotalText}
          </span>
          <span
            className={`w-12 text-right ${deltaColorClass(row.tradedDelta)}`}
          >
            {displayRow.tradedDeltaText}
          </span>
        </div>
      </TableCell>
    </TableRow>
  );
};

export const FlowLiveDomPanel = ({
  gateway,
  now = Date.now,
  symbol,
}: FlowLiveDomPanelProps) => {
  const domSymbol = domSymbolOf(symbol);
  const windowId = useId();
  const cadenceId = useId();

  const [windowSeconds, setWindowSeconds] =
    useState<FlowLiveDomWindowSeconds>(900);
  const [cadenceMs, setCadenceMs] = useState<FlowLiveDomCadenceMs>(500);
  const [sinceState, setSinceState] = useState<
    Readonly<{ symbol: string; value: number | null }>
  >({ symbol: domSymbol, value: null });
  const since = sinceState.symbol === domSymbol ? sinceState.value : null;
  const [paused, setPaused] = useState(false);
  const [pausedAtMs, setPausedAtMs] = useState<number | null>(null);
  const [tabHidden, setTabHidden] = useState(
    () =>
      typeof document !== "undefined" && document.visibilityState === "hidden"
  );
  const [lockedCenterTick, setLockedCenterTick] = useState<number | null>(null);
  const [selectedTick, setSelectedTick] = useState<number | null>(null);

  const [frame, setFrame] = useState<FlowLiveDom | null>(null);
  const [prevBookSizes, setPrevBookSizes] = useState<BookSizesByTick | null>(
    null
  );
  const [phase, setPhase] = useState<LiveDomConnectionPhase>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorAtMs, setErrorAtMs] = useState<number | null>(null);
  const [retryInMs, setRetryInMs] = useState<number | null>(null);

  const prevFrameRef = useRef<FlowLiveDom | null>(null);
  const rowRefs = useRef<Map<number, HTMLTableRowElement | null>>(new Map());

  // Track browser tab visibility so hidden tabs pause streaming automatically.
  useEffect(() => {
    const onVisibilityChange = () => {
      setTabHidden(document.visibilityState === "hidden");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // Reset client-local ladder state when switching between ES and NQ groups.
  useEffect(() => {
    prevFrameRef.current = null;
    setFrame(null);
    setPrevBookSizes(null);
    setLockedCenterTick(null);
    setSelectedTick(null);
    setErrorMessage(null);
    setErrorAtMs(null);
    setRetryInMs(null);
  }, [domSymbol]);

  // Bounded SSE stream consumer with automatic lease renewal and exponential backoff.
  useEffect(() => {
    if (paused) {
      setPhase("paused");
      return;
    }
    if (tabHidden) {
      setPhase("hidden");
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    const runLoop = async () => {
      let attempt = 0;
      setPhase((current) =>
        current === "streaming" ? "reconnecting" : "connecting"
      );

      while (!signal.aborted) {
        let nextDelayMs = 250;
        try {
          const stream = await gateway.liveDomStream(
            {
              cadenceMs,
              rows: 10,
              ...(since === null ? {} : { since }),
              symbol: domSymbol,
              windowSeconds,
            },
            { signal }
          );

          for await (const event of stream) {
            if (signal.aborted) return;
            if (event.type === "frame") {
              attempt = 0;
              setErrorMessage(null);
              setErrorAtMs(null);
              setRetryInMs(null);
              const previous = prevFrameRef.current;
              if (
                previous === null ||
                shouldResetDomClientState(previous, event.frame)
              ) {
                setPrevBookSizes(null);
                setLockedCenterTick(null);
              } else {
                setPrevBookSizes(captureBookSizes(previous.rows));
              }
              prevFrameRef.current = event.frame;
              setFrame(event.frame);
              setPhase("streaming");
            } else if (event.type === "heartbeat") {
              setPhase("streaming");
            } else {
              nextDelayMs = event.retryAfterMs;
              if (event.reason === "upstream_interrupted") {
                setRetryInMs(event.retryAfterMs);
                setPhase("interrupted");
              } else {
                setPhase(
                  event.reason === "lease_expired"
                    ? "reconnecting"
                    : "streaming"
                );
              }
            }
          }
        } catch (error) {
          if (signal.aborted) return;
          const message =
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Live DOM stream request failed";
          if (isTerminalAuthError(error)) {
            setPhase("auth_error");
            setErrorAtMs(now());
            setRetryInMs(null);
            setErrorMessage(message);
            return;
          }
          const delay = nextDomBackoffMs(attempt);
          attempt += 1;
          setPhase("error");
          setErrorAtMs(now());
          setRetryInMs(delay);
          setErrorMessage(message);
          nextDelayMs = delay;
        }

        await waitAbortable(nextDelayMs, signal);
      }
    };

    void runLoop();
    return () => {
      controller.abort();
    };
  }, [
    cadenceMs,
    domSymbol,
    gateway,
    now,
    paused,
    since,
    tabHidden,
    windowSeconds,
  ]);

  const displayRows = useMemo(
    () =>
      frame === null
        ? []
        : buildLiveDomDisplayRows(frame, prevBookSizes, lockedCenterTick),
    [frame, lockedCenterTick, prevBookSizes]
  );

  const kpis = useMemo(
    () => (frame === null ? [] : buildLiveDomKpis(frame)),
    [frame]
  );

  const statusBanner = useMemo(
    () =>
      buildLiveDomStatusBanner({
        cadenceMs,
        errorAtMs,
        errorMessage,
        frame,
        pausedAtMs,
        phase,
        retryInMs,
        symbol: domSymbol,
      }),
    [
      cadenceMs,
      domSymbol,
      errorAtMs,
      errorMessage,
      frame,
      pausedAtMs,
      phase,
      retryInMs,
    ]
  );

  const inspectedRow = useMemo(() => {
    if (selectedTick === null) return null;
    return displayRows.find((d) => d.row.tickIndex === selectedTick) ?? null;
  }, [displayRows, selectedTick]);

  const handleTogglePause = () => {
    if (paused) {
      setPaused(false);
      setPausedAtMs(null);
    } else {
      setPaused(true);
      setPausedAtMs(now());
    }
  };

  const handleToggleReset = () => {
    setSinceState({
      symbol: domSymbol,
      value: since === null ? Math.max(1, Math.floor(now() / 1000)) : null,
    });
  };

  const currentCenterTick = useMemo(
    () => (frame === null ? null : frameCenterTick(frame)),
    [frame]
  );

  const handleToggleLock = () => {
    setLockedCenterTick((current) =>
      current === null ? currentCenterTick : null
    );
  };

  const handleRecenter = () => {
    setLockedCenterTick(null);
    setSelectedTick(null);
  };

  const handleRowKeyDown = (
    event: KeyboardEvent<HTMLTableRowElement>,
    index: number
  ) => {
    const target = nextRowKey(event.key, index, displayRows.length);
    if (target === null) return;
    event.preventDefault();
    if (target === "clear") {
      setSelectedTick(null);
      return;
    }
    // target is clamped to [0, displayRows.length - 1] on a non-empty rendered table
    const nextRow = displayRows[target] as LiveDomDisplayRow;
    setSelectedTick(nextRow.row.tickIndex);
    rowRefs.current.get(nextRow.row.tickIndex)?.focus();
  };

  return (
    <Panel
      data-live-dom-panel={domSymbol}
      description="Live CME L2 depth and streamed traded-volume profile (Jigsaw-style). Read-only research view: never places orders, arms trading, or changes risk settings."
      title={liveDomTitle(symbol)}
    >
      <div className="space-y-4">
        <div
          className="flex flex-wrap items-center justify-between gap-2"
          data-live-dom-status=""
        >
          <div className="flex flex-wrap items-center gap-2">
            <span role="status">
              <StatusBadge status={statusBanner.tone}>
                {statusBanner.badge}
              </StatusBadge>
            </span>
            <span className="text-muted-foreground text-xs">
              {statusBanner.detail}
            </span>
          </div>
        </div>

        <div
          className="flex flex-wrap items-end gap-2"
          data-live-dom-controls=""
        >
          <Button
            className="min-h-11"
            data-live-dom-pause=""
            onClick={handleTogglePause}
            size="sm"
            variant={paused ? "default" : "outline"}
          >
            {paused ? (
              <Play aria-hidden="true" className="size-4" />
            ) : (
              <Pause aria-hidden="true" className="size-4" />
            )}
            {paused ? "Resume live" : "Pause"}
          </Button>

          <label className="space-y-1" htmlFor={cadenceId}>
            <span className="block text-muted-foreground text-xs">Cadence</span>
            <select
              className={FLOW_SELECT_CLASS}
              data-live-dom-cadence=""
              id={cadenceId}
              onChange={(event) =>
                setCadenceMs(Number(event.target.value) as FlowLiveDomCadenceMs)
              }
              value={cadenceMs}
            >
              {LIVE_DOM_CADENCE_OPTIONS.map((option) => (
                <option key={option.ms} value={option.ms}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1" htmlFor={windowId}>
            <span className="block text-muted-foreground text-xs">
              Vol window
            </span>
            <select
              className={FLOW_SELECT_CLASS}
              data-live-dom-window=""
              id={windowId}
              onChange={(event) => {
                setSinceState({ symbol: domSymbol, value: null });
                setWindowSeconds(
                  Number(event.target.value) as FlowLiveDomWindowSeconds
                );
              }}
              value={windowSeconds}
            >
              {LIVE_DOM_WINDOW_OPTIONS.map((option) => (
                <option key={option.seconds} value={option.seconds}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <Button
            aria-pressed={since !== null}
            className="min-h-11"
            data-live-dom-reset=""
            onClick={handleToggleReset}
            size="sm"
            variant={since === null ? "outline" : "secondary"}
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            {since === null ? "Reset vol" : "Full window"}
          </Button>

          <Button
            aria-pressed={lockedCenterTick !== null}
            className="min-h-11"
            data-live-dom-lock=""
            disabled={currentCenterTick === null}
            onClick={handleToggleLock}
            size="sm"
            variant={lockedCenterTick === null ? "outline" : "secondary"}
          >
            {lockedCenterTick === null ? (
              <Lock aria-hidden="true" className="size-4" />
            ) : (
              <Unlock aria-hidden="true" className="size-4" />
            )}
            {lockedCenterTick === null ? "Lock axis" : "Axis locked"}
          </Button>

          <Button
            className="min-h-11"
            data-live-dom-recenter=""
            disabled={lockedCenterTick === null && selectedTick === null}
            onClick={handleRecenter}
            size="sm"
            variant="outline"
          >
            <Crosshair aria-hidden="true" className="size-4" />
            Re-center
          </Button>
        </div>

        {kpis.length > 0 ? (
          <dl
            className="grid grid-cols-2 gap-3 lg:grid-cols-4"
            data-live-dom-kpis=""
          >
            {kpis.map((kpi) => (
              <div
                className="rounded-md border border-border bg-muted/20 px-3 py-2"
                data-live-dom-kpi={kpi.id}
                key={kpi.id}
              >
                <dt className="text-muted-foreground text-xs">{kpi.label}</dt>
                <dd className="mt-0.5 font-mono font-semibold text-sm tabular-nums">
                  {kpi.value}
                </dd>
                <dd className="text-muted-foreground text-xs tabular-nums">
                  {kpi.detail}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {inspectedRow === null ? null : (
          <p
            aria-live="polite"
            className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs tabular-nums"
            data-live-dom-inspection=""
          >
            {inspectLiveDomRow(inspectedRow)}
          </p>
        )}

        {displayRows.length === 0 ? (
          <p
            className="rounded-md border border-border px-4 py-6 text-center text-muted-foreground text-sm"
            data-live-dom-empty=""
          >
            {frame === null
              ? phase === "paused"
                ? `Live DOM stream for ${domSymbol} is paused. Select Resume live to connect.`
                : phase === "auth_error"
                  ? `Sign-in is required to view the ${domSymbol} live DOM stream.`
                  : phase === "error"
                    ? `Live DOM stream for ${domSymbol} has not connected yet. Retrying automatically.`
                    : `Connecting to ${domSymbol} live DOM stream. Ladder rows appear when the first frame arrives.`
              : `No resting L2 quotes or prints for ${domSymbol} in this window.`}
          </p>
        ) : (
          <div className="max-h-[34rem] overflow-y-auto rounded-md border border-border">
            <TableScroll label={`Live DOM price ladder for ${domSymbol}`}>
              <Table className="w-full" data-live-dom-table="">
                <TableCaption className="sr-only">
                  Live DOM price ladder for {domSymbol} with resting bids, asks,
                  queue changes, and traded volume
                </TableCaption>
                <TableHeader className="sticky top-0 z-20 bg-card">
                  <TableRow>
                    <TableHead
                      className="hidden text-right sm:table-cell"
                      scope="col"
                    >
                      Bid Δ
                    </TableHead>
                    <TableHead className="text-right" scope="col">
                      Bid
                    </TableHead>
                    <TableHead
                      className="hidden text-right md:table-cell"
                      scope="col"
                    >
                      Bid T
                    </TableHead>
                    <TableHead className="text-center" scope="col">
                      Price
                    </TableHead>
                    <TableHead
                      className="hidden text-left md:table-cell"
                      scope="col"
                    >
                      Ask T
                    </TableHead>
                    <TableHead className="text-left" scope="col">
                      Ask
                    </TableHead>
                    <TableHead
                      className="hidden text-left sm:table-cell"
                      scope="col"
                    >
                      Ask Δ
                    </TableHead>
                    <TableHead scope="col">Volume · Net Δ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayRows.map((displayRow, index) => (
                    <DomLadderRow
                      displayRow={displayRow}
                      isFirstRow={inspectedRow === null && index === 0}
                      isSelected={selectedTick === displayRow.row.tickIndex}
                      key={displayRow.row.tickIndex}
                      onKeyDown={(event) => handleRowKeyDown(event, index)}
                      onSelect={() => setSelectedTick(displayRow.row.tickIndex)}
                      rowRef={(node) => {
                        if (node === null) {
                          rowRefs.current.delete(displayRow.row.tickIndex);
                        } else {
                          rowRefs.current.set(displayRow.row.tickIndex, node);
                        }
                      }}
                    />
                  ))}
                </TableBody>
              </Table>
            </TableScroll>
          </div>
        )}

        <DomLegend />
      </div>
    </Panel>
  );
};
