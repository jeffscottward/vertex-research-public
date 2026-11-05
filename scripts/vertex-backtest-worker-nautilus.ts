// Nautilus backtest worker for the research host (never the live trading node). See
// scripts/backtest-worker/nautilus-worker.ts and infra/research-worker/README.md.
import { fileURLToPath } from "node:url";

import {
  runCommand,
  runNautilusWorker,
  sleep,
} from "./backtest-worker/nautilus-worker.ts";

const controller = new AbortController();
for (const name of ["SIGTERM", "SIGINT"] as const)
  process.on(name, () => controller.abort());

process.exitCode = await runNautilusWorker(process.argv.slice(2), {
  env: process.env,
  post: (url, init) => globalThis.fetch(url, init),
  researchDir: fileURLToPath(new URL("../services/research/", import.meta.url)),
  runCommand,
  signal: controller.signal,
  sleep,
  stderr: process.stderr,
  stdout: process.stdout,
});
