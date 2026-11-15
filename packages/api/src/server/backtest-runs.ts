import type {
  BacktestRunRecord,
  BacktestRunsRepository,
  MarketBarColumns,
  MarketBarSeries,
  MarketBarsRepository,
  MarketDailyColumns,
  MarketDailySeriesRepository,
} from "@darkfactory/db/server";
import { marketDailyBars } from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { COST_PROFILE_PRESETS } from "../backtest-costs.ts";
import {
  type BacktestRunReport,
  buildBacktestRunReport,
  buildOptionsRunReport,
} from "../backtest-run-report.ts";
import {
  type BacktestSweepGrid,
  runBacktestSweep,
  type SweepCellRun,
} from "../backtest-sweep.ts";
import { sweepValueCount } from "../backtest-sweep-grid.ts";
import { sliceColumnsByDate } from "../bar-slice.ts";
import { canonicalJson, sha256Hex } from "../canonical-json.ts";
import { appContract } from "../contract.ts";
import {
  BACKTEST_RUN_DEFAULT_CAPITAL,
  BACKTEST_RUN_ENGINE_VERSION,
  BACKTEST_RUN_NAUTILUS_ENGINE,
  type BacktestRun,
  type BacktestRunReportOutput,
} from "../contracts/backtest-runs.ts";
import {
  BACKTEST_SWEEP_MAX_BAR_STEPS,
  BACKTEST_SWEEP_SPIKE_RATIO,
  type BacktestSweepOutput,
  type BacktestSweepRequest,
} from "../contracts/backtest-sweep.ts";
import {
  ENGINE_COMPARISON_SWEEP_CELLS_MAX,
  TIMER_FROZEN_NOTE,
} from "../contracts/engine-comparison.ts";
import {
  type ComparisonBaseSpec,
  type ComparisonQueue,
  comparisonGroupId,
  typescriptSide,
  type WallTime,
} from "../engine-comparison.ts";
import {
  InstantBacktestInputError,
  runInstantBacktest,
} from "../instant-backtest-engine.ts";
import {
  optionsDatasetFromRows,
  optionsRunMetrics,
  type OptionsRunOutcome,
  runOptionsDefinition,
} from "../options-engine/portfolio.ts";
import { ComboInputError, combinePortfolio } from "../portfolio-combination.ts";
import {
  STRATEGY_IV_INDEX,
  type StrategyDefinition,
  StrategyDefinitionSchema,
  serverStrategyRefusal,
} from "../strategy-dsl.ts";
import {
  assertServerRunnable,
  runStrategyDefinition,
} from "../strategy-dsl-compile.ts";
import { costsForSpec, runParamsForSpec } from "./backtest-run-params.ts";
import type { ApiContext } from "./context.ts";
import { comparisonQueueFor } from "./engine-comparison.ts";
import { COMPARISON_QUEUE_ERROR, columnsFor } from "./instant-backtest.ts";
import { requireOperator } from "./operator-access.ts";
import {
  loadSectorQuadrants,
  type SectorQuadrantSource,
} from "./sector-quadrant-series.ts";
import {
  type LoadedStrategySeries,
  loadStrategySeries,
  runInputsSha256,
  type StrategySeriesLoader,
  strategySeriesInput,
} from "./strategy-series.ts";

// Backtest run procedures. submit stores a queued run. With the TypeScript engine (the default of
// VERTEX_BACKTEST_RUNS_ENGINE) it schedules the execution on the request's tracked background
// scheduler (the database connection stays open until it finishes); without a scheduler it runs
// before the response. With the Nautilus engine the run waits for the research worker
// (backtest-run-engine.ts). get re-schedules a queued TypeScript run, so a run whose scheduled task
// was lost still completes, fails runs left running longer than the stale limit, and fails a
// Nautilus run that waited longer than the same limit while no worker claimed any Nautilus run
// (a busy worker does not fail its backlog). The claim is a conditional update, so
// a run executes at most once. sweep runs a parameter grid in the request after a cells x bars
// budget check and stores nothing. Definitions that read daily series run with the series store
// rows (strategy-series.ts); options definitions run in the options runner (options-engine) on
// those rows. Research only; no order path.

const BACKTEST_RUN_STALE_MS = 10 * 60 * 1000;
export const NAUTILUS_UNCLAIMED_ERROR =
  "Nautilus backtest worker did not pick up the run";
export const BACKTEST_RUN_STORAGE_ERROR =
  "Backtest failed: bar storage or engine error";

export type Failures = Readonly<{
  NOT_FOUND: (options?: { message?: string }) => Error;
  BAD_REQUEST: (options?: { message?: string }) => Error;
  STORAGE_ERROR: () => Error;
  VALIDATION_ERROR: (options?: { message?: string }) => Error;
}>;

export type BacktestRunExecutionDependencies = Readonly<{
  runs: BacktestRunsRepository;
  marketBars: MarketBarsRepository;
  /** Stored sector rotation points for definitions with sector filters. */
  sectorRotation?: SectorQuadrantSource;
  /** Daily series store for definitions that read series and for options definitions. */
  marketDailySeries?: MarketDailySeriesRepository;
}>;

/** What backtest runs load: the options runner and the daily series. */
const BACKTEST_RUN_SUPPORT = { options: true, series: true } as const;

/**
 * Why a backtest run spec cannot run an options definition, or undefined: the options book has its
 * own costs and exits, so the run-level costs, stop and target must be off, and the run symbol
 * must be one the book trades (a portfolio member, else a symbol with an IV index).
 */
const optionsSpecProblem = (
  spec: Readonly<{
    costBps: number;
    costProfile?: unknown;
    stopLossPct: number;
    symbol: string;
    takeProfitPct: number;
  }>,
  definition: StrategyDefinition
): string | undefined => {
  if (spec.costBps !== 0 || spec.costProfile !== undefined)
    return "Options definitions charge the options book costs; set costBps to 0 and leave out costProfile.";
  if (spec.stopLossPct !== 0 || spec.takeProfitPct !== 0)
    return "Options definitions exit by the options block; set stopLossPct and takeProfitPct to 0.";
  const members: readonly string[] | undefined = definition.portfolio?.symbols;
  if (members !== undefined && !members.includes(spec.symbol))
    return `The run symbol ${spec.symbol} is not in the portfolio symbols (${members.join(", ")}).`;
  if (members === undefined && STRATEGY_IV_INDEX[spec.symbol] === undefined)
    return `Options definitions trade ${Object.keys(STRATEGY_IV_INDEX).sort().join(", ")}; ${spec.symbol} has no IV index.`;
  return undefined;
};

/**
 * Throws StrategyUnsupportedError or InstantBacktestInputError when a stored run cannot run its
 * definition (queued before the submit check, or written past it): refuse rather than run it half.
 */
const assertRunnableDefinition = (
  spec: BacktestRunRecord["spec"],
  definition: StrategyDefinition
): void => {
  assertServerRunnable(definition, spec.timeframe, BACKTEST_RUN_SUPPORT);
  const problem =
    definition.options === undefined
      ? undefined
      : optionsSpecProblem(spec, definition);
  if (problem !== undefined) throw new InstantBacktestInputError(problem);
};

export type OptionsRun = Readonly<{
  outcome: OptionsRunOutcome;
  metrics: ReturnType<typeof optionsRunMetrics>;
}>;

/**
 * Runs an options definition on its loaded store rows (TypeScript options runner: from `from` to
 * `to` with the run capital and symbol). An error of the runner (missing data, a ledger it cannot
 * book) becomes an input error with the runner's message, so the run fails with it.
 */
export const runOptionsOnRows = (
  spec: BacktestRunRecord["spec"],
  definition: StrategyDefinition,
  loaded: LoadedStrategySeries
): OptionsRun => {
  try {
    const outcome = runOptionsDefinition(
      definition,
      optionsDatasetFromRows(Object.fromEntries(loaded.rows)),
      {
        capital: spec.initialCapital,
        end: spec.to,
        start: spec.from,
        symbol: spec.symbol,
      }
    );
    return { metrics: optionsRunMetrics(outcome), outcome };
  } catch (error) {
    // A code error is not the data's: it keeps its type (the run gets the generic message).
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new InstantBacktestInputError(
      `Options run failed: ${(error as Error).message}`
    );
  }
};

/** The report of an options run; `nautilusGap` is null for the TypeScript engine. */
export const optionsRunReport = (
  spec: BacktestRunRecord["spec"],
  definition: StrategyDefinition,
  bars: MarketBarColumns,
  run: OptionsRun,
  nautilusGap: number | null
): BacktestRunReport =>
  buildOptionsRunReport({
    bars,
    ledger: run.outcome.result,
    metrics: run.metrics,
    nautilusGap,
    signals: run.outcome.signals,
    symbols: definition.portfolio?.symbols ?? [spec.symbol],
  });

/** Runs an options definition on its loaded store rows and builds the report (TypeScript engine). */
export const runOptionsBacktest = (
  spec: BacktestRunRecord["spec"],
  definition: StrategyDefinition,
  bars: MarketBarColumns,
  loaded: LoadedStrategySeries
): BacktestRunReport =>
  optionsRunReport(
    spec,
    definition,
    bars,
    runOptionsOnRows(spec, definition, loaded),
    null
  );

export type LoadedRunBars =
  | Readonly<{ bars: MarketBarColumns; series: MarketBarSeries }>
  | Readonly<{ error: string }>;

/** The stored bars of the run's date range, or the error message for the run. */
const loadRunBars = async (
  marketBars: MarketBarsRepository,
  spec: BacktestRunRecord["spec"]
): Promise<LoadedRunBars> => {
  const series = await marketBars.getSeries(spec.symbol, spec.timeframe);
  if (series === null)
    return { error: `No stored ${spec.timeframe} bars for ${spec.symbol}` };
  const loaded = await columnsFor(marketBars, series);
  const bars = sliceColumnsByDate(loaded.columns, spec.from, spec.to);
  if (bars.t.length < 2)
    return {
      error: `Fewer than 2 bars for ${spec.symbol} between ${spec.from} and ${spec.to}`,
    };
  return { bars, series };
};

/** The bars of an options run: the store row of the run symbol (bar rules), from `from` to `to`. */
export const optionsRunBars = (
  row: MarketDailyColumns,
  spec: Pick<BacktestRunRecord["spec"], "from" | "to">
): MarketBarColumns => {
  const bars = marketDailyBars(row);
  const keep = bars.dates.flatMap((date, index) =>
    date >= spec.from && date <= spec.to ? [index] : []
  );
  const column = (values: readonly number[]) =>
    Float64Array.from(keep, (index) => values[index] as number);
  return {
    c: column(bars.close),
    h: column(bars.high),
    l: column(bars.low),
    o: column(bars.open),
    t: Float64Array.from(keep, (index) =>
      Date.parse(`${bars.dates[index] as string}T00:00:00.000Z`)
    ),
  };
};

/** What a run reads: its bars, definition, daily series rows and the hash of them. */
export type RunData = Readonly<{
  bars: MarketBarColumns;
  /** The market_bars series of the run; null for options runs (bars from the series store). */
  series: MarketBarSeries | null;
  definition: StrategyDefinition | undefined;
  /** The daily series rows the definition reads; null when it reads none. */
  daily: LoadedStrategySeries | null;
  /** Hash of the bars and of the rows (runInputsSha256); options runs: the rows hash. */
  seriesSha256: string;
}>;

/**
 * Loads what a run reads, or the error message for the run. Equity runs read market_bars; an
 * options run reads the series store only (its bars are the run symbol's store row). With
 * `check`, a definition the run cannot run throws (StrategyUnsupportedError or an input error);
 * a missing series throws StrategySeriesDataError. `loadSeries` replaces the run's own series load
 * (a batch claim loads the store once for all its runs).
 */
export const loadRunData = async (
  dependencies: BacktestRunExecutionDependencies,
  spec: BacktestRunRecord["spec"],
  check: boolean,
  loadSeries?: StrategySeriesLoader
): Promise<RunData | Readonly<{ error: string }>> => {
  const definition =
    spec.rule.kind === "dsl"
      ? StrategyDefinitionSchema.parse(spec.rule.definition)
      : undefined;
  if (definition !== undefined && check)
    assertRunnableDefinition(spec, definition);
  const loadDaily = async () =>
    definition === undefined
      ? null
      : loadSeries === undefined
        ? await loadStrategySeries(
            dependencies.marketDailySeries,
            definition,
            spec.symbol,
            spec.to
          )
        : await loadSeries(definition, spec.symbol, spec.to);
  if (definition?.options !== undefined) {
    // An options definition always reads store rows, the run symbol's row among them.
    const daily = (await loadDaily()) as LoadedStrategySeries;
    const bars = optionsRunBars(
      daily.rows.get(spec.symbol) as MarketDailyColumns,
      spec
    );
    if (bars.t.length < 2)
      return {
        error: `Fewer than 2 daily series bars for ${spec.symbol} between ${spec.from} and ${spec.to}`,
      };
    return {
      bars,
      daily,
      definition,
      series: null,
      seriesSha256: daily.sha256,
    };
  }
  const loaded = await loadRunBars(dependencies.marketBars, spec);
  if ("error" in loaded) return loaded;
  const daily = await loadDaily();
  return {
    bars: loaded.bars,
    daily,
    definition,
    series: loaded.series,
    seriesSha256: await runInputsSha256(
      loaded.series.sourceSha256,
      daily?.sha256 ?? null
    ),
  };
};

export const ACADEMY_RUN_ENGINE_ERROR =
  "An Academy run needs the Nautilus research worker";

const executeClaimed = async (
  dependencies: BacktestRunExecutionDependencies,
  run: BacktestRunRecord
): Promise<void> => {
  const { spec } = run;
  if (spec.rule.kind === "academy") {
    // The Academy rule exists for comparison runs, which carry the Nautilus engine id.
    await dependencies.runs.fail(run.id, ACADEMY_RUN_ENGINE_ERROR);
    return;
  }
  const loaded = await loadRunData(dependencies, spec, true);
  if ("error" in loaded) {
    await dependencies.runs.fail(run.id, loaded.error);
    return;
  }
  const { bars, daily, definition, seriesSha256 } = loaded;
  const costs = costsForSpec(spec);
  // A definition rule carries its own stop, target and sizing; the run-level stop and target
  // apply to the fixed rules only.
  if (definition === undefined) {
    const result = runInstantBacktest(bars, runParamsForSpec(spec));
    await dependencies.runs.complete(run.id, {
      ...buildBacktestRunReport(
        bars,
        result,
        spec.initialCapital,
        costs?.profile
      ),
      seriesSha256,
    });
    return;
  }
  if (definition.options !== undefined) {
    const report = runOptionsBacktest(
      spec,
      definition,
      bars,
      daily as LoadedStrategySeries
    );
    await dependencies.runs.complete(run.id, { ...report, seriesSha256 });
    return;
  }
  const sectorQuadrants = await loadSectorQuadrants(
    dependencies.sectorRotation,
    definition,
    bars.t[0] as number
  );
  const result = runStrategyDefinition(
    bars,
    definition,
    spec.costBps,
    costs,
    sectorQuadrants,
    spec.timeframe,
    BACKTEST_RUN_SUPPORT,
    daily === null
      ? undefined
      : strategySeriesInput(definition, spec.symbol, daily.rows),
    spec.maxHoldBars
  );
  await dependencies.runs.complete(run.id, {
    ...buildBacktestRunReport(
      bars,
      result,
      spec.initialCapital,
      costs?.profile
    ),
    seriesSha256,
  });
};

/**
 * Claims and executes one queued run. Returns without work when another caller holds the claim.
 * Engine input errors become the run's error; other failures store a generic message only.
 */
export const executeBacktestRun = async (
  dependencies: BacktestRunExecutionDependencies,
  id: string
): Promise<void> => {
  const run = await dependencies.runs.claim(id);
  if (run === null) return;
  try {
    await executeClaimed(dependencies, run);
  } catch (error) {
    await dependencies.runs.fail(
      run.id,
      error instanceof InstantBacktestInputError
        ? error.message
        : BACKTEST_RUN_STORAGE_ERROR
    );
  }
};

const toOutput = (run: BacktestRunRecord): BacktestRun =>
  ({
    createdAt: run.createdAt,
    engineVersion: run.engineVersion,
    error: run.error,
    finishedAt: run.finishedAt,
    id: run.id,
    report: run.report,
    spec: run.spec,
    startedAt: run.startedAt,
    status: run.status,
    strategyId: run.strategyId,
    strategyRevision: run.strategyRevision,
    strategySnapshot: run.strategySnapshot,
  }) as BacktestRun;

export const dependenciesFor = (
  context: ApiContext,
  failures: Failures
): BacktestRunExecutionDependencies => {
  const {
    backtestRuns: runs,
    marketBars,
    marketDailySeries,
    sectorRotation,
  } = context.repositories;
  if (runs === undefined || marketBars === undefined)
    throw failures.STORAGE_ERROR();
  return {
    marketBars,
    runs,
    ...(marketDailySeries === undefined ? {} : { marketDailySeries }),
    ...(sectorRotation === undefined ? {} : { sectorRotation }),
  };
};

/** Runs the task on the tracked scheduler, or awaits it when none is wired. */
const schedule = async (
  context: ApiContext,
  task: () => Promise<void>
): Promise<void> => {
  if (context.scheduleDatabaseTask === undefined) {
    await task();
    return;
  }
  context.scheduleDatabaseTask(task().catch(() => undefined));
};

const api = implement(appContract).$context<ApiContext>();

const submit = api.backtestRuns.submit
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    // Backtest runs load the daily series and run options blocks (1d only); an options run has
    // the book's own costs and exits. Refuse what cannot run before queueing.
    if (input.rule.kind === "dsl") {
      const { definition } = input.rule;
      const refusal = serverStrategyRefusal(
        definition,
        input.timeframe,
        BACKTEST_RUN_SUPPORT
      );
      const problem =
        refusal?.message ??
        (definition.options === undefined
          ? undefined
          : optionsSpecProblem(input, definition));
      if (problem !== undefined)
        throw failures.VALIDATION_ERROR({ message: problem });
    }
    const dependencies = dependenciesFor(context, failures);
    const { costProfile, strategyId, ...rest } = input;
    // Store the resolved profile, so a later preset change does not alter what the run tested.
    const spec =
      costProfile === undefined
        ? rest
        : {
            ...rest,
            costProfile:
              typeof costProfile === "string"
                ? COST_PROFILE_PRESETS[costProfile]
                : costProfile,
          };
    let snapshot: BacktestRunRecord["strategySnapshot"] = null;
    let libraryId: string | null = null;
    if (strategyId !== undefined && strategyId !== null) {
      const library = context.repositories.strategyLibrary;
      if (library === undefined) throw failures.STORAGE_ERROR();
      const found = await library.get(strategyId);
      if (found === null)
        throw failures.NOT_FOUND({ message: "Strategy not found" });
      const strategy = found.strategy;
      snapshot = {
        id: strategy.id,
        kind: strategy.kind,
        name: strategy.name,
        params: strategy.params as unknown[],
        slug: strategy.slug,
        sourceRef: strategy.sourceRef,
        updatedAt: strategy.updatedAt.toISOString(),
      };
      libraryId = strategy.id;
    } else if (spec.rule.kind === "dsl") {
      // A definition run without a library strategy is versioned by its content: the snapshot
      // depends only on the definition, so equal definitions get equal revisions.
      const definition = spec.rule.definition;
      const contentHash = await sha256Hex(canonicalJson(definition));
      snapshot = {
        id: `dsl:${contentHash.slice(0, 16)}`,
        kind: "dsl",
        name: definition.name,
        params: [definition],
        slug: `dsl-${contentHash.slice(0, 16)}`,
        sourceRef: null,
        updatedAt: "",
      };
    }
    const nautilus = context.backtestRunsEngine === "nautilus";
    const created = await dependencies.runs.create({
      engineVersion: nautilus
        ? BACKTEST_RUN_NAUTILUS_ENGINE
        : BACKTEST_RUN_ENGINE_VERSION,
      requestedBy: context.principal.userId,
      spec,
      strategyId: libraryId,
      strategyRevision:
        snapshot === null ? null : await sha256Hex(canonicalJson(snapshot)),
      strategySnapshot: snapshot,
    });
    // A Nautilus run waits for the research worker (backtestRuns.engine.claim).
    if (nautilus) return toOutput(created);
    await schedule(context, () => executeBacktestRun(dependencies, created.id));
    return toOutput((await dependencies.runs.get(created.id)) ?? created);
  });

const get = api.backtestRuns.get
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const dependencies = dependenciesFor(context, failures);
    const staleBefore = new Date(Date.now() - BACKTEST_RUN_STALE_MS);
    await dependencies.runs.failIfStale(
      input.id,
      staleBefore,
      "Backtest stopped before it finished"
    );
    let run = await dependencies.runs.get(input.id);
    if (run === null)
      throw failures.NOT_FOUND({ message: "Backtest run not found" });
    if (run.status === "queued") {
      if (run.engineVersion !== BACKTEST_RUN_NAUTILUS_ENGINE) {
        const id = run.id;
        await schedule(context, () => executeBacktestRun(dependencies, id));
      } else if (
        run.createdAt < staleBefore &&
        (await dependencies.runs.failIfUnclaimed(
          run.id,
          run.engineVersion,
          staleBefore,
          NAUTILUS_UNCLAIMED_ERROR
        ))
      )
        run = (await dependencies.runs.get(run.id)) ?? run;
    }
    return toOutput(run);
  });

const list = api.backtestRuns.list
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const dependencies = dependenciesFor(context, failures);
    const runs = await dependencies.runs.list({
      ...(input.strategyId === undefined
        ? {}
        : { strategyId: input.strategyId }),
      limit: input.limit,
    });
    return { runs: runs.map((run) => toOutput({ ...run, report: null })) };
  });

const sweep = api.backtestRuns.sweep
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const { marketBars } = context.repositories;
    if (marketBars === undefined) throw failures.STORAGE_ERROR();
    let series: MarketBarSeries | null;
    try {
      series = await marketBars.getSeries(input.symbol, input.timeframe);
    } catch {
      throw failures.STORAGE_ERROR();
    }
    if (series === null) throw failures.NOT_FOUND();
    let columns: MarketBarColumns;
    try {
      columns = (await columnsFor(marketBars, series)).columns;
    } catch {
      throw failures.STORAGE_ERROR();
    }
    const bars = sliceColumnsByDate(columns, input.from, input.to);
    const size = bars.t.length;
    if (size < 2)
      throw failures.BAD_REQUEST({
        message: `Fewer than 2 bars for ${input.symbol} between ${input.from} and ${input.to}`,
      });
    const cells = input.dimensions.reduce(
      (product, dimension) => product * sweepValueCount(dimension),
      1
    );
    if (cells * size > BACKTEST_SWEEP_MAX_BAR_STEPS)
      throw failures.BAD_REQUEST({
        message: `The sweep needs ${cells} cells x ${size} bars; the limit is ${BACKTEST_SWEEP_MAX_BAR_STEPS.toLocaleString("en-US")} bar steps. Narrow the date range or the grid.`,
      });
    const queue = comparisonQueueFor(context, context.principal.userId);
    // Full cell results only for the cells Nautilus repeats; the wall time of every cell.
    const cellRuns: SweepCellRun[] = [];
    const walls: SweepWalls = { cells: 0, frozen: false, totalMs: 0 };
    const started = performance.now();
    const grid = runBacktestSweep(
      bars,
      input,
      queue === null
        ? undefined
        : {
            clock: () => performance.now(),
            onCell: (cell) => {
              walls.cells += 1;
              if (cell.wall.wallMs === null) walls.frozen = true;
              else walls.totalMs += cell.wall.wallMs;
              if (cellRuns.length < ENGINE_COMPARISON_SWEEP_CELLS_MAX)
                cellRuns.push(cell);
            },
          }
    );
    const computeMs = performance.now() - started;
    const comparison =
      queue === null
        ? undefined
        : await queueSweepComparison(
            queue,
            input,
            series.sourceSha256,
            grid,
            cellRuns,
            walls
          );
    return {
      ...grid,
      ...(comparison === undefined ? {} : { comparison }),
      bars: size,
      computeMs,
      engineVersion: BACKTEST_RUN_ENGINE_VERSION,
      firstT: bars.t[0] as number,
      from: input.from,
      lastT: bars.t[size - 1] as number,
      metric: input.metric,
      seriesSha256: series.sourceSha256,
      spikeRatio: BACKTEST_SWEEP_SPIKE_RATIO,
      symbol: input.symbol,
      timeframe: input.timeframe,
      to: input.to,
    };
  });

/** The evaluated cell count and summed wall time of a sweep; `frozen` when a cell clock froze. */
interface SweepWalls {
  cells: number;
  frozen: boolean;
  totalMs: number;
}

/**
 * Queues the first ENGINE_COMPARISON_SWEEP_CELLS_MAX evaluated cells of a sweep on Nautilus (one
 * run per cell, labelled with the cell's parameters) and returns the comparison answer. `queued`
 * holds only those cells; `walls` covers every evaluated cell.
 */
const queueSweepComparison = async (
  queue: ComparisonQueue,
  input: BacktestSweepRequest,
  seriesSha256: string,
  grid: BacktestSweepGrid,
  queued: readonly SweepCellRun[],
  walls: SweepWalls
): Promise<NonNullable<BacktestSweepOutput["comparison"]>> => {
  const dropped = walls.cells - queued.length;
  // One frozen cell clock makes the total unknown (measureWall in ../engine-comparison.ts).
  const wall: WallTime = walls.frozen
    ? { wallMs: null, wallNote: TIMER_FROZEN_NOTE }
    : { wallMs: walls.totalMs };
  const timing = { dropped, host: queue.host, queued: queued.length, ...wall };
  if (queued.length === 0) return { ...timing, groupId: null };
  try {
    // An identical sweep (same bars, range, rule, grid and costs) reuses its group; a new one
    // replaces the older queued sweep runs of this user (the page runs again on every change).
    const enqueued = await queue.enqueue({
      dropped,
      feature: "sweep",
      groupId: await comparisonGroupId("sweep", {
        costBps: input.costBps,
        dimensions: input.dimensions,
        from: input.from,
        rule: input.rule,
        seriesSha256,
        stopLossPct: input.stopLossPct,
        takeProfitPct: input.takeProfitPct,
        to: input.to,
      }),
      runs: queued.map((cell) => ({
        key: String(cell.index),
        label: grid.dimensions
          .map(
            (dimension, position) =>
              `${dimension.param}=${cell.params[position]}`
          )
          .join(", "),
        spec: {
          costBps: input.costBps,
          from: input.from,
          initialCapital: BACKTEST_RUN_DEFAULT_CAPITAL,
          // A sweep rule is the input's smaCross or breakout rule with swept values.
          rule: cell.settings.rule as ComparisonBaseSpec["rule"],
          stopLossPct: cell.settings.stopLossPct,
          symbol: input.symbol,
          takeProfitPct: cell.settings.takeProfitPct,
          timeframe: input.timeframe,
          to: input.to,
        },
        typescript: typescriptSide(cell.result, cell.wall, queue.host),
      })),
      latest: true,
    });
    return { ...timing, ...enqueued };
  } catch {
    return {
      ...timing,
      error: COMPARISON_QUEUE_ERROR,
      groupId: null,
      queued: 0,
    };
  }
};

/** Short run label: strategy or symbol, timeframe, rule and date range. */
export const describeRun = (run: BacktestRunRecord): string =>
  `${run.strategySnapshot?.name ?? run.spec.symbol} ${run.spec.timeframe} ${run.spec.rule.kind} ${run.spec.from}..${run.spec.to}`;

const combine = api.backtestRuns.combine
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const dependencies = dependenciesFor(context, failures);
    const runs: BacktestRunRecord[] = [];
    for (const slot of input.slots) {
      const run = await dependencies.runs.get(slot.runId);
      if (run === null)
        throw failures.NOT_FOUND({
          message: `Backtest run ${slot.runId} not found`,
        });
      if (run.status !== "succeeded" || run.report === null)
        throw failures.BAD_REQUEST({
          message: `Backtest run ${slot.runId} has not succeeded`,
        });
      if (
        slot.expectedRevision !== undefined &&
        slot.expectedRevision !== null &&
        slot.expectedRevision !== run.strategyRevision
      )
        throw failures.BAD_REQUEST({
          message: `Backtest run ${slot.runId} does not match the pinned strategy revision`,
        });
      runs.push(run);
    }
    try {
      const result = combinePortfolio(
        input.deposit,
        runs.map((run, index) => ({
          equity: (run.report as unknown as BacktestRunReportOutput).equity,
          initialCapital: run.spec.initialCapital,
          label: describeRun(run),
          weight: (input.slots[index] as (typeof input.slots)[number]).weight,
        }))
      );
      return {
        ...result,
        correlation: result.correlation.map((row) => [...row]),
        drawdownOverlap: result.drawdownOverlap.map((row) => [...row]),
        points: [...result.points],
        slots: result.slots.map((slot, index) => {
          const run = runs[index] as BacktestRunRecord;
          return {
            ...slot,
            engineVersion: run.engineVersion,
            runId: run.id,
            seriesSha256: (run.report as unknown as BacktestRunReportOutput)
              .seriesSha256,
            strategyRevision: run.strategyRevision,
          };
        }),
      };
    } catch (error) {
      if (error instanceof ComboInputError)
        throw failures.BAD_REQUEST({ message: error.message });
      throw error;
    }
  });

export const backtestRunsRouter = { combine, get, list, submit, sweep };
