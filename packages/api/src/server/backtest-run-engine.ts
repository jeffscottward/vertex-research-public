import type { BacktestRunRecord } from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { buildBacktestRunReport } from "../backtest-run-report.ts";
import { appContract } from "../contract.ts";
import {
  BACKTEST_RUN_ENGINE_BARS_MAX,
  type BacktestRunEngineClaimOutput,
} from "../contracts/backtest-runs.ts";
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
import { requireOperator } from "./operator-access.ts";
import { loadSectorQuadrants } from "./sector-quadrant-series.ts";

// Engine worker procedures (backtestRuns.engine.*), called by the Nautilus research worker on the
// rig (scripts/backtest-worker/nautilus-worker.ts) with an operator agent write key. claim moves
// the oldest queued run of the engine to running and sends the inputs the API engine would use:
// the bars of the date range, the cost settings and the sector rotation points. A run whose inputs
// cannot be loaded fails here with the same message as the API engine, and claim tries the next
// run. complete reloads the bars, checks the result against them and builds the report with the
// same code as the API engine. Research only; no order path.

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

/** JSON has no NaN; the engine reads null as NaN. */
const jsonColumn = (values: Float64Array): (number | null)[] =>
  Array.from(values, (value) => (Number.isNaN(value) ? null : value));

/** The engine inputs of a claimed run, or null after the run was failed. */
const prepareRun = async (
  dependencies: BacktestRunExecutionDependencies,
  run: BacktestRunRecord
): Promise<ClaimedRun | null> => {
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
    const costs = costsForSpec(spec);
    return {
      bars: {
        c: jsonColumn(bars.c),
        h: jsonColumn(bars.h),
        l: jsonColumn(bars.l),
        o: jsonColumn(bars.o),
        t: jsonColumn(bars.t),
        ...(bars.v === undefined ? {} : { v: jsonColumn(bars.v) }),
      },
      costs: costs ?? null,
      id: run.id,
      sectorQuadrants: sectorQuadrants ?? null,
      seriesSha256: series.sourceSha256,
      spec,
    } as ClaimedRun;
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

/** The run, when it is running on the engine; otherwise a typed failure. */
const runningRun = async (
  dependencies: BacktestRunExecutionDependencies,
  failures: EngineFailures,
  id: string,
  engine: string
): Promise<BacktestRunRecord> => {
  const run = await dependencies.runs.get(id);
  if (run === null)
    throw failures.NOT_FOUND({ message: "Backtest run not found" });
  if (run.status !== "running" || run.engineVersion !== engine)
    throw failures.CONFLICT();
  return run;
};

const api = implement(appContract).$context<ApiContext>();

const claim = api.backtestRuns.engine.claim
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const dependencies = dependenciesFor(
      context,
      errors as unknown as Failures
    );
    for (let attempt = 0; attempt < ENGINE_CLAIM_ATTEMPTS; attempt += 1) {
      const run = await dependencies.runs.claimNext(input.engine);
      if (run === null) return { run: null };
      const prepared = await prepareRun(dependencies, run);
      if (prepared !== null) return { run: prepared };
    }
    return { run: null };
  });

const complete = api.backtestRuns.engine.complete
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as EngineFailures;
    const dependencies = dependenciesFor(context, failures);
    const run = await runningRun(
      dependencies,
      failures,
      input.id,
      input.engine
    );
    const { spec } = run;
    // A result that does not fit the stored bars fails the run, so the user sees the reason.
    const reject = async (message: string): Promise<never> => {
      await dependencies.runs.fail(run.id, message);
      throw failures.BAD_REQUEST({ message });
    };
    const loaded = await loadRunBars(dependencies.marketBars, spec);
    if ("error" in loaded) return await reject(loaded.error);
    if (loaded.series.sourceSha256 !== input.seriesSha256)
      return await reject(
        "The stored bars changed while the backtest was running"
      );
    if (loaded.bars.t.length !== input.result.equity.length)
      return await reject(
        `The engine result has ${input.result.equity.length} bars; the date range has ${loaded.bars.t.length}`
      );
    // The stored stats are the API's own, computed from the worker's equity and trades.
    const equity = Float64Array.from(input.result.equity);
    // Same shape; the zod output marks optional fields `| undefined` (exactOptionalPropertyTypes).
    const trades = input.result.trades as InstantRunResult["trades"];
    const stats = summarize(
      loaded.bars,
      equity,
      trades,
      barsInPositionOf(trades)
    );
    const mismatch = engineStatsMismatch(input.result.stats, stats);
    if (mismatch !== null)
      return await reject(
        `The engine stats do not match its equity and trades (${mismatch})`
      );
    const costs = costsForSpec(spec);
    const report = {
      ...buildBacktestRunReport(
        loaded.bars,
        { equity, stats, trades },
        spec.initialCapital,
        costs?.profile
      ),
      seriesSha256: loaded.series.sourceSha256,
    };
    const stored = await dependencies.runs.complete(run.id, report);
    if (stored === null) throw failures.CONFLICT();
    return { id: stored.id, status: stored.status };
  });

const fail = api.backtestRuns.engine.fail
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as EngineFailures;
    const dependencies = dependenciesFor(context, failures);
    const run = await runningRun(
      dependencies,
      failures,
      input.id,
      input.engine
    );
    const stored = await dependencies.runs.fail(run.id, input.error);
    if (stored === null) throw failures.CONFLICT();
    return { id: stored.id, status: stored.status };
  });

export const backtestRunEngineRouter = { claim, complete, fail };
