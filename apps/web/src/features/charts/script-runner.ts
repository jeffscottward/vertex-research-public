// Main-thread side of script execution: one module Web Worker, one run at a time, a hard
// time limit. A run that does not answer in time terminates the worker (a fresh one is
// started for the next run), so a runaway script cannot freeze the chart. Runs queued under
// one key are latest-wins: a newer run replaces an older one that has not started.

import type { RunResult, ScriptBar } from "@darkfactory/scripting";
import {
  SCRIPT_WORKER_READY,
  type ScriptInputs,
  type ScriptRunRequest,
  scriptFailure,
} from "./script-sandbox.ts";

export const SCRIPT_TIMEOUT_MS = 3000;
// Loading the worker module (and the engine) is not counted against a script's time.
const SCRIPT_STARTUP_TIMEOUT_MS = 20_000;
export const WORKER_UNAVAILABLE =
  "Scripts need Web Worker support, which this browser does not provide.";
// The result of a queued run replaced by a newer one with the same key. Compare by identity.
export const SCRIPT_RUN_SUPERSEDED: RunResult = Object.freeze({
  errors: Object.freeze([
    Object.freeze({ column: 1, line: 1, message: "Replaced by a newer run." }),
  ]),
  ok: false,
});

export type ScriptWorkerLike = Readonly<{
  postMessage: (message: ScriptRunRequest) => void;
  terminate: () => void;
  addEventListener: (
    type: "message" | "error" | "messageerror",
    listener: (event: Event) => void
  ) => void;
}>;

export type ScriptRunner = Readonly<{
  // key: runs with the same key are coalesced while queued (latest wins).
  run: (
    source: string,
    bars: readonly ScriptBar[],
    inputs: ScriptInputs,
    key?: string
  ) => Promise<RunResult>;
  dispose: () => void;
}>;

export type ScriptRunnerOptions = Readonly<{
  // Returns null when workers are unavailable. Defaults to the bundled module worker.
  createWorker?: () => ScriptWorkerLike | null;
  timeoutMs?: number;
  startupTimeoutMs?: number;
}>;

// The literal `new Worker(new URL(..., import.meta.url))` form is what Vite bundles.
const defaultWorker = (): ScriptWorkerLike | null =>
  typeof Worker === "undefined"
    ? null
    : new Worker(new URL("./script-worker.ts", import.meta.url), {
        name: "vx-script",
        type: "module",
      });

// Shape check for what comes back from the worker; the engine output itself is
// validated again by the renderer before it is drawn.
export const isRunResult = (value: unknown): value is RunResult => {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return result["ok"] === true
    ? Array.isArray(result["plots"]) &&
        Array.isArray(result["signals"]) &&
        Array.isArray(result["inputs"]) &&
        typeof result["title"] === "string" &&
        typeof result["overlay"] === "boolean"
    : result["ok"] === false && Array.isArray(result["errors"]);
};

type Job = Readonly<{
  key: string | undefined;
  request: Omit<ScriptRunRequest, "id">;
  resolve: (result: RunResult) => void;
}>;
type Pending = Readonly<{
  id: number;
  resolve: (result: RunResult) => void;
}>;

export const createScriptRunner = ({
  createWorker = defaultWorker,
  timeoutMs = SCRIPT_TIMEOUT_MS,
  startupTimeoutMs = SCRIPT_STARTUP_TIMEOUT_MS,
}: ScriptRunnerOptions = {}): ScriptRunner => {
  let worker: ScriptWorkerLike | null = null;
  let ready = false;
  let pending: Pending | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Job[] = [];
  let nextId = 1;
  let disposed = false;
  const startTimer = (ms: number, message: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => fail(message), ms);
  };
  const runTimer = () =>
    startTimer(
      timeoutMs,
      `Script stopped after ${timeoutMs / 1000} s without finishing. Check for very long loops.`
    );
  const settle = (result: RunResult) => {
    const current = pending;
    if (current === null) return;
    pending = null;
    clearTimeout(timer);
    current.resolve(result);
    next();
  };
  const stop = () => {
    worker?.terminate();
    worker = null;
    ready = false;
  };
  function fail(message: string) {
    stop();
    settle(scriptFailure(message));
  }
  const start = (): ScriptWorkerLike | null => {
    if (worker !== null) return worker;
    try {
      const created = createWorker();
      if (created === null) return null;
      created.addEventListener("message", (event) => {
        if (created !== worker) return;
        const data = (event as MessageEvent<unknown>).data as
          | Readonly<{ id?: unknown; result?: unknown; type?: unknown }>
          | null
          | undefined;
        if (data?.type === SCRIPT_WORKER_READY) {
          ready = true;
          if (pending !== null) runTimer();
          return;
        }
        if (pending === null || data?.id !== pending.id) return;
        if (isRunResult(data?.result)) settle(data.result);
        else fail("The script worker sent an unreadable result.");
      });
      created.addEventListener("error", () => {
        if (created === worker)
          fail("The script worker stopped with an error.");
      });
      created.addEventListener("messageerror", () => {
        if (created === worker)
          fail("The script worker sent an unreadable result.");
      });
      worker = created;
      return created;
    } catch {
      return null;
    }
  };
  // Starts the oldest queued job when nothing is running.
  function next() {
    if (pending !== null) return;
    const job = queue.shift();
    if (job === undefined) return;
    if (disposed) {
      job.resolve(scriptFailure("Script runner stopped."));
      next();
      return;
    }
    const target = start();
    if (target === null) {
      job.resolve(scriptFailure(WORKER_UNAVAILABLE));
      next();
      return;
    }
    const id = nextId;
    nextId += 1;
    pending = { id, resolve: job.resolve };
    if (ready) runTimer();
    else
      startTimer(
        startupTimeoutMs,
        "The script worker did not start in time. Reload the page to try again."
      );
    try {
      target.postMessage({ ...job.request, id });
    } catch {
      fail("Chart bars could not be sent to the script worker.");
    }
  }
  return {
    dispose: () => {
      disposed = true;
      for (const job of queue.splice(0))
        job.resolve(scriptFailure("Script runner stopped."));
      fail("Script runner stopped.");
    },
    run: (source, bars, inputs, key) => {
      if (key !== undefined) {
        const older = queue.findIndex((job) => job.key === key);
        if (older >= 0)
          queue.splice(older, 1)[0]?.resolve(SCRIPT_RUN_SUPERSEDED);
      }
      // Executor form: Promise.withResolvers is ES2024, past this project's ES2023 lib.
      const result = new Promise<RunResult>((resolve) => {
        queue.push({ key, request: { bars, inputs, source }, resolve });
      });
      next();
      return result;
    },
  };
};
