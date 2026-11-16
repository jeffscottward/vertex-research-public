// What: the pure assembly of flow-control.v1 (flow.control) from stored rows: the options side of one
// index group from the settled net drift buckets of its primary and check tickers, the net drift
// series, the cross-check against stored option prints, the study status and freshness. The futures
// side is "not collected" until pull request 2. No I/O.
// Research only: a state describes recent flow and is never a trade signal.
// Doc: docs/vertex-rebuild/flow-pipeline.md.
import {
  FLOW_CONTROL_VERSION,
  FLOW_FILTER_PROFILE,
  type FlowControl,
  type FlowControlFreshness,
  type FlowControlOptionsSide,
  type FlowControlSide,
  type FlowControlState,
  type FlowCrossCheck,
  type FlowGroupId,
  type FlowNetDriftSeries,
  type FlowNetDriftTotals,
  type FlowNoDataReason,
  type FlowOptionTicker,
  type FlowStudyStatus,
  type FlowSymbol,
} from "../contracts/flow.ts";
import {
  crossCheckResult,
  describeAgreement,
  describeCrossCheck,
  describeParts,
  describeSide,
  describeStudy,
  FLOW_CONTROL_RULES,
  FLOW_CONTROL_STUDY_ID,
  FLOW_NET_DRIFT_SLOPE_MINUTES,
  FLOW_STUDY_AGREEMENT_DETAIL,
  type FlowControlStep,
  type FlowDriftMinute,
  foldControlState,
  groupOptionsState,
  windowTotals,
} from "../flow-control-rules.ts";
import { FLOW_GROUPS, flowSymbolForTicker } from "../flow-features.ts";
import type { FlowNetDriftRow } from "../flow-net-drift.ts";
import type { FlowOptionPrintRow } from "../flow-options.ts";
import { newYorkTime } from "./merged-bars.ts";
import {
  FLOW_STALE_SECONDS,
  type FlowSampleRow,
  flowClockText,
  flowSessionOpen,
} from "./flow-snapshot.ts";

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
  crossPrints: readonly FlowOptionPrintRow[] | null;
  crossGaps: readonly Readonly<{ startTime: Date; endTime: Date }>[] | null;
  study: FlowStudyRead;
}>;

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
  ticker: FlowOptionTicker;
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

const samplesOf = (rows: FlowControlRows, symbol: FlowSymbol) => {
  const entry = rows.samples[symbol];
  return {
    latest: entry?.latest.find((sample) => sample.source === "net_drift"),
    latestOk: entry?.latestOk.find((sample) => sample.source === "net_drift"),
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
  const { latest, latestOk } = samplesOf(rows, symbol);
  const okRecently =
    latestOk !== undefined &&
    now.getTime() - latestOk.at.getTime() <=
      FLOW_STALE_SECONDS.net_drift * 1000;
  if (latest?.status === "unavailable" && !okRecently)
    return "source_unavailable";
  const newest = Math.max(newestTotal?.getTime() ?? 0, from.getTime());
  if (now.getTime() - newest > FLOW_STALE_SECONDS.net_drift * 1000)
    return "stale";
  if (last === null) return "session_start";
  return last.noDataReason;
};

const foldTicker = (
  rows: FlowControlRows,
  ticker: FlowOptionTicker,
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
    cause: samplesOf(rows, symbol).latest?.message ?? null,
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
      minutesSinceOpen: last === null ? 0 : last.minute + 1,
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
  put: number;
  callVolume: number;
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
  const split = partsStatus === "complete";
  let total = ZERO;
  const points = fold.settled.map((row) => {
    total = add(total, row);
    const zero = fold.zero
      .filter((entry) => entry.minute <= row.minute)
      .reduce(add, ZERO);
    const longer = minus(total, zero);
    return {
      minute: row.minute.toISOString(),
      sums: { longer, total, zero },
      view: {
        longer: split
          ? { netCallPremiumUsd: longer.call, netPutPremiumUsd: longer.put }
          : null,
        minute: row.minute.toISOString(),
        total: { netCallPremiumUsd: total.call, netPutPremiumUsd: total.put },
        underlyingPrice: row.underlyingPrice,
        zeroDte: split
          ? { netCallPremiumUsd: zero.call, netPutPremiumUsd: zero.put }
          : null,
      },
    };
  });
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
      longer:
        lastPoint !== undefined && split
          ? totalsOf(lastPoint.sums.longer)
          : null,
      total: lastPoint === undefined ? null : totalsOf(lastPoint.sums.total),
      zeroDte:
        lastPoint !== undefined && split ? totalsOf(lastPoint.sums.zero) : null,
    },
  };
};

const SIDE_SIGN: Readonly<Record<string, number>> = {
  above_ask: 1,
  ask: 1,
  below_bid: -1,
  bid: -1,
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
  const prints = rows.crossPrints.filter(
    (print) =>
      print.ticker === ticker && print.tradedAt >= start && print.tradedAt < end
  );
  const figure = prints.reduce(
    (sum, print) =>
      sum +
      print.premium *
        (SIDE_SIGN[print.side] ?? 0) *
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

const buildFreshnessRow = (
  rows: FlowControlRows,
  fold: TickerFold
): FlowControlFreshness => {
  const { latest, latestOk } = samplesOf(rows, fold.symbol);
  const age =
    latestOk === undefined
      ? null
      : Math.max(
          0,
          Math.round((rows.now.getTime() - latestOk.at.getTime()) / 1000)
        );
  const state = (() => {
    if (age === null) return "never" as const;
    if (!flowSessionOpen("net_drift", fold.symbol, rows.now))
      return "closed" as const;
    return age > FLOW_STALE_SECONDS.net_drift
      ? ("stale" as const)
      : ("fresh" as const);
  })();
  return {
    ageSeconds: age,
    instrument: fold.ticker,
    lastOkAt: latestOk?.at.toISOString() ?? null,
    message: latest?.message ?? null,
    source: "net_drift",
    state,
  };
};

export const buildFlowControl = (rows: FlowControlRows): FlowControl => {
  const group = FLOW_GROUPS[rows.group];
  const { from, to } = optionsSessionRange(rows.sessionDate);
  const primary = foldTicker(rows, group.primaryTicker, from, to);
  const check = foldTicker(rows, group.checkTicker, from, to);
  const options = buildOptionsSide(rows, primary, check, from);
  const futuresText = describeSide(
    {
      buckets: 0,
      cause: null,
      checkInstrument: null,
      closeState: null,
      instrument: group.future,
      minutesSinceOpen: 0,
      newestBucketEt: null,
      primaryState: "no_data",
      ratio: null,
      reason: "not_collected",
      sessionDate: rows.sessionDate,
      staleMinutes: FLOW_STALE_SECONDS.net_drift / 60,
      state: "no_data",
    },
    FLOW_CONTROL_RULES
  );
  const futures: FlowControlSide = {
    asOf: null,
    detail: futuresText.detail,
    direction: "neutral",
    enterRatio: FLOW_CONTROL_RULES.enterRatio,
    inputs: { denominator: null, numerator: null, rows: 0 },
    instrument: group.future,
    label: futuresText.label,
    noDataReason: "not_collected",
    ratio: null,
    since: null,
    state: "no_data",
    windowEnd: null,
    windowStart: null,
  };
  const agreement = describeAgreement(futures, options);
  const cross = buildCrossCheck(rows, options);
  const optionsOpen = flowSessionOpen("options", group.future, rows.now);
  const futuresOpen = flowSessionOpen("ticks", group.future, rows.now);
  return {
    agreement: {
      detail: agreement.detail,
      direction: "neutral",
      label: agreement.label,
      since: null,
      state: "not_comparable",
    },
    crossCheck: { ...cross, detail: describeCrossCheck(cross) },
    deepTrades: {
      absorptions: [],
      capture: "sampled",
      coverage: {
        seenSeconds: 0,
        share: null,
        windowSeconds: FLOW_CONTROL_RULES.windowMinutes * 60,
      },
      limitSize: null,
      minutes: [],
      signing: null,
      sums: { buyVolume: 0, cumulativeFrom: null, netVolume: 0, sellVolume: 0 },
      symbol: group.future,
      totalTrades: 0,
      trades: [],
    },
    freshness: [
      buildFreshnessRow(rows, primary),
      buildFreshnessRow(rows, check),
    ],
    futures,
    generatedAt: rows.now.toISOString(),
    group: rows.group,
    levels: null,
    netDrift: [
      buildSeries(primary, "primary", from),
      buildSeries(check, "check", from),
    ],
    notes: [
      `Net drift filter ${FLOW_FILTER_PROFILE}: out-of-the-money options only, without complex, tied, floor and cancelled trades.`,
      "Net drift values are the vendor's signed per-minute values; sums start at 09:30 New York.",
      "The newest net drift minute is left out until it has closed.",
      "Futures deep trades are not collected yet.",
      "Research only; a state describes recent flow and is not a trade signal.",
    ],
    options,
    rules: FLOW_CONTROL_RULES,
    schemaVersion: FLOW_CONTROL_VERSION,
    session: {
      date: rows.sessionDate,
      event: null,
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
