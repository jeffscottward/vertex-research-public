// Model and framework benchmark over recorded agent model runs (pure, no I/O).
//
// Arms group runs (by model, served model, provider and model, framework or variant) and are
// compared on the same (ticker, decision date) cells.
//
// Formulas adapted from Glassbench (https://github.com/davidalmeida90/glassbench), Copyright 2026
// David Arias, Apache License 2.0, commit 255414b3f38b5def667d3b75faf1dfd7c0d25c9b:
// results/local-models/README.md (ratings that match a baseline run; distance to the closest baseline
// rating on the five-step scale) and backend/deskapp/paired.py (exact two-sided sign test). See NOTICE
// and licenses/glassbench-APACHE-2.0.txt.
// Modified: written in TypeScript; the arm's modal rating stands for its reruns (ties go to the rating
// nearest hold, then the more bullish one); the sign test sums in log space so it stays exact-ish for
// thousands of cells; the paired test scores a directional hit on a 5-day forward return instead of
// valuation statements.
//
// Research only. A rating is a research label. Nothing here creates, sizes or sends an order.

import {
  AGENT_MODEL_BENCHMARK_ARMS_MAX,
  AGENT_MODEL_BENCHMARK_BAR_TICKERS_MAX,
  AGENT_MODEL_BENCHMARK_FORWARD_DAYS,
  AGENT_MODEL_BENCHMARK_MATRIX_ARMS_MAX,
  type AgentModelBenchmarkArmByValue,
  type AgentModelBenchmarkArmOutput,
  type AgentModelBenchmarkOutput,
  type AgentModelBenchmarkPairOutput,
  type AgentModelRunOutput,
} from "./contracts/agent-model-runs.ts";
import {
  AGENT_RATING_VALUES,
  type AgentRating,
} from "./contracts/agent-ops.ts";

export type BenchmarkRun = Pick<
  AgentModelRunOutput,
  | "costUsd"
  | "decisionDate"
  | "durationMs"
  | "flags"
  | "framework"
  | "inputTokens"
  | "llmCalls"
  | "model"
  | "modelsServed"
  | "outputTokens"
  | "provider"
  | "rating"
  | "status"
  | "ticker"
  | "toolCalls"
  | "variant"
>;

/** Daily bars: `t` is the bar time in ms since the epoch (UTC date = trading date), `c` the close. */
export type BenchmarkBars = Readonly<{
  t: ArrayLike<number>;
  c: ArrayLike<number>;
}>;

export type BenchmarkPair = Readonly<{ control: string; treatment: string }>;

export type BenchmarkOptions = Readonly<{
  armBy: AgentModelBenchmarkArmByValue;
  baselineArm?: string | undefined;
  pair?: BenchmarkPair | undefined;
}>;

/** Runs flagged with this slug ran on a local model server (cost 0); the page labels the arm "local". */
export const LOCAL_MODEL_FLAG = "local_model";
export const NO_SERVED_MODEL = "(not reported)";
export const NO_VARIANT = "(no variant)";
const ARM_KEY_MAX = 400;
const DAY_MS = 86_400_000;
const HOLD_INDEX = 2;
// Modal ties resolve in this order: nearest hold first, then the more bullish rating.
const TIE_ORDER = [2, 1, 3, 0, 4] as const;

interface ArmCell {
  costUsd: number;
  durations: number[];
  finished: number;
  ratings: AgentRating[];
  runs: number;
  tokens: number;
}

interface ArmState {
  cells: Map<string, ArmCell>;
  costUsd: number;
  durations: number[];
  failed: number;
  finished: number;
  inputTokens: number;
  key: string;
  llmCalls: number;
  localRuns: number;
  mix: number[];
  outputTokens: number;
  rated: number;
  runs: number;
  served: Set<string>;
  toolCalls: number;
  unrated: number;
}

const ratingIndex = (rating: AgentRating): number =>
  AGENT_RATING_VALUES.indexOf(rating);

export const armKeyOf = (
  run: BenchmarkRun,
  armBy: AgentModelBenchmarkArmByValue
): string => {
  switch (armBy) {
    case "model":
      return run.model;
    case "provider_model":
      return `${run.provider}:${run.model}`;
    case "framework":
      return run.framework;
    case "variant":
      return run.variant ?? NO_VARIANT;
    case "servedModel": {
      const served = [
        ...new Set(run.modelsServed.map((entry) => entry.served)),
      ].sort();
      return served.length === 0
        ? NO_SERVED_MODEL
        : served.join(" + ").slice(0, ARM_KEY_MAX);
    }
  }
};

const cellKeyOf = (run: Pick<BenchmarkRun, "ticker" | "decisionDate">) =>
  `${run.ticker} ${run.decisionDate}`;

// A cell key is "TICKER YYYY-MM-DD"; a ticker never holds a space.
const splitCellKey = (key: string): [string, string] =>
  key.split(" ") as [string, string];

/** The most frequent rating; ties go to the rating nearest hold, then the more bullish one. */
export const modalRating = (
  ratings: readonly AgentRating[]
): AgentRating | null => {
  if (ratings.length === 0) return null;
  const counts = AGENT_RATING_VALUES.map(() => 0);
  for (const rating of ratings) {
    const index = ratingIndex(rating);
    counts[index] = (counts[index] as number) + 1;
  }
  let best: number = HOLD_INDEX;
  for (const index of TIE_ORDER)
    if ((counts[index] as number) > (counts[best] as number)) best = index;
  return AGENT_RATING_VALUES[best] as AgentRating;
};

/** buy and overweight call up (+1), underweight and sell call down (-1), hold and no rating make no call. */
export const ratingDirection = (rating: AgentRating | null): number => {
  if (rating === null) return 0;
  return Math.sign(HOLD_INDEX - ratingIndex(rating));
};

export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

/**
 * Exact two-sided sign test: min(1, 2 * sum_{i<=k} C(m, i) / 2^m) with m = wins + losses and
 * k = min(wins, losses). Ties are left out before the call. The terms are summed in log space.
 */
export const signTestP = (wins: number, losses: number): number => {
  const m = wins + losses;
  if (m === 0) return 1;
  const k = Math.min(wins, losses);
  let logTerm = -m * Math.LN2;
  let sum = Math.exp(logTerm);
  for (let i = 1; i <= k; i += 1) {
    logTerm += Math.log(m - i + 1) - Math.log(i);
    sum += Math.exp(logTerm);
  }
  return Math.min(1, 2 * sum);
};

/**
 * Close-to-close return from the last bar on or before the decision date to the bar `days` trading
 * bars later. Null when the decision bar or the later bar is missing, or a close is not positive.
 */
export const forwardReturn = (
  bars: BenchmarkBars,
  decisionDate: string,
  days: number = AGENT_MODEL_BENCHMARK_FORWARD_DAYS
): number | null => {
  const end = Date.parse(`${decisionDate}T00:00:00.000Z`) + DAY_MS;
  let low = 0;
  let high = bars.t.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if ((bars.t[middle] as number) < end) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (found < 0 || found + days >= bars.c.length) return null;
  const start = bars.c[found] as number;
  const later = bars.c[found + days] as number;
  if (!(start > 0 && later > 0)) return null;
  return later / start - 1;
};

const newCell = (): ArmCell => ({
  costUsd: 0,
  durations: [],
  finished: 0,
  ratings: [],
  runs: 0,
  tokens: 0,
});

const newArm = (key: string): ArmState => ({
  cells: new Map(),
  costUsd: 0,
  durations: [],
  failed: 0,
  finished: 0,
  inputTokens: 0,
  key,
  llmCalls: 0,
  localRuns: 0,
  mix: AGENT_RATING_VALUES.map(() => 0),
  outputTokens: 0,
  rated: 0,
  runs: 0,
  served: new Set(),
  toolCalls: 0,
  unrated: 0,
});

const addRun = (arm: ArmState, run: BenchmarkRun): void => {
  const cellKey = cellKeyOf(run);
  const cell = arm.cells.get(cellKey) ?? newCell();
  arm.cells.set(cellKey, cell);
  arm.runs += 1;
  cell.runs += 1;
  arm.costUsd += run.costUsd;
  cell.costUsd += run.costUsd;
  arm.inputTokens += run.inputTokens;
  arm.outputTokens += run.outputTokens;
  cell.tokens += run.inputTokens + run.outputTokens;
  arm.llmCalls += run.llmCalls;
  arm.toolCalls += run.toolCalls;
  if (run.durationMs !== null) {
    arm.durations.push(run.durationMs);
    cell.durations.push(run.durationMs);
  }
  for (const entry of run.modelsServed) arm.served.add(entry.served);
  if (run.flags.includes(LOCAL_MODEL_FLAG)) arm.localRuns += 1;
  if (run.status === "failed") arm.failed += 1;
  if (run.status !== "succeeded") return;
  arm.finished += 1;
  cell.finished += 1;
  // A finished run without a rating is unrated, never hold.
  if (run.rating === null) {
    arm.unrated += 1;
    return;
  }
  arm.rated += 1;
  const index = ratingIndex(run.rating);
  arm.mix[index] = (arm.mix[index] as number) + 1;
  cell.ratings.push(run.rating);
};

/** Groups runs into arms, largest arm first (then by key). */
const groupArms = (
  runs: readonly BenchmarkRun[],
  armBy: AgentModelBenchmarkArmByValue
): ArmState[] => {
  const arms = new Map<string, ArmState>();
  for (const run of runs) {
    const key = armKeyOf(run, armBy);
    const arm = arms.get(key) ?? newArm(key);
    arms.set(key, arm);
    addRun(arm, run);
  }
  return [...arms.values()].sort(
    (left, right) =>
      right.runs - left.runs ||
      Number(left.key > right.key) - Number(left.key < right.key)
  );
};

const rerunAgreement = (
  arm: ArmState
): AgentModelBenchmarkArmOutput["rerun"] => {
  let cells = 0;
  let agree = 0;
  let modalShares = 0;
  for (const cell of arm.cells.values()) {
    if (cell.ratings.length < 2) continue;
    cells += 1;
    const modal = modalRating(cell.ratings);
    const modalCount = cell.ratings.filter((rating) => rating === modal).length;
    if (modalCount === cell.ratings.length) agree += 1;
    modalShares += modalCount / cell.ratings.length;
  }
  return cells === 0
    ? { allAgreeShare: null, cells, meanModalShare: null }
    : {
        allAgreeShare: agree / cells,
        cells,
        meanModalShare: modalShares / cells,
      };
};

/**
 * Agreement with the baseline arm on shared cells (the arm has a modal rating and the baseline at
 * least one rating): match rate = share of cells where the modal rating is one of the baseline's
 * ratings; mean closest distance = mean of min |index(modal) - index(baseline rating)| (0-4).
 */
const baselineAgreement = (
  arm: Pick<ArmState, "cells">,
  baseline: Pick<ArmState, "cells">
): NonNullable<AgentModelBenchmarkArmOutput["baseline"]> => {
  let shared = 0;
  let matches = 0;
  let distance = 0;
  for (const [key, cell] of arm.cells) {
    const modal = modalRating(cell.ratings);
    const reference = baseline.cells.get(key)?.ratings ?? [];
    if (modal === null || reference.length === 0) continue;
    shared += 1;
    if (reference.includes(modal)) matches += 1;
    distance += Math.min(
      ...reference.map((rating) =>
        Math.abs(ratingIndex(rating) - ratingIndex(modal))
      )
    );
  }
  return shared === 0
    ? { matchRate: null, meanClosestDistance: null, sharedCells: 0 }
    : {
        matchRate: matches / shared,
        meanClosestDistance: distance / shared,
        sharedCells: shared,
      };
};

/** Share of shared cells (both arms have a modal rating) where the modal ratings are equal. */
const pairwiseAgreement = (
  left: Pick<ArmState, "cells">,
  right: Pick<ArmState, "cells">
): { sharedCells: number; agreeShare: number | null } => {
  let shared = 0;
  let agree = 0;
  for (const [key, cell] of left.cells) {
    const mine = modalRating(cell.ratings);
    const theirs = modalRating(right.cells.get(key)?.ratings ?? []);
    if (mine === null || theirs === null) continue;
    shared += 1;
    if (mine === theirs) agree += 1;
  }
  return {
    agreeShare: shared === 0 ? null : agree / shared,
    sharedCells: shared,
  };
};

const armOutput = (
  arm: ArmState,
  baseline: ArmState | undefined
): AgentModelBenchmarkArmOutput => {
  const ratingMix = Object.fromEntries(
    AGENT_RATING_VALUES.map((rating, index) => [rating, arm.mix[index]])
  ) as AgentModelBenchmarkArmOutput["ratingMix"];
  let ratedCells = 0;
  for (const cell of arm.cells.values())
    if (cell.ratings.length > 0) ratedCells += 1;
  return {
    avgCostUsd: arm.costUsd / arm.runs,
    baseline:
      baseline === undefined || baseline === arm
        ? null
        : baselineAgreement(arm, baseline),
    cells: arm.cells.size,
    extremityShare:
      arm.rated === 0 ? null : (ratingMix.buy + ratingMix.sell) / arm.rated,
    failed: arm.failed,
    finished: arm.finished,
    inputTokens: arm.inputTokens,
    key: arm.key,
    llmCalls: arm.llmCalls,
    local: arm.localRuns === arm.runs,
    medianDurationMs: median(arm.durations),
    outputTokens: arm.outputTokens,
    rated: arm.rated,
    ratedCells,
    ratingMix,
    rerun: rerunAgreement(arm),
    runs: arm.runs,
    servedModels: [...arm.served].sort(),
    toolCalls: arm.toolCalls,
    totalCostUsd: arm.costUsd,
    unrated: arm.unrated,
  };
};

/** Cells where both arms of the pair have at least one finished run. */
const sharedFinishedCells = (
  control: ArmState,
  treatment: ArmState
): string[] => {
  const keys: string[] = [];
  for (const [key, cell] of control.cells)
    if (cell.finished > 0 && (treatment.cells.get(key)?.finished ?? 0) > 0)
      keys.push(key);
  return keys.sort();
};

// An arm key that matches no run is an empty arm: it shares no cell.
const armOrEmpty = (
  arms: ReadonlyMap<string, ArmState>,
  key: string
): ArmState => arms.get(key) ?? newArm(key);

// Sorted tickers of the cells. The server loads bars for the first
// AGENT_MODEL_BENCHMARK_BAR_TICKERS_MAX of them; the rest are reported as over the cap.
const cellTickers = (cells: readonly string[]): string[] =>
  [...new Set(cells.map((key) => splitCellKey(key)[0]))].sort();

/** Tickers whose daily bars the paired comparison needs, sorted. */
export const benchmarkPairTickers = (
  runs: readonly BenchmarkRun[],
  options: BenchmarkOptions
): string[] => {
  if (options.pair === undefined) return [];
  const arms = new Map(
    groupArms(runs, options.armBy).map((arm) => [arm.key, arm])
  );
  const cells = sharedFinishedCells(
    armOrEmpty(arms, options.pair.control),
    armOrEmpty(arms, options.pair.treatment)
  );
  return cellTickers(cells);
};

const pairArm = (
  arm: ArmState,
  cells: readonly string[],
  hits: number
): AgentModelBenchmarkPairOutput["controlArm"] => {
  let runs = 0;
  let costUsd = 0;
  let tokens = 0;
  const durations: number[] = [];
  for (const key of cells) {
    const cell = arm.cells.get(key) as ArmCell;
    runs += cell.runs;
    costUsd += cell.costUsd;
    tokens += cell.tokens;
    durations.push(...cell.durations);
  }
  return {
    hits,
    medianDurationMs: median(durations),
    runs,
    totalCostUsd: costUsd,
    totalTokens: tokens,
  };
};

// The outcome of one shared cell of a pair.
type CellOutcome =
  | Readonly<{ kind: "no_call" }>
  | Readonly<{ kind: "no_bars"; missingTicker: string | null }>
  | Readonly<{ kind: "compared"; controlHit: boolean; treatmentHit: boolean }>;

const scoreCell = (
  controlModal: AgentRating | null,
  treatmentModal: AgentRating | null,
  key: string,
  bars: ReadonlyMap<string, BenchmarkBars>
): CellOutcome => {
  const controlCall = ratingDirection(controlModal);
  const treatmentCall = ratingDirection(treatmentModal);
  if (controlCall === 0 || treatmentCall === 0) return { kind: "no_call" };
  const [ticker, date] = splitCellKey(key);
  const series = bars.get(ticker);
  if (series === undefined) return { kind: "no_bars", missingTicker: ticker };
  const change = forwardReturn(series, date);
  if (change === null) return { kind: "no_bars", missingTicker: null };
  return {
    controlHit: Math.sign(change) === controlCall,
    kind: "compared",
    treatmentHit: Math.sign(change) === treatmentCall,
  };
};

/**
 * Paired comparison on cells where both arms finished: N of M cells changed the modal rating, and a
 * directional hit (the sign of the forward return matches the rating direction) per arm. Cells where
 * either arm makes no call (hold or no rating) or the bars are missing are left out and counted.
 */
const pairedComparison = (
  arms: ReadonlyMap<string, ArmState>,
  pair: BenchmarkPair,
  bars: ReadonlyMap<string, BenchmarkBars>
): AgentModelBenchmarkPairOutput => {
  const control = armOrEmpty(arms, pair.control);
  const treatment = armOrEmpty(arms, pair.treatment);
  const cells = sharedFinishedCells(control, treatment);
  const counts = {
    changed: 0,
    controlHits: 0,
    losses: 0,
    noBars: 0,
    noCall: 0,
    ties: 0,
    treatmentHits: 0,
    wins: 0,
  };
  const missing = new Set<string>();
  const overCap = new Set(
    cellTickers(cells).slice(AGENT_MODEL_BENCHMARK_BAR_TICKERS_MAX)
  );
  for (const key of cells) {
    const controlModal = modalRating(
      (control.cells.get(key) as ArmCell).ratings
    );
    const treatmentModal = modalRating(
      (treatment.cells.get(key) as ArmCell).ratings
    );
    if (controlModal !== treatmentModal) counts.changed += 1;
    const outcome = scoreCell(controlModal, treatmentModal, key, bars);
    if (outcome.kind === "no_call") counts.noCall += 1;
    else if (outcome.kind === "no_bars") {
      counts.noBars += 1;
      if (outcome.missingTicker !== null && !overCap.has(outcome.missingTicker))
        missing.add(outcome.missingTicker);
    } else {
      counts.controlHits += Number(outcome.controlHit);
      counts.treatmentHits += Number(outcome.treatmentHit);
      if (outcome.treatmentHit === outcome.controlHit) counts.ties += 1;
      else if (outcome.treatmentHit) counts.wins += 1;
      else counts.losses += 1;
    }
  }
  return {
    changedRating: counts.changed,
    compared: counts.wins + counts.losses + counts.ties,
    control: pair.control,
    controlArm: pairArm(control, cells, counts.controlHits),
    excludedNoBars: counts.noBars,
    excludedNoCall: counts.noCall,
    forwardDays: AGENT_MODEL_BENCHMARK_FORWARD_DAYS,
    losses: counts.losses,
    sharedCells: cells.length,
    signTestP: signTestP(counts.wins, counts.losses),
    tickersOverCap: [...overCap],
    tickersWithoutBars: [...missing].sort(),
    ties: counts.ties,
    treatment: pair.treatment,
    treatmentArm: pairArm(treatment, cells, counts.treatmentHits),
    wins: counts.wins,
  };
};

/** The whole benchmark for one set of runs. `truncated`: more runs matched than were read. */
export const computeBenchmark = (
  runs: readonly BenchmarkRun[],
  options: BenchmarkOptions,
  bars: ReadonlyMap<string, BenchmarkBars>,
  truncated: boolean
): AgentModelBenchmarkOutput => {
  const ordered = groupArms(runs, options.armBy);
  const arms = new Map(ordered.map((arm) => [arm.key, arm]));
  const baseline =
    options.baselineArm === undefined
      ? undefined
      : arms.get(options.baselineArm);
  const matrixArms = ordered.slice(0, AGENT_MODEL_BENCHMARK_MATRIX_ARMS_MAX);
  return {
    armBy: options.armBy,
    arms: ordered
      .slice(0, AGENT_MODEL_BENCHMARK_ARMS_MAX)
      .map((arm) => armOutput(arm, baseline)),
    armsTruncated: ordered.length > AGENT_MODEL_BENCHMARK_ARMS_MAX,
    baselineArm: baseline?.key ?? null,
    cells: new Set(runs.map(cellKeyOf)).size,
    matrix: {
      arms: matrixArms.map((arm) => arm.key),
      rows: matrixArms.map((row) =>
        matrixArms.map((column) => pairwiseAgreement(row, column))
      ),
    },
    pair:
      options.pair === undefined
        ? null
        : pairedComparison(arms, options.pair, bars),
    runCount: runs.length,
    truncated,
  };
};
