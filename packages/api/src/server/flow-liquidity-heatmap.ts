// What: server-side assembly of flow-liquidity-heatmap.v1 (flow.liquidityHeatmap) from stored
// flow_book_snapshots, flow_large_trades, and flow_samples (depth freshness).
// Used by: packages/api/src/server/flow.ts (the flow.liquidityHeatmap handler).
// Research only: describes recorded CME L2 resting liquidity and large prints; never a signal.

import type {
  FlowBookSnapshotRecord,
  FlowLargeTradeRecord,
  FlowRepository,
} from "@darkfactory/db/server";
import type {
  FlowLiquidityHeatmap,
  FlowLiquidityHeatmapParsedInput,
  FlowTapeSymbol,
} from "../contracts/flow.ts";
import { buildFlowLiquidityHeatmap } from "../flow-liquidity-heatmap-rules.ts";
import { buildSourceFreshness, type FlowSampleRow } from "./flow-snapshot.ts";

/** Covers a full 390-minute streamed window at 5-second cadence (4,680 rows) with headroom. */
export const FLOW_BOOK_SNAPSHOTS_READ_LIMIT = 5000;

export type FlowLiquidityHeatmapRows = Readonly<{
  largeTrades: readonly FlowLargeTradeRecord[];
  latest: readonly FlowSampleRow[];
  latestOk: readonly FlowSampleRow[];
  minutes: number;
  now: Date;
  snapshots: readonly FlowBookSnapshotRecord[];
  symbol: FlowTapeSymbol;
  windowEnd: Date;
  windowStart: Date;
}>;

/** Reads stored L2 snapshots, large trades, and depth freshness for one window. */
export const readFlowLiquidityHeatmapRows = async (
  repository: Pick<
    FlowRepository,
    "latestSamples" | "readBookSnapshots" | "readLargeTrades"
  >,
  input: FlowLiquidityHeatmapParsedInput,
  now: Date
): Promise<FlowLiquidityHeatmapRows> => {
  const windowEnd = now;
  // Read an extra 3 minutes before windowStart so floor-aligned axis buckets never miss the left edge.
  const windowStart = new Date(windowEnd.getTime() - input.minutes * 60_000);
  const readFrom = new Date(windowStart.getTime() - 180_000);
  const [snapshots, largeTrades, samples] = await Promise.all([
    repository.readBookSnapshots({
      from: readFrom,
      limit: FLOW_BOOK_SNAPSHOTS_READ_LIMIT,
      symbol: input.symbol,
      to: windowEnd,
    }),
    repository.readLargeTrades({
      from: readFrom,
      symbol: input.symbol,
      to: windowEnd,
    }),
    repository.latestSamples(input.symbol, ["depth"]),
  ]);
  return {
    ...samples,
    largeTrades,
    minutes: input.minutes,
    now,
    snapshots,
    symbol: input.symbol,
    windowEnd,
    windowStart,
  };
};

/** Builds flow-liquidity-heatmap.v1 from the rows loaded by readFlowLiquidityHeatmapRows. */
export const buildFlowLiquidityHeatmapFromRows = (
  rows: FlowLiquidityHeatmapRows
): FlowLiquidityHeatmap =>
  buildFlowLiquidityHeatmap({
    depth: buildSourceFreshness(rows, "depth"),
    largeTrades: rows.largeTrades,
    minutes: rows.minutes,
    now: rows.now,
    snapshots: rows.snapshots,
    symbol: rows.symbol,
    windowEnd: rows.windowEnd,
    windowStart: rows.windowStart,
  });
