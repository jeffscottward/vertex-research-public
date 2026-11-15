import type { AutopilotCampaignRecord } from "@darkfactory/db/server";

import { splitIndex } from "../autopilot-gate.ts";
import { sliceColumnsByDate } from "../bar-slice.ts";
import { BACKTEST_RUN_DEFAULT_CAPITAL } from "../contracts/backtest-runs.ts";
import { ENGINE_COMPARISON_GATE_RUNS_MAX } from "../contracts/engine-comparison.ts";
import {
  barDate,
  type ComparisonQueue,
  type ComparisonRunInput,
  measureWall,
  typescriptSide,
} from "../engine-comparison.ts";
import type { BarColumns } from "../instant-backtest-engine.ts";
import type { StrategyDefinition } from "../strategy-dsl.ts";
import {
  runStrategyDefinition,
  type SectorQuadrantSeries,
  type StrategySeriesInput,
} from "../strategy-dsl-compile.ts";

// Autopilot gate shadow runs (engine comparison). For each candidate a tick gated, the gate's two
// engine calls become Nautilus runs: the in-sample slice and the full run whose tail is the
// out-of-sample part. Each slice is a date range, so the TypeScript side is computed on exactly
// the bars of that date range (for daily bars the same bars as the gate's call). At most
// ENGINE_COMPARISON_GATE_RUNS_MAX runs per tick; the runs record how many the cap left out.
// Candidates whose filters read daily series run with the campaign's series input here; the
// Nautilus claim loads the same series from the store for its repeat.
// The group is the campaign. A failure here never changes the tick. Research only.

export type GatedCandidate = Readonly<{
  id: string;
  definition: StrategyDefinition;
}>;

export type GateComparisonResult = Readonly<{
  queued: number;
  dropped: number;
  error?: string;
}>;

type Slice = Readonly<{ label: string; from: string; to: string }>;

const slicesOf = (bars: BarColumns): readonly Slice[] => {
  const end = splitIndex(bars.c.length);
  const first = barDate(bars.t[0] as number);
  const last = barDate(bars.t.at(-1) as number);
  const oosFrom = barDate(bars.t[end] as number);
  return [
    {
      from: first,
      label: "in-sample",
      to: barDate(bars.t[end - 1] as number),
    },
    {
      from: first,
      label: `full run (out-of-sample from ${oosFrom})`,
      to: last,
    },
  ];
};

/** Queues the shadow runs of the gated candidates of one tick. */
export const queueGateComparisons = async (
  input: Readonly<{
    queue: ComparisonQueue;
    campaign: AutopilotCampaignRecord;
    costBps: number;
    bars: BarColumns;
    sectorQuadrants: SectorQuadrantSeries | undefined;
    /** Daily series of the campaign filters; undefined when they read none. */
    series?: StrategySeriesInput | undefined;
    candidates: readonly GatedCandidate[];
    clock: () => number;
  }>
): Promise<GateComparisonResult> => {
  const slices = slicesOf(input.bars);
  const planned = input.candidates.flatMap((candidate) =>
    slices.map((slice) => ({ candidate, slice }))
  );
  const kept = planned.slice(0, ENGINE_COMPARISON_GATE_RUNS_MAX);
  const dropped = planned.length - kept.length;
  if (kept.length === 0) return { dropped, queued: 0 };
  try {
    const runs: ComparisonRunInput[] = kept.map(({ candidate, slice }) => {
      const bars = sliceColumnsByDate(input.bars, slice.from, slice.to);
      const measured = measureWall(input.clock, () =>
        runStrategyDefinition(
          bars,
          candidate.definition,
          input.costBps,
          undefined,
          input.sectorQuadrants,
          undefined,
          input.series === undefined ? {} : { series: true },
          input.series
        )
      );
      return {
        key: candidate.id,
        label: `${candidate.definition.name}: ${slice.label}`,
        spec: {
          costBps: input.costBps,
          from: slice.from,
          initialCapital: BACKTEST_RUN_DEFAULT_CAPITAL,
          rule: {
            definition: candidate.definition as unknown as Record<
              string,
              unknown
            >,
            kind: "dsl",
          },
          stopLossPct: 0,
          symbol: input.campaign.symbol,
          takeProfitPct: 0,
          timeframe: input.campaign.timeframe as "1d" | "1m",
          to: slice.to,
        },
        typescript: typescriptSide(measured.value, measured, input.queue.host),
      };
    });
    await input.queue.enqueue({
      dropped,
      feature: "autopilotGate",
      groupId: `autopilot:${input.campaign.id}`,
      runs,
    });
    return { dropped, queued: runs.length };
  } catch {
    return {
      dropped,
      error: "Nautilus gate comparison could not be queued",
      queued: 0,
    };
  }
};
