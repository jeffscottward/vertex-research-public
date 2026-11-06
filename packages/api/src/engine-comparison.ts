// Engine comparison helpers: the timing of a TypeScript engine call, the compact TypeScript side
// of a comparison run, the differences between a Nautilus result and that side (with the parity
// tolerances of docs/vertex-rebuild/nautilus-backtest-engine.md), and the queue that stores one
// Nautilus backtest run per TypeScript result (spec.comparison) for the research worker. Pure
// apart from the repository it is given; no oRPC server code, so research-only modules such as
// the Autopilot runner may use it. Research only.

import type {
  BacktestRunRecord,
  BacktestRunsRepository,
} from "@darkfactory/db/server";

import { BACKTEST_RUN_NAUTILUS_ENGINE } from "./contracts/backtest-runs.ts";
import { canonicalJson, sha256Hex } from "./canonical-json.ts";
import {
  ENGINE_COMPARISON_REUSE_MS,
  ENGINE_COMPARISON_SUPERSEDED_ERROR,
  ENGINE_COMPARISON_TOLERANCES,
  ENGINE_COMPARISON_TRADES_MAX,
  type EngineComparisonFeature,
  type EngineComparisonSpec,
  type EngineComparisonTrade,
  type EngineDifferences,
  TIMER_FROZEN_NOTE,
} from "./contracts/engine-comparison.ts";
import type {
  InstantRunResult,
  InstantStats,
  InstantTrade,
} from "./instant-backtest-engine.ts";

export type WallTime = Readonly<{ wallMs: number | null; wallNote?: string }>;

/**
 * Runs `work` and returns its result with the wall time from `clock`. A Worker runtime does not
 * advance its clock during pure compute, so a zero (or negative) time is recorded as null with a
 * note instead of a fake 0.
 */
export const measureWall = <T>(
  clock: () => number,
  work: () => T
): Readonly<{ value: T }> & WallTime => {
  const started = clock();
  const value = work();
  const elapsed = clock() - started;
  return elapsed > 0
    ? { value, wallMs: elapsed }
    : { value, wallMs: null, wallNote: TIMER_FROZEN_NOTE };
};

/** Trades as [entry bar, exit bar, exit reason], at most ENGINE_COMPARISON_TRADES_MAX. */
export const compactTrades = (
  trades: readonly Pick<
    InstantTrade,
    "entryIndex" | "exitIndex" | "exitReason"
  >[]
): EngineComparisonTrade[] =>
  trades
    .slice(0, ENGINE_COMPARISON_TRADES_MAX)
    .map((trade) => [trade.entryIndex, trade.exitIndex, trade.exitReason]);

/** The TypeScript side of a comparison run. */
export const typescriptSide = (
  result: Pick<InstantRunResult, "stats" | "trades">,
  wall: WallTime,
  host: string
): EngineComparisonSpec["typescript"] => ({
  host,
  stats: { ...result.stats },
  tradeCount: result.trades.length,
  trades: compactTrades(result.trades),
  wallMs: wall.wallMs,
  ...(wall.wallNote === undefined ? {} : { wallNote: wall.wallNote }),
});

type Item = EngineDifferences["items"][number];

const statDifference = (
  field: "maxDrawdown" | "sharpe" | "totalReturn",
  typescript: number | null,
  nautilus: number | null
): Item | null => {
  const tolerance = ENGINE_COMPARISON_TOLERANCES[field];
  if (typescript === null || nautilus === null)
    return typescript === nautilus
      ? null
      : {
          detail: `${field} is ${typescript === null ? "missing" : "present"} in TypeScript and ${nautilus === null ? "missing" : "present"} in Nautilus`,
          field,
          nautilus,
          typescript,
        };
  const difference = Math.abs(typescript - nautilus);
  return difference <= tolerance
    ? null
    : {
        detail: `|difference| ${difference.toExponential(2)} is above the tolerance ${tolerance}`,
        field,
        nautilus,
        typescript,
      };
};

const tradeText = (trade: EngineComparisonTrade): string =>
  `${trade[0]}->${trade[1]} ${trade[2]}`;

/** The first trade that differs in entry bar, exit bar or exit reason, among the kept trades. */
const sequenceDifference = (
  typescript: readonly EngineComparisonTrade[],
  nautilus: readonly EngineComparisonTrade[]
): Item | null => {
  const shared = Math.min(typescript.length, nautilus.length);
  for (let index = 0; index < shared; index += 1) {
    const left = typescript[index] as EngineComparisonTrade;
    const right = nautilus[index] as EngineComparisonTrade;
    if (left[0] !== right[0] || left[1] !== right[1] || left[2] !== right[2])
      return {
        detail: `Trade ${index + 1} differs (entry bar, exit bar, exit reason)`,
        field: "trades",
        nautilus: tradeText(right),
        typescript: tradeText(left),
      };
  }
  return null;
};

/** Differences between a Nautilus result and the TypeScript side it repeats. */
export const compareEngineResults = (
  typescript: EngineComparisonSpec["typescript"],
  nautilus: Readonly<{
    stats: InstantStats;
    trades: readonly Pick<
      InstantTrade,
      "entryIndex" | "exitIndex" | "exitReason"
    >[];
  }>
): EngineDifferences => {
  const items: Item[] = [];
  if (typescript.tradeCount !== nautilus.trades.length)
    items.push({
      detail: "The engines made a different number of trades",
      field: "tradeCount",
      nautilus: nautilus.trades.length,
      typescript: typescript.tradeCount,
    });
  const sequence = sequenceDifference(
    typescript.trades,
    compactTrades(nautilus.trades)
  );
  if (sequence !== null) items.push(sequence);
  for (const field of ["totalReturn", "sharpe", "maxDrawdown"] as const) {
    const item = statDifference(
      field,
      typescript.stats[field],
      nautilus.stats[field]
    );
    if (item !== null) items.push(item);
  }
  return { items, ok: items.length === 0 };
};

/** A run spec without the comparison part. */
export type ComparisonBaseSpec = Omit<BacktestRunRecord["spec"], "comparison">;

/** One TypeScript result to repeat on Nautilus. */
export type ComparisonRunInput = Readonly<{
  label: string;
  key?: string;
  spec: ComparisonBaseSpec;
  typescript: EngineComparisonSpec["typescript"];
}>;

/** What enqueue did: the group, whether an identical live group was reused, runs superseded. */
export type ComparisonEnqueued = Readonly<{
  groupId: string;
  reused: boolean;
  superseded: number;
}>;

export type ComparisonQueue = Readonly<{
  /** VERTEX_HOST_LABEL: where the TypeScript engine ran. */
  host: string;
  /**
   * Stores the runs of one group. With `latest` (instant backtest and sweep, which run again on
   * every form change): an identical request whose group has a live run from the last
   * ENGINE_COMPARISON_REUSE_MS queues nothing new, and queued runs of the same feature and
   * requester in other groups fail as superseded.
   */
  enqueue: (
    input: Readonly<{
      feature: EngineComparisonFeature;
      /** A content hash (comparisonGroupId) or a stable group (an Autopilot campaign). */
      groupId: string;
      runs: readonly ComparisonRunInput[];
      /** Runs of this request that the cap left out. */
      dropped?: number;
      latest?: boolean;
    }>
  ) => Promise<ComparisonEnqueued>;
}>;

/** The group id of a request: the feature and a SHA-256 of its canonical content. */
export const comparisonGroupId = async (
  feature: EngineComparisonFeature,
  content: unknown
): Promise<string> =>
  `${feature}-${(await sha256Hex(canonicalJson({ content, feature }))).slice(0, 32)}`;

export const createComparisonQueue = (
  runs: Pick<BacktestRunsRepository, "enqueueGroup">,
  host: string,
  requestedBy: string,
  now: () => number = () => Date.now()
): ComparisonQueue => ({
  enqueue: async (input) => {
    const { groupId } = input;
    const latest = input.latest === true;
    const stored = await runs.enqueueGroup({
      groupId,
      ...(latest
        ? { reuseSince: new Date(now() - ENGINE_COMPARISON_REUSE_MS) }
        : {}),
      runs: input.runs.map((run) => ({
        engineVersion: BACKTEST_RUN_NAUTILUS_ENGINE,
        requestedBy,
        spec: {
          ...run.spec,
          comparison: {
            feature: input.feature,
            groupId,
            label: run.label.slice(0, 200),
            typescript: run.typescript,
            ...(run.key === undefined ? {} : { key: run.key }),
            ...(input.dropped === undefined || input.dropped === 0
              ? {}
              : { dropped: input.dropped }),
          },
        },
        strategyId: null,
        strategyRevision: null,
        strategySnapshot: null,
      })),
      supersededError: ENGINE_COMPARISON_SUPERSEDED_ERROR,
      ...(latest
        ? {
            supersede: {
              engineVersion: BACKTEST_RUN_NAUTILUS_ENGINE,
              feature: input.feature,
              requestedBy,
            },
          }
        : {}),
    });
    return { groupId, reused: stored.reused, superseded: stored.superseded };
  },
  host,
});

/** UTC calendar date of an epoch-millisecond bar time. */
export const barDate = (t: number): string =>
  new Date(t).toISOString().slice(0, 10);
