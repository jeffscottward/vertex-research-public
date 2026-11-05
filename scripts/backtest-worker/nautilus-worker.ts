// Nautilus backtest worker for the research host (user systemd service on the rig, never on the
// live trading node).
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... VERTEX_NAUTILUS_PYTHON=<venv>/bin/python \
//   bun run vertex:backtest-worker:nautilus [-- --once]
// Loop: claim the oldest queued Nautilus backtest run (backtestRuns.engine.claim) with an operator
// agent WRITE key, run `python -m nautilus_backtest run -` in services/research with the run's
// bars and spec on stdin, and post the result (backtestRuns.engine.complete) or the error
// (backtestRuns.engine.fail). The API builds the report. After a run it claims again at once;
// with no run it waits VERTEX_WORKER_IDLE_MS (default 3000). `--once` runs one claim cycle.
// SIGTERM stops the loop; a running engine process is killed and its run fails. Research only:
// the worker sends HTTP requests to Vertex and starts the engine process, nothing else. The key
// is never printed.

import { spawn } from "node:child_process";
import { z } from "zod";

import {
  BACKTEST_RUN_ENGINE_ERROR_MAX,
  BACKTEST_RUN_NAUTILUS_ENGINE,
  type BacktestRunEngineClaimOutput,
  BacktestRunEngineClaimOutputSchema,
} from "../../packages/api/src/contracts/backtest-runs.ts";

/** Engine run limit. Below the API stale limit (10 min), so the worker reports its own timeout. */
export const NAUTILUS_RUN_TIMEOUT_MS = 9 * 60 * 1000;
export const DEFAULT_IDLE_MS = 3000;
/** complete tries after a network error, a 429 or a 5xx answer, with doubling waits from the first. */
export const COMPLETE_ATTEMPTS = 4;
export const COMPLETE_RETRY_MS = 1000;
export const UNDELIVERED_ERROR = "Could not deliver the Nautilus result";
export const REJECTED_ERROR = "The API rejected the Nautilus result";
/** Engine stderr kept for the worker log. */
const STDERR_LOG_MAX = 2000;

export type CommandOutcome = Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
  /** Killed after the timeout. */
  timedOut: boolean;
  /** Killed because the worker is stopping. */
  stopped: boolean;
}>;

export type CommandOptions = Readonly<{
  cwd: string;
  input: string;
  timeoutMs: number;
  signal: AbortSignal;
}>;

export type RunCommand = (
  command: string,
  args: readonly string[],
  options: CommandOptions
) => Promise<CommandOutcome>;

export type NautilusWorkerIo = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  post: (url: string, init: RequestInit) => Promise<Response>;
  runCommand: RunCommand;
  /** services/research, where the nautilus_backtest package lives. */
  researchDir: string;
  /** Aborted on SIGTERM or SIGINT. */
  signal: AbortSignal;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  stdout: Readonly<{ write: (text: string) => unknown }>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
}>;

type Config = Readonly<{
  origin: string;
  apiKey: string;
  python: string;
  idleMs: number;
}>;

type ClaimedRun = NonNullable<BacktestRunEngineClaimOutput["run"]>;

/** Runs a command with `input` on stdin; kills it after the timeout or on abort. */
export const runCommand: RunCommand = (command, args, options) => {
  const { promise, resolve } = Promise.withResolvers<CommandOutcome>();
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let timedOut = false;
  let stopped = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);
  const stop = () => {
    stopped = true;
    child.kill("SIGKILL");
  };
  options.signal.addEventListener("abort", stop, { once: true });
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  // A child that exits before it reads all input closes stdin early; its exit code reports why.
  child.stdin.on("error", () => undefined);
  const finish = (code: number | null, error?: Error) => {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", stop);
    resolve({
      code,
      stderr:
        error === undefined
          ? Buffer.concat(stderr).toString("utf8")
          : error.message,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stopped,
      timedOut,
    });
  };
  child.on("error", (error) => finish(null, error));
  child.on("close", (code) => finish(code));
  if (options.signal.aborted) stop();
  child.stdin.end(options.input);
  return promise;
};

/** A signal that aborts on SIGTERM or SIGINT of `target` (the process), so the worker stops cleanly. */
export const stopSignal = (
  target: Readonly<{
    on: (name: "SIGTERM" | "SIGINT", listener: () => void) => unknown;
  }>
): AbortSignal => {
  const controller = new AbortController();
  for (const name of ["SIGTERM", "SIGINT"] as const)
    target.on(name, () => controller.abort());
  return controller.signal;
};

/** Waits `ms`, or less when the signal aborts. */
export const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
  if (signal.aborted) done();
  return promise;
};

const required = (
  env: NautilusWorkerIo["env"],
  name: "VERTEX_ORIGIN" | "VERTEX_AGENT_API_KEY" | "VERTEX_NAUTILUS_PYTHON"
): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
};

const readConfig = (env: NautilusWorkerIo["env"]): Config => {
  const idle = env["VERTEX_WORKER_IDLE_MS"]?.trim();
  const idleMs =
    idle === undefined || idle === "" ? DEFAULT_IDLE_MS : Number(idle);
  if (!Number.isInteger(idleMs) || idleMs < 1)
    throw new Error("VERTEX_WORKER_IDLE_MS must be a positive whole number");
  return {
    apiKey: required(env, "VERTEX_AGENT_API_KEY"),
    idleMs,
    origin: new URL(required(env, "VERTEX_ORIGIN")).origin,
    python: required(env, "VERTEX_NAUTILUS_PYTHON"),
  };
};

/** An HTTP error answer of the API: its status and a short body only. */
class ApiError extends Error {
  readonly status: number;
  constructor(path: string, status: number, body: string) {
    super(`${path} returned HTTP ${status}: ${body.slice(0, 300)}`);
    this.status = status;
  }
}

/** Calls one oRPC procedure with the write key. */
const call = async (
  config: Config,
  io: NautilusWorkerIo,
  path: string,
  input: unknown
): Promise<unknown> => {
  const response = await io.post(`${config.origin}/api/orpc/${path}`, {
    body: JSON.stringify({ json: input }),
    headers: {
      "content-type": "application/json",
      origin: config.origin,
      "x-api-key": config.apiKey,
    },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) throw new ApiError(path, response.status, text);
  const body: unknown = JSON.parse(text);
  return typeof body === "object" && body !== null && "json" in body
    ? body.json
    : undefined;
};

/** The engine request: the run's spec with the resolved costs and sector points. */
export const engineRequest = (run: ClaimedRun): string =>
  JSON.stringify({
    bars: run.bars,
    spec: {
      ...run.spec,
      costs: run.costs,
      ...(run.sectorQuadrants === null
        ? {}
        : { sectorQuadrants: run.sectorQuadrants }),
    },
  });

/** `run` prints a RunResult, or {"error": ...} with exit status 2. */
const CliResultSchema = z.object({
  engine: z.string(),
  equity: z.unknown(),
  stats: z.unknown(),
  trades: z.unknown(),
});
const CliErrorSchema = z.object({ error: z.string() });

type EngineOutput =
  | Readonly<{
      result: Readonly<{ equity: unknown; stats: unknown; trades: unknown }>;
    }>
  | Readonly<{ error: string; detail?: string }>;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Maps the CLI outcome to a result or a run error (exit 2: input error, exit 3: no Nautilus). */
export const readEngineOutput = (outcome: CommandOutcome): EngineOutput => {
  const detail = outcome.stderr.slice(-STDERR_LOG_MAX);
  if (outcome.stopped)
    return { error: "The Nautilus worker stopped before the run finished" };
  if (outcome.timedOut)
    return {
      error: `The Nautilus backtest took longer than ${NAUTILUS_RUN_TIMEOUT_MS / 60_000} minutes`,
    };
  const body = parseJson(outcome.stdout);
  const inputError = CliErrorSchema.safeParse(body);
  if (outcome.code === 2 && inputError.success)
    return {
      error: inputError.data.error.slice(0, BACKTEST_RUN_ENGINE_ERROR_MAX),
    };
  if (outcome.code === 3)
    return {
      detail,
      error: "Nautilus is not installed on the research worker",
    };
  const parsed = CliResultSchema.safeParse(body);
  if (outcome.code !== 0 || !parsed.success)
    return { detail, error: `Nautilus engine failed (exit ${outcome.code})` };
  const { engine, equity, stats, trades } = parsed.data;
  if (engine !== BACKTEST_RUN_NAUTILUS_ENGINE)
    return {
      error: `The worker engine ${engine} does not match the run engine ${BACKTEST_RUN_NAUTILUS_ENGINE}`,
    };
  return { result: { equity, stats, trades } };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Posts the result. Returns null when it was stored, "" when the run is no longer running on this
 * engine (409: nothing to do), or the error to store. A network error, a 429 or a 5xx answer is tried
 * again after a wait; any other 4xx is a rejection (the API fails the run itself when the result
 * does not fit the bars; a contract rejection leaves it running, so the worker fails it).
 */
const deliver = async (
  config: Config,
  io: NautilusWorkerIo,
  run: ClaimedRun,
  result: unknown
): Promise<string | null> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await call(config, io, "backtestRuns/engine/complete", {
        engine: BACKTEST_RUN_NAUTILUS_ENGINE,
        id: run.id,
        result,
        seriesSha256: run.seriesSha256,
      });
      return null;
    } catch (error) {
      io.stderr.write(`run ${run.id}: ${messageOf(error)}\n`);
      if (
        error instanceof ApiError &&
        error.status < 500 &&
        error.status !== 429
      )
        return error.status === 409 ? "" : REJECTED_ERROR;
      if (attempt === COMPLETE_ATTEMPTS) return UNDELIVERED_ERROR;
      await io.sleep(COMPLETE_RETRY_MS * 2 ** (attempt - 1), io.signal);
    }
  }
};

/** One claim cycle. Returns true when a run was claimed. */
const workOnce = async (
  config: Config,
  io: NautilusWorkerIo
): Promise<boolean> => {
  const engine = BACKTEST_RUN_NAUTILUS_ENGINE;
  const { run } = BacktestRunEngineClaimOutputSchema.parse(
    await call(config, io, "backtestRuns/engine/claim", { engine })
  );
  if (run === null) return false;
  const outcome = await io.runCommand(
    config.python,
    ["-m", "nautilus_backtest", "run", "-"],
    {
      cwd: io.researchDir,
      input: engineRequest(run),
      signal: io.signal,
      timeoutMs: NAUTILUS_RUN_TIMEOUT_MS,
    }
  );
  const output = readEngineOutput(outcome);
  if ("result" in output) {
    const error = await deliver(config, io, run, output.result);
    if (error === null) io.stdout.write(`run ${run.id}: succeeded\n`);
    // A refused fail (the run already finished) changes nothing; the next claim goes on.
    else if (error !== "")
      await call(config, io, "backtestRuns/engine/fail", {
        engine,
        error,
        id: run.id,
      }).catch((failure: unknown) =>
        io.stderr.write(`run ${run.id}: ${messageOf(failure)}\n`)
      );
    return true;
  }
  if (output.detail !== undefined && output.detail !== "")
    io.stderr.write(`run ${run.id}: engine stderr: ${output.detail}\n`);
  await call(config, io, "backtestRuns/engine/fail", {
    engine,
    error: output.error,
    id: run.id,
  });
  io.stdout.write(`run ${run.id}: failed: ${output.error}\n`);
  return true;
};

/** Runs the worker loop (or one cycle with --once) and returns the process exit code. */
export const runNautilusWorker = async (
  argv: readonly string[],
  io: NautilusWorkerIo
): Promise<number> => {
  let config: Config;
  try {
    const unknown = argv.filter((arg) => arg !== "--once");
    if (unknown.length > 0) throw new Error(`Unknown argument ${unknown[0]}`);
    config = readConfig(io.env);
  } catch (error) {
    io.stderr.write(`nautilus worker: ${messageOf(error)}\n`);
    return 1;
  }
  const once = argv.includes("--once");
  while (!io.signal.aborted) {
    let found = false;
    try {
      found = await workOnce(config, io);
    } catch (error) {
      io.stderr.write(`nautilus worker: ${messageOf(error)}\n`);
      if (once) return 1;
    }
    if (once) return 0;
    if (!found) await io.sleep(config.idleMs, io.signal);
  }
  return 0;
};
