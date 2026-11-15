import type {
  BacktestRunRecord,
  MarketBarColumns,
  MarketDailyColumns,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";
import {
  type BacktestRunOptionsMetrics,
  buildBacktestRunReport,
} from "../backtest-run-report.ts";
import { sliceColumnsByDate } from "../bar-slice.ts";
import { canonicalJson } from "../canonical-json.ts";
import { appContract } from "../contract.ts";
import {
  BACKTEST_RUN_ENGINE_BARS_MAX,
  BACKTEST_RUN_ENGINE_SERIES_MAX_BYTES,
  type BacktestRunEngineClaimOutput,
  type BacktestRunEngineCompleteItem,
  type BacktestRunEngineOptionsResult,
  type BacktestRunEngineResult,
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
import {
  type StrategyDefinition,
  StrategyDefinitionSchema,
} from "../strategy-dsl.ts";
import { costsForSpec } from "./backtest-run-params.ts";
import {
  BACKTEST_RUN_STORAGE_ERROR,
  type BacktestRunExecutionDependencies,
  dependenciesFor,
  type Failures,
  loadRunData,
  type OptionsRun,
  optionsRunReport,
  type RunData,
  runOptionsOnRows,
} from "./backtest-runs.ts";
import type { ApiContext } from "./context.ts";
import { columnsFor } from "./instant-backtest.ts";
import { requireOperator } from "./operator-access.ts";
import { loadSectorQuadrants } from "./sector-quadrant-series.ts";
import {
  type LoadedStrategySeries,
  type StrategySeriesLoader,
  sharedStrategySeriesLoader,
  strategySeriesStoreIds,
} from "./strategy-series.ts";

// Engine worker procedures (backtestRuns.engine.*), called by the Nautilus research worker on the
// rig (scripts/backtest-worker/nautilus-worker.ts) with an operator agent write key. claim moves
// the oldest queued run of the engine to running and sends the inputs the API engine would use:
// the bars of the date range, the cost settings and the sector rotation points. A run whose inputs
// cannot be loaded fails here with the same message as the API engine, and claim tries the next
// run. complete reloads the bars, checks the result against them and builds the report with the
// same code as the API engine. With `max`, claim returns a batch (one comparison group, one bar
// series) and completeMany stores the batch; a comparison run's report also gets the differences
// to the TypeScript result it repeats. A definition that reads daily series gets the store rows
// too (`series`, at most BACKTEST_RUN_ENGINE_SERIES_MAX_BYTES; the seriesSha256 then covers bars
// and rows); a batch loads the store once for all its runs. An options definition is claimed
// alone and returns the options runner result; complete runs the options runner on the same rows
// and stores the API's run only when the worker's ledger is that run. Research only; no order
// path.

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

type RunInputs = RunData &
  Readonly<{
    run: BacktestRunRecord;
    costs: ClaimedRun["costs"];
    sectorQuadrants: ClaimedRun["sectorQuadrants"];
  }>;

/** True for a stored dsl run whose definition has an options block. */
const isOptionsRun = (run: BacktestRunRecord): boolean =>
  run.spec.rule.kind === "dsl" &&
  (run.spec.rule.definition as { options?: unknown }).options !== undefined;

/** The engine inputs of a claimed run, or null after the run was failed. */
const runInputs = async (
  dependencies: BacktestRunExecutionDependencies,
  run: BacktestRunRecord,
  loadSeries?: StrategySeriesLoader
): Promise<RunInputs | null> => {
  const { spec } = run;
  try {
    // Written past the submit check: refuse, never run it half.
    const loaded = await loadRunData(dependencies, spec, true, loadSeries);
    if ("error" in loaded) {
      await dependencies.runs.fail(run.id, loaded.error);
      return null;
    }
    const { bars, daily, definition } = loaded;
    if (bars.t.length > BACKTEST_RUN_ENGINE_BARS_MAX) {
      await dependencies.runs.fail(
        run.id,
        `The date range has ${bars.t.length} bars; the Nautilus worker takes at most ${BACKTEST_RUN_ENGINE_BARS_MAX}`
      );
      return null;
    }
    const rowsBytes =
      daily === null ? 0 : rowsByteLength(Object.fromEntries(daily.rows));
    if (rowsBytes > BACKTEST_RUN_ENGINE_SERIES_MAX_BYTES) {
      await dependencies.runs.fail(run.id, rowsTooLarge(rowsBytes));
      return null;
    }
    const sectorQuadrants =
      definition === undefined
        ? undefined
        : await loadSectorQuadrants(
            dependencies.sectorRotation,
            definition,
            bars.t[0] as number
          );
    return {
      ...loaded,
      costs: (costsForSpec(spec) ?? null) as ClaimedRun["costs"],
      run,
      // The worker reads the points only; readonly arrays are the same JSON.
      sectorQuadrants: (sectorQuadrants ??
        null) as ClaimedRun["sectorQuadrants"],
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

/** Bytes of store rows as claim JSON (ASCII: one byte per character). */
const rowsByteLength = (rows: Record<string, MarketDailyColumns>): number =>
  JSON.stringify(rows).length;

const rowsTooLarge = (bytes: number): string =>
  `The daily series rows are ${(bytes / 1e6).toFixed(1)} MB; the Nautilus worker takes at most ${BACKTEST_RUN_ENGINE_SERIES_MAX_BYTES / 1e6} MB`;

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
    series:
      inputs.daily === null ? null : Object.fromEntries(inputs.daily.rows),
    seriesSha256: inputs.seriesSha256,
    spec: engineSpec(run.spec),
  } as ClaimedRun;
};

type ClaimedBatch = NonNullable<BacktestRunEngineClaimOutput["batch"]>;

/**
 * One series load for the runs of a batch: every store id any of its definitions reads, up to the
 * latest `to`. A definition that cannot be read here fails later in runInputs with its message.
 */
const batchSeriesLoader = (
  dependencies: BacktestRunExecutionDependencies,
  runs: readonly BacktestRunRecord[]
): StrategySeriesLoader => {
  const ids = new Set<string>();
  for (const run of runs) {
    const { spec } = run;
    // A comparison batch never runs an options run (prepareBatch fails it).
    if (spec.rule.kind !== "dsl" || (runs.length > 1 && isOptionsRun(run)))
      continue;
    try {
      const definition = StrategyDefinitionSchema.parse(spec.rule.definition);
      for (const id of strategySeriesStoreIds(definition, spec.symbol))
        ids.add(id);
    } catch {
      // runInputs fails the run with the reason.
    }
  }
  const to = runs
    .map((run) => run.spec.to)
    .sort()
    .at(-1) as string;
  return sharedStrategySeriesLoader(
    dependencies.marketDailySeries,
    [...ids],
    to
  );
};

/** The rows of every run: each series as the longest load (the latest `to`) of any run. */
const batchRows = (
  ready: readonly RunInputs[]
): Record<string, MarketDailyColumns> | null => {
  const merged = new Map<string, MarketDailyColumns>();
  for (const { daily } of ready)
    for (const [id, columns] of daily?.rows ?? []) {
      const known = merged.get(id);
      if (known === undefined || columns.dates.length > known.dates.length)
        merged.set(id, columns);
    }
  return merged.size === 0 ? null : Object.fromEntries(merged);
};

/**
 * The engine inputs of a claimed batch on one shared bar series: the bars from the earliest
 * `from` to the latest `to`, each run's index range in them, and the daily series rows the runs
 * read. Runs whose inputs cannot be loaded, that are on another series than the first one, or
 * options runs in a batch of several runs (an options run runs alone), fail; null when none is
 * left.
 */
const prepareBatch = async (
  dependencies: BacktestRunExecutionDependencies,
  runs: readonly BacktestRunRecord[]
): Promise<ClaimedBatch | null> => {
  const loadSeries = batchSeriesLoader(dependencies, runs);
  const ready: RunInputs[] = [];
  for (const run of runs) {
    const first = ready[0];
    if (runs.length > 1 && isOptionsRun(run)) {
      await dependencies.runs.fail(
        run.id,
        "An options run runs alone, not in a comparison batch; submit the run again"
      );
      continue;
    }
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
    const inputs = await runInputs(dependencies, run, loadSeries);
    if (inputs !== null) ready.push(inputs);
  }
  const rows = batchRows(ready);
  const rowsBytes = rows === null ? 0 : rowsByteLength(rows);
  if (rowsBytes > BACKTEST_RUN_ENGINE_SERIES_MAX_BYTES) {
    for (const entry of ready)
      if (entry.daily !== null)
        await dependencies.runs.fail(entry.run.id, rowsTooLarge(rowsBytes));
    return await finishBatch(
      dependencies,
      ready.filter((entry) => entry.daily === null),
      null
    );
  }
  return await finishBatch(dependencies, ready, rows);
};

/** The batch of the ready runs on their shared bars, or null when none is ready. */
const finishBatch = async (
  dependencies: BacktestRunExecutionDependencies,
  ready: readonly RunInputs[],
  rows: Record<string, MarketDailyColumns> | null
): Promise<ClaimedBatch | null> => {
  const [head] = ready;
  if (head === undefined) return null;
  const from = ready.map((entry) => entry.run.spec.from).sort()[0] as string;
  const to = ready
    .map((entry) => entry.run.spec.to)
    .sort()
    .at(-1) as string;
  // An options run comes alone, on its own bars from the series store.
  const shared =
    head.series === null
      ? head.bars
      : sliceColumnsByDate(
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
        ...(entry.daily === null || entry.series === null
          ? {}
          : { seriesSha256: entry.seriesSha256 }),
        spec: engineSpec(entry.run.spec),
      };
    }),
    series: rows,
    seriesSha256: head.series?.sourceSha256 ?? head.seriesSha256,
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

/** The first options metric where the worker differs from the API beyond the tolerance, or null. */
const optionsMetricsMismatch = (
  sent: BacktestRunOptionsMetrics,
  computed: BacktestRunOptionsMetrics
): string | null => {
  for (const [key, expected] of Object.entries(computed)) {
    const value = sent[key as keyof BacktestRunOptionsMetrics];
    const equal =
      typeof expected === "number" && typeof value === "number"
        ? close(value, expected)
        : expected === value;
    if (!equal) return key;
  }
  return null;
};

type CheckedReport = Readonly<{ report: Record<string, unknown> }>;

/** True when two numbers agree within ENGINE_STATS_TOLERANCE (relative, at least 1 absolute). */
const close = (value: number, expected: number): boolean =>
  Math.abs(value - expected) <=
  ENGINE_STATS_TOLERANCE * Math.max(1, Math.abs(value), Math.abs(expected));

/** Trade fields that must equal the API's own run exactly. */
const OPTIONS_TRADE_FIELDS = [
  "id",
  "symbol",
  "structure",
  "expiry",
  "longStrike",
  "shortStrike",
  "entryDate",
  "exitDate",
  "contracts",
  "exitReason",
] as const;
/** Trade prices compared within ENGINE_STATS_TOLERANCE (relative). */
const OPTIONS_TRADE_PRICES = [
  "entryPrice",
  "exitPrice",
  "returnOnRisk",
] as const;
/** Trade money amounts (rounded to cents by both ledgers) compared within one cent. */
const OPTIONS_TRADE_CENTS = ["entryFee", "exitFee", "pnl"] as const;
/** One cent, with room for the binary representation of cent amounts. */
const CENT = 0.01 + 1e-9;

/**
 * Where the worker's options result differs from the API's own run of the same rows, or null:
 * the run days must be equal, the daily equity within ENGINE_STATS_TOLERANCE, the trades and skips
 * equal (prices, returnOnRisk and maxLoss within the tolerance, fees and pnl within one cent) and
 * the metrics within the tolerance.
 */
const optionsResultMismatch = (
  result: BacktestRunEngineOptionsResult,
  own: OptionsRun
): string | null => {
  const ledger = own.outcome.result;
  if (result.capital !== ledger.capital)
    return `capital ${result.capital} is not the run capital ${ledger.capital}`;
  if (
    result.dates.length !== ledger.dates.length ||
    result.dates.some((date, index) => date !== ledger.dates[index])
  )
    return "the run days are not the SPY calendar of the date range";
  const day = result.equity.findIndex(
    (value, index) => !close(value, ledger.equity[index] as number)
  );
  if (day >= 0) return `equity on ${result.dates[day]}`;
  if (
    result.openPositions.some(
      (count, index) => count !== ledger.openPositions[index]
    )
  )
    return "open positions";
  if (result.trades.length !== ledger.trades.length)
    return `${result.trades.length} trades; the run has ${ledger.trades.length}`;
  const maxLoss = new Map(
    own.outcome.priced.map((trade) => [trade.tradeId, trade.maxLoss])
  );
  for (const [index, trade] of result.trades.entries()) {
    const expected = ledger.trades[index] as (typeof ledger.trades)[number];
    const field = OPTIONS_TRADE_FIELDS.find(
      (key) => trade[key] !== expected[key]
    );
    const price = OPTIONS_TRADE_PRICES.find(
      (key) => !close(trade[key], expected[key])
    );
    const cents = OPTIONS_TRADE_CENTS.find(
      (key) => !(Math.abs(trade[key] - expected[key]) <= CENT)
    );
    const differs = field ?? price ?? cents;
    if (differs !== undefined) return `trade ${index + 1} ${differs}`;
    if (!close(trade.maxLoss, maxLoss.get(expected.id) as number))
      return `trade ${index + 1} maxLoss`;
  }
  if (
    canonicalJson(result.skipped) !== canonicalJson(ledger.skipped) ||
    result.bookSkipped !== own.outcome.bookSkipped
  )
    return "skipped trades";
  if (canonicalJson(result.signals) !== canonicalJson(own.outcome.signals))
    return "signals";
  const metric = optionsMetricsMismatch(result.metrics, own.metrics);
  return metric === null ? null : `metrics (${metric})`;
};

/**
 * The report of an options result, or the reason it does not fit the run: the API runs the
 * options runner on the same rows and the worker's ledger must be that run (optionsResultMismatch).
 * The report is the API's run with the worker's Nautilus gap.
 */
const optionsReport = (
  spec: BacktestRunRecord["spec"],
  definition: StrategyDefinition,
  bars: MarketBarColumns,
  daily: LoadedStrategySeries,
  result: BacktestRunEngineOptionsResult
): CheckedReport | string => {
  let own: OptionsRun;
  try {
    own = runOptionsOnRows(spec, definition, daily);
  } catch (error) {
    // The API's own run cannot book the stored rows; a code error (TypeError, RangeError) stays one.
    if (!(error instanceof InstantBacktestInputError)) throw error;
    return error.message;
  }
  const mismatch = optionsResultMismatch(result, own);
  if (mismatch !== null)
    return `The options result does not match the options run of the stored series: ${mismatch}`;
  return {
    report: optionsRunReport(spec, definition, bars, own, result.nautilusGap),
  };
};

/** The report of an equity engine result, or the reason it does not fit the bars. */
const equityReport = (
  run: BacktestRunRecord,
  bars: MarketBarColumns,
  result: BacktestRunEngineResult
): CheckedReport | string => {
  const { spec } = run;
  if (bars.t.length !== result.equity.length)
    return `The engine result has ${result.equity.length} bars; the date range has ${bars.t.length}`;
  // The stored stats are the API's own, computed from the worker's equity and trades.
  const equity = Float64Array.from(result.equity);
  // Same shape; the zod output marks optional fields `| undefined` (exactOptionalPropertyTypes).
  const trades = result.trades as InstantRunResult["trades"];
  const stats = summarize(bars, equity, trades, barsInPositionOf(trades));
  const mismatch = engineStatsMismatch(result.stats, stats);
  if (mismatch !== null)
    return `The engine stats do not match its equity and trades (${mismatch})`;
  const costs = costsForSpec(spec);
  const differences = differencesFor(run, { stats, trades });
  return {
    report: {
      ...buildBacktestRunReport(
        bars,
        { equity, stats, trades },
        spec.initialCapital,
        costs?.profile
      ),
      ...(differences === undefined ? {} : { differences }),
    },
  };
};

/**
 * Checks a result against the stored bars and daily series, recomputes its stats (options: its
 * metrics) and stores the report. A result that does not fit the run fails the run, so the user
 * sees the reason.
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
  let loaded: Awaited<ReturnType<typeof loadRunData>>;
  try {
    loaded = await loadRunData(dependencies, spec, false);
  } catch (error) {
    if (!(error instanceof InstantBacktestInputError)) throw error;
    return await reject(error.message);
  }
  if ("error" in loaded) return await reject(loaded.error);
  const { daily, definition } = loaded;
  const sha256 = loaded.seriesSha256;
  if (sha256 !== item.seriesSha256)
    return await reject(
      daily === null
        ? "The stored bars changed while the backtest was running"
        : "The stored bars or daily series changed while the backtest was running"
    );
  const options = definition?.options !== undefined;
  if (options !== "kind" in item.result)
    return await reject(
      options
        ? "An options run needs the options runner result"
        : "The options runner result is for options definitions only"
    );
  const checked =
    "kind" in item.result
      ? optionsReport(
          spec,
          definition as StrategyDefinition,
          loaded.bars,
          daily as LoadedStrategySeries,
          item.result
        )
      : equityReport(run, loaded.bars, item.result);
  if (typeof checked === "string") return await reject(checked);
  const stored = await dependencies.runs.complete(run.id, {
    ...checked.report,
    seriesSha256: sha256,
    ...(item.engineRun === undefined ? {} : { engineRun: item.engineRun }),
  });
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
