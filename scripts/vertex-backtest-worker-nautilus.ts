// Nautilus backtest worker for the research host (never the live trading node). See
// scripts/backtest-worker/nautilus-worker.ts and infra/research-worker/README.md.
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

import {
  fileAgeMs,
  isExecutableFile,
  restartLockState,
  runCommand,
  runNautilusWorker,
  sleep,
  stopSignal,
} from "./backtest-worker/nautilus-worker.ts";

process.exitCode = await runNautilusWorker(process.argv.slice(2), {
  canExecute: isExecutableFile,
  env: process.env,
  fileAgeMs,
  hostname: hostname(),
  post: (url, init) => globalThis.fetch(url, init),
  researchDir: fileURLToPath(new URL("../services/research/", import.meta.url)),
  restartLock: restartLockState,
  runCommand,
  signal: stopSignal(process),
  sleep,
  stderr: process.stderr,
  stdout: process.stdout,
});
