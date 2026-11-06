// Imported first by script-worker.ts: module evaluation order guarantees this runs before
// the script engine is evaluated. Only for the Web Worker scope; never import elsewhere.
import { lockdownWorkerGlobals } from "./script-sandbox.ts";

export const WORKER_GLOBALS_LEFT: readonly string[] =
  lockdownWorkerGlobals(globalThis);
