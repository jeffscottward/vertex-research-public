// What: projects stored IBKR flow_events (stacked_imbalance, absorption) onto price-chart
// ChartMarkers and correlates them with Footprint time buckets. Pure display logic; no order path.
// Used by: components/portal/charts-workspace.tsx, components/portal/order-flow-panel.tsx,
//          components/portal/order-flow-views.tsx.
import type { FlowDirection, FlowSnapshotEvent } from "@darkfactory/api";
import type { ChartMarker, DisplayCandle } from "../charts/types.ts";
import type { Footprint } from "./footprint.ts";

export const ORDER_FLOW_MARKER_KINDS = [
  "stacked_imbalance",
  "absorption",
] as const;
export type OrderFlowMarkerKind = (typeof ORDER_FLOW_MARKER_KINDS)[number];

export type OrderFlowMarkerItem = Readonly<{
  id: string;
  at: string;
  kind: OrderFlowMarkerKind;
  direction: FlowDirection;
  price: number | null;
  detail: string;
  shortLabel: "SI" | "ABS";
  /** True when the event falls inside the loaded price bars. */
  onChart: boolean;
}>;

export type OrderFlowChartMarkers = Readonly<{
  markers: readonly ChartMarker[];
  shownEvents: number;
  outsideEvents: number;
  stackedBuy: number;
  stackedSell: number;
  absorptionBuy: number;
  absorptionSell: number;
  items: readonly OrderFlowMarkerItem[];
}>;

export type FootprintBucketStoredMarks = Readonly<{
  stackedImbalances: readonly FlowSnapshotEvent[];
  absorptions: readonly FlowSnapshotEvent[];
}>;

export type FootprintStoredEvents = Readonly<{
  /** Indexed by bucket.start (epoch seconds). */
  byBucketStart: ReadonlyMap<number, FootprintBucketStoredMarks>;
  matchedCount: number;
}>;

const isMarkerKind = (
  kind: FlowSnapshotEvent["kind"]
): kind is OrderFlowMarkerKind =>
  kind === "stacked_imbalance" || kind === "absorption";

// Last candle whose start is at or before ms, or -1.
const candleIndexAt = (
  candles: readonly DisplayCandle[],
  ms: number
): number => {
  let low = 0;
  let high = candles.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candle = candles[middle];
    if (candle !== undefined && candle.timestamp <= ms) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
};

interface MarkerGroup {
  candle: DisplayCandle;
  kind: OrderFlowMarkerKind;
  direction: FlowDirection;
  count: number;
}

const buildMarkersFromGroups = (
  groups: ReadonlyMap<string, MarkerGroup>
): ChartMarker[] => {
  // Sort deterministically by candle time, then absorption before stacked_imbalance.
  const ordered = [...groups.values()].sort((a, b) =>
    a.candle.timestamp === b.candle.timestamp
      ? a.kind.localeCompare(b.kind)
      : a.candle.timestamp - b.candle.timestamp
  );
  const sideSlots = new Map<string, number>();
  return ordered.map((group) => {
    const position = group.direction === "bullish" ? "below" : "above";
    const slotKey = `${group.candle.timestamp}|${position}`;
    const stackOrder = sideSlots.get(slotKey) ?? 0;
    sideSlots.set(slotKey, stackOrder + 1);
    const prefix = group.kind === "stacked_imbalance" ? "SI" : "ABS";
    const value =
      group.direction === "bullish"
        ? group.candle.low
        : group.direction === "bearish"
          ? group.candle.high
          : group.candle.close;
    return {
      id: `flow-${group.kind}-${group.direction}-${group.candle.timestamp}`,
      position,
      shape: group.kind === "stacked_imbalance" ? "arrow" : "diamond",
      stackOrder,
      text: group.count > 1 ? `${prefix} ×${group.count}` : prefix,
      timestamp: group.candle.timestamp,
      tone: group.direction,
      value,
    };
  });
};

export const flowEventsToChartMarkers = (
  events: readonly FlowSnapshotEvent[],
  candles: readonly DisplayCandle[],
  barSeconds: number
): OrderFlowChartMarkers => {
  const lastCandle = candles.at(-1);
  const end =
    lastCandle === undefined
      ? Number.NEGATIVE_INFINITY
      : lastCandle.timestamp + barSeconds * 1000;
  const groups = new Map<string, MarkerGroup>();
  const items: OrderFlowMarkerItem[] = [];
  const counts = {
    absorptionBuy: 0,
    absorptionSell: 0,
    outsideEvents: 0,
    shownEvents: 0,
    stackedBuy: 0,
    stackedSell: 0,
  };

  const intraday = barSeconds > 0 && barSeconds < 86_400;
  for (const [index, event] of events.entries()) {
    if (!isMarkerKind(event.kind)) continue;
    const ms = Date.parse(event.at);
    const matched =
      Number.isFinite(ms) && ms < end
        ? candles[candleIndexAt(candles, ms)]
        : undefined;
    const candle =
      matched !== undefined &&
      (!intraday || ms < matched.timestamp + barSeconds * 1000)
        ? matched
        : undefined;
    const onChart = candle !== undefined;
    items.push({
      at: event.at,
      detail: event.detail,
      direction: event.direction,
      id: `of-${event.kind}-${event.at}-${index}`,
      kind: event.kind,
      onChart,
      price: event.price,
      shortLabel: event.kind === "stacked_imbalance" ? "SI" : "ABS",
    });
    if (!onChart) {
      counts.outsideEvents += 1;
      continue;
    }
    counts.shownEvents += 1;
    if (event.kind === "stacked_imbalance") {
      if (event.direction === "bullish") counts.stackedBuy += 1;
      else if (event.direction === "bearish") counts.stackedSell += 1;
    } else if (event.direction === "bearish") {
      counts.absorptionBuy += 1;
    } else if (event.direction === "bullish") {
      counts.absorptionSell += 1;
    }
    const groupKey = `${candle.timestamp}|${event.kind}|${event.direction}`;
    const existing = groups.get(groupKey);
    if (existing === undefined)
      groups.set(groupKey, {
        candle,
        count: 1,
        direction: event.direction,
        kind: event.kind,
      });
    else existing.count += 1;
  }

  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    ...counts,
    items,
    markers: buildMarkersFromGroups(groups),
  };
};

export const matchEventsToFootprint = (
  events: readonly FlowSnapshotEvent[],
  footprint: Footprint
): FootprintStoredEvents => {
  const byBucketStart = new Map<
    number,
    { stackedImbalances: FlowSnapshotEvent[]; absorptions: FlowSnapshotEvent[] }
  >();
  let matchedCount = 0;
  for (const event of events) {
    if (!isMarkerKind(event.kind)) continue;
    const ms = Date.parse(event.at);
    if (!Number.isFinite(ms)) continue;
    const sec = Math.floor(ms / 1000);
    const bucket = footprint.buckets.find(
      (candidate) => sec >= candidate.start && sec < candidate.end
    );
    if (bucket === undefined) continue;
    const entry = byBucketStart.get(bucket.start) ?? {
      absorptions: [],
      stackedImbalances: [],
    };
    if (event.kind === "stacked_imbalance") entry.stackedImbalances.push(event);
    else entry.absorptions.push(event);
    byBucketStart.set(bucket.start, entry);
    matchedCount += 1;
  }
  return { byBucketStart, matchedCount };
};
