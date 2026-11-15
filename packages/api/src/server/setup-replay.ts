import type {
  MarketBarColumns,
  MarketBarSeries,
  MarketBarsRepository,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import { BACKTEST_RUN_DEFAULT_CAPITAL } from "../contracts/backtest-runs.ts";
import type { EngineComparisonTiming } from "../contracts/engine-comparison.ts";
import type { SetupReplayRunInput } from "../contracts/setup-replay.ts";
import {
  barDate,
  comparisonGroupId,
  measureWall,
  typescriptSide,
  type WallTime,
} from "../engine-comparison.ts";
import { InstantBacktestInputError } from "../instant-backtest-engine.ts";
import {
  runSetupReplay,
  type SetupReplayEngineRun,
  type SetupReplayResult,
  setupReplayEngineRun,
  setupReplayPresetList,
} from "../setup-replay.ts";
import type { ApiContext } from "./context.ts";
import { comparisonQueueFor } from "./engine-comparison.ts";
import { COMPARISON_QUEUE_ERROR, columnsFor } from "./instant-backtest.ts";
import { requireOperator } from "./operator-access.ts";

// Setup replay procedures: stored daily bars through the shared instant backtest column cache, then
// the pure replay. Same operator gate as the instant backtest. With engine comparison on, the same
// engine run repeats on Nautilus (dual run, owner decision 2026-11-08); the replay answer stays the
// TypeScript one. Research only; no order path.

/**
 * Queues the setup replay engine run on Nautilus when engine comparison is on: the setup's DSL
 * definition with no costs and the time exit, over the whole daily series. Returns the timing for
 * the answer, or undefined when off. A queue failure never changes the replay.
 */
const queueSetupReplayComparison = async (
  context: ApiContext & Readonly<{ principal: { userId: string } }>,
  input: SetupReplayRunInput,
  series: MarketBarSeries,
  columns: MarketBarColumns,
  engineRun: SetupReplayEngineRun,
  wall: WallTime
): Promise<EngineComparisonTiming | undefined> => {
  const queue = comparisonQueueFor(context, context.principal.userId);
  if (queue === null) return undefined;
  const timing = { host: queue.host, ...wall };
  const spec = {
    costBps: 0,
    from: barDate(columns.t[0] as number),
    initialCapital: BACKTEST_RUN_DEFAULT_CAPITAL,
    maxHoldBars: input.maxHoldBars,
    rule: { definition: engineRun.definition, kind: "dsl" as const },
    stopLossPct: 0,
    symbol: series.symbol,
    takeProfitPct: 0,
    timeframe: series.timeframe,
    to: barDate(columns.t.at(-1) as number),
  };
  try {
    // As the instant backtest: an identical replay reuses its group; a new one replaces the older
    // queued setup replay runs of this user.
    const enqueued = await queue.enqueue({
      feature: "setupReplay",
      groupId: await comparisonGroupId("setupReplay", {
        seriesSha256: series.sourceSha256,
        spec,
      }),
      latest: true,
      runs: [
        {
          label: `${series.symbol} 1d setup ${input.setup}`,
          spec,
          typescript: typescriptSide(engineRun.result, wall, queue.host),
        },
      ],
    });
    return { ...timing, ...enqueued };
  } catch {
    return { ...timing, error: COMPARISON_QUEUE_ERROR, groupId: null };
  }
};

type SetupReplayErrorFactories = Readonly<{
  NOT_FOUND: () => Error;
  BAD_REQUEST: (options?: { message?: string }) => Error;
  STORAGE_ERROR: () => Error;
}>;

const api = implement(appContract).$context<ApiContext>();

const setupReplayPresets = api.setupReplay.presets
  .use(requireOperator)
  .handler(() => ({ presets: setupReplayPresetList() }));

const setupReplayRun = api.setupReplay.run
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as SetupReplayErrorFactories;
    const repository: MarketBarsRepository | undefined =
      context.repositories.marketBars;
    if (repository === undefined) throw failures.STORAGE_ERROR();
    // The id is `SYMBOL:1d` (validated by the contract).
    const symbol = input.seriesId.slice(0, -":1d".length);
    let series: MarketBarSeries | null;
    try {
      series = await repository.getSeries(symbol, "1d");
    } catch {
      throw failures.STORAGE_ERROR();
    }
    if (series === null) throw failures.NOT_FOUND();
    let columns: MarketBarColumns;
    try {
      ({ columns } = await columnsFor(repository, series));
    } catch {
      throw failures.STORAGE_ERROR();
    }
    let result: SetupReplayResult;
    let engineRun: ReturnType<typeof measureWall<SetupReplayEngineRun>>;
    try {
      engineRun = measureWall(
        () => performance.now(),
        () => setupReplayEngineRun(columns, input)
      );
      result = runSetupReplay(
        columns,
        input,
        `${series.id}|${series.sourceSha256}|${series.barCount}`,
        engineRun.value
      );
    } catch (error) {
      if (error instanceof InstantBacktestInputError) {
        throw failures.BAD_REQUEST({ message: error.message });
      }
      throw error;
    }
    const comparison = await queueSetupReplayComparison(
      context,
      input,
      series,
      columns,
      engineRun.value,
      {
        wallMs: engineRun.wallMs,
        ...(engineRun.wallNote === undefined
          ? {}
          : { wallNote: engineRun.wallNote }),
      }
    );
    return {
      ...result,
      ...(comparison === undefined ? {} : { comparison }),
      series: {
        bars: series.barCount,
        from: new Date(series.firstT).toISOString().slice(0, 10),
        id: input.seriesId,
        symbol: series.symbol,
        to: new Date(series.lastT).toISOString().slice(0, 10),
      },
    };
  });

export const setupReplayRouter = {
  presets: setupReplayPresets,
  run: setupReplayRun,
};
