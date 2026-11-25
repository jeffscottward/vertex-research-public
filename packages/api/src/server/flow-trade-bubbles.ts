// What: server-side assembly of flow-trade-bubbles.v1 (flow.tradeBubbles) from stored
// flow_minutes, flow_large_trades, and flow_samples (ticks freshness).
// Used by: packages/api/src/server/flow.ts (the flow.tradeBubbles handler).
// Research only: describes recorded CME futures 1-minute prices and deep prints; never a signal.

import type {
  FlowLargeTradeRecord,
  FlowMinuteRecord,
  FlowRepository,
} from "@darkfactory/db/server";
import type {
  FlowTapeSymbol,
  FlowTradeBubbles,
  FlowTradeBubblesParsedInput,
} from "../contracts/flow.ts";
import { buildFlowTradeBubbles } from "../flow-trade-bubbles-rules.ts";
import { buildSourceFreshness, type FlowSampleRow } from "./flow-snapshot.ts";

const MINUTE_MS = 60_000;

export type FlowTradeBubblesRows = Readonly<{
  largeTrades: readonly FlowLargeTradeRecord[];
  latest: readonly FlowSampleRow[];
  latestOk: readonly FlowSampleRow[];
  minuteBars: readonly FlowMinuteRecord[];
  minutes: number;
  now: Date;
  symbol: FlowTapeSymbol;
  windowEnd: Date;
  windowStart: Date;
}>;

/**
 * Reads stored 1-minute OHLC/VWAP bars, stored deep trades, and tape freshness for one ES or NQ
 * window. Anchors windowEnd to the newest stored data (extended by 60 s clamped to now so deep
 * trades inside the newest minute row are never cut off) when data is older than now.
 */
export const readFlowTradeBubblesRows = async (
  repository: Pick<
    FlowRepository,
    "latestSamples" | "newestDataAt" | "readLargeTrades" | "readMinutes"
  >,
  input: FlowTradeBubblesParsedInput,
  now: Date
): Promise<FlowTradeBubblesRows> => {
  const newest = await repository.newestDataAt(input.symbol);
  const windowEnd =
    newest === null || newest.getTime() >= now.getTime()
      ? now
      : new Date(Math.min(now.getTime(), newest.getTime() + MINUTE_MS));
  const windowStart = new Date(windowEnd.getTime() - input.minutes * MINUTE_MS);
  const [minuteBars, largeTrades, samples] = await Promise.all([
    repository.readMinutes({
      from: windowStart,
      symbol: input.symbol,
      to: windowEnd,
    }),
    repository.readLargeTrades({
      from: windowStart,
      symbol: input.symbol,
      to: windowEnd,
    }),
    repository.latestSamples(input.symbol, ["ticks"]),
  ]);
  return {
    ...samples,
    largeTrades,
    minuteBars,
    minutes: input.minutes,
    now,
    symbol: input.symbol,
    windowEnd,
    windowStart,
  };
};

/** Builds flow-trade-bubbles.v1 from the rows loaded by readFlowTradeBubblesRows. */
export const buildFlowTradeBubblesFromRows = (
  rows: FlowTradeBubblesRows
): FlowTradeBubbles =>
  buildFlowTradeBubbles({
    largeTrades: rows.largeTrades,
    minuteBars: rows.minuteBars,
    minutes: rows.minutes,
    symbol: rows.symbol,
    tape: buildSourceFreshness(rows, "ticks"),
    windowEnd: rows.windowEnd,
    windowStart: rows.windowStart,
  });
