import type {
  MarketBarColumns,
  MarketBarSeries,
  MarketBarsRepository,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import { InstantBacktestInputError } from "../instant-backtest-engine.ts";
import {
  runSetupReplay,
  type SetupReplayResult,
  setupReplayPresetList,
} from "../setup-replay.ts";
import type { ApiContext } from "./context.ts";
import { columnsFor } from "./instant-backtest.ts";
import { requireOperator } from "./operator-access.ts";

// Setup replay procedures: stored daily bars through the shared instant backtest column cache, then
// the pure replay. Same operator gate as the instant backtest. Research only; no order path.

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
    try {
      result = runSetupReplay(
        columns,
        input,
        `${series.id}|${series.sourceSha256}|${series.barCount}`
      );
    } catch (error) {
      if (error instanceof InstantBacktestInputError) {
        throw failures.BAD_REQUEST({ message: error.message });
      }
      throw error;
    }
    return {
      ...result,
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
