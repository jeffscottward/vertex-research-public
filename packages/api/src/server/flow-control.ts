// What: the pure assembly of flow-control.v1 (flow.control) from stored rows: the options side of one
// index group from the settled net drift buckets of its primary and check tickers, the net drift
// series, the cross-check against stored option prints, the study status and freshness; the futures
// side from the covered tape minutes and the deep trades of the group's future, the agreement of the
// two sides, the deep trades block, the session levels and the session event. No I/O.
// Research only: a state describes recent flow and is never a trade signal.
// Doc: docs/vertex-rebuild/flow-pipeline.md.
import {
  FLOW_CONTROL_MAX_ABSORPTIONS,
  FLOW_CONTROL_MAX_MINUTES,
  FLOW_CONTROL_MAX_TRADES,
  FLOW_CONTROL_VERSION,
  FLOW_FILTER_PROFILE,
  FLOW_STORAGE_FAILURE_PREFIX,
  type FlowControl,
  type FlowControlFreshness,
  type FlowControlFuturesSide,
  type FlowControlOptionsSide,
  type FlowControlState,
  type FlowCrossCheck,
  type FlowDeepTrades,
  type FlowGroupId,
  type FlowNetDriftSeries,
  type FlowNetDriftTotals,
  type FlowIndexOptionTicker,
  type FlowNoDataReason,
  type FlowStudyStatus,
  type FlowSymbol,
} from "../contracts/flow.ts";
import {
  agreementOf,
  crossCheckResult,
  describeAgreement,
  describeCrossCheck,
  describeFuturesSide,
  describeParts,
  describeSide,
  describeStudy,
  FLOW_CONTROL_RULES,
  FLOW_CONTROL_STUDY_ID,
  FLOW_FUTURES_RULES,
  FLOW_NET_DRIFT_SLOPE_MINUTES,
  FLOW_STUDY_AGREEMENT_DETAIL,
  type FlowAgreementResult,
  type FlowControlStep,
  type FlowDriftMinute,
  type FlowFuturesReason,
  type FlowFuturesStep,
  type FlowTapeMinute,
  foldControlState,
  foldFuturesState,
  futuresWindowTotals,
  groupOptionsState,
  windowTotals,
} from "../flow-control-rules.ts";
import {
  type FlowDeepMinute,
  type FlowDeepTradeRow,
  sumDeepTradesByMinute,
} from "../flow-deep-trades.ts";
import {
  FLOW_GROUPS,
  FLOW_INSTRUMENTS,
  type FlowEventRow,
  type FlowGroup,
  type FlowMinuteRow,
  flowSymbolForTicker,
} from "../flow-features.ts";
import type { FlowNetDriftRow } from "../flow-net-drift.ts";
import { type FlowOptionPrintRow, OPTION_SIDE_SIGN } from "../flow-options.ts";
import { newYorkClock } from "../signal-alerts.ts";
import {
  FLOW_STALE_SECONDS,
  type FlowSampleRow,
  flowClockText,
  flowSessionOpen,
  flowStaleSeconds,
} from "./flow-snapshot.ts";
import { newYorkTime } from "./merged-bars.ts";

const MINUTE_MS = 60_000;
/** A zero_dte part whose newest bucket is this far behind the newest total bucket is partial. */
const PARTS_LAG_MS = 5 * MINUTE_MS;

export type FlowStudyRead = Readonly<{
  status: FlowStudyStatus;
  testedOn: string | null;
  rulesVersion: string | null;
}>;

export type FlowControlRows = Readonly<{
  group: FlowGroupId;
  now: Date;
  sessionDate: string;
  netDrift: readonly FlowNetDriftRow[];
  /** Keyed by flow symbol; the samples of a ticker are those of flowSymbolForTicker(ticker). */
  samples: Readonly<
    Partial<
      Record<
        FlowSymbol,
        Readonly<{
          latest: readonly FlowSampleRow[];
          latestOk: readonly FlowSampleRow[];
        }>
      >
    >
  >;
  /** Stored option prints of the cross-check and the range they were read for (from and to inclusive). */
  crossPrints: Readonly<{
    prints: readonly FlowOptionPrintRow[];
    from: Date;
    to: Date;
  }> | null;
  crossGaps: readonly Readonly<{ startTime: Date; endTime: Date }>[] | null;
  study: FlowStudyRead;
  /** Deep trades of the group's future (any time; filtered to the futures session here). */
  largeTrades: readonly FlowDeepTradeRow[];
  /** Minute rows of the group's future over the options session. */
  tape: readonly FlowMinuteRow[];
  /** Events of the group's future over the options session. */
  tapeEvents: readonly FlowEventRow[];
  /** Last one-minute close of the primary ticker before the session, or null. */
  previousClose: number | null;
  sessionEvent: FlowSessionEventRead;
  /**
   * Checks of the future's streamed tape against IBKR history over the futures session
   * (flow_tape_audits), or null when they could not be read.
   */
  tapeAudits: readonly FlowTapeAuditRow[] | null;
}>;

/** The counts of one check of the streamed tape against IBKR history. */
export type FlowTapeAuditRow = Readonly<{
  comparedSeconds: number;
  matchedSeconds: number;
}>;

/** The FOMC mark of the session date and whether the event calendar was read. */
export type FlowSessionEventRead = Readonly<{
  event: "fomc" | null;
  calendar: "read" | "not_read";
}>;

/** The futures deep-trade session of a New York date: 09:30 to 16:00, end-exclusive. */
export const futuresSessionRange = (
  date: string
): Readonly<{ from: Date; to: Date }> => ({
  from: newYorkTime(date, 570),
  to: newYorkTime(date, 960),
});

/** The options session of a New York date: 09:30 to 16:15. */
export const optionsSessionRange = (
  date: string
): Readonly<{ from: Date; to: Date }> => ({
  from: newYorkTime(date, 570),
  to: newYorkTime(date, 975),
});

/** New York wall time as "HH:MM ET". */
export const etClock = (date: Date): string => `${flowClockText(date)} ET`;

type TickerFold = Readonly<{
  ticker: FlowIndexOptionTicker;
  symbol: FlowSymbol;
  state: FlowControlState;
  reason: FlowNoDataReason | null;
  last: FlowControlStep | null;
  input: readonly FlowDriftMinute[];
  settled: readonly FlowNetDriftRow[];
  zero: readonly FlowNetDriftRow[];
  newestTotal: Date | null;
  cause: string | null;
  closeState: FlowControlState | null;
}>;

const atMinute = (from: Date, minute: number): Date =>
  new Date(from.getTime() + minute * MINUTE_MS);

const samplesOf = (
  rows: FlowControlRows,
  symbol: FlowSymbol,
  source: "net_drift" | "ticks"
) => {
  const entry = rows.samples[symbol];
  return {
    latest: entry?.latest.find((sample) => sample.source === source),
    latestOk: entry?.latestOk.find((sample) => sample.source === source),
  };
};

const tickerReason = (
  rows: FlowControlRows,
  symbol: FlowSymbol,
  from: Date,
  newestTotal: Date | null,
  last: FlowControlStep | null
): FlowNoDataReason | null => {
  const { now } = rows;
  if (!flowSessionOpen("options", symbol, now)) return "market_closed";
  const { latest, latestOk } = samplesOf(rows, symbol, "net_drift");
  const okRecently =
    latestOk !== undefined &&
    now.getTime() - latestOk.at.getTime() <=
      FLOW_STALE_SECONDS.net_drift * 1000;
  if (latest?.status === "unavailable" && !okRecently)
    return latest.message?.startsWith(FLOW_STORAGE_FAILURE_PREFIX)
      ? "storage_failed"
      : "source_unavailable";
  const newest = Math.max(newestTotal?.getTime() ?? 0, from.getTime());
  if (now.getTime() - newest > FLOW_STALE_SECONDS.net_drift * 1000)
    return "stale";
  if (last === null) return "session_start";
  return last.noDataReason;
};

const foldTicker = (
  rows: FlowControlRows,
  ticker: FlowIndexOptionTicker,
  from: Date,
  to: Date
): TickerFold => {
  const symbol = flowSymbolForTicker(ticker);
  const own = rows.netDrift.filter(
    (row) =>
      row.ticker === ticker &&
      row.filterProfile === FLOW_FILTER_PROFILE &&
      row.minute >= from &&
      row.minute < to
  );
  const byMinute = (a: FlowNetDriftRow, b: FlowNetDriftRow) =>
    a.minute.getTime() - b.minute.getTime();
  const totals = own.filter((row) => row.part === "total").sort(byMinute);
  const zero = own.filter((row) => row.part === "zero_dte").sort(byMinute);
  const settled = flowSessionOpen("net_drift", symbol, rows.now)
    ? totals.slice(0, -1)
    : totals;
  const input = settled.map((row) => ({
    minute: Math.round((row.minute.getTime() - from.getTime()) / MINUTE_MS),
    netCallPremium: row.netCallPremium,
    netPutPremium: row.netPutPremium,
  }));
  const last = foldControlState(input, FLOW_CONTROL_RULES).at(-1) ?? null;
  const newestTotal = totals.at(-1)?.minute ?? null;
  const reason = tickerReason(rows, symbol, from, newestTotal, last);
  return {
    cause: samplesOf(rows, symbol, "net_drift").latest?.message ?? null,
    closeState: last?.state ?? null,
    input,
    last,
    newestTotal,
    reason,
    settled,
    state: reason === null && last !== null ? last.state : "no_data",
    symbol,
    ticker,
    zero,
  };
};

const directionOf = (state: FlowControlState) => {
  if (state === "buyers") return "bullish" as const;
  if (state === "sellers") return "bearish" as const;
  return "neutral" as const;
};

const buildOptionsSide = (
  rows: FlowControlRows,
  primary: TickerFold,
  check: TickerFold,
  from: Date
): FlowControlOptionsSide => {
  const group = FLOW_GROUPS[rows.group];
  const state = groupOptionsState(primary.state, check.state);
  const reason = state === "no_data" ? primary.reason : null;
  const { last } = primary;
  const inputs =
    last === null
      ? { denominator: null, numerator: null, rows: 0 }
      : windowTotals(primary.input, last.minute, FLOW_CONTROL_RULES);
  const windowEnd = last === null ? null : atMinute(from, last.minute + 1);
  const text = describeSide(
    {
      buckets: inputs.rows,
      cause: primary.cause,
      checkInstrument: group.checkTicker,
      closeState: primary.closeState,
      instrument: group.primaryTicker,
      // Clock minutes since 09:30, capped below minBuckets: buckets settle late, so the
      // session_start text must never read "10 of 10" while the reason still applies.
      minutesSinceOpen: Math.min(
        FLOW_CONTROL_RULES.minBuckets - 1,
        Math.max(
          0,
          Math.floor((rows.now.getTime() - from.getTime()) / MINUTE_MS)
        )
      ),
      newestBucketEt:
        primary.newestTotal === null ? null : etClock(primary.newestTotal),
      primaryState: primary.state,
      ratio: last?.ratio ?? null,
      reason,
      sessionDate: rows.sessionDate,
      staleMinutes: FLOW_STALE_SECONDS.net_drift / 60,
      state,
    },
    FLOW_CONTROL_RULES
  );
  const controlled = state === "buyers" || state === "sellers";
  return {
    asOf: windowEnd?.toISOString() ?? null,
    checkState: check.state,
    checkTicker: group.checkTicker,
    detail: text.detail,
    direction: directionOf(state),
    enterRatio: FLOW_CONTROL_RULES.enterRatio,
    inputs,
    instrument: group.primaryTicker,
    label: text.label,
    noDataReason: reason,
    primaryTicker: group.primaryTicker,
    ratio: last === null || state === "no_data" ? null : last.ratio,
    since:
      controlled && last !== null && last.sinceMinute !== null
        ? atMinute(from, last.sinceMinute).toISOString()
        : null,
    state,
    windowEnd: windowEnd?.toISOString() ?? null,
    windowStart:
      windowEnd === null
        ? null
        : new Date(
            windowEnd.getTime() - FLOW_CONTROL_RULES.windowMinutes * MINUTE_MS
          ).toISOString(),
  };
};

interface Sums {
  call: number;
  callVolume: number;
  put: number;
  putVolume: number;
}

const add = (sums: Sums, row: FlowNetDriftRow): Sums => ({
  call: sums.call + row.netCallPremium,
  callVolume: sums.callVolume + row.netCallVolume,
  put: sums.put + row.netPutPremium,
  putVolume: sums.putVolume + row.netPutVolume,
});

const ZERO: Sums = { call: 0, callVolume: 0, put: 0, putVolume: 0 };

const totalsOf = (sums: Sums): FlowNetDriftTotals => ({
  callMinusPutUsd: sums.call - sums.put,
  netCallPremiumUsd: sums.call,
  netCallVolume: sums.callVolume,
  netPutPremiumUsd: sums.put,
  netPutVolume: sums.putVolume,
});

const minus = (left: Sums, right: Sums): Sums => ({
  call: left.call - right.call,
  callVolume: left.callVolume - right.callVolume,
  put: left.put - right.put,
  putVolume: left.putVolume - right.putVolume,
});

const buildSeries = (
  fold: TickerFold,
  role: "primary" | "check",
  from: Date
): FlowNetDriftSeries => {
  const newestSettled = fold.settled.at(-1)?.minute ?? null;
  const newestZero = fold.zero.at(-1)?.minute ?? null;
  const partsStatus =
    newestSettled === null
      ? "no_data"
      : newestZero === null ||
          newestZero.getTime() < newestSettled.getTime() - PARTS_LAG_MS
        ? "partial"
        : "complete";
  // Both parts exist up to the newest zero_dte bucket; later points and a partial series have
  // no expiry split (longer needs both parts).
  const zeroEnd = partsStatus === "complete" ? newestZero : null;
  let total = ZERO;
  const points = fold.settled.map((row) => {
    total = add(total, row);
    const zero = fold.zero
      .filter((entry) => entry.minute <= row.minute)
      .reduce(add, ZERO);
    const longer = minus(total, zero);
    const both = zeroEnd !== null && row.minute <= zeroEnd;
    return {
      both,
      sums: { longer, total, zero },
      view: {
        longer: both
          ? { netCallPremiumUsd: longer.call, netPutPremiumUsd: longer.put }
          : null,
        minute: row.minute.toISOString(),
        total: { netCallPremiumUsd: total.call, netPutPremiumUsd: total.put },
        underlyingPrice: row.underlyingPrice,
        zeroDte: both
          ? { netCallPremiumUsd: zero.call, netPutPremiumUsd: zero.put }
          : null,
      },
    };
  });
  const lastBoth = points.findLast((point) => point.both);
  const lastPoint = points.at(-1);
  const lastRow = fold.settled.at(-1);
  const earlier =
    lastRow === undefined
      ? undefined
      : points[
          fold.settled.findLastIndex(
            (row) =>
              row.minute.getTime() <=
              lastRow.minute.getTime() -
                FLOW_NET_DRIFT_SLOPE_MINUTES * MINUTE_MS
          )
        ];
  const slope =
    lastPoint === undefined || earlier === undefined
      ? null
      : (lastPoint.sums.total.call -
          lastPoint.sums.total.put -
          (earlier.sums.total.call - earlier.sums.total.put)) /
        FLOW_NET_DRIFT_SLOPE_MINUTES;
  const { last } = fold;
  return {
    asOf: last === null ? null : atMinute(from, last.minute + 1).toISOString(),
    filterProfile: FLOW_FILTER_PROFILE,
    partsDetail: partsStatus === "partial" ? describeParts(fold.ticker) : null,
    partsStatus,
    points: points.map((point) => point.view),
    role,
    slopeUsdPerMinute: slope,
    slopeWindowMinutes: FLOW_NET_DRIFT_SLOPE_MINUTES,
    ticker: fold.ticker,
    totals: {
      cumulativeFrom: from.toISOString(),
      longer: lastBoth === undefined ? null : totalsOf(lastBoth.sums.longer),
      total: lastPoint === undefined ? null : totalsOf(lastPoint.sums.total),
      zeroDte: lastBoth === undefined ? null : totalsOf(lastBoth.sums.zero),
    },
  };
};

const buildCrossCheck = (
  rows: FlowControlRows,
  options: FlowControlOptionsSide
): Omit<FlowCrossCheck, "detail"> => {
  const ticker = FLOW_GROUPS[rows.group].primaryTicker;
  if (rows.crossPrints === null)
    return {
      oldestUnreadAt: null,
      result: "not_collected",
      storedPrints: 0,
      ticker,
      unreadRanges: 0,
    };
  if (options.windowStart === null || options.windowEnd === null)
    return {
      oldestUnreadAt: null,
      result: "not_comparable",
      storedPrints: 0,
      ticker,
      unreadRanges: 0,
    };
  const start = new Date(options.windowStart);
  const end = new Date(options.windowEnd);
  const read = rows.crossPrints;
  // Prints read for another range cannot be compared with this window.
  if (read.from > start || read.to < end)
    return {
      oldestUnreadAt: null,
      result: "not_comparable",
      storedPrints: 0,
      ticker,
      unreadRanges: 0,
    };
  const prints = read.prints.filter(
    (print) =>
      print.ticker === ticker && print.tradedAt >= start && print.tradedAt < end
  );
  const figure = prints.reduce(
    (sum, print) =>
      sum +
      print.premium *
        OPTION_SIDE_SIGN[print.side] *
        (print.right === "call" ? 1 : -1),
    0
  );
  const gaps = (rows.crossGaps ?? []).filter(
    (gap) => gap.startTime < end && gap.endTime > start
  );
  const oldest = gaps.reduce<Date | null>(
    (min, gap) => (min === null || gap.startTime < min ? gap.startTime : min),
    null
  );
  return {
    oldestUnreadAt: oldest?.toISOString() ?? null,
    result: crossCheckResult(options.inputs.numerator, figure, prints.length),
    storedPrints: prints.length,
    ticker,
    unreadRanges: gaps.length,
  };
};

/** One freshness row: the net drift of a ticker, or the tape of the group's future. */
const buildFreshnessRow = (
  rows: FlowControlRows,
  source: "net_drift" | "ticks",
  symbol: FlowSymbol,
  instrument: string
): FlowControlFreshness => {
  const { latest, latestOk } = samplesOf(rows, symbol, source);
  const age =
    latestOk === undefined
      ? null
      : Math.max(
          0,
          Math.round((rows.now.getTime() - latestOk.at.getTime()) / 1000)
        );
  const state = (() => {
    if (age === null) return "never" as const;
    if (!flowSessionOpen(source, symbol, rows.now)) return "closed" as const;
    return age > flowStaleSeconds(source, symbol)
      ? ("stale" as const)
      : ("fresh" as const);
  })();
  return {
    ageSeconds: age,
    instrument,
    lastOkAt: latestOk?.at.toISOString() ?? null,
    message: latest?.message ?? null,
    source,
    state,
  };
};

const isWeekday = (day: string): boolean => {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
};

/** The stored rows of the group's future inside the futures session of the session date. */
type FuturesSession = Readonly<{
  range: Readonly<{ from: Date; to: Date }>;
  inRange: (at: Date) => boolean;
  /** Whole minutes after 09:30 New York. */
  minuteOf: (at: Date) => number;
  trades: readonly FlowDeepTradeRow[];
  /** Minute rows, ascending. */
  tape: readonly FlowMinuteRow[];
  /** Deep-trade sums per session minute; a minute without a deep trade has no entry. */
  byMinute: ReadonlyMap<number, FlowDeepMinute>;
}>;

const futuresSessionOf = (
  rows: FlowControlRows,
  group: FlowGroup
): FuturesSession => {
  const range = futuresSessionRange(rows.sessionDate);
  const inRange = (at: Date) => at >= range.from && at < range.to;
  const trades = rows.largeTrades.filter((row) => inRange(row.second));
  return {
    byMinute: new Map(
      sumDeepTradesByMinute(trades, range.from).map((entry) => [
        entry.minute,
        entry,
      ])
    ),
    inRange,
    minuteOf: (at: Date) =>
      Math.floor((at.getTime() - range.from.getTime()) / MINUTE_MS),
    range,
    tape: rows.tape
      .filter((row) => row.symbol === group.future && inRange(row.minute))
      .sort((a, b) => a.minute.getTime() - b.minute.getTime()),
    trades,
  };
};

const NO_DEEP_TRADE = { buyVolume: 0, sellVolume: 0, trades: 0 };

/** The fold input: the covered minutes of the ended rows, each with the deep trades of its minute. */
const tapeMinutesOf = (
  session: FuturesSession,
  ended: readonly FlowMinuteRow[]
): readonly FlowTapeMinute[] =>
  ended
    .filter((row) => row.coveredSeconds >= FLOW_FUTURES_RULES.minCoveredSeconds)
    .map((row) => {
      const minute = session.minuteOf(row.minute);
      const deep = session.byMinute.get(minute) ?? NO_DEEP_TRADE;
      return {
        close: row.close,
        deepBuy: deep.buyVolume,
        deepSell: deep.sellVolume,
        deepTrades: deep.trades,
        delta: row.delta,
        minute,
        volume: row.volume,
        vwap: row.vwap,
      };
    });

/** The reason chain of the futures side: closed, failed read, stale read, then the fold. */
const futuresReason = (
  rows: FlowControlRows,
  group: FlowGroup,
  last: FlowFuturesStep | null
): FlowFuturesReason | null => {
  const { now } = rows;
  const staleMs = flowStaleSeconds("ticks", group.future) * 1000;
  const { latest, latestOk } = samplesOf(rows, group.future, "ticks");
  const today = newYorkClock(now).day;
  const open = futuresSessionRange(today);
  if (!isWeekday(today) || now < open.from || now >= open.to)
    return "market_closed";
  const okRecently =
    latestOk !== undefined && now.getTime() - latestOk.at.getTime() <= staleMs;
  if (latest?.status === "unavailable" && !okRecently)
    return latest.message?.startsWith(FLOW_STORAGE_FAILURE_PREFIX)
      ? "storage_failed"
      : "source_unavailable";
  const newest = Math.max(latestOk?.at.getTime() ?? 0, open.from.getTime());
  if (now.getTime() - newest > staleMs) return "stale";
  if (last !== null) return last.noDataReason;
  // No stored minute has ended yet: the rule of the fold, with the minutes that have ended since 09:30.
  const ended = Math.floor((now.getTime() - open.from.getTime()) / MINUTE_MS);
  return ended < FLOW_FUTURES_RULES.minBuckets ? "session_start" : "gap";
};

const buildFuturesSide = (
  rows: FlowControlRows,
  group: FlowGroup,
  session: FuturesSession
): FlowControlFuturesSide => {
  const rules = FLOW_FUTURES_RULES;
  // The stored minutes that have ended, covered or not; the minute in progress is left out.
  const ended = session.tape.filter(
    (row) => row.minute.getTime() + MINUTE_MS <= rows.now.getTime()
  );
  const newestStored = ended.at(-1);
  const input = tapeMinutesOf(session, ended);
  // The fold runs through the newest stored minute: a state must not outlive its tape.
  const last =
    foldFuturesState(
      input,
      rules,
      newestStored === undefined ? -1 : session.minuteOf(newestStored.minute)
    ).at(-1) ?? null;
  const reason = futuresReason(rows, group, last);
  // Without a reason the last step exists and holds a state.
  const step = reason === null ? last : null;
  const state = step?.state ?? "no_data";
  const inputs =
    last === null
      ? { denominator: null, numerator: null, rows: 0 }
      : futuresWindowTotals(input, last.minute, rules);
  // The end of the newest stored minute.
  const windowEnd =
    last === null ? null : atMinute(session.range.from, last.minute + 1);
  const newestCovered = input.at(-1);
  const { latest, latestOk } = samplesOf(rows, group.future, "ticks");
  const hold = step?.hold ?? null;
  const trades = last?.trades ?? 0;
  const text = describeFuturesSide(
    {
      cause: latest?.message ?? null,
      coveredMinutes: inputs.rows,
      hold,
      instrument: group.future,
      newestReadEt: latestOk === undefined ? null : etClock(latestOk.at),
      ratio: step?.ratio ?? null,
      reason,
      sessionDate: rows.sessionDate,
      staleMinutes: flowStaleSeconds("ticks", group.future) / 60,
      state,
      trades,
    },
    rules
  );
  return {
    // The end of the newest covered minute: it shows how old the tape is.
    asOf:
      newestCovered === undefined
        ? null
        : atMinute(session.range.from, newestCovered.minute + 1).toISOString(),
    detail: text.detail,
    direction: directionOf(state),
    enterRatio: rules.enterRatio,
    hold,
    inputs,
    instrument: group.future,
    label: text.label,
    noDataReason: reason,
    ratio: step?.ratio ?? null,
    since:
      step === null || step.sinceMinute === null
        ? null
        : atMinute(session.range.from, step.sinceMinute).toISOString(),
    state,
    trades,
    windowEnd: windowEnd?.toISOString() ?? null,
    windowStart:
      windowEnd === null
        ? null
        : new Date(
            windowEnd.getTime() - rules.windowMinutes * MINUTE_MS
          ).toISOString(),
  };
};

/** The later start of the two sides for agree and diverge; null for every other agreement. */
const agreementSince = (
  agreement: FlowAgreementResult,
  futures: FlowControlFuturesSide,
  options: FlowControlOptionsSide
): string | null => {
  if (
    (agreement.state !== "agree" && agreement.state !== "diverge") ||
    futures.since === null ||
    options.since === null
  )
    return null;
  return futures.since > options.since ? futures.since : options.since;
};

/**
 * The capture mode of the deep trades of one session of a symbol: streamed when the collector
 * reads the tape of the symbol and no row of the session came from the sampled collector. One
 * sampled row makes the session sampled, because its sums are then lower bounds. Without a row
 * the tick mode of the symbol decides.
 */
export const flowCaptureOf = (
  symbol: FlowSymbol,
  trades: readonly FlowDeepTradeRow[]
): "sampled" | "streamed" =>
  FLOW_INSTRUMENTS[symbol].ticks === "stream" &&
  trades.every((row) => row.capture !== "sampled")
    ? "streamed"
    : "sampled";

/**
 * The newest stored minute may be this many minutes behind the last ended minute of the clock (not
 * clamped to the session end) without a gap.
 */
const COVERAGE_STORE_LAG_MINUTES = 2;

const buildDeepTrades = (
  rows: FlowControlRows,
  group: FlowGroup,
  session: FuturesSession
): FlowDeepTrades => {
  const { byMinute, inRange, minuteOf, range, tape, trades } = session;
  const methods = new Set(trades.map((row) => row.signing));
  const signing =
    methods.size === 1 ? (trades[0] as FlowDeepTradeRow).signing : null;
  const windowMinutes = FLOW_FUTURES_RULES.windowMinutes;
  // The minutes of the session that have ended; the minute in progress has no complete row.
  const ended = Math.floor(
    (Math.min(rows.now.getTime(), range.to.getTime()) - range.from.getTime()) /
      MINUTE_MS
  );
  // The newest stored minute that has ended (the tape is in ascending order).
  const newestStored = tape
    .map((row) => minuteOf(row.minute))
    .filter((minute) => minute < ended)
    .at(-1);
  // The collector stores a minute some seconds after it ends. The window ends after the newest
  // stored minute when that minute is at most COVERAGE_STORE_LAG_MINUTES behind the last ended
  // minute of the clock, so a stream without a gap gives the share 1. The clock minute is not
  // clamped to the session end, so the same rule covers the 15:59 row, which the collector stores
  // some seconds after 16:00; the allowance for it ends at 16:02. A larger delay is a gap: the
  // window ends after the last ended minute of the session.
  const clockEnded = Math.floor(
    (rows.now.getTime() - range.from.getTime()) / MINUTE_MS
  );
  const windowEnd =
    newestStored !== undefined &&
    clockEnded - 1 - newestStored <= COVERAGE_STORE_LAG_MINUTES
      ? newestStored + 1
      : ended;
  let coverage: FlowDeepTrades["coverage"];
  if (ended <= 0)
    coverage = {
      seenSeconds: 0,
      share: null,
      windowSeconds: windowMinutes * 60,
    };
  else {
    const windowSeconds = Math.min(windowMinutes, windowEnd) * 60;
    const seenSeconds = tape
      .filter((row) => {
        const n = minuteOf(row.minute);
        return n >= windowEnd - windowMinutes && n < windowEnd;
      })
      .reduce((sum, row) => sum + row.coveredSeconds, 0);
    coverage = {
      seenSeconds,
      share: tape.length === 0 ? null : seenSeconds / windowSeconds,
      windowSeconds,
    };
  }
  let buyVolume = 0;
  let sellVolume = 0;
  for (const row of trades)
    if (row.side === "buy") buyVolume += row.size;
    else sellVolume += row.size;
  const capture = flowCaptureOf(group.future, trades);
  const audits = capture === "streamed" ? (rows.tapeAudits ?? []) : [];
  return {
    absorptions: rows.tapeEvents
      .filter(
        (event) =>
          event.kind === "absorption" &&
          event.symbol === group.future &&
          inRange(event.at)
      )
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, FLOW_CONTROL_MAX_ABSORPTIONS)
      .map((event) => ({
        at: event.at.toISOString(),
        detail: event.detail.slice(0, 200),
        direction: event.direction,
        price: event.price,
      })),
    audit:
      audits.length === 0
        ? null
        : {
            checks: audits.length,
            comparedSeconds: audits.reduce(
              (sum, row) => sum + row.comparedSeconds,
              0
            ),
            matchedSeconds: audits.reduce(
              (sum, row) => sum + row.matchedSeconds,
              0
            ),
          },
    capture,
    coverage,
    limitSize: FLOW_INSTRUMENTS[group.future].deepTradeLimit,
    minutes: tape.slice(0, FLOW_CONTROL_MAX_MINUTES).map((row) => {
      const entry = byMinute.get(minuteOf(row.minute));
      return {
        buyVolume: entry?.buyVolume ?? 0,
        coveredSeconds: row.coveredSeconds,
        minute: row.minute.toISOString(),
        sellVolume: entry?.sellVolume ?? 0,
      };
    }),
    signing,
    sums: {
      buyVolume,
      cumulativeFrom: trades.length === 0 ? null : range.from.toISOString(),
      netVolume: buyVolume - sellVolume,
      sellVolume,
    },
    symbol: group.future,
    totalTrades: trades.length,
    trades: [...trades]
      .reverse()
      .slice(0, FLOW_CONTROL_MAX_TRADES)
      .map((row) => ({
        at: row.second.toISOString(),
        price: row.price,
        side: row.side,
        signing: row.signing,
        size: row.size,
      })),
  };
};

const buildLevels = (
  rows: FlowControlRows,
  group: FlowGroup
): FlowControl["levels"] => {
  const ticker = group.primaryTicker;
  const range = futuresSessionRange(rows.sessionDate);
  const byMinute = new Map<number, FlowNetDriftRow>();
  for (const row of rows.netDrift) {
    if (
      row.ticker !== ticker ||
      row.underlyingPrice === null ||
      row.minute < range.from ||
      row.minute >= range.to
    )
      continue;
    const key = row.minute.getTime();
    if (row.part === "total" || !byMinute.has(key)) byMinute.set(key, row);
  }
  const prices = [...byMinute.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row.underlyingPrice as number);
  if (prices.length === 0 && rows.previousClose === null) return null;
  return {
    previousClose: rows.previousClose,
    sessionHigh: prices.length === 0 ? null : Math.max(...prices),
    sessionLow: prices.length === 0 ? null : Math.min(...prices),
    sessionOpen: prices[0] ?? null,
    source: "one_minute_closes",
    ticker,
  };
};

/**
 * The notes of the deep trades block and of the session event. `tickSigned` counts the deep trades
 * of the session that the tick rule signed.
 */
const deepTradeNotes = (
  rows: FlowControlRows,
  group: FlowGroup,
  deep: FlowDeepTrades,
  tickSigned: number
): string[] => {
  const limit = String(deep.limitSize);
  const levels = `Session levels are from one-minute closes of ${group.primaryTicker}; on a half day the previous close is not the official close.`;
  return [
    ...(deep.capture === "streamed"
      ? [
          `Deep trades are single prints of at least ${limit} contracts on ${group.future}, from the streamed tape.`,
          `Each side comes from the quote rule against the quotes of the same contract; the tick rule signed ${tickSigned} of ${deep.totalTrades} deep trades of this session.`,
          levels,
          "Tape coverage counts the seconds between received trades of a live stream; it is not checked against a second source.",
          rows.tapeAudits === null
            ? "The checks of the tape against IBKR history were not read."
            : "Every 5 minutes the collector compares the newest IBKR history prints with the tape, second by second (print count and contracts); a check samples the tape, so it does not prove that the whole session is complete.",
        ]
      : [
          `Deep trades are single prints of at least ${limit} contracts on ${group.future}, from a sampled tape; sums are lower bounds.`,
          "Futures sides come from the quote rule where the sampled quotes cover a print, else from the tick rule; a part of this session was sampled, so the sums of this session are lower bounds.",
          levels,
          "Coverage is approximate: it comes from flow_minutes.covered_seconds, which counts the edge seconds that deep-trade detection leaves out.",
        ]),
    ...(rows.sessionEvent.event === "fomc"
      ? ["FOMC meeting day (Federal Reserve calendar)."]
      : []),
    ...(rows.sessionEvent.calendar === "not_read"
      ? ["The event calendar was not read; no FOMC mark for this session."]
      : []),
  ];
};

export const buildFlowControl = (rows: FlowControlRows): FlowControl => {
  const group = FLOW_GROUPS[rows.group];
  const { from, to } = optionsSessionRange(rows.sessionDate);
  const primary = foldTicker(rows, group.primaryTicker, from, to);
  const check = foldTicker(rows, group.checkTicker, from, to);
  const options = buildOptionsSide(rows, primary, check, from);
  const session = futuresSessionOf(rows, group);
  const deepTrades = buildDeepTrades(rows, group, session);
  const futures = buildFuturesSide(rows, group, session);
  const agreement = agreementOf(futures.state, options.state);
  const agreementText = describeAgreement(agreement, futures, options);
  const cross = buildCrossCheck(rows, options);
  const optionsOpen = flowSessionOpen("options", group.future, rows.now);
  const futuresOpen = flowSessionOpen("ticks", group.future, rows.now);
  return {
    agreement: {
      detail: agreementText.detail,
      direction: agreement.direction,
      label: agreementText.label,
      since: agreementSince(agreement, futures, options),
      state: agreement.state,
    },
    crossCheck: { ...cross, detail: describeCrossCheck(cross) },
    deepTrades,
    freshness: [
      buildFreshnessRow(rows, "net_drift", primary.symbol, primary.ticker),
      buildFreshnessRow(rows, "net_drift", check.symbol, check.ticker),
      buildFreshnessRow(rows, "ticks", group.future, group.future),
    ],
    futures,
    futuresRules: FLOW_FUTURES_RULES,
    generatedAt: rows.now.toISOString(),
    group: rows.group,
    levels: buildLevels(rows, group),
    netDrift: [
      buildSeries(primary, "primary", from),
      buildSeries(check, "check", from),
    ],
    notes: [
      `Net drift filter ${FLOW_FILTER_PROFILE}: out-of-the-money options only, without complex, tied, floor and cancelled trades.`,
      "Net drift values are the vendor's signed per-minute values; sums start at 09:30 New York.",
      "The newest net drift minute is left out until it has closed.",
      ...deepTradeNotes(
        rows,
        group,
        deepTrades,
        session.trades.filter((row) => row.signing === "tick").length
      ),
      "Research only; a state describes recent flow and is not a trade signal.",
    ],
    options,
    rules: FLOW_CONTROL_RULES,
    schemaVersion: FLOW_CONTROL_VERSION,
    session: {
      date: rows.sessionDate,
      event: rows.sessionEvent.event,
      futuresOpen,
      open: optionsOpen || futuresOpen,
      optionsOpen,
    },
    study: {
      agreementDetail: FLOW_STUDY_AGREEMENT_DETAIL,
      detail: describeStudy(rows.study),
      rulesVersion: rows.study.rulesVersion,
      status: rows.study.status,
      strategyId: FLOW_CONTROL_STUDY_ID,
      testedOn: rows.study.testedOn,
    },
  };
};
