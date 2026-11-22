// What: pure assembly of flow-put-call-ratio.v1 (flow.putCallRatio) from stored per-minute and
// per-day option print aggregates, open collector gaps, and options source freshness.
// Used by: packages/api/src/server/flow.ts (the flow.putCallRatio handler).
// Research only: the ratios describe stored option prints, never a trade signal.
// Doc: docs/vertex-rebuild/flow-pipeline.md ("Put/call ratio (SPY, ES)").
import {
  FLOW_PUT_CALL_RATIO_MAX_DAYS,
  FLOW_PUT_CALL_RATIO_VERSION,
  type FlowHedgingUnread,
  type FlowPutCallRatio,
  type FlowPutCallRatioSymbol,
} from "../contracts/flow.ts";
import { FLOW_INSTRUMENTS } from "../flow-features.ts";
import {
  foldPutCallDays,
  foldPutCallSession,
  PUT_CALL_RATIO_RULES,
  type PutCallDayRow,
  type PutCallMinuteRow,
} from "../flow-put-call-ratio-rules.ts";
import { optionsSessionRange } from "./flow-control.ts";
import { buildSourceFreshness, type FlowSampleRow } from "./flow-snapshot.ts";

/** An unread range of the collector (flow_option_gaps): from startTime to endTime. */
export type FlowPutCallGapRow = Readonly<{ startTime: Date; endTime: Date }>;

export type FlowPutCallRatioRows = Readonly<{
  symbol: FlowPutCallRatioSymbol;
  now: Date;
  /** New York date of the newest options session; null when no print is stored. */
  session: string | null;
  /** Per-minute sums of the newest session, ascending by minute. */
  minutes: readonly PutCallMinuteRow[];
  /** Per-session sums over stored sessions, oldest first. */
  days: readonly PutCallDayRow[];
  /** Every stored open gap of the symbol. */
  gaps: readonly FlowPutCallGapRow[];
  /** Newest sample of any status, and newest ok sample, per source. */
  latest: readonly FlowSampleRow[];
  latestOk: readonly FlowSampleRow[];
}>;

const overlappingGaps = (
  gaps: readonly FlowPutCallGapRow[],
  from: Date,
  to: Date
): readonly FlowPutCallGapRow[] =>
  gaps.filter((gap) => gap.startTime < to && gap.endTime > from);

const unreadOf = (
  gaps: readonly FlowPutCallGapRow[],
  from: Date,
  to: Date
): FlowHedgingUnread | null => {
  const inside = overlappingGaps(gaps, from, to);
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
 * flow-put-call-ratio.v1 of one symbol. Without a session: no points, no days and zero totals.
 * With a session: minutes inside [09:30, 16:15) ET fold into running ratios, and daily rows
 * (bounded to the newest FLOW_PUT_CALL_RATIO_MAX_DAYS) fold with per-session gap flags.
 */
export const buildFlowPutCallRatio = (
  rows: FlowPutCallRatioRows
): FlowPutCallRatio => {
  const range =
    rows.session === null ? null : optionsSessionRange(rows.session);
  const inSession =
    range === null
      ? []
      : rows.minutes.filter(
          (row) => row.minute >= range.from && row.minute < range.to
        );
  const fold = foldPutCallSession(inSession);
  const days =
    rows.session === null
      ? []
      : foldPutCallDays(
          rows.days.slice(-FLOW_PUT_CALL_RATIO_MAX_DAYS),
          (session) => {
            const dayRange = optionsSessionRange(session);
            return (
              overlappingGaps(rows.gaps, dayRange.from, dayRange.to).length > 0
            );
          }
        );

  return {
    days,
    options: buildSourceFreshness(rows, "options"),
    points: fold.points,
    rules: { ...PUT_CALL_RATIO_RULES },
    schemaVersion: FLOW_PUT_CALL_RATIO_VERSION,
    session: rows.session,
    storedUntil: fold.storedUntil,
    symbol: rows.symbol,
    ticker: FLOW_INSTRUMENTS[rows.symbol].optionsTicker,
    totals: fold.totals,
    unread: range === null ? null : unreadOf(rows.gaps, range.from, range.to),
  };
};
