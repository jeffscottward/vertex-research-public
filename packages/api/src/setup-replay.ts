import { createRandom, monteCarlo, seedFrom } from "./backtest-analytics.ts";
import {
  SETUP_REPLAY_MAX_OCCURRENCES,
  SETUP_REPLAY_SETUP_IDS,
  type SetupReplayMonteCarlo,
  type SetupReplayOccurrence,
  type SetupReplayPreset,
  type SetupReplayRunInput,
  type SetupReplaySetupId,
  type SetupReplaySummary,
} from "./contracts/setup-replay.ts";
import {
  type BarColumns,
  type InstantRunResult,
  type InstantTrade,
  runSignalBacktest,
} from "./instant-backtest-engine.ts";
import {
  type StrategyDefinition,
  type StrategyDefinitionInput,
  StrategyDefinitionSchema,
} from "./strategy-dsl.ts";
import { compileStrategy } from "./strategy-dsl-compile.ts";

// Setup replay ("time machine", idea from trader-timemachine in Jake Schincariol's day-trader-skill,
// MIT): one long-only daily setup, written as a strategy DSL entry rule, runs through the instant
// backtest engine over a stored daily series. Each engine trade is one occurrence: the stop and
// target are ATR distances read at the signal bar, the target is targetR times the stop distance,
// and a time exit fills at the next open after maxHoldBars bars. No costs, so outcomes are pure
// price. A seeded bootstrap Monte Carlo resamples the realized outcomes. Research only; no orders.

/** ATR length for the stop distance. */
const SETUP_REPLAY_ATR_LENGTH = 14;

type EntryRule = StrategyDefinitionInput["entry"]["all"];

const close = { field: "close", type: "price" } as const;
const open = { field: "open", type: "price" } as const;
const sma = (length: number, offset?: number) =>
  ({
    length,
    name: "sma",
    type: "indicator",
    ...(offset === undefined ? {} : { offset }),
  }) as const;

/** The preset table: one DSL entry rule per setup. Entries fill at the next open. */
export const SETUP_REPLAY_PRESETS: Readonly<
  Record<
    SetupReplaySetupId,
    Omit<SetupReplayPreset, "id"> & { entry: EntryRule }
  >
> = {
  breakout20: {
    description:
      "The close moves above the highest high of the previous 20 days (first day only).",
    entry: [
      {
        left: close,
        op: "crossesAbove",
        right: {
          length: 20,
          name: "highest",
          offset: 1,
          source: "high",
          type: "indicator",
        },
      },
    ],
    label: "20-day breakout",
  },
  gapUpHold: {
    description:
      "The day opens above the previous day's high and closes above its own open.",
    entry: [
      {
        left: open,
        op: ">",
        right: { field: "high", offset: 1, type: "price" },
      },
      { left: close, op: ">", right: open },
    ],
    label: "Gap up and hold",
  },
  reclaim50: {
    description:
      "After a pullback, the close moves back above a rising 50-day average.",
    entry: [
      { left: close, op: "crossesAbove", right: sma(50) },
      { left: sma(50), op: ">", right: sma(50, 10) },
    ],
    label: "50-day average reclaim",
  },
  rsi2Oversold: {
    description:
      "2-day RSI below 10 while the close is above the 200-day average: a dip in an uptrend.",
    entry: [
      {
        left: { length: 2, name: "rsi", type: "indicator" },
        op: "<",
        right: { type: "const", value: 10 },
      },
      { left: close, op: ">", right: sma(200) },
    ],
    label: "RSI(2) oversold bounce",
  },
};

/** Presets in the contract's order, without their rules. */
export const setupReplayPresetList = (): SetupReplayPreset[] =>
  SETUP_REPLAY_SETUP_IDS.map((id) => ({
    description: SETUP_REPLAY_PRESETS[id].description,
    id,
    label: SETUP_REPLAY_PRESETS[id].label,
  }));

export type SetupReplayParams = Pick<
  SetupReplayRunInput,
  "setup" | "stop" | "targetR" | "maxHoldBars" | "paths"
>;

/** The validated DSL strategy for one setup with an ATR stop and a target at targetR times the stop. */
export const setupReplayDefinition = (
  params: Pick<SetupReplayParams, "setup" | "stop" | "targetR">
): StrategyDefinition => {
  const preset = SETUP_REPLAY_PRESETS[params.setup];
  return StrategyDefinitionSchema.parse({
    description: preset.description,
    entry: { all: preset.entry },
    name: `Setup replay: ${preset.label}`,
    stopLoss: {
      kind: "atr",
      length: SETUP_REPLAY_ATR_LENGTH,
      multiple: params.stop.multiple,
    },
    takeProfit: {
      kind: "atr",
      length: SETUP_REPLAY_ATR_LENGTH,
      multiple: params.stop.multiple * params.targetR,
    },
    version: 1,
  });
};

// A trade still open when the data ends ("end") has no outcome yet; runSetupReplay drops it.
const OUTCOMES: Readonly<
  Record<
    Exclude<InstantTrade["exitReason"], "end">,
    SetupReplayOccurrence["outcome"]
  >
> = {
  // Setup replays pass no closeAt mask; a market-on-close exit would be a time exit.
  sessionClose: "time",
  signal: "time",
  stop: "stop",
  target: "target",
};

const mean = (values: readonly number[]): number | null =>
  values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const summarizeOccurrences = (
  occurrences: readonly SetupReplayOccurrence[],
  targetR: number
): SetupReplaySummary => {
  const count = (outcome: SetupReplayOccurrence["outcome"]) =>
    occurrences.filter((entry) => entry.outcome === outcome).length;
  const targetFirst = count("target");
  const stopFirst = count("stop");
  const decided = targetFirst + stopFirst;
  const empty = occurrences.length === 0;
  return {
    avgR: mean(occurrences.map((entry) => entry.rMultiple)),
    breakEvenShare: 1 / (1 + targetR),
    count: occurrences.length,
    expectancyR: mean(
      occurrences.map((entry) =>
        entry.outcome === "target"
          ? targetR
          : entry.outcome === "stop"
            ? -1
            : entry.rMultiple
      )
    ),
    stopFirst,
    targetFirst,
    targetShare: decided === 0 ? null : targetFirst / decided,
    timeExit: count("time"),
    winRate: empty
      ? null
      : occurrences.filter((entry) => entry.rMultiple > 0).length /
        occurrences.length,
  };
};

/**
 * Bootstrap over the realized outcomes: each path draws `occurrences.length` of them with
 * replacement. R and compounded return use the same seed, so path k draws the same trades in both.
 */
const setupReplayMonteCarlo = (
  occurrences: readonly SetupReplayOccurrence[],
  paths: SetupReplayParams["paths"],
  seed: number
): SetupReplayMonteCarlo | null => {
  if (occurrences.length === 0) return null;
  const totalR = monteCarlo(
    occurrences.map((entry) => entry.rMultiple),
    1,
    "bootstrap",
    createRandom(seed),
    paths
  );
  // Summed log growth, mapped back to a compounded percent return.
  const growth = monteCarlo(
    occurrences.map((entry) => Math.log1p(entry.returnPct / 100)),
    1,
    "bootstrap",
    createRandom(seed),
    paths
  ).finalPnl;
  const toPct = (value: number) => Math.expm1(value) * 100;
  return {
    paths,
    pProfit: totalR.probabilityOfProfit,
    seed,
    totalR: totalR.finalPnl,
    totalReturnPct: {
      p5: toPct(growth.p5),
      p25: toPct(growth.p25),
      p50: toPct(growth.p50),
      p75: toPct(growth.p75),
      p95: toPct(growth.p95),
    },
    tradesPerPath: occurrences.length,
  };
};

export type SetupReplayResult = Readonly<{
  /** Newest first, at most SETUP_REPLAY_MAX_OCCURRENCES. */
  occurrences: SetupReplayOccurrence[];
  summary: SetupReplaySummary;
  monteCarlo: SetupReplayMonteCarlo | null;
}>;

/** The engine run of one setup replay: the DSL definition, its stop distances and the run. */
export type SetupReplayEngineRun = Readonly<{
  definition: StrategyDefinition;
  stopDistance: Float64Array;
  result: InstantRunResult;
}>;

/**
 * Runs one setup over the bars: the definition's ATR stop and target, no costs, and a time exit
 * after `maxHoldBars`. The same run as runStrategyDefinition(bars, definition, 0, undefined,
 * undefined, undefined, undefined, undefined, maxHoldBars), which the engine comparison repeats on Nautilus. Throws
 * InstantBacktestInputError when the series is too short for the setup's indicators.
 */
export const setupReplayEngineRun = (
  bars: BarColumns,
  params: Pick<SetupReplayParams, "setup" | "stop" | "targetR" | "maxHoldBars">
): SetupReplayEngineRun => {
  const definition = setupReplayDefinition(params);
  const compiled = compileStrategy(bars, definition);
  // Both levels are ATR distances, so the compiler always returns them.
  const stopDistance = compiled.stopDistance as Float64Array;
  const result = runSignalBacktest(bars, compiled.signals, {
    costBps: 0,
    exits: compiled.exits,
    maxHoldBars: params.maxHoldBars,
    stopDistance,
    stopLossPct: 0,
    takeProfitPct: 0,
    targetDistance: compiled.targetDistance as Float64Array,
  });
  return { definition, result, stopDistance };
};

/**
 * Replays one setup over the bars. `dataKey` identifies the bar data (series and version); with the
 * parameters it fixes the Monte Carlo seed, so a rerun gives the same numbers. `engineRun` is the
 * setupReplayEngineRun of the same bars and parameters (computed here when absent). Throws
 * InstantBacktestInputError when the series is too short for the setup's indicators.
 */
export const runSetupReplay = (
  bars: BarColumns,
  params: SetupReplayParams,
  dataKey: string,
  engineRun: SetupReplayEngineRun = setupReplayEngineRun(bars, params)
): SetupReplayResult => {
  const { result, stopDistance } = engineRun;
  const occurrences = result.trades.flatMap((trade): SetupReplayOccurrence[] =>
    trade.exitReason === "end"
      ? []
      : [
          {
            // Bars the position was open through. A time exit fills at the open of the exit bar,
            // so that bar does not count; a stop or target fills inside it, so it does.
            barsHeld:
              trade.exitIndex -
              trade.entryIndex +
              (trade.exitReason === "signal" ? 0 : 1),
            entryDate: new Date(bars.t[trade.entryIndex] as number)
              .toISOString()
              .slice(0, 10),
            entryPrice: trade.entryPrice,
            exitDate: new Date(bars.t[trade.exitIndex] as number)
              .toISOString()
              .slice(0, 10),
            exitPrice: trade.exitPrice,
            outcome: OUTCOMES[trade.exitReason],
            returnPct: (trade.exitPrice / trade.entryPrice - 1) * 100,
            // The engine reads the stop distance at the signal bar, the bar before the fill.
            rMultiple:
              (trade.exitPrice - trade.entryPrice) /
              (stopDistance[trade.entryIndex - 1] as number),
          },
        ]
  );
  const seed = seedFrom(
    JSON.stringify([
      dataKey,
      params.setup,
      params.stop.multiple,
      params.targetR,
      params.maxHoldBars,
      params.paths,
    ])
  );
  return {
    monteCarlo: setupReplayMonteCarlo(occurrences, params.paths, seed),
    occurrences: occurrences.slice(-SETUP_REPLAY_MAX_OCCURRENCES).reverse(),
    summary: summarizeOccurrences(occurrences, params.targetR),
  };
};
