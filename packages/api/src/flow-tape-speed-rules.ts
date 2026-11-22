// What: the rule that marks a burst second of the streamed tape (flow-tape-speed-rules.v1), the
// verdict of each covered second and the fold of burst seconds into bursts, for flow.tapeSpeed.
// Pure; imports contract types only. A later study imports FLOW_TAPE_SPEED_RULES,
// judgeTapeSeconds and foldTapeBursts.
// Research only: a burst describes how fast the tape traded and is never a trade signal.
// Doc: docs/vertex-rebuild/flow-pipeline.md ("Tape speed (ES, NQ)").
import type { FlowTapeSpeedRules } from "./contracts/flow.ts";

/**
 * Version 1. The numbers come from one measured sample (the ES and NQ tape of 2026-11-20, 15:26
 * to 17:00 New York: about 7 bursts per hour); they are not tested as a signal. Known limit: the
 * baseline is a mean, so a strong burst raises the limit of the next baselineSeconds.
 */
export const FLOW_TAPE_SPEED_RULES: FlowTapeSpeedRules = Object.freeze({
  baselineSeconds: 600,
  floorTrades: 20,
  minBaselineCoveredSeconds: 300,
  multiple: 8,
  version: "flow-tape-speed-rules.v1",
});

/** One covered exchange second. A series is ascending by `t` and holds covered seconds only. */
export type TapeSecond = Readonly<{
  t: number;
  trades: number;
  contracts: number;
}>;

/** not_evaluated: too few covered seconds before the second for a baseline. */
export type TapeSecondVerdict = "burst" | "normal" | "not_evaluated";

export type JudgedTapeSecond = TapeSecond &
  Readonly<{
    /** Mean trades per second of the covered seconds before it; null only for not_evaluated. */
    baseline: number | null;
    verdict: TapeSecondVerdict;
  }>;

/**
 * The verdict of each second. The baseline of a second at `t` is the mean trades per second over
 * the covered seconds in [t - baselineSeconds, t - 1]; with fewer than minBaselineCoveredSeconds
 * of them the second is not evaluated. A burst second has at least floorTrades trades and at
 * least `multiple` times its baseline. The rule uses exchange seconds only, so a second has the
 * same verdict in every series that holds the baselineSeconds before it. Linear in the series.
 */
export const judgeTapeSeconds = (
  seconds: readonly TapeSecond[],
  rules: FlowTapeSpeedRules = FLOW_TAPE_SPEED_RULES
): JudgedTapeSecond[] => {
  const judged: JudgedTapeSecond[] = [];
  // The baseline window is seconds[first, index): a moving start and a running sum.
  let first = 0;
  let sum = 0;
  seconds.forEach((second, index) => {
    while (
      (seconds[first] as TapeSecond).t <
      second.t - rules.baselineSeconds
    ) {
      sum -= (seconds[first] as TapeSecond).trades;
      first += 1;
    }
    const covered = index - first;
    if (covered < rules.minBaselineCoveredSeconds)
      judged.push({ ...second, baseline: null, verdict: "not_evaluated" });
    else {
      const baseline = sum / covered;
      const burst =
        second.trades >= rules.floorTrades &&
        second.trades >= rules.multiple * baseline;
      judged.push({ ...second, baseline, verdict: burst ? "burst" : "normal" });
    }
    sum += second.trades;
  });
  return judged;
};

/** A run of burst seconds whose exchange seconds follow each other without a step. */
export type TapeBurst = Readonly<{
  /** The first second of the burst. */
  start: number;
  seconds: number;
  contracts: number;
  /** The most trades of one second of the burst. */
  peakTrades: number;
  /** The baseline of the first second. */
  baseline: number;
}>;

/** The bursts of a judged series, ascending by start. */
export const foldTapeBursts = (
  judged: readonly JudgedTapeSecond[]
): TapeBurst[] => {
  const bursts: TapeBurst[] = [];
  for (const second of judged) {
    if (second.verdict !== "burst") continue;
    const open = bursts.at(-1);
    // The series is ascending, so only the newest burst can end one second before this one.
    if (open !== undefined && second.t === open.start + open.seconds) {
      bursts[bursts.length - 1] = {
        ...open,
        contracts: open.contracts + second.contracts,
        peakTrades: Math.max(open.peakTrades, second.trades),
        seconds: open.seconds + 1,
      };
      continue;
    }
    bursts.push({
      // A burst second always has a baseline (see JudgedTapeSecond).
      baseline: second.baseline as number,
      contracts: second.contracts,
      peakTrades: second.trades,
      seconds: 1,
      start: second.t,
    });
  }
  return bursts;
};
