// What: pure assembly of flow-off-exchange-levels.v1 (flow.offExchangeLevels) from stored SPY
// flow_minutes, flow_events (kind = 'off_exchange_print'), ticks source freshness, and optional
// openbb_finra_otc_weekly rows.
// Used by: packages/api/src/server/flow.ts (the flow.offExchangeLevels handler).
// Research only: describes sampled off-exchange prints and lagged FINRA weekly OTC shares.
// Doc: docs/vertex-rebuild/designs/vertex-viz-offexchange-levels/design.md.
import {
  FLOW_OFF_EXCHANGE_LEVELS_VERSION,
  type FlowOffExchangeLevels,
  type FlowOffExchangeRange,
  type FlowOffExchangeSymbol,
} from "../contracts/flow.ts";
import {
  foldOffExchangeLevels,
  OFF_EXCHANGE_FINRA_LOOKBACK_DAYS,
  OFF_EXCHANGE_LEVELS_RULES,
  OFF_EXCHANGE_RANGE_CONFIG,
  type OffExchangeEventRow,
  type OffExchangeFinraRow,
  type OffExchangeMinuteRow,
} from "../flow-off-exchange-levels-rules.ts";
import { buildSourceFreshness, type FlowSampleRow } from "./flow-snapshot.ts";
import { newYorkTime } from "./merged-bars.ts";

const DAY_MS = 86_400_000;
const STOCK_OPEN_MINUTE = 570;
const STOCK_CLOSE_MINUTE = 960;

export type FlowOffExchangeLevelsRows = Readonly<{
  symbol: FlowOffExchangeSymbol;
  range: FlowOffExchangeRange;
  now: Date;
  /** New York date of the newest stored minute row; null when no minutes exist. */
  anchorSession: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  minutes: readonly OffExchangeMinuteRow[];
  events: readonly OffExchangeEventRow[];
  truncated: boolean;
  finraRows: readonly OffExchangeFinraRow[];
  latest: readonly FlowSampleRow[];
  latestOk: readonly FlowSampleRow[];
}>;

/** Shifts a YYYY-MM-DD calendar date backward by `days` calendar days. */
export const shiftCalendarDate = (isoDate: string, days: number): string => {
  const [year = 1970, month = 1, day = 1] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) - days * DAY_MS)
    .toISOString()
    .slice(0, 10);
};

/** Inclusive [from, to) UTC query window covering regular NY hours for the chosen lookback range. */
export const offExchangeWindowRange = (
  anchorSession: string,
  range: FlowOffExchangeRange
): Readonly<{ from: Date; to: Date }> => {
  const lookback = OFF_EXCHANGE_RANGE_CONFIG[range].calendarLookbackDays;
  const startDay = shiftCalendarDate(anchorSession, lookback - 1);
  return {
    from: newYorkTime(startDay, STOCK_OPEN_MINUTE),
    to: newYorkTime(anchorSession, STOCK_CLOSE_MINUTE),
  };
};

/** Start date (YYYY-MM-DD) for querying FINRA weekly OTC context rows relative to `anchorDate`. */
export const offExchangeFinraFromDate = (anchorDate: string): string =>
  shiftCalendarDate(anchorDate, OFF_EXCHANGE_FINRA_LOOKBACK_DAYS);

/**
 * Builds flow-off-exchange-levels.v1 for SPY. Without a stored session: empty bars/prints/levels
 * with ticks freshness and any stored FINRA weekly context.
 */
export const buildFlowOffExchangeLevels = (
  rows: FlowOffExchangeLevelsRows
): FlowOffExchangeLevels => {
  const fold = foldOffExchangeLevels({
    events: rows.events,
    finraRows: rows.finraRows,
    minutes: rows.minutes,
    range: rows.range,
    truncated: rows.truncated,
  });

  return {
    anchorSession: rows.anchorSession,
    bars: fold.bars,
    bucketMinutes: fold.bucketMinutes,
    finraWeekly: fold.finraWeekly,
    latestPrice: fold.latestPrice,
    latestPriceAt: fold.latestPriceAt,
    levels: fold.levels,
    prints: fold.prints,
    range: rows.range,
    rules: { ...OFF_EXCHANGE_LEVELS_RULES },
    schemaVersion: FLOW_OFF_EXCHANGE_LEVELS_VERSION,
    sessions: fold.sessions,
    symbol: rows.symbol,
    ticks: buildSourceFreshness(rows, "ticks"),
    totals: fold.totals,
    windowEnd: rows.windowEnd?.toISOString() ?? null,
    windowStart: rows.windowStart?.toISOString() ?? null,
  };
};
