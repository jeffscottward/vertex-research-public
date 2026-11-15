import type {
  BacktestRunsRepository,
  ForwardDriftRepository,
  MarketBarColumns,
  MarketBarsRepository,
} from "@darkfactory/db/server";

import type { BacktestRunReportOutput } from "../contracts/backtest-runs.ts";
import {
  FORWARD_DRIFT_RECORD_MAX,
  type PaperForwardTickResult,
} from "../contracts/forward-drift.ts";
import {
  barDate,
  type ComparisonQueue,
  measureWall,
  typescriptSide,
  type WallTime,
} from "../engine-comparison.ts";
import {
  type InstantRunResult,
  InstantBacktestInputError,
} from "../instant-backtest-engine.ts";
import { paperForwardStep } from "../paper-forward.ts";
import { runParamsForSpec } from "./backtest-run-params.ts";
import { appendObservations, baselineOf } from "./forward-drift-append.ts";

// Paper forward runner. One tick loads the stored bars of the baseline run's series (read-only
// history path), runs the baseline strategy from the run's start date to the newest bar, and
// appends the settled paper points and closed trades after the forward start (the day after the
// run's end date) to the drift monitor, which evaluates drift and raises alerts. Fills are
// simulated by the backtest engine with the run's cost settings. With engine comparison on, a tick
// that caught up with the newest bar also queues the same engine run on Nautilus (dual run, owner
// decision 2026-11-08); the paper results stay the TypeScript ones. There is no broker client,
// order path or network call here; a guard test checks the import graph.

const DAY_MS = 86_400_000;

export type PaperForwardDependencies = Readonly<{
  drift: ForwardDriftRepository;
  runs: BacktestRunsRepository;
  marketBars: MarketBarsRepository;
  /** Engine comparison queue (null or absent: off). */
  comparison?: ComparisonQueue | null;
}>;

type StoredSpec = NonNullable<
  Awaited<ReturnType<BacktestRunsRepository["get"]>>
>["spec"];

/**
 * Queues the tick's engine run on Nautilus: the baseline spec over the same bars (its start to the
 * newest bar), one group per monitor and newest bar. No `latest`: other monitors of the same batch
 * share the feature and the requester, so superseding would cancel their runs. A queue failure is
 * ignored; the paper results never depend on it.
 */
const queuePaperForwardComparison = async (
  queue: ComparisonQueue,
  monitorId: string,
  spec: StoredSpec,
  bars: MarketBarColumns,
  run: InstantRunResult,
  wall: WallTime
): Promise<void> => {
  const { comparison: _comparison, ...base } = spec;
  const to = barDate(bars.t.at(-1) as number);
  try {
    await queue.enqueue({
      feature: "paperForward",
      groupId: `paperForward:${monitorId}:${to}`,
      runs: [
        {
          key: monitorId,
          label: `${spec.symbol} ${spec.timeframe} paper forward ${spec.rule.kind}`,
          spec: { ...base, from: barDate(bars.t[0] as number), to },
          typescript: typescriptSide(run, wall, queue.host),
        },
      ],
    });
  } catch {
    // The comparison is optional; the tick result stands.
  }
};

const result = (
  monitorId: string,
  note: string | null,
  counts: Readonly<{ points: number; trades: number; raised: number }> = {
    points: 0,
    raised: 0,
    trades: 0,
  }
): PaperForwardTickResult => ({
  monitorId,
  newPoints: counts.points,
  newTrades: counts.trades,
  note,
  raised: counts.raised,
});

const sliceFrom = (
  columns: MarketBarColumns,
  start: number
): MarketBarColumns => {
  let first = 0;
  while (first < columns.t.length && (columns.t[first] as number) < start)
    first += 1;
  return {
    c: columns.c.slice(first),
    h: columns.h.slice(first),
    l: columns.l.slice(first),
    o: columns.o.slice(first),
    t: columns.t.slice(first),
  };
};

/** Note text for an unexpected tick failure; only engine input errors are shown in full. */
const tickFailureNote = (error: unknown): string =>
  error instanceof InstantBacktestInputError
    ? `Tick failed: ${error.message}`
    : "Tick failed; the next tick retries";

/**
 * Ticks one monitor of a scheduler batch. A failure is noted on that monitor and returned as its
 * result, so one failing monitor never stops the rest of the batch.
 */
export const tickPaperForwardInBatch = async (
  dependencies: PaperForwardDependencies,
  monitorId: string
): Promise<PaperForwardTickResult | null> => {
  try {
    return await tickPaperForward(dependencies, monitorId);
  } catch (error) {
    const note = tickFailureNote(error);
    try {
      await dependencies.drift.notePaperTick(monitorId, note);
    } catch {
      // The storage failure is reported in the result; the batch continues.
    }
    return result(monitorId, note);
  }
};

/**
 * Runs one paper tick for one monitor and records its outcome note. Returns a result with a
 * note instead of throwing for expected problems (missing bars, storage full, conflicts).
 */
export const tickPaperForward = async (
  dependencies: PaperForwardDependencies,
  monitorId: string
): Promise<PaperForwardTickResult | null> => {
  const monitor = await dependencies.drift.get(monitorId);
  if (monitor === null) return null;
  const finish = async (
    note: string | null,
    counts?: Readonly<{ points: number; trades: number; raised: number }>
  ) => {
    await dependencies.drift.notePaperTick(monitorId, note);
    return result(monitorId, note, counts);
  };
  const run = await dependencies.runs.get(monitor.baselineRunId);
  if (run === null || run.status !== "succeeded" || run.report === null)
    return finish("The baseline backtest run is not available");
  const { spec } = run;
  const series = await dependencies.marketBars.getSeries(
    spec.symbol,
    spec.timeframe
  );
  if (series === null)
    return finish(`No stored ${spec.timeframe} bars for ${spec.symbol}`);
  const columns = await dependencies.marketBars.loadColumns(series.id);
  const bars = sliceFrom(columns, Date.parse(`${spec.from}T00:00:00Z`));
  const measured = measureWall(
    () => performance.now(),
    () =>
      paperForwardStep(bars, runParamsForSpec(spec), {
        afterPointT: monitor.points.at(-1)?.t ?? Number.NEGATIVE_INFINITY,
        afterTradeT: monitor.trades.at(-1)?.t ?? Number.NEGATIVE_INFINITY,
        capital: spec.initialCapital,
        forwardStartT: Date.parse(`${spec.to}T00:00:00Z`) + DAY_MS,
      })
  );
  const step = measured.value;
  // A long gap is recorded over several ticks, oldest first, within the request limit.
  const points = step.points.slice(0, FORWARD_DRIFT_RECORD_MAX);
  const pointsEnd = points.at(-1)?.t ?? Number.POSITIVE_INFINITY;
  const trades = step.trades
    .filter((trade) => trade.t <= pointsEnd)
    .slice(0, FORWARD_DRIFT_RECORD_MAX);
  if (points.length === 0 && trades.length === 0)
    return finish("No new settled bars after the forward start");
  const outcome = await appendObservations(
    dependencies.drift,
    monitor,
    baselineOf(run.report as BacktestRunReportOutput),
    { points, trades }
  );
  // Another tick or recording saved first and wrote its own outcome; keep that note.
  if (outcome.kind === "conflict")
    return result(
      monitorId,
      "The monitor changed during the tick; the next tick retries"
    );
  if (outcome.kind === "rejected") {
    await dependencies.drift.setPaperStatus(monitorId, "off");
    return finish(`Stopped: ${outcome.message}`);
  }
  const more =
    step.points.length > points.length || step.trades.length > trades.length;
  // Once per newest bar: a tick that recorded only part of the bars leaves the queueing to the
  // tick that catches up. `step.run` is set here (new points need at least 2 bars).
  if (!more && dependencies.comparison)
    await queuePaperForwardComparison(
      dependencies.comparison,
      monitorId,
      spec,
      bars,
      step.run as InstantRunResult,
      {
        wallMs: measured.wallMs,
        ...(measured.wallNote === undefined
          ? {}
          : { wallNote: measured.wallNote }),
      }
    );
  return finish(
    more ? "Recorded part of the new bars; the next tick continues" : null,
    {
      points: points.length,
      raised: outcome.alerts.length,
      trades: trades.length,
    }
  );
};
