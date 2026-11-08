// Engine selection for the offline research scripts (core7-rerun.ts, quantjourney.ts). Switch plan
// step 3 (docs/vertex-rebuild/nautilus-backtest-engine.md): they run NautilusTrader by default and
// keep the TypeScript engine behind `--engine typescript`. A Nautilus run also runs every job on
// the TypeScript engine and fails when the unit equity differs by more than the parity tolerance,
// so a default run proves "equal to the parity figures". Research only: no orders.
import { join } from "node:path";
import { BACKTEST_RUN_ENGINE_VERSION } from "../../packages/api/src/contracts/backtest-runs.ts";
import type { BarColumns } from "../../packages/api/src/instant-backtest-engine.ts";
import type { StrategyDefinition } from "../../packages/api/src/strategy-dsl.ts";
import { runStrategyDefinition } from "../../packages/api/src/strategy-dsl-compile.ts";
import {
  type Batch,
  batchInput,
  relDiff,
  TOLERANCES,
} from "./nautilus-parity.ts";

export const ENGINE_NAMES = ["nautilus", "typescript"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];
const DEFAULT_ENGINE: EngineName = "nautilus";
export const NAUTILUS_ENGINE_ID = "nautilus-trader-1.227.0";
export const TYPESCRIPT_ENGINE_ID = BACKTEST_RUN_ENGINE_VERSION;
/** Run capital of the Nautilus batches (USD); the same as DEFAULT_CAPITAL in nautilus-parity.ts. */
const NAUTILUS_CAPITAL = 1_000_000;

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
  /** Runs `python args` in `cwd`; a status other than 0 is a failure. */
  spawn: (
    python: string,
    args: readonly string[],
    cwd: string
  ) => Readonly<{ status: number | null; stderr: string }>;
}>;

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
  let batchIndex = 0;
  for (const [bars, series] of bySeries) {
    const keys = [...series.keys()];
    const cases = keys.map((key, index) => {
      const job = series.get(key) as DslJob;
      return {
        id: String(index),
        spec: {
          costBps: job.costBps,
          costs: null,
          // Nautilus trades whole cents and quantity steps; the TS engine has no capital. The
          // parity suite's capital keeps that rounding far below the tolerance.
          initialCapital: NAUTILUS_CAPITAL,
          rule: { definition: job.definition, kind: "dsl" as const },
          stopLossPct: 0,
          takeProfitPct: 0,
        },
        strategy: String(index),
      };
    });
    const input = join(work, `batch-${batchIndex}.json`);
    batchIndex += 1;
    const output = `${input}.out`;
    io.writeText(input, batchInput(bars, cases));
    const run = io.spawn(
      io.python,
      ["-m", "nautilus_backtest", "batch", input, output],
      join(io.root, "services/research")
    );
    if (run.status !== 0)
      throw new Error(`nautilus batch failed for ${input}: ${run.stderr}`);
    const batch = JSON.parse(io.readText(output)) as Batch;
    if (batch.engine !== NAUTILUS_ENGINE_ID)
      throw new Error(
        `nautilus batch engine ${batch.engine}, expected ${NAUTILUS_ENGINE_ID}`
      );
    const equity = new Map<string, readonly number[]>();
    for (const entry of batch.results) {
      const key = keys[Number(entry.id)];
      if (key === undefined) throw new Error(`unknown batch case ${entry.id}`);
      if (entry.result === undefined)
        throw new Error(`nautilus input error: ${entry.error ?? "no result"}`);
      equity.set(key, entry.result.equity);
    }
    results.set(bars, equity);
  }
  return (bars, definition, costBps) => {
    const equity = results.get(bars)?.get(jobKey(definition, costBps));
    if (equity === undefined)
      throw new Error("nautilus runner: this job was not run up front");
    return equity;
  };
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

/** Error text when a Nautilus run is outside the parity tolerance, else null. */
export const parityFailure = (parity: EngineParity | null): string | null =>
  parity === null || parity.pass === parity.jobs
    ? null
    : `Nautilus differs from ${parity.against} on ${parity.jobs - parity.pass} of ${parity.jobs} jobs (max unit-equity difference ${parity.maxEquityRel.toExponential(2)}, tolerance ${parity.equityRelTolerance}); results not written\n`;

/**
 * `--engine nautilus|typescript` (default nautilus) and `--python <path>` (default `defaultPython`,
 * else python3); null on a bad value.
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
  return { engine: engine as EngineName, python };
};
