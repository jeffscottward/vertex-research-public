import type {
  BacktestRunRecord,
  BacktestRunsRepository,
  MarketBarColumns,
  MarketBarSeries,
  MarketBarsRepository,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { COST_PROFILE_PRESETS } from "../backtest-costs.ts";
import { buildBacktestRunReport } from "../backtest-run-report.ts";
import { runBacktestSweep } from "../backtest-sweep.ts";
import { sweepValueCount } from "../backtest-sweep-grid.ts";
import { appContract } from "../contract.ts";
import {
  BACKTEST_RUN_ENGINE_VERSION,
  BACKTEST_RUN_NAUTILUS_ENGINE,
  type BacktestRun,
  type BacktestRunReportOutput,
} from "../contracts/backtest-runs.ts";
import {
  BACKTEST_SWEEP_MAX_BAR_STEPS,
  BACKTEST_SWEEP_SPIKE_RATIO,
} from "../contracts/backtest-sweep.ts";
import {
  InstantBacktestInputError,
  type InstantRunResult,
  runInstantBacktest,
} from "../instant-backtest-engine.ts";
import { ComboInputError, combinePortfolio } from "../portfolio-combination.ts";
import { StrategyDefinitionSchema } from "../strategy-dsl.ts";
import { runStrategyDefinition } from "../strategy-dsl-compile.ts";
import { costsForSpec, runParamsForSpec } from "./backtest-run-params.ts";
import type { ApiContext } from "./context.ts";
import { columnsFor } from "./instant-backtest.ts";
import { requireOperator } from "./operator-access.ts";
import {
  loadSectorQuadrants,
  type SectorQuadrantSource,
} from "./sector-quadrant-series.ts";

// Backtest run procedures. submit stores a queued run. With the TypeScript engine (the default of
// VERTEX_BACKTEST_RUNS_ENGINE) it schedules the execution on the request's tracked background
// scheduler (the database connection stays open until it finishes); without a scheduler it runs
// before the response. With the Nautilus engine the run waits for the research worker
// (backtest-run-engine.ts). get re-schedules a queued TypeScript run, so a run whose scheduled task
// was lost still completes, fails runs left running longer than the stale limit, and fails a
// Nautilus run that waited longer than the same limit while no worker claimed any Nautilus run
// (a busy worker does not fail its backlog). The claim is a conditional update, so
// a run executes at most once. sweep runs a parameter grid in the request after a cells x bars
// budget check and stores nothing. Research only; no order path.

const BACKTEST_RUN_STALE_MS = 10 * 60 * 1000;
export const NAUTILUS_UNCLAIMED_ERROR =
  "Nautilus backtest worker did not pick up the run";
export const BACKTEST_RUN_STORAGE_ERROR =
  "Backtest failed: bar storage or engine error";
const DAY_MS = 86_400_000;

export type Failures = Readonly<{
  NOT_FOUND: (options?: { message?: string }) => Error;
  BAD_REQUEST: (options?: { message?: string }) => Error;
  STORAGE_ERROR: () => Error;
}>;

export type BacktestRunExecutionDependencies = Readonly<{
  runs: BacktestRunsRepository;
  marketBars: MarketBarsRepository;
  /** Stored sector rotation points for definitions with sector filters. */
  sectorRotation?: SectorQuadrantSource;
}>;

/** Deterministic JSON with sorted object keys, used for the strategy revision hash. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      // Object keys are unique, so equal keys never compare.
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

/** Copies the bars whose time falls on or between the two UTC calendar dates. */
export const sliceColumnsByDate = (
  columns: MarketBarColumns,
  from: string,
  to: string
): MarketBarColumns => {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`) + DAY_MS;
  let first = 0;
  while (first < columns.t.length && (columns.t[first] as number) < start)
    first += 1;
  let last = first;
  while (last < columns.t.length && (columns.t[last] as number) < end)
    last += 1;
  return {
    c: columns.c.slice(first, last),
    h: columns.h.slice(first, last),
    l: columns.l.slice(first, last),
    o: columns.o.slice(first, last),
    t: columns.t.slice(first, last),
    ...(columns.v === undefined ? {} : { v: columns.v.slice(first, last) }),
  };
};

export type LoadedRunBars =
  | Readonly<{ bars: MarketBarColumns; series: MarketBarSeries }>
  | Readonly<{ error: string }>;

/** The stored bars of the run's date range, or the error message for the run. */
export const loadRunBars = async (
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

const executeClaimed = async (
  dependencies: BacktestRunExecutionDependencies,
  run: BacktestRunRecord
): Promise<void> => {
  const { spec } = run;
  const loaded = await loadRunBars(dependencies.marketBars, spec);
  if ("error" in loaded) {
    await dependencies.runs.fail(run.id, loaded.error);
    return;
  }
  const { bars, series } = loaded;
  const costs = costsForSpec(spec);
  const { rule } = spec;
  // A definition rule carries its own stop, target and sizing; the run-level stop and target
  // apply to the fixed rules only.
  let result: InstantRunResult;
  if (rule.kind === "dsl") {
    const definition = StrategyDefinitionSchema.parse(rule.definition);
    const sectorQuadrants = await loadSectorQuadrants(
      dependencies.sectorRotation,
      definition,
      bars.t[0] as number
    );
    result = runStrategyDefinition(
      bars,
      definition,
      spec.costBps,
      costs,
      sectorQuadrants
    );
  } else result = runInstantBacktest(bars, runParamsForSpec(spec));
  const report = {
    ...buildBacktestRunReport(
      bars,
      result,
      spec.initialCapital,
      costs?.profile
    ),
    seriesSha256: series.sourceSha256,
  };
  await dependencies.runs.complete(run.id, report);
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
    sectorRotation,
  } = context.repositories;
  if (runs === undefined || marketBars === undefined)
    throw failures.STORAGE_ERROR();
  return {
    marketBars,
    runs,
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
    const started = performance.now();
    const grid = runBacktestSweep(bars, input);
    return {
      ...grid,
      bars: size,
      computeMs: performance.now() - started,
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
