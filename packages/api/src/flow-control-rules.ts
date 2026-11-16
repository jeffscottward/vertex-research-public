// What: the rules of the options-side control state (flow-control-rules.v1), the fold over one-minute
// net drift buckets, the group and cross-check rules, and every label and detail text of flow.control.
// Pure; imports contract types only. The study (pull request 3) imports FLOW_CONTROL_RULES,
// optionsRatio, foldControlState and FLOW_CONTROL_STUDY_RULES_ITEM.
// Research only: a state describes recent flow and is never a trade signal.
// Doc: docs/vertex-rebuild/flow-pipeline.md.
import type {
  FlowControlRules,
  FlowControlState,
  FlowCrossCheckResult,
  FlowNoDataReason,
  FlowStudyStatus,
} from "./contracts/flow.ts";

export const FLOW_CONTROL_RULES: FlowControlRules = Object.freeze({
  version: "flow-control-rules.v1",
  windowMinutes: 30,
  enterRatio: 0.3,
  exitRatio: 0.1,
  minMinutes: 5,
  minBuckets: 10,
});
/** The item name of the rules version in a stored strategy-backtest study. */
export const FLOW_CONTROL_STUDY_RULES_ITEM = "Rules version";
export const FLOW_CONTROL_STUDY_ID = "flow-control-continuation";
export const FLOW_STUDY_AGREEMENT_DETAIL =
  "futures and options agreement is not compared or tested";
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

const inWindow = (
  minutes: readonly FlowDriftMinute[],
  end: number,
  rules: FlowControlRules
): readonly FlowDriftMinute[] =>
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
  carried: Carried;
  since: number | null;
  buyRun: number;
  sellRun: number;
}

const countRuns = (
  state: FoldState,
  ratio: number,
  minute: number,
  rules: FlowControlRules
): void => {
  if (ratio >= rules.enterRatio) {
    state.buyRun += 1;
    state.sellRun = 0;
  } else if (ratio <= -rules.enterRatio) {
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

const applyRatio = (
  state: FoldState,
  ratio: number,
  minute: number,
  rules: FlowControlRules
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
  if (state.carried === "balanced") countRuns(state, ratio, minute, rules);
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
  const head = `Last session ended 16:15 ET on ${facts.sessionDate}; at the close the ${facts.instrument} options side`;
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
    case "sampled_tape":
      return {
        detail: `${I} trades are sampled; no state is computed from them`,
        label: "Sampled tape",
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

/** The not_comparable text: names the side without data (the futures side when both have none). */
export const describeAgreement = (
  futures: FlowSideSummary,
  options: FlowSideSummary
): FlowText => {
  const side =
    futures.state === "no_data" || options.state !== "no_data"
      ? futures
      : options;
  return {
    detail: cut(`${side.label}: ${side.detail}`),
    label: "Cannot compare",
  };
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
