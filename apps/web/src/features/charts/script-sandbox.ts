// Pure pieces of the script Web Worker, kept free of the engine so tests need no Worker.
// The interpreter already has no eval and no network; the lockdown is defence in depth:
// it removes what a worker could use to reach the network or shared storage.

import type {
  RunOptions,
  RunResult,
  ScriptBar,
  ScriptInputValue,
} from "@darkfactory/scripting";

export const BLOCKED_WORKER_GLOBALS = Object.freeze([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebTransport",
  "EventSource",
  "importScripts",
  "indexedDB",
  "caches",
  "BroadcastChannel",
  "Worker",
  "SharedWorker",
  "WebSocketStream",
] as const);
export const BLOCKED_NAVIGATOR_FIELDS = Object.freeze([
  "storage",
  "locks",
] as const);
// Posted once by the worker when its message listener is installed.
export const SCRIPT_WORKER_READY = "vx-script-ready" as const;

// Same bounds as @darkfactory/scripting (SCRIPT_SOURCE_MAX, SCRIPT_BARS_MAX); repeated so this
// module, which runs before the engine is imported, imports no engine code.
const SOURCE_MAX = 16_000;
const BARS_MAX = 5000;
const INPUTS_MAX = 64;

// Removes `name` from `target` and every object on its prototype chain (WorkerGlobalScope
// and DedicatedWorkerGlobalScope prototypes included); a property that cannot be deleted
// is shadowed on `target` by a read-only undefined, else overwritten when writable.
const removeEverywhere = (target: Record<string, unknown>, name: string) => {
  for (
    let owner: object | null = target;
    owner !== null && owner !== Object.prototype;
    owner = Reflect.getPrototypeOf(owner)
  )
    if (Object.hasOwn(owner, name)) Reflect.deleteProperty(owner, name);
  if (
    name in target &&
    !Reflect.defineProperty(target, name, {
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false,
    })
  )
    Reflect.set(target, name, undefined);
};

/**
 * Removes network and shared-storage APIs from a worker scope and its navigator, through
 * the whole prototype chain, so they are not reachable from a prototype either. Returns
 * the names still reachable (none when the lockdown worked). Never throws.
 */
export const lockdownWorkerGlobals = (scope: object): readonly string[] => {
  const target = scope as Record<string, unknown>;
  for (const name of BLOCKED_WORKER_GLOBALS) removeEverywhere(target, name);
  const navigator = target["navigator"];
  const fields =
    typeof navigator === "object" && navigator !== null
      ? (navigator as Record<string, unknown>)
      : null;
  if (fields !== null)
    for (const name of BLOCKED_NAVIGATOR_FIELDS) removeEverywhere(fields, name);
  return [
    ...BLOCKED_WORKER_GLOBALS.filter((name) => target[name] !== undefined),
    ...BLOCKED_NAVIGATOR_FIELDS.filter(
      (name) => fields !== null && fields[name] !== undefined
    ).map((name) => `navigator.${name}`),
  ];
};

export type ScriptInputs = Readonly<Record<string, ScriptInputValue>>;
export type ScriptRunRequest = Readonly<{
  id: number;
  source: string;
  bars: readonly ScriptBar[];
  inputs: ScriptInputs;
}>;
export type ScriptRunResponse = Readonly<{ id: number; result: RunResult }>;
export type RunScript = (
  source: string,
  bars: readonly ScriptBar[],
  options: RunOptions
) => RunResult;

// One error at 1:1: how runner and worker failures reach the error list.
export const scriptFailure = (message: string): RunResult => ({
  errors: [{ column: 1, line: 1, message }],
  ok: false,
});

const validBar = (value: unknown): value is ScriptBar => {
  if (typeof value !== "object" || value === null) return false;
  const bar = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(bar["timestamp"]) &&
    ["open", "high", "low", "close", "volume"].every(
      (field) =>
        typeof bar[field] === "number" && Number.isFinite(bar[field] as number)
    )
  );
};

const validInputs = (value: unknown): value is ScriptInputs => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const entries = Object.entries(value);
  return (
    entries.length <= INPUTS_MAX &&
    entries.every(
      ([key, input]) =>
        key.length <= 64 &&
        (typeof input === "boolean" ||
          (typeof input === "number" && Number.isFinite(input)) ||
          (typeof input === "string" && input.length <= 200))
    )
  );
};

/**
 * Worker message handler without the Worker: validates one request and runs it. Returns
 * null only when the request has no usable id (nothing to answer); never throws.
 */
export const handleScriptMessage = (
  data: unknown,
  run: RunScript
): ScriptRunResponse | null => {
  if (typeof data !== "object" || data === null) return null;
  const { id, source, bars, inputs } = data as Record<string, unknown>;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  if (typeof source !== "string" || source.length > SOURCE_MAX)
    return { id, result: scriptFailure("Script is missing or too long.") };
  if (!Array.isArray(bars) || bars.length > BARS_MAX || !bars.every(validBar))
    return { id, result: scriptFailure("Chart bars are not valid input.") };
  if (!validInputs(inputs))
    return { id, result: scriptFailure("Script inputs are not valid.") };
  try {
    return { id, result: run(source, bars, { inputs }) };
  } catch (error) {
    return {
      id,
      result: scriptFailure(
        `Script engine failed: ${error instanceof Error ? error.message : "unknown error"}`
      ),
    };
  }
};
