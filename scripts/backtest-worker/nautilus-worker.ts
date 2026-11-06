// Nautilus backtest worker for the research host (user systemd service on the rig, never on the
// live trading node).
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... VERTEX_NAUTILUS_PYTHON=<venv>/bin/python \
//   bun run vertex:backtest-worker:nautilus [-- --once]
// Loop: claim the oldest queued Nautilus backtest run (backtestRuns.engine.claim) with an operator
// agent WRITE key, run `python -m nautilus_backtest run -` in services/research with the run's
// bars and spec on stdin, and post the result (backtestRuns.engine.complete) or the error
// (backtestRuns.engine.fail). The API builds the report. After a run it claims again at once;
// after an empty claim it waits VERTEX_WORKER_IDLE_MS (default 3000), then twice as long after
// each further empty claim up to VERTEX_WORKER_IDLE_MAX_MS (default 45000). `--once` runs one
// claim cycle.
// Request budget: the agent key limiter (better-auth api-key plugin) allows 600 accepted requests
// per key and resets the count only after more than 60 s with no accepted request on that key;
// requests that come 60 s apart or closer never reset it. The worker therefore sends at most
// REQUEST_BUDGET requests (a quarter of the limit, so the shared key stays below half of it with
// the other clients), then sends nothing for QUIET_PAUSE_MS. Whether the count then resets
// depends on the other clients of the key: see QUIET_PAUSE_MS. A 429 answer pauses the same way,
// or for its Retry-After when that is longer; during a delivery the worker waits at most once.
// SIGTERM stops the loop; a running engine process is killed and its run fails. After
// ALERT_AFTER_FAILURES failed cycles in a row (API errors, a result that could not be delivered,
// an engine crash or timeout; not an input error or an empty claim) it posts one alert line to
// VERTEX_ALERT_POST_URL / VERTEX_ALERT_CHANNEL (optional), and one recovery line on the next good
// cycle. Alert lines carry counts and error classes only, never the key or a payload. Research only:
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
/**
 * Longest idle wait. Above the 30 s quiet window plus the two-poll check (5 s) of
 * restart-when-idle.sh, with slack for an Autopilot tick log line that splits a gap.
 */
export const DEFAULT_IDLE_MAX_MS = 45_000;
/** Accepted requests per key before the limiter refuses (better-auth api-key plugin default). */
export const AGENT_KEY_LIMIT = 600;
/** The limiter resets a key's count after this long with no accepted request. */
export const AGENT_KEY_WINDOW_MS = 60_000;
/** Requests the worker sends before a quiet pause: a quarter of the key limit. */
export const REQUEST_BUDGET = AGENT_KEY_LIMIT / 4;
/**
 * Quiet pause: two limiter windows plus a margin (125 s). The worker sends nothing for this long.
 * The other client of the shared key is the Autopilot tick (vertex-autopilot.timer:
 * OnUnitActiveSec=1min plus the run time, one request per tick). With one tick inside the pause,
 * the two gaps add up to 125 s, so one is over 60 s; with two ticks, the gap between them is over
 * 60 s. Either way the count resets. It depends on ticks being more than 60 s apart with one
 * request each; a separate worker key is the robust fix (the owner chose to reuse the Autopilot key).
 */
export const QUIET_PAUSE_MS = 2 * AGENT_KEY_WINDOW_MS + 5000;
/**
 * The API fails a run left running this long (backtestRuns.get, BACKTEST_RUN_STALE_MS); a result
 * delivered later gets 409 and is lost, so a 429 wait during delivery ends this margin before it.
 */
export const API_STALE_MS = 10 * 60 * 1000;
export const DELIVERY_MARGIN_MS = 30_000;
/** Below this time left a 429 during delivery gives up instead of trying again. */
export const DELIVERY_MIN_WAIT_MS = 1000;
/**
 * complete tries after a network error or a 5xx answer, with doubling waits from the first. A 429
 * is tried again once, after the limiter wait cut to the time left before the API stale limit.
 */
export const COMPLETE_ATTEMPTS = 4;
export const COMPLETE_RETRY_MS = 1000;
export const UNDELIVERED_ERROR = "Could not deliver the Nautilus result";
export const REJECTED_ERROR = "The API rejected the Nautilus result";
/** Failed cycles in a row before the one alert of an incident. */
const ALERT_AFTER_FAILURES = 3;
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
  idleMaxMs: number;
  /** API requests sent since the last quiet pause. */
  budget: { requests: number };
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

/** Longest wait for one API request and for one alert post. */
const API_TIMEOUT_MS = 60_000;
const ALERT_TIMEOUT_MS = 5000;

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

/** A positive whole number of milliseconds from the environment, or the default. */
const milliseconds = (
  env: NautilusWorkerIo["env"],
  name: "VERTEX_WORKER_IDLE_MS" | "VERTEX_WORKER_IDLE_MAX_MS",
  fallback: number
): number => {
  const text = env[name]?.trim();
  const value = text === undefined || text === "" ? fallback : Number(text);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive whole number`);
  return value;
};

const readConfig = (env: NautilusWorkerIo["env"]): Config => {
  const idleMs = milliseconds(env, "VERTEX_WORKER_IDLE_MS", DEFAULT_IDLE_MS);
  const idleMaxMs = milliseconds(
    env,
    "VERTEX_WORKER_IDLE_MAX_MS",
    Math.max(DEFAULT_IDLE_MAX_MS, idleMs)
  );
  if (idleMaxMs < idleMs)
    throw new Error(
      "VERTEX_WORKER_IDLE_MAX_MS must not be below VERTEX_WORKER_IDLE_MS"
    );
  return {
    apiKey: required(env, "VERTEX_AGENT_API_KEY"),
    budget: { requests: 0 },
    idleMaxMs,
    idleMs,
    origin: new URL(required(env, "VERTEX_ORIGIN")).origin,
    python: required(env, "VERTEX_NAUTILUS_PYTHON"),
  };
};

/** Retry-After as milliseconds (delta seconds or an HTTP date), or null when absent or invalid. */
export const retryAfterMs = (
  value: string | null,
  now: number
): number | null => {
  const text = value?.trim() ?? "";
  if (text === "") return null;
  if (/^\d+$/u.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
};

/** An HTTP error answer of the API: its status, its Retry-After and a short body only. */
class ApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(
    path: string,
    status: number,
    body: string,
    retryAfter: number | null
  ) {
    super(`${path} returned HTTP ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.retryAfterMs = retryAfter;
  }
}

/** The wait after a 429 answer: the quiet pause, or Retry-After when longer. */
const rateLimitWait = (error: ApiError): number =>
  Math.max(QUIET_PAUSE_MS, error.retryAfterMs ?? 0);

/** Calls one oRPC procedure with the write key. */
const call = async (
  config: Config,
  io: NautilusWorkerIo,
  path: string,
  input: unknown
): Promise<unknown> => {
  config.budget.requests += 1;
  const response = await io.post(`${config.origin}/api/orpc/${path}`, {
    body: JSON.stringify({ json: input }),
    headers: {
      "content-type": "application/json",
      origin: config.origin,
      "x-api-key": config.apiKey,
    },
    method: "POST",
    // A hung API request must not stop the claim loop.
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok)
    throw new ApiError(
      path,
      response.status,
      text,
      retryAfterMs(response.headers.get("retry-after"), Date.now())
    );
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
  | Readonly<{
      error: string;
      detail?: string;
      /** Error class of an engine failure (crash, timeout); absent for input errors and stops. */
      failure?: string;
    }>;

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
      failure: "engine timeout",
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
      failure: "Nautilus missing (exit 3)",
    };
  const parsed = CliResultSchema.safeParse(body);
  if (outcome.code !== 0 || !parsed.success)
    return {
      detail,
      error: `Nautilus engine failed (exit ${outcome.code})`,
      failure: `engine exit ${outcome.code}`,
    };
  const { engine, equity, stats, trades } = parsed.data;
  if (engine !== BACKTEST_RUN_NAUTILUS_ENGINE)
    return {
      error: `The worker engine ${engine} does not match the run engine ${BACKTEST_RUN_NAUTILUS_ENGINE}`,
      failure: "engine version mismatch",
    };
  return { result: { equity, stats, trades } };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The wait before the next delivery try, or null to give up: a network error or a 5xx answer waits
 * 1, 2, 4 s; a 429 waits once for the limiter, never past the API stale limit of the run, and gives
 * up when less than DELIVERY_MIN_WAIT_MS is left.
 */
const deliveryWait = (
  error: unknown,
  attempt: number,
  limited: { used: boolean },
  claimedAt: number
): number | null => {
  if (attempt === COMPLETE_ATTEMPTS) return null;
  if (!(error instanceof ApiError && error.status === 429))
    return COMPLETE_RETRY_MS * 2 ** (attempt - 1);
  if (limited.used) return null;
  limited.used = true;
  const left = claimedAt + API_STALE_MS - DELIVERY_MARGIN_MS - Date.now();
  // No time left for a wait: a try at once would meet the same limiter.
  if (left < DELIVERY_MIN_WAIT_MS) return null;
  return Math.min(rateLimitWait(error), left);
};

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
  result: unknown,
  claimedAt: number
): Promise<string | null> => {
  const limited = { used: false };
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
      const wait = deliveryWait(error, attempt, limited, claimedAt);
      if (wait === null) return UNDELIVERED_ERROR;
      await io.sleep(wait, io.signal);
      // Only a full quiet pause starts a new request budget.
      if (wait >= QUIET_PAUSE_MS) config.budget.requests = 0;
    }
  }
};

/**
 * One claim cycle: whether a run was claimed, the error class when the cycle failed, and the wait
 * a 429 answer asks for.
 */
type Cycle = Readonly<{
  found: boolean;
  failure: string | null;
  rateLimitMs?: number;
}>;

/** One claim cycle. Throws on an API error of claim or fail. */
const workOnce = async (
  config: Config,
  io: NautilusWorkerIo
): Promise<Cycle> => {
  const engine = BACKTEST_RUN_NAUTILUS_ENGINE;
  const { run } = BacktestRunEngineClaimOutputSchema.parse(
    await call(config, io, "backtestRuns/engine/claim", { engine })
  );
  if (run === null) return { failure: null, found: false };
  const claimedAt = Date.now();
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
    const error = await deliver(config, io, run, output.result, claimedAt);
    if (error === null) io.stdout.write(`run ${run.id}: succeeded\n`);
    // A refused fail (the run already finished) changes nothing; the next claim goes on.
    else if (error !== "")
      await call(config, io, "backtestRuns/engine/fail", {
        engine,
        error,
        id: run.id,
      }).catch((refused: unknown) =>
        io.stderr.write(`run ${run.id}: ${messageOf(refused)}\n`)
      );
    const failure =
      error === null || error === ""
        ? null
        : error === UNDELIVERED_ERROR
          ? "result not delivered"
          : "result rejected";
    return { failure, found: true };
  }
  if (output.detail !== undefined && output.detail !== "")
    io.stderr.write(`run ${run.id}: engine stderr: ${output.detail}\n`);
  await call(config, io, "backtestRuns/engine/fail", {
    engine,
    error: output.error,
    id: run.id,
  });
  io.stdout.write(`run ${run.id}: failed: ${output.error}\n`);
  return { failure: output.failure ?? null, found: true };
};

/** Class of a thrown cycle error for the alert line: the HTTP status or the error name. */
const errorClass = (error: unknown): string =>
  error instanceof ApiError
    ? `HTTP ${error.status}`
    : error instanceof Error
      ? error.name
      : "unknown error";

/** Posts one line to the optional chat endpoint ({channel, text}); never throws. */
const postAlert = async (io: NautilusWorkerIo, text: string): Promise<void> => {
  const url = io.env["VERTEX_ALERT_POST_URL"]?.trim() ?? "";
  const channel = io.env["VERTEX_ALERT_CHANNEL"]?.trim() ?? "";
  if (url === "" || channel === "") return;
  const response = await io
    .post(url, {
      body: JSON.stringify({ channel, text }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    })
    .catch(() => null);
  const body: unknown =
    response?.ok === true ? await response.json().catch(() => null) : null;
  if (
    typeof body === "object" &&
    body !== null &&
    "ok" in body &&
    body.ok === true
  )
    io.stdout.write(`alert posted to ${channel}\n`);
  else io.stderr.write("nautilus worker: alert post failed\n");
};

/** Sends nothing for `ms`, then starts a new request budget. */
const quiet = async (
  config: Config,
  io: NautilusWorkerIo,
  ms: number
): Promise<void> => {
  await io.sleep(ms, io.signal);
  config.budget.requests = 0;
};

/** Failed cycles in a row and whether this incident was alerted. */
interface AlertState {
  failures: number;
  alerted: boolean;
}

/** One alert per incident (ALERT_AFTER_FAILURES failed cycles in a row), one recovery line after. */
const noteCycle = async (
  io: NautilusWorkerIo,
  state: AlertState,
  failure: string | null
): Promise<void> => {
  if (failure === null) {
    if (state.alerted)
      await postAlert(
        io,
        `Vertex Nautilus backtest worker recovered after ${state.failures} failed cycles.`
      );
    state.failures = 0;
    state.alerted = false;
    return;
  }
  state.failures += 1;
  if (state.failures !== ALERT_AFTER_FAILURES) return;
  state.alerted = true;
  await postAlert(
    io,
    `Vertex Nautilus backtest worker: ${state.failures} cycles failed in a row (last: ${failure}). Research only; see journalctl --user -u vertex-nautilus-worker.`
  );
};

/**
 * Waits after a cycle and returns the next idle wait: the limiter wait after a 429, none after
 * work, else the idle wait (doubled for the next empty claim, up to the cap); then a quiet pause
 * when the request budget is used.
 */
const waitAfter = async (
  config: Config,
  io: NautilusWorkerIo,
  cycle: Cycle,
  idleMs: number
): Promise<number> => {
  let next = idleMs;
  if (cycle.rateLimitMs !== undefined) {
    io.stderr.write(
      `nautilus worker: agent key rate limited; quiet for ${Math.round(cycle.rateLimitMs / 1000)} s\n`
    );
    await quiet(config, io, cycle.rateLimitMs);
    next = config.idleMs;
  } else if (cycle.found) next = config.idleMs;
  else {
    await io.sleep(idleMs, io.signal);
    next = Math.min(idleMs * 2, config.idleMaxMs);
  }
  if (config.budget.requests >= REQUEST_BUDGET) {
    io.stdout.write(
      `nautilus worker: ${config.budget.requests} requests sent; quiet for ${QUIET_PAUSE_MS / 1000} s so the agent key limiter resets\n`
    );
    await quiet(config, io, QUIET_PAUSE_MS);
  }
  return next;
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
  const alerts: AlertState = { alerted: false, failures: 0 };
  let idleMs = config.idleMs;
  while (!io.signal.aborted) {
    let cycle: Cycle;
    try {
      cycle = await workOnce(config, io);
    } catch (error) {
      io.stderr.write(`nautilus worker: ${messageOf(error)}\n`);
      if (once) return 1;
      cycle = {
        failure: errorClass(error),
        found: false,
        ...(error instanceof ApiError && error.status === 429
          ? { rateLimitMs: rateLimitWait(error) }
          : {}),
      };
    }
    if (once) return 0;
    await noteCycle(io, alerts, cycle.failure);
    idleMs = await waitAfter(config, io, cycle, idleMs);
  }
  return 0;
};
