// Connectivity health & alerting tick entrypoint for QuantVPS / rig (research only, no orders).
// See scripts/connectivity/tick.ts.
import { runConnectivityTick } from "./connectivity/tick.ts";

process.exitCode = await runConnectivityTick({
  argv: process.argv.slice(2),
  env: process.env,
  post: (url, init) => globalThis.fetch(url, init),
  stderr: process.stderr,
  stdout: process.stdout,
});
