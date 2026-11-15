// Daily engine comparison driver for the rig timer (research only, no orders).
// See scripts/engine-comparison-driver/driver.ts and infra/engine-comparison-driver/README.md.
import { setTimeout as delay } from "node:timers/promises";

import { runEngineComparisonDriver } from "./engine-comparison-driver/driver.ts";

process.exitCode = await runEngineComparisonDriver({
  env: process.env,
  now: () => Date.now(),
  post: (url, init) => globalThis.fetch(url, init),
  sleep: (ms) => delay(ms),
  stderr: process.stderr,
  stdout: process.stdout,
});
