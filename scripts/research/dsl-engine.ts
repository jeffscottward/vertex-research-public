// Engine selection for the offline research scripts (core7-rerun.ts, quantjourney.ts). Switch plan
// step 3 (docs/vertex-rebuild/nautilus-backtest-engine.md): they run NautilusTrader by default and
// keep the TypeScript engine behind `--engine typescript`. A Nautilus run also runs every job on
// the TypeScript engine and fails when the unit equity differs by more than the parity tolerance,
// so a default run proves "equal to the parity figures". Research only: no orders.
import { join, resolve } from "node:path";
import { BACKTEST_RUN_ENGINE_VERSION } from "../../packages/api/src/contracts/backtest-runs.ts";
import type { BarColumns } from "../../packages/api/src/instant-backtest-engine.ts";
import type { StrategyDefinition } from "../../packages/api/src/strategy-dsl.ts";
import { runStrategyDefinition } from "../../packages/api/src/strategy-dsl-compile.ts";
import {
  type Batch,
  batchInput,
  DEFAULT_CAPITAL,
  relDiff,
  TOLERANCES,
} from "./nautilus-parity.ts";

export const ENGINE_NAMES = ["nautilus", "typescript"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];
const DEFAULT_ENGINE: EngineName = "nautilus";
export const NAUTILUS_ENGINE_ID = "nautilus-trader-1.227.0";
export const TYPESCRIPT_ENGINE_ID = BACKTEST_RUN_ENGINE_VERSION;

/** Unit equity (1 at the start) of one DSL definition on one bar series. */
export type DslRunner = (
  bars: BarColumns,
  definition: StrategyDefinition,
  costBps: number
) => readonly number[];

export type DslJob = Readonly<{
  bars: BarColumns;
  definition: StrategyDefinition;
  costBps: number;
}>;

export const typescriptRunner: DslRunner = (bars, definition, costBps) =>
  Array.from(runStrategyDefinition(bars, definition, costBps).equity);

/** The Python process and its files, passed in by the CLI (and by tests). */
export type NautilusIo = Readonly<{
  root: string;
  python: string;
  readText: (path: string) => string;
  writeText: (path: string, text: string) => void;
  /** A new empty folder for the batch files. */
  tempDir: () => string;
  /** Deletes that folder and its files. */
  removeDir: (path: string) => void;
  /**
   * Runs `python args` in `cwd`; a status other than 0 is a failure. `error` is set when the
   * process did not start (for example a wrong Python path).
   */
  spawn: (
    python: string,
    args: readonly string[],
    cwd: string
  ) => Readonly<{
    status: number | null;
    stderr: string | null;
    error?: Error;
  }>;
}>;

/** One-line hint for a Nautilus batch that could not run, printed by the research CLIs. */
const NAUTILUS_HINT =
  "pass --python <venv python with services/research/requirements-nautilus-linux-py312.lock> (or set VERTEX_NAUTILUS_PYTHON), or --engine typescript";

/** A Nautilus batch that failed or answered badly; `setupHint` when the Python setup is the likely cause. */
export class NautilusBatchError extends Error {
  readonly setupHint: boolean;
  constructor(message: string, setupHint: boolean) {
    super(message);
    this.name = "NautilusBatchError";
    this.setupHint = setupHint;
  }
}

const jobKey = (definition: StrategyDefinition, costBps: number): string =>
  JSON.stringify([definition, costBps]);

/**
 * Runs every job on Nautilus up front (one Python batch per bar series) and returns a runner that
 * answers from those results. Asking for a job that was not run throws, so a missed job never
 * falls back to the TypeScript engine. An input error of a case throws with its message.
 */
export const nautilusRunner = (
  jobs: readonly DslJob[],
  io: NautilusIo
): DslRunner => {
  const bySeries = new Map<BarColumns, Map<string, DslJob>>();
  for (const job of jobs) {
    const series = bySeries.get(job.bars) ?? new Map<string, DslJob>();
    series.set(jobKey(job.definition, job.costBps), job);
    bySeries.set(job.bars, series);
  }
  const results = new Map<BarColumns, Map<string, readonly number[]>>();
  const work = io.tempDir();
  try {
    let batchIndex = 0;
    for (const [bars, series] of bySeries) {
      results.set(
        bars,
        runBatch(io, join(work, `batch-${batchIndex}.json`), bars, series)
      );
      batchIndex += 1;
    }
  } finally {
    io.removeDir(work);
  }
  return (bars, definition, costBps) => {
    const equity = results.get(bars)?.get(jobKey(definition, costBps));
    if (equity === undefined)
      throw new Error("internal: dsl-engine job was not run up front");
    return equity;
  };
};

/** One Python batch: every job of one bar series. Returns unit equity by job key. */
const runBatch = (
  io: NautilusIo,
  input: string,
  bars: BarColumns,
  series: ReadonlyMap<string, DslJob>
): Map<string, readonly number[]> => {
  const keys = new Map(
    [...series.keys()].map((key, index) => [String(index), key])
  );
  const cases = [...keys].map(([id, key]) => {
    const job = series.get(key) as DslJob;
    return {
      id,
      spec: {
        costBps: job.costBps,
        costs: null,
        // Nautilus trades whole cents and quantity steps; the TS engine has no capital. The
        // parity suite's capital keeps that rounding far below the tolerance.
        initialCapital: DEFAULT_CAPITAL,
        rule: { definition: job.definition, kind: "dsl" as const },
        stopLossPct: 0,
        takeProfitPct: 0,
      },
      strategy: id,
    };
  });
  const output = `${input}.out`;
  io.writeText(input, batchInput(bars, cases));
  const run = io.spawn(
    io.python,
    ["-m", "nautilus_backtest", "batch", input, output],
    join(io.root, "services/research")
  );
  if (run.status !== 0) {
    // The last stderr line names the cause (a Python traceback ends with the exception).
    const detail =
      run.error?.message ??
      run.stderr?.trim().split("\n").filter(Boolean).at(-1) ??
      "";
    throw new NautilusBatchError(
      `nautilus batch failed (${detail || `status ${run.status}`})`,
      true
    );
  }
  let batch: Batch;
  try {
    batch = JSON.parse(io.readText(output)) as Batch;
  } catch (error) {
    throw new NautilusBatchError(
      `nautilus batch output unreadable (${(error as Error).message})`,
      false
    );
  }
  if (batch.engine !== NAUTILUS_ENGINE_ID)
    throw new NautilusBatchError(
      `nautilus batch engine ${batch.engine}, expected ${NAUTILUS_ENGINE_ID}`,
      true
    );
  const equity = new Map<string, readonly number[]>();
  for (const entry of Array.isArray(batch.results) ? batch.results : []) {
    const key = keys.get(entry.id);
    if (key === undefined || equity.has(key))
      throw new NautilusBatchError(
        `nautilus batch returned an unknown or repeated case ${entry.id}`,
        false
      );
    if (entry.result === undefined)
      throw new NautilusBatchError(
        `nautilus input error: ${entry.error ?? "no result"}`,
        false
      );
    equity.set(key, entry.result.equity);
  }
  if (equity.size !== keys.size)
    throw new NautilusBatchError(
      `nautilus batch returned ${equity.size} of ${keys.size} cases`,
      false
    );
  return equity;
};

export type EngineParity = Readonly<{
  /** Engine id of the reference runs (the TypeScript engine). */
  against: string;
  jobs: number;
  pass: number;
  /** Largest relative unit-equity difference over every bar of every job. */
  maxEquityRel: number;
  equityRelTolerance: number;
}>;

/** Compares each job's unit equity on both runners (relative difference at every bar). */
export const engineParity = (
  jobs: readonly DslJob[],
  runner: DslRunner,
  reference: DslRunner = typescriptRunner
): EngineParity => {
  let pass = 0;
  let maxEquityRel = 0;
  for (const job of jobs) {
    const a = runner(job.bars, job.definition, job.costBps);
    const b = reference(job.bars, job.definition, job.costBps);
    let worst = a.length === b.length ? 0 : Number.POSITIVE_INFINITY;
    for (let i = 0; i < Math.min(a.length, b.length); i += 1)
      worst = Math.max(worst, relDiff(a[i] as number, b[i] as number));
    maxEquityRel = Math.max(maxEquityRel, worst);
    if (worst <= TOLERANCES.equityRel) pass += 1;
  }
  return {
    against: TYPESCRIPT_ENGINE_ID,
    equityRelTolerance: TOLERANCES.equityRel,
    jobs: jobs.length,
    maxEquityRel,
    pass,
  };
};

/** The engine of one re-run: its id, its runner and (Nautilus only) the parity against TypeScript. */
export type PreparedEngine = Readonly<{
  engine: string;
  runner: DslRunner;
  parity: EngineParity | null;
}>;

export const typescriptEngine = (): PreparedEngine => ({
  engine: TYPESCRIPT_ENGINE_ID,
  parity: null,
  runner: typescriptRunner,
});

/** Runs every job on Nautilus, then on TypeScript for the parity check. */
export const nautilusEngine = (
  jobs: readonly DslJob[],
  io: NautilusIo
): PreparedEngine => {
  const runner = nautilusRunner(jobs, io);
  return {
    engine: NAUTILUS_ENGINE_ID,
    parity: engineParity(jobs, runner),
    runner,
  };
};

/** The engine named on the command line; `io` is used only for Nautilus. */
export const prepareEngine =
  (name: EngineName, io: NautilusIo) =>
  (jobs: readonly DslJob[]): PreparedEngine =>
    name === "typescript" ? typescriptEngine() : nautilusEngine(jobs, io);

/**
 * Runs `build`. A NautilusBatchError is printed as one line (with NAUTILUS_HINT when the Python
 * setup is the likely cause) and gives null; any other error is thrown as before.
 */
export const catchNautilusErrors = <T>(
  build: () => T,
  stderr: Readonly<{ write: (text: string) => unknown }>
): T | null => {
  try {
    return build();
  } catch (error) {
    if (!(error instanceof NautilusBatchError)) throw error;
    stderr.write(
      `${error.message}${error.setupHint ? `; ${NAUTILUS_HINT}` : ""}\n`
    );
    return null;
  }
};

/** Error text when a Nautilus run is outside the parity tolerance, else null. */
export const parityFailure = (parity: EngineParity | null): string | null =>
  parity === null || parity.pass === parity.jobs
    ? null
    : `Nautilus differs from ${parity.against} on ${parity.jobs - parity.pass} of ${parity.jobs} jobs (max unit-equity difference ${parity.maxEquityRel.toExponential(2)}, tolerance ${parity.equityRelTolerance}); results not written\n`;

/**
 * `--engine nautilus|typescript` (default nautilus) and `--python <path>` (default `defaultPython`,
 * else python3; a relative path is resolved from the current folder); null on a bad value.
 */
export const engineOptions = (
  args: readonly string[],
  defaultPython: string | undefined
): Readonly<{ engine: EngineName; python: string }> | null => {
  // A flag without a value reads as "" and is refused below.
  const value = (name: string, fallback: string): string => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : (args[index + 1] ?? "");
  };
  const engine = value("--engine", DEFAULT_ENGINE);
  if (!(ENGINE_NAMES as readonly string[]).includes(engine)) return null;
  const python = value("--python", defaultPython ?? "python3");
  if (python === "" || python.startsWith("--")) return null;
  // The batch runs in services/research, so a path is made absolute from the caller's folder;
  // a bare command name (python3) is looked up on PATH as before.
  return {
    engine: engine as EngineName,
    python: python.includes("/") ? resolve(python) : python,
  };
};
