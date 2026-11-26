"use client";

// What: compact status bar, legend and expandable detail list for stored IBKR order-flow marks
// (stacked imbalances and absorption) overlaid on the /charts price chart. Research only.
// Used by: components/portal/charts-workspace.tsx.
import type { FlowDirection, FlowSnapshotEvent } from "@darkfactory/api";
import type {
  OrderFlowChartMarkers,
  OrderFlowMarkerItem,
} from "../../features/order-flow/order-flow-markers.ts";
import { formatPrice } from "./order-flow-views.tsx";

export type FlowEventsLoadState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "unsupported"; symbol: string; secType: string }>
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{
      type: "ready";
      events: readonly FlowSnapshotEvent[];
      truncated: boolean;
    }>;

const etDateTime = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "short",
  timeZone: "America/New_York",
});

const formatEventTime = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${etDateTime.format(new Date(ms))} ET` : iso;
};

const ITEM_TONE_CLASS: Readonly<Record<FlowDirection, string>> = {
  bearish: "font-semibold text-destructive",
  bullish: "font-semibold text-success-foreground",
  neutral: "font-semibold text-foreground",
};

const itemBadgeText = (item: OrderFlowMarkerItem): string => {
  if (item.shortLabel === "SI") {
    if (item.direction === "bullish") return "▲ SI";
    if (item.direction === "bearish") return "▼ SI";
    return "• SI";
  }
  if (item.direction === "bullish") return "◆ ABS ▲";
  if (item.direction === "bearish") return "◆ ABS ▼";
  return "◆ ABS";
};

const MarksDetails = ({
  items,
  priceDigits,
}: Readonly<{
  items: readonly OrderFlowMarkerItem[];
  priceDigits: number;
}>) => (
  <details className="text-xs">
    <summary className="inline-flex min-h-11 cursor-pointer select-none items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-2">
      Show {items.length} mark{items.length === 1 ? "" : "s"}
    </summary>
    <ul
      className="mt-2 max-h-48 space-y-1 overflow-auto font-mono"
      data-flow-marks-list=""
    >
      {items.map((item) => (
        <li
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-border border-t pt-1"
          key={item.id}
        >
          <span className="text-muted-foreground">
            {formatEventTime(item.at)}
          </span>
          <span className={ITEM_TONE_CLASS[item.direction]}>
            {itemBadgeText(item)}
          </span>
          {item.price === null ? null : (
            <span className="tabular-nums">
              @ {formatPrice(item.price, priceDigits)}
            </span>
          )}
          <span className="font-sans text-muted-foreground">{item.detail}</span>
        </li>
      ))}
    </ul>
  </details>
);

export interface OrderFlowMarksBarProps {
  readonly enabled: boolean;
  readonly state: FlowEventsLoadState;
  readonly summary: OrderFlowChartMarkers | null;
  readonly priceDigits: number;
}

export const OrderFlowMarksBar = ({
  enabled,
  state,
  summary,
  priceDigits,
}: OrderFlowMarksBarProps) => {
  if (!enabled || state.type === "idle") return null;
  if (state.type === "unsupported")
    return (
      <p
        className="text-muted-foreground text-xs"
        data-flow-marks-status="unsupported"
      >
        {/* A forex chart has no Order flow panel (no ticks or depth), so the text does not point to one. */}
        {state.secType === "CASH"
          ? "Order-flow marks are not available for forex (CASH)."
          : `Order-flow marks: stored IBKR flow_events cover SPY and QQQ equities and ES and NQ futures only (${state.symbol} ${state.secType} shows print-computed marks in the Order flow Footprint tab below).`}
      </p>
    );
  if (state.type === "loading")
    return (
      <p
        aria-busy="true"
        className="text-muted-foreground text-xs"
        data-flow-marks-status="loading"
      >
        Loading stored order-flow marks…
      </p>
    );
  if (state.type === "forbidden")
    return (
      <p
        className="text-muted-foreground text-xs"
        data-flow-marks-status="forbidden"
        role="status"
      >
        Operator access required to load stored order-flow marks.
      </p>
    );
  if (state.type === "error")
    return (
      <p
        className="text-destructive text-xs"
        data-flow-marks-status="error"
        role="alert"
      >
        Could not load stored order-flow marks: {state.message}
      </p>
    );
  if (summary === null) return null;

  return (
    <div
      className="space-y-2 rounded-md border border-border bg-card px-3 py-2 text-xs"
      data-flow-marks-summary=""
    >
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground"
        role="status"
      >
        <span className="font-medium text-foreground">
          Order-flow marks (stored IBKR flow_events)
        </span>
        {summary.shownEvents === 0 ? (
          <span>
            none in loaded bars
            {summary.outsideEvents > 0
              ? ` · ${summary.outsideEvents} outside loaded bars`
              : ""}
          </span>
        ) : (
          <>
            <span className="font-mono text-success-foreground">
              ▲ SI buy: {summary.stackedBuy}
            </span>
            <span className="font-mono text-destructive">
              ▼ SI sell: {summary.stackedSell}
            </span>
            <span className="font-mono text-success-foreground">
              ◆ ABS bullish: {summary.absorptionSell}
            </span>
            <span className="font-mono text-destructive">
              ◆ ABS bearish: {summary.absorptionBuy}
            </span>
            {summary.outsideEvents > 0 ? (
              <span>· {summary.outsideEvents} outside loaded bars</span>
            ) : null}
            {state.truncated ? <span>· newest 200 shown</span> : null}
          </>
        )}
      </div>
      {summary.items.length > 0 ? (
        <MarksDetails items={summary.items} priceDigits={priceDigits} />
      ) : null}
    </div>
  );
};
