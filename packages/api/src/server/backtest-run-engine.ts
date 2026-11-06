import type {
  BacktestRunRecord,
  MarketBarColumns,
  MarketBarSeries,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";
import { buildBacktestRunReport } from "../backtest-run-report.ts";
import { sliceColumnsByDate } from "../bar-slice.ts";
import { appContract } from "../contract.ts";
import {
  BACKTEST_RUN_ENGINE_BARS_MAX,
  type BacktestRunEngineClaimOutput,
  type BacktestRunEngineCompleteItem,
} from "../contracts/backtest-runs.ts";
import {
  EngineComparisonSpecSchema,
  type EngineDifferences,
} from "../contracts/engine-comparison.ts";
import { compareEngineResults } from "../engine-comparison.ts";
import {
  barsInPositionOf,
  InstantBacktestInputError,
  type InstantRunResult,
  type InstantStats,
  summarize,
} from "../instant-backtest-engine.ts";
import { StrategyDefinitionSchema } from "../strategy-dsl.ts";
import { costsForSpec } from "./backtest-run-params.ts";
import {
  BACKTEST_RUN_STORAGE_ERROR,
  type BacktestRunExecutionDependencies,
  dependenciesFor,
  type Failures,
  loadRunBars,
} from "./backtest-runs.ts";
import type { ApiContext } from "./context.ts";
import { columnsFor } from "./instant-backtest.ts";
import { requireOperator } from "./operator-access.ts";
import { loadSectorQuadrants } from "./sector-quadrant-series.ts";

// Engine worker procedures (backtestRuns.engine.*), called by the Nautilus research worker on the
// rig (scripts/backtest-worker/nautilus-worker.ts) with an operator agent write key. claim moves
// the oldest queued run of the engine to running and sends the inputs the API engine would use:
// the bars of the date range, the cost settings and the sector rotation points. A run whose inputs
// cannot be loaded fails here with the same message as the API engine, and claim tries the next
// run. complete reloads the bars, checks the result against them and builds the report with the
// same code as the API engine. With `max`, claim returns a batch (one comparison group, one bar
// series) and completeMany stores the batch; a comparison run's report also gets the differences
// to the TypeScript result it repeats. Research only; no order path.

/** Runs one claim may fail while it loads inputs before it returns no run. */
export const ENGINE_CLAIM_ATTEMPTS = 5;
/** Relative tolerance between the worker's stats and the API's (the Python summary is a port). */
export const ENGINE_STATS_TOLERANCE = 1e-9;

/** The first stat where the worker differs from the API beyond the tolerance, or null. */
export const engineStatsMismatch = (
  sent: InstantStats,
  computed: InstantStats
): string | null => {
  for (const [key, expected] of Object.entries(computed)) {
    const value = sent[key as keyof InstantStats];
    const equal =
      expected === null || value === null
        ? expected === value
        : Math.abs(value - expected) <=
          ENGINE_STATS_TOLERANCE *
            Math.max(1, Math.abs(value), Math.abs(expected));
    if (!equal) return key;
  }
  return null;
};

type EngineFailures = Failures &
  Readonly<{ CONFLICT: (options?: { message?: string }) => Error }>;

type ClaimedRun = NonNullable<BacktestRunEngineClaimOutput["run"]>;
type BacktestRunStatus = BacktestRunRecord["status"];

/** JSON has no NaN; the engine reads null as NaN. */
const jsonColumn = (values: Float64Array): (number | null)[] =>
  Array.from(values, (value) => (Number.isNaN(value) ? null : value));

const jsonBars = (bars: MarketBarColumns): ClaimedRun["bars"] => ({
  c: jsonColumn(bars.c),
  h: jsonColumn(bars.h),
  l: jsonColumn(bars.l),
  o: jsonColumn(bars.o),
  t: jsonColumn(bars.t),
  ...(bars.v === undefined ? {} : { v: jsonColumn(bars.v) }),
});

/** The spec the worker needs: the comparison part stays on the server. */
const engineSpec = (
  spec: BacktestRunRecord["spec"]
): Omit<BacktestRunRecord["spec"], "comparison"> =>
  Object.fromEntries(
    Object.entries(spec).filter(([key]) => key !== "comparison")
  ) as Omit<BacktestRunRecord["spec"], "comparison">;

type RunInputs = Readonly<{
  run: BacktestRunRecord;
  bars: MarketBarColumns;
  series: MarketBarSeries;
  costs: ClaimedRun["costs"];
  sectorQuadrants: ClaimedRun["sectorQuadrants"];
}>;

/** The engine inputs of a claimed run, or null after the run was failed. */
const runInputs = async (
  dependencies: BacktestRunExecutionDependencies,
  run: BacktestRunRecord
): Promise<RunInputs | null> => {
  const { spec } = run;
  try {
    const loaded = await loadRunBars(dependencies.marketBars, spec);
    if ("error" in loaded) {
      await dependencies.runs.fail(run.id, loaded.error);
      return null;
    }
    const { bars, series } = loaded;
    if (bars.t.length > BACKTEST_RUN_ENGINE_BARS_MAX) {
      await dependencies.runs.fail(
        run.id,
        `The date range has ${bars.t.length} bars; the Nautilus worker takes at most ${BACKTEST_RUN_ENGINE_BARS_MAX}`
      );
      return null;
    }
    const sectorQuadrants =
      spec.rule.kind === "dsl"
        ? await loadSectorQuadrants(
            dependencies.sectorRotation,
            StrategyDefinitionSchema.parse(spec.rule.definition),
            bars.t[0] as number
          )
        : undefined;
    return {
      bars,
      costs: (costsForSpec(spec) ?? null) as ClaimedRun["costs"],
      run,
      // The worker reads the points only; readonly arrays are the same JSON.
      sectorQuadrants: (sectorQuadrants ??
        null) as ClaimedRun["sectorQuadrants"],
      series,
    };
  } catch (error) {
    await dependencies.runs.fail(
      run.id,
      error instanceof InstantBacktestInputError
        ? error.message
        : BACKTEST_RUN_STORAGE_ERROR
    );
    return null;
  }
};

/** The engine inputs of a claimed run, or null after the run was failed. */
const prepareRun = async (
  dependencies: BacktestRunExecutionDependencies,
  run: BacktestRunRecord
): Promise<ClaimedRun | null> => {
  const inputs = await runInputs(dependencies, run);
  if (inputs === null) return null;
  return {
    bars: jsonBars(inputs.bars),
    costs: inputs.costs,
    id: run.id,
    sectorQuadrants: inputs.sectorQuadrants,
    seriesSha256: inputs.series.sourceSha256,
    spec: engineSpec(run.spec),
  } as ClaimedRun;
};

type ClaimedBatch = NonNullable<BacktestRunEngineClaimOutput["batch"]>;

/**
 * The engine inputs of a claimed batch on one shared bar series: the bars from the earliest
 * `from` to the latest `to`, and each run's index range in them. Runs whose inputs cannot be
 * loaded, or that are on another series than the first one, fail; null when none is left.
 */
const prepareBatch = async (
  dependencies: BacktestRunExecutionDependencies,
  runs: readonly BacktestRunRecord[]
): Promise<ClaimedBatch | null> => {
  const ready: RunInputs[] = [];
  for (const run of runs) {
    const first = ready[0];
    if (
      first !== undefined &&
      (first.run.spec.symbol !== run.spec.symbol ||
        first.run.spec.timeframe !== run.spec.timeframe)
    ) {
      await dependencies.runs.fail(
        run.id,
        "The comparison batch mixes bar series; submit the run again"
      );
      continue;
    }
    const inputs = await runInputs(dependencies, run);
    if (inputs !== null) ready.push(inputs);
  }
  const [head] = ready;
  if (head === undefined) return null;
  const from = ready.map((entry) => entry.run.spec.from).sort()[0] as string;
  const to = ready
    .map((entry) => entry.run.spec.to)
    .sort()
    .at(-1) as string;
  const shared = sliceColumnsByDate(
    (await columnsFor(dependencies.marketBars, head.series)).columns,
    from,
    to
  );
  return {
    bars: jsonBars(shared),
    runs: ready.map((entry) => {
      const start = entry.bars.t[0] as number;
      let first = 0;
      while ((shared.t[first] as number) < start) first += 1;
      return {
        costs: entry.costs,
        end: first + entry.bars.t.length,
        first,
        id: entry.run.id,
        sectorQuadrants: entry.sectorQuadrants,
        spec: engineSpec(entry.run.spec),
      };
    }),
    seriesSha256: head.series.sourceSha256,
  } as ClaimedBatch;
};

const api = implement(appContract).$context<ApiContext>();

const claim = api.backtestRuns.engine.claim
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const dependencies = dependenciesFor(
      context,
      errors as unknown as Failures
    );
    const { max } = input;
    for (let attempt = 0; attempt < ENGINE_CLAIM_ATTEMPTS; attempt += 1) {
      if (max === undefined) {
        const run = await dependencies.runs.claimNext(input.engine);
        if (run === null) return { run: null };
        const prepared = await prepareRun(dependencies, run);
        if (prepared !== null) return { run: prepared };
      } else {
        const runs = await dependencies.runs.claimBatch(input.engine, max);
        if (runs.length === 0) return { batch: null, run: null };
        const batch = await prepareBatch(dependencies, runs);
        if (batch !== null) return { batch, run: null };
      }
    }
    return max === undefined ? { run: null } : { batch: null, run: null };
  });

type ResultItem = Extract<BacktestRunEngineCompleteItem, { result: unknown }>;
type ErrorItem = Extract<BacktestRunEngineCompleteItem, { error: string }>;

/** What one result or error did: the stored status, or why nothing changed. */
type StoreOutcome =
  | Readonly<{ status: BacktestRunStatus }>
  | Readonly<{
      error: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND";
      message?: string;
    }>;

/** The run, when it is running on the engine; otherwise the outcome that refuses it. */
const runningRun = async (
  dependencies: BacktestRunExecutionDependencies,
  id: string,
  engine: string
): Promise<BacktestRunRecord | StoreOutcome> => {
  const run = await dependencies.runs.get(id);
  if (run === null)
    return { error: "NOT_FOUND", message: "Backtest run not found" };
  if (run.status !== "running" || run.engineVersion !== engine)
    return { error: "CONFLICT" };
  return run;
};

/** Differences to the TypeScript result of a comparison run; undefined for other runs. */
const differencesFor = (
  run: BacktestRunRecord,
  nautilus: Parameters<typeof compareEngineResults>[1]
): EngineDifferences | undefined => {
  if (run.spec.comparison === undefined) return undefined;
  const parsed = EngineComparisonSpecSchema.safeParse(run.spec.comparison);
  if (!parsed.success)
    return {
      items: [
        {
          detail: "The stored TypeScript result could not be read",
          field: "comparison",
          nautilus: null,
          typescript: null,
        },
      ],
      ok: false,
    };
  return compareEngineResults(parsed.data.typescript, nautilus);
};

/**
 * Checks a result against the stored bars, recomputes its stats and stores the report. A result
 * that does not fit the bars fails the run, so the user sees the reason.
 */
const storeResult = async (
  dependencies: BacktestRunExecutionDependencies,
  engine: string,
  item: ResultItem
): Promise<StoreOutcome> => {
  const run = await runningRun(dependencies, item.id, engine);
  if (!("spec" in run)) return run;
  const { spec } = run;
  const reject = async (message: string): Promise<StoreOutcome> => {
    await dependencies.runs.fail(run.id, message);
    return { error: "BAD_REQUEST", message };
  };
  const loaded = await loadRunBars(dependencies.marketBars, spec);
  if ("error" in loaded) return await reject(loaded.error);
  if (loaded.series.sourceSha256 !== item.seriesSha256)
    return await reject(
      "The stored bars changed while the backtest was running"
    );
  if (loaded.bars.t.length !== item.result.equity.length)
    return await reject(
      `The engine result has ${item.result.equity.length} bars; the date range has ${loaded.bars.t.length}`
    );
  // The stored stats are the API's own, computed from the worker's equity and trades.
  const equity = Float64Array.from(item.result.equity);
  // Same shape; the zod output marks optional fields `| undefined` (exactOptionalPropertyTypes).
  const trades = item.result.trades as InstantRunResult["trades"];
  const stats = summarize(
    loaded.bars,
    equity,
    trades,
    barsInPositionOf(trades)
  );
  const mismatch = engineStatsMismatch(item.result.stats, stats);
  if (mismatch !== null)
    return await reject(
      `The engine stats do not match its equity and trades (${mismatch})`
    );
  const costs = costsForSpec(spec);
  const differences = differencesFor(run, { stats, trades });
  const report = {
    ...buildBacktestRunReport(
      loaded.bars,
      { equity, stats, trades },
      spec.initialCapital,
      costs?.profile
    ),
    seriesSha256: loaded.series.sourceSha256,
    ...(item.engineRun === undefined ? {} : { engineRun: item.engineRun }),
    ...(differences === undefined ? {} : { differences }),
  };
  const stored = await dependencies.runs.complete(run.id, report);
  return stored === null ? { error: "CONFLICT" } : { status: stored.status };
};

/** Stores the engine error of a running run. */
const storeError = async (
  dependencies: BacktestRunExecutionDependencies,
  engine: string,
  item: ErrorItem
): Promise<StoreOutcome> => {
  const run = await runningRun(dependencies, item.id, engine);
  if (!("spec" in run)) return run;
  const stored = await dependencies.runs.fail(run.id, item.error);
  return stored === null ? { error: "CONFLICT" } : { status: stored.status };
};

/** The procedure answer of one outcome: the stored status, or the typed error. */
const answer = (
  failures: EngineFailures,
  id: string,
  outcome: StoreOutcome
): Readonly<{ id: string; status: BacktestRunStatus }> => {
  if ("status" in outcome) return { id, status: outcome.status };
  throw failures[outcome.error](
    outcome.message === undefined ? undefined : { message: outcome.message }
  );
};

const complete = api.backtestRuns.engine.complete
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as EngineFailures;
    const dependencies = dependenciesFor(context, failures);
    const { engine, ...item } = input;
    return answer(
      failures,
      input.id,
      await storeResult(dependencies, engine, item)
    );
  });

const completeMany = api.backtestRuns.engine.completeMany
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const dependencies = dependenciesFor(
      context,
      errors as unknown as Failures
    );
    const outcomes: Readonly<{
      id: string;
      status: BacktestRunStatus | null;
      error?: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND";
      message?: string;
    }>[] = [];
    for (const item of input.items) {
      const outcome =
        "result" in item
          ? await storeResult(dependencies, input.engine, item)
          : await storeError(dependencies, input.engine, item);
      outcomes.push(
        "status" in outcome
          ? { id: item.id, status: outcome.status }
          : { ...outcome, id: item.id, status: null }
      );
    }
    return { outcomes };
  });

const fail = api.backtestRuns.engine.fail
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as EngineFailures;
    const dependencies = dependenciesFor(context, failures);
    const { engine, ...item } = input;
    return answer(
      failures,
      input.id,
      await storeError(dependencies, engine, item)
    );
  });

export const backtestRunEngineRouter = { claim, complete, completeMany, fail };
