// What: the rules of the options-side control state (flow-control-rules.v1) and of the futures-side
// control state (flow-futures-rules.v1), the fold over one-minute net drift buckets, the fold over
// covered tape minutes, the group, agreement and cross-check rules, and every label and detail text
// of flow.control.
// Pure; imports contract types only. The study (pull request 3) imports FLOW_CONTROL_RULES,
// optionsRatio, foldControlState and FLOW_CONTROL_STUDY_RULES_ITEM.
// Research only: a state describes recent flow and is never a trade signal.
// Doc: docs/vertex-rebuild/flow-pipeline.md.
import type {
  FlowAgreementState,
  FlowControlRules,
  FlowControlState,
  FlowCrossCheckResult,
  FlowDirection,
  FlowFuturesHold,
  FlowFuturesRules,
  FlowNoDataReason,
  FlowStudyStatus,
} from "./contracts/flow.ts";

export const FLOW_CONTROL_RULES: FlowControlRules = Object.freeze({
  enterRatio: 0.3,
  exitRatio: 0.1,
  minBuckets: 10,
  minMinutes: 5,
  version: "flow-control-rules.v1",
  windowMinutes: 30,
});
/** The start values of the futures fold (plan flow-streaming-tape, section 5). */
export const FLOW_FUTURES_RULES: FlowFuturesRules = Object.freeze({
  enterRatio: 0.3,
  exitRatio: 0.1,
  maxMissingMinutes: 5,
  minBuckets: 10,
  minCoveredSeconds: 55,
  minMinutes: 5,
  minTrades: 10,
  version: "flow-futures-rules.v1",
  windowMinutes: 30,
});
/** The item name of the rules version in a stored strategy-backtest study. */
export const FLOW_CONTROL_STUDY_RULES_ITEM = "Rules version";
export const FLOW_CONTROL_STUDY_ID = "flow-control-continuation";
export const FLOW_STUDY_AGREEMENT_DETAIL =
  "the agreement is not tested as an entry rule yet";
export const FLOW_NET_DRIFT_SLOPE_MINUTES = 15;
export const FLOW_CROSS_CHECK_MIN_PRINTS = 20;

const DETAIL_MAX = 300;

/** One settled total bucket: `minute` is whole minutes after 09:30 New York; a missing minute is a gap. */
export type FlowDriftMinute = Readonly<{
  minute: number;
  netCallPremium: number;
  netPutPremium: number;
}>;

export type FlowWindowTotals = Readonly<{
  numerator: number;
  denominator: number;
  rows: number;
}>;

const inWindow = <T extends Readonly<{ minute: number }>>(
  minutes: readonly T[],
  end: number,
  rules: FlowControlRules
): readonly T[] =>
  minutes.filter(
    (entry) => entry.minute > end - rules.windowMinutes && entry.minute <= end
  );

const totalsOf = (window: readonly FlowDriftMinute[]): FlowWindowTotals => ({
  denominator: window.reduce(
    (sum, entry) =>
      sum + Math.abs(entry.netCallPremium) + Math.abs(entry.netPutPremium),
    0
  ),
  numerator: window.reduce(
    (sum, entry) => sum + entry.netCallPremium - entry.netPutPremium,
    0
  ),
  rows: window.length,
});

/** Sums over the entries with end − windowMinutes < minute <= end. */
export const windowTotals = (
  minutes: readonly FlowDriftMinute[],
  end: number,
  rules: FlowControlRules
): FlowWindowTotals => totalsOf(inWindow(minutes, end, rules));

/** Σ(call − put) / Σ(|call| + |put|) over the given entries; 0 for a zero denominator. */
export const optionsRatio = (window: readonly FlowDriftMinute[]): number => {
  const { numerator, denominator } = totalsOf(window);
  return denominator === 0 ? 0 : numerator / denominator;
};

export type FlowControlStep = Readonly<{
  minute: number;
  ratio: number | null;
  state: "buyers" | "sellers" | "balanced" | "no_data";
  noDataReason: "session_start" | "gap" | null;
  sinceMinute: number | null;
}>;

type Carried = "buyers" | "sellers" | "balanced";

interface FoldState {
  buyRun: number;
  carried: Carried;
  sellRun: number;
  since: number | null;
}

/**
 * `held` is true for a minute of the futures fold that cannot count toward an entry: an entry
 * check failed, or the minute has no tape. The minute then breaks the run.
 */
const countRuns = (
  state: FoldState,
  ratio: number,
  minute: number,
  rules: FlowControlRules,
  held: boolean
): void => {
  if (!held && ratio >= rules.enterRatio) {
    state.buyRun += 1;
    state.sellRun = 0;
  } else if (!held && ratio <= -rules.enterRatio) {
    state.sellRun += 1;
    state.buyRun = 0;
  } else {
    state.buyRun = 0;
    state.sellRun = 0;
  }
  if (state.buyRun >= rules.minMinutes) {
    state.carried = "buyers";
    state.since = minute - state.buyRun + 1;
  } else if (state.sellRun >= rules.minMinutes) {
    state.carried = "sellers";
    state.since = minute - state.sellRun + 1;
  } else return;
  state.buyRun = 0;
  state.sellRun = 0;
};

/** The exit test reads the ratio alone; `held` only stops the minute from counting toward an entry. */
const applyRatio = (
  state: FoldState,
  ratio: number,
  minute: number,
  rules: FlowControlRules,
  held = false
): void => {
  const ended =
    (state.carried === "buyers" && ratio < rules.exitRatio) ||
    (state.carried === "sellers" && ratio > -rules.exitRatio);
  if (ended) {
    state.carried = "balanced";
    state.since = null;
    state.buyRun = 0;
    state.sellRun = 0;
  }
  if (state.carried === "balanced")
    countRuns(state, ratio, minute, rules, held);
};

/**
 * One step per minute from 0 to the last input minute (gaps included); no step for an empty input.
 * The rules argument is required: the study passes windows of 15 and 60 minutes.
 */
export const foldControlState = (
  minutes: readonly FlowDriftMinute[],
  rules: FlowControlRules
): readonly FlowControlStep[] => {
  if (minutes.length === 0) return [];
  const last = Math.max(...minutes.map((entry) => entry.minute));
  const state: FoldState = {
    buyRun: 0,
    carried: "balanced",
    sellRun: 0,
    since: null,
  };
  const steps: FlowControlStep[] = [];
  for (let minute = 0; minute <= last; minute += 1) {
    const window = inWindow(minutes, minute, rules);
    if (window.length < rules.minBuckets) {
      state.buyRun = 0;
      state.sellRun = 0;
      steps.push({
        minute,
        noDataReason: minute + 1 < rules.minBuckets ? "session_start" : "gap",
        ratio: null,
        sinceMinute: null,
        state: "no_data",
      });
      continue;
    }
    const ratio = optionsRatio(window);
    applyRatio(state, ratio, minute, rules);
    steps.push({
      minute,
      noDataReason: null,
      ratio,
      sinceMinute: state.since,
      state: state.carried,
    });
  }
  return steps;
};

/**
 * One covered minute of the streamed tape of a future. `minute` is whole minutes after 09:30 New
 * York. `deepBuy`, `deepSell` and `deepTrades` are the contracts and the number of the deep trades
 * of the minute; `delta` and `volume` are contracts of all prints; `vwap` is the VWAP of the minute
 * and `close` its last price. The caller passes covered minutes only.
 */
export type FlowTapeMinute = Readonly<{
  minute: number;
  deepBuy: number;
  deepSell: number;
  deepTrades: number;
  delta: number;
  volume: number;
  vwap: number;
  close: number;
}>;

/** One step of the futures fold: `ratio` is the ratio before the checks; `trades` counts the deep trades of the window. */
export type FlowFuturesStep = FlowControlStep &
  Readonly<{ hold: FlowFuturesHold | null; trades: number }>;

const sumOf = <T>(rows: readonly T[], value: (row: T) => number): number =>
  rows.reduce((sum, row) => sum + value(row), 0);

const deepTotalsOf = (window: readonly FlowTapeMinute[]): FlowWindowTotals => ({
  denominator: sumOf(window, (entry) => entry.deepBuy + entry.deepSell),
  numerator: sumOf(window, (entry) => entry.deepBuy - entry.deepSell),
  rows: window.length,
});

/** Net and total deep-trade volume and the number of covered minutes with end − windowMinutes < minute <= end. */
export const futuresWindowTotals = (
  minutes: readonly FlowTapeMinute[],
  end: number,
  rules: FlowControlRules
): FlowWindowTotals => deepTotalsOf(inWindow(minutes, end, rules));

/**
 * The first failed entry check of a window with at least one row, or null. The checks apply only
 * to a ratio at or beyond the enter ratio. A window without volume has no VWAP: the price check fails.
 */
const holdOf = (
  window: readonly FlowTapeMinute[],
  ratio: number,
  trades: number,
  rules: FlowFuturesRules
): FlowFuturesHold | null => {
  if (Math.abs(ratio) < rules.enterRatio) return null;
  if (trades < rules.minTrades) return "few_trades";
  const side = ratio < 0 ? -1 : 1;
  if (Math.sign(sumOf(window, (entry) => entry.delta)) !== side)
    return "delta_against";
  const vwap =
    sumOf(window, (entry) => entry.vwap * entry.volume) /
    sumOf(window, (entry) => entry.volume);
  const newest = window.reduce((latest, entry) =>
    entry.minute > latest.minute ? entry : latest
  );
  return (newest.close - vwap) * side > 0 ? null : "price_against";
};

/**
 * The futures fold: one step per minute from 0 to the newer of `through` and the last input
 * minute; no step when that minute is below 0. `through` is the newest minute with a stored row,
 * covered or not. A minute without a covered row counts as missing, also after the last covered
 * minute: a state must not outlive its tape. A window with too few covered minutes gives no_data
 * and ends a running state, because the tape of a gap cannot be read later. A minute without a
 * covered row also breaks the entry run: an entry needs `minMinutes` minutes in a row that the
 * tape saw. It does not end a running state before the gap rule does. The checks never end a
 * state; a step reports `hold` only for a failed check and only while its state is balanced.
 */
export const foldFuturesState = (
  minutes: readonly FlowTapeMinute[],
  rules: FlowFuturesRules,
  through = -1
): readonly FlowFuturesStep[] => {
  const last = Math.max(through, ...minutes.map((entry) => entry.minute));
  const covered = new Set(minutes.map((entry) => entry.minute));
  const state: FoldState = {
    buyRun: 0,
    carried: "balanced",
    sellRun: 0,
    since: null,
  };
  const steps: FlowFuturesStep[] = [];
  for (let minute = 0; minute <= last; minute += 1) {
    const window = inWindow(minutes, minute, rules);
    const trades = sumOf(window, (entry) => entry.deepTrades);
    const expected = Math.min(rules.windowMinutes, minute + 1);
    if (
      window.length < rules.minBuckets ||
      expected - window.length > rules.maxMissingMinutes
    ) {
      state.buyRun = 0;
      state.sellRun = 0;
      state.carried = "balanced";
      state.since = null;
      steps.push({
        hold: null,
        minute,
        noDataReason: minute + 1 < rules.minBuckets ? "session_start" : "gap",
        ratio: null,
        sinceMinute: null,
        state: "no_data",
        trades,
      });
      continue;
    }
    const { numerator, denominator } = deepTotalsOf(window);
    const ratio = denominator === 0 ? 0 : numerator / denominator;
    const hold = holdOf(window, ratio, trades, rules);
    applyRatio(
      state,
      ratio,
      minute,
      rules,
      hold !== null || !covered.has(minute)
    );
    steps.push({
      hold: state.carried === "balanced" ? hold : null,
      minute,
      noDataReason: null,
      ratio,
      sinceMinute: state.since,
      state: state.carried,
      trades,
    });
  }
  return steps;
};

/** The group's options state: the primary decides; opposite control of the two tickers is mixed. */
export const groupOptionsState = (
  primary: FlowControlState,
  check: FlowControlState
): FlowControlState => {
  if (primary === "no_data") return "no_data";
  if (
    (primary === "buyers" && check === "sellers") ||
    (primary === "sellers" && check === "buyers")
  )
    return "mixed";
  return primary;
};

export type FlowAgreementResult = Readonly<{
  state: FlowAgreementState;
  direction: FlowDirection;
}>;

const inControl = (state: FlowControlState): boolean =>
  state === "buyers" || state === "sellers";
const comparable = (state: FlowControlState): boolean =>
  inControl(state) || state === "balanced";

/**
 * The agreement of the futures state with the options state. Only `agree` has a direction. A side
 * with no data, or a mixed side, cannot be compared.
 */
export const agreementOf = (
  futures: FlowControlState,
  options: FlowControlState
): FlowAgreementResult => {
  const neutral = (state: FlowAgreementState): FlowAgreementResult => ({
    direction: "neutral",
    state,
  });
  if (!(comparable(futures) && comparable(options)))
    return neutral("not_comparable");
  if (!(inControl(futures) || inControl(options)))
    return neutral("both_balanced");
  if (!(inControl(futures) && inControl(options))) return neutral("one_sided");
  if (futures !== options) return neutral("diverge");
  return {
    direction: futures === "buyers" ? "bullish" : "bearish",
    state: "agree",
  };
};

/** Compares the vendor numerator with the signed premium of the stored option prints. */
export const crossCheckResult = (
  vendorNumerator: number | null,
  printsFigure: number,
  storedPrints: number
): "same_direction" | "opposite_direction" | "not_comparable" => {
  if (
    storedPrints < FLOW_CROSS_CHECK_MIN_PRINTS ||
    vendorNumerator === null ||
    vendorNumerator === 0 ||
    printsFigure === 0
  )
    return "not_comparable";
  return Math.sign(vendorNumerator) === Math.sign(printsFigure)
    ? "same_direction"
    : "opposite_direction";
};

export type FlowText = Readonly<{ label: string; detail: string }>;

export type FlowSideFacts = Readonly<{
  instrument: string;
  state: FlowControlState;
  reason: FlowNoDataReason | null;
  ratio: number | null;
  primaryState: FlowControlState;
  checkInstrument: string | null;
  buckets: number;
  minutesSinceOpen: number;
  cause: string | null;
  newestBucketEt: string | null;
  staleMinutes: number;
  sessionDate: string;
  /** Close of that session as "HH:MM ET" (16:15 ET, 13:15 ET after an NYSE early close). */
  sessionEndEt: string;
  closeState: FlowControlState | null;
}>;

export type FlowSideSummary = Readonly<{
  instrument: string;
  state: FlowControlState;
  label: string;
  detail: string;
}>;

const cut = (detail: string): string => detail.slice(0, DETAIL_MAX);
const two = (value: number | null): string => (value ?? 0).toFixed(2);
const sideWord = (state: FlowControlState): string =>
  state === "sellers" ? "bearish" : "bullish";

const closedDetail = (facts: FlowSideFacts): string => {
  const head = `Last session ended ${facts.sessionEndEt} on ${facts.sessionDate}; at the close the ${facts.instrument} options side`;
  switch (facts.closeState) {
    case null:
      return "No net drift session is stored yet";
    case "buyers":
    case "sellers":
      return `${head} was ${sideWord(facts.closeState)}`;
    case "no_data":
      return `${head} had no state`;
    default:
      return `${head} was ${facts.closeState}`;
  }
};

const describeReason = (
  facts: FlowSideFacts,
  reason: FlowNoDataReason,
  rules: FlowControlRules
): FlowText => {
  const I = facts.instrument;
  switch (reason) {
    case "market_closed":
      return { detail: closedDetail(facts), label: "Market closed" };
    case "source_unavailable":
      return {
        detail: facts.cause ?? "the last request failed",
        label: "No answer from QuantData net drift",
      };
    case "storage_failed":
      return {
        detail: `The last ${I} net drift answer was not stored (${facts.cause ?? "write failed"}); the next run retries`,
        label: "Net drift was not stored",
      };
    case "stale":
      return {
        detail:
          facts.newestBucketEt === null
            ? `No ${I} bucket since 09:30 ET; stale after ${facts.staleMinutes} min`
            : `Newest ${I} bucket is ${facts.newestBucketEt}; stale after ${facts.staleMinutes} min`,
        label: "Net drift is stale",
      };
    case "gap":
      return {
        detail: `${facts.buckets} of ${rules.minBuckets} buckets needed in the last ${rules.windowMinutes} min for ${I}`,
        label: "Gap in net drift",
      };
    case "session_start":
      return {
        detail: `${facts.minutesSinceOpen} of ${rules.minBuckets} minutes needed since 09:30 ET`,
        label: "Session start",
      };
    default:
      return {
        detail: `${I} deep trades are not collected yet`,
        label: "Futures: deep trades not collected yet",
      };
  }
};

/** Label and detail of one side; the numbers come from the rules and the facts. */
export const describeSide = (
  facts: FlowSideFacts,
  rules: FlowControlRules
): FlowText => {
  const I = facts.instrument;
  const ratioText = `Ratio ${two(facts.ratio)} over the last ${rules.windowMinutes} min; enter ratio ${two(rules.enterRatio)}`;
  const text = ((): FlowText => {
    switch (facts.state) {
      case "buyers":
        return {
          detail: ratioText,
          label: `${I} options: bullish, call buying leads`,
        };
      case "sellers":
        return {
          detail: ratioText,
          label: `${I} options: bearish, put buying leads`,
        };
      case "balanced":
        return { detail: ratioText, label: `${I} options: balanced` };
      case "mixed":
        return {
          detail: `${I} ratio ${two(facts.ratio)} over the last ${rules.windowMinutes} min; ${facts.checkInstrument ?? ""} is in control of the other side`,
          label: `Options mixed: ${I} ${sideWord(facts.primaryState)}, ${facts.checkInstrument ?? ""} ${facts.primaryState === "sellers" ? "bullish" : "bearish"}`,
        };
      default:
        return describeReason(facts, facts.reason ?? "session_start", rules);
    }
  })();
  return { detail: cut(text.detail), label: text.label };
};

export type FlowFuturesReason =
  | "market_closed"
  | "source_unavailable"
  | "storage_failed"
  | "stale"
  | "gap"
  | "session_start";

/** Facts of the futures side; `reason` says why a side with the state no_data has none. */
export type FlowFuturesSideFacts = Readonly<{
  instrument: string;
  state: "buyers" | "sellers" | "balanced" | "no_data";
  reason: FlowFuturesReason | null;
  ratio: number | null;
  hold: FlowFuturesHold | null;
  /** Deep trades in the window. */
  trades: number;
  /** Covered tape minutes in the window. */
  coveredMinutes: number;
  cause: string | null;
  newestReadEt: string | null;
  staleMinutes: number;
  sessionDate: string;
}>;

const holdText = (hold: FlowFuturesHold, rules: FlowFuturesRules): string => {
  switch (hold) {
    case "few_trades":
      return `fewer than ${rules.minTrades} deep trades`;
    case "delta_against":
      return "the delta of all trades points the other way";
    case "price_against":
      return `the price is on the other side of the ${rules.windowMinutes}-min VWAP`;
  }
};

const futuresText = (
  facts: FlowFuturesSideFacts,
  rules: FlowFuturesRules
): FlowText => {
  const f = facts.instrument;
  const window = rules.windowMinutes;
  const ratioText = `Deep-trade ratio ${two(facts.ratio)} over the last ${window} min from ${facts.trades} deep trades; enter ratio ${two(rules.enterRatio)}`;
  const status =
    facts.state === "no_data" ? (facts.reason ?? "session_start") : facts.state;
  switch (status) {
    case "buyers":
      return { detail: ratioText, label: `${f} futures: buyers in control` };
    case "sellers":
      return { detail: ratioText, label: `${f} futures: sellers in control` };
    case "balanced":
      return {
        detail:
          facts.hold === null
            ? ratioText
            : `${ratioText}; not counted: ${holdText(facts.hold, rules)}`,
        label: `${f} futures: balanced`,
      };
    case "session_start":
      return {
        detail: `${facts.coveredMinutes} of ${rules.minBuckets} covered tape minutes needed in the last ${window} min for ${f}`,
        label: "Futures: session start",
      };
    case "gap":
      return {
        detail: `${facts.coveredMinutes} covered tape minutes in the last ${window} min for ${f}; at most ${rules.maxMissingMinutes} may be missing`,
        label: `Gap in the ${f} tape`,
      };
    case "market_closed":
      return {
        detail: `The ${f} deep-trade window is 09:30 to 16:00 ET; the last window was ${facts.sessionDate}`,
        label: "Market closed",
      };
    case "source_unavailable":
      return {
        detail: facts.cause ?? "the last request failed",
        label: "No answer from the IBKR tape",
      };
    case "storage_failed":
      return {
        detail: `The last ${f} tape read was not stored (${facts.cause ?? "write failed"}); the next run retries`,
        label: "Futures tape was not stored",
      };
    case "stale":
      return {
        detail:
          facts.newestReadEt === null
            ? `No ${f} tape read since 09:30 ET; stale after ${facts.staleMinutes} min`
            : `Newest ${f} tape read is ${facts.newestReadEt}; stale after ${facts.staleMinutes} min`,
        label: "Futures tape is stale",
      };
  }
};

/** Label and detail of the futures side; the numbers come from the rules and the facts. The detail is cut to 300 characters. */
export const describeFuturesSide = (
  facts: FlowFuturesSideFacts,
  rules: FlowFuturesRules
): FlowText => {
  const text = futuresText(facts, rules);
  return { detail: cut(text.detail), label: text.label };
};

const agreementText = (
  agreement: FlowAgreementResult,
  futures: FlowSideSummary,
  options: FlowSideSummary
): FlowText => {
  const names = `${futures.instrument} futures`;
  const other = `${options.instrument} options`;
  const labels = `${futures.label}; ${options.label}`;
  switch (agreement.state) {
    case "agree": {
      const side = agreement.direction === "bullish" ? "buyers" : "sellers";
      return {
        detail: `${names} and ${other} both show ${side} in control`,
        label: `Agree: ${side} in control on both sides`,
      };
    }
    case "diverge":
      return {
        detail: labels,
        label: "Diverge: the two sides show opposite control",
      };
    case "one_sided":
      return {
        detail: labels,
        label: `One-sided: only the ${inControl(futures.state) ? "futures" : "options"} side shows control`,
      };
    case "both_balanced":
      return {
        detail: `Neither ${names} nor ${other} show a side in control`,
        label: "Both sides balanced",
      };
    case "not_comparable": {
      // The futures side when it has no data, else the options side (no data or mixed).
      const side = futures.state === "no_data" ? futures : options;
      return {
        detail: `${side.label}: ${side.detail}`,
        label: "Cannot compare",
      };
    }
  }
};

/** Label and detail of the agreement of the two sides; the detail is cut to 300 characters. */
export const describeAgreement = (
  agreement: FlowAgreementResult,
  futures: FlowSideSummary,
  options: FlowSideSummary
): FlowText => {
  const text = agreementText(agreement, futures, options);
  return { detail: cut(text.detail), label: text.label };
};

/** The sentence of a partial parts status. */
export const describeParts = (instrument: string): string =>
  `The same-day (0DTE) part of ${instrument} net drift is missing; the totals are complete`;

export const describeCrossCheck = (
  facts: Readonly<{
    ticker: string;
    result: FlowCrossCheckResult;
    storedPrints: number;
    unreadRanges: number;
  }>
): string => {
  const { ticker, storedPrints, unreadRanges } = facts;
  switch (facts.result) {
    case "same_direction":
      return `Stored ${ticker} option prints point the same way as the vendor net drift (${storedPrints} prints, ${unreadRanges} unread time ranges)`;
    case "opposite_direction":
      return `Stored ${ticker} option prints point the other way (${storedPrints} prints, ${unreadRanges} unread time ranges). Check the filter profile and the vendor status. No state is changed.`;
    case "not_comparable":
      return `Too few stored ${ticker} option prints to compare, or one figure is zero (${storedPrints} prints, ${FLOW_CROSS_CHECK_MIN_PRINTS} needed)`;
    default:
      return `Option prints are not collected for ${ticker}`;
  }
};

const STUDY_RESULT: Readonly<
  Record<Exclude<FlowStudyStatus, "not_tested">, string>
> = {
  edge: "edge found",
  "needs-more-data": "more data needed",
  "no-edge": "no edge found",
};

export const describeStudy = (
  study: Readonly<{ status: FlowStudyStatus; testedOn: string | null }>
): string => {
  const head = "Options-side continuation rule (modelled fills)";
  if (study.status === "not_tested") return `${head}: not tested yet`;
  return `${head}: tested on ${study.testedOn ?? ""}, ${STUDY_RESULT[study.status]} (Strategy Library)`;
};
