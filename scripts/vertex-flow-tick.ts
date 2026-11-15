// Flow pipeline tick for the scheduler (research only, no orders). See scripts/flow/tick.ts.
import { runFlowTick } from "./flow/tick.ts";

process.exitCode = await runFlowTick({
  argv: process.argv.slice(2),
  env: process.env,
  post: (url, init) => globalThis.fetch(url, init),
  stderr: process.stderr,
  stdout: process.stdout,
});
