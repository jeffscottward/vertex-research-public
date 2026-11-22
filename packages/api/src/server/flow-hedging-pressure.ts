// What: the pure assembly of flow-hedging-pressure.v1 (flow.hedgingPressure) from stored rows: the
// prints of one options session cut to the read cap and folded by the hedging pressure rules, the
// collector's open gaps inside the session, and the freshness of the options source.
// Used by: packages/api/src/server/flow.ts (the flow.hedgingPressure handler).
// Research only: the line is an estimate of dealer hedging, never a trade signal.
// Doc: docs/vertex-rebuild/flow-pipeline.md ("Hedging pressure (SPY, ES)").
import {
  FLOW_HEDGING_PRESSURE_VERSION,
  type FlowHedgingPressure,
  type FlowHedgingSymbol,
  type FlowHedgingUnread,
} from "../contracts/flow.ts";
import { FLOW_INSTRUMENTS } from "../flow-features.ts";
import {
  foldHedgingPressure,
  HEDGING_PRESSURE_RULES,
  HEDGING_READ_CAP,
  type HedgingPrint,
} from "../flow-hedging-pressure-rules.ts";
import { optionsSessionRange } from "./flow-control.ts";
import { buildSourceFreshness, type FlowSampleRow } from "./flow-snapshot.ts";

/** An unread range of the collector (flow_option_gaps): from startTime to endTime. */
export type FlowHedgingGapRow = Readonly<{ startTime: Date; endTime: Date }>;

export type FlowHedgingPressureRows = Readonly<{
  symbol: FlowHedgingSymbol;
  now: Date;
  /** New York date of the options session; null when no print is stored. */
  session: string | null;
  /** The prints of the session, ascending by trade time then id; at most HEDGING_READ_CAP + 1. */
  prints: readonly HedgingPrint[];
  /** Every stored gap of the symbol. */
  gaps: readonly FlowHedgingGapRow[];
  /** Newest sample of any status, and newest ok sample, per source. */
  latest: readonly FlowSampleRow[];
  latestOk: readonly FlowSampleRow[];
}>;

/**
 * The gaps that overlap the session as one span: the oldest start and the newest end, both
 * clipped to the session, and the count of such gaps; null without one.
 */
const unreadOf = (
  gaps: readonly FlowHedgingGapRow[],
  from: Date,
  to: Date
): FlowHedgingUnread | null => {
  const inside = gaps.filter((gap) => gap.startTime < to && gap.endTime > from);
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
 * flow-hedging-pressure.v1 of one symbol. Without a session: no points and zero totals. With a
 * session: the prints inside the session range are cut to HEDGING_READ_CAP (the newest are
 * dropped and `truncated` is true), then folded. `cap` exists for tests only.
 */
export const buildFlowHedgingPressure = (
  rows: FlowHedgingPressureRows,
  cap: number = HEDGING_READ_CAP
): FlowHedgingPressure => {
  const range =
    rows.session === null ? null : optionsSessionRange(rows.session);
  const inSession =
    range === null
      ? []
      : rows.prints.filter(
          (print) => print.tradedAt >= range.from && print.tradedAt < range.to
        );
  const fold = foldHedgingPressure(inSession.slice(0, cap));
  return {
    options: buildSourceFreshness(rows, "options"),
    points: fold.points,
    rules: { ...HEDGING_PRESSURE_RULES },
    schemaVersion: FLOW_HEDGING_PRESSURE_VERSION,
    session: rows.session,
    storedUntil: fold.storedUntil,
    symbol: rows.symbol,
    ticker: FLOW_INSTRUMENTS[rows.symbol].optionsTicker,
    totals: fold.totals,
    truncated: inSession.length > cap,
    unread: range === null ? null : unreadOf(rows.gaps, range.from, range.to),
  };
};
