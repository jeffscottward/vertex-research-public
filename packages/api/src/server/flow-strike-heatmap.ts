// What: pure assembly of flow-strike-heatmap.v1 (flow.strikeHeatmap) from stored domain-agnostic
// strike-bucket aggregates, per-slot underlying prices, open collector gaps, and options source
// freshness.
// Used by: packages/api/src/server/flow.ts (the flow.strikeHeatmap handler).
// Research only: the heatmap describes stored option prints, never a trade signal.
// Doc: docs/vertex-rebuild/designs/vertex-viz-flow-strike-time-heatmap/design.md.
import {
  FLOW_STRIKE_HEATMAP_VERSION,
  type FlowHedgingUnread,
  type FlowStrikeHeatmap,
  type FlowStrikeHeatmapBucketMinutes,
  type FlowStrikeHeatmapSymbol,
} from "../contracts/flow.ts";
import { FLOW_INSTRUMENTS } from "../flow-features.ts";
import {
  foldStrikeHeatmap,
  STRIKE_HEATMAP_RULES,
  type StrikeHeatmapBucketRow,
  type StrikeHeatmapGapRow,
  type StrikeHeatmapSlotPriceRow,
} from "../flow-strike-heatmap-rules.ts";
import { optionsSessionRange } from "./flow-control.ts";
import { buildSourceFreshness, type FlowSampleRow } from "./flow-snapshot.ts";

export type FlowStrikeHeatmapRows = Readonly<{
  symbol: FlowStrikeHeatmapSymbol;
  bucketMinutes: FlowStrikeHeatmapBucketMinutes;
  now: Date;
  /** New York date of the newest options session; null when no print is stored. */
  session: string | null;
  buckets: readonly StrikeHeatmapBucketRow[];
  slotPrices: readonly StrikeHeatmapSlotPriceRow[];
  gaps: readonly StrikeHeatmapGapRow[];
  latest: readonly FlowSampleRow[];
  latestOk: readonly FlowSampleRow[];
}>;

const unreadOf = (
  gaps: readonly StrikeHeatmapGapRow[],
  from: Date,
  to: Date
): FlowHedgingUnread | null => {
  const inside = gaps.filter((gap) => {
    const startMs = gap.startTime.getTime();
    const endMs = gap.endTime.getTime();
    return (
      startMs < to.getTime() &&
      (endMs > from.getTime() ||
        (endMs === startMs && startMs === from.getTime()))
    );
  });
  if (inside.length === 0) return null;
  const start = Math.min(...inside.map((gap) => gap.startTime.getTime()));
  const end = Math.max(...inside.map((gap) => gap.endTime.getTime()));
  return {
    from: new Date(Math.max(start, from.getTime())).toISOString(),
    ranges: inside.length,
    to: new Date(Math.min(end, to.getTime())).toISOString(),
  };
};

/**
 * Builds flow-strike-heatmap.v1 of one symbol. Without a session: empty slots/strikes/cells and
 * zero totals. With a session: folds the session's strike buckets and slot prices into the
 * bounded heatmap with clipped open-gap metadata and options source freshness.
 */
export const buildFlowStrikeHeatmap = (
  rows: FlowStrikeHeatmapRows
): FlowStrikeHeatmap => {
  const range =
    rows.session === null ? null : optionsSessionRange(rows.session);
  const fold =
    range === null
      ? foldStrikeHeatmap({
          bucketMinutes: rows.bucketMinutes,
          buckets: [],
          gaps: [],
          range: { from: new Date(0), to: new Date(0) },
          slotPrices: [],
        })
      : foldStrikeHeatmap({
          bucketMinutes: rows.bucketMinutes,
          buckets: rows.buckets,
          gaps: rows.gaps,
          range,
          slotPrices: rows.slotPrices,
        });

  return {
    bucketMinutes: rows.bucketMinutes,
    cells: fold.cells,
    options: buildSourceFreshness(rows, "options"),
    rules: { ...STRIKE_HEATMAP_RULES },
    schemaVersion: FLOW_STRIKE_HEATMAP_VERSION,
    session: rows.session,
    slots: fold.slots,
    storedUntil: fold.storedUntil,
    strikes: fold.strikes,
    symbol: rows.symbol,
    ticker: FLOW_INSTRUMENTS[rows.symbol].optionsTicker,
    totals: fold.totals,
    unread: range === null ? null : unreadOf(rows.gaps, range.from, range.to),
  };
};
