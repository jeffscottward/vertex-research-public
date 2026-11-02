// Instant backtest latency benchmark (research only). See scripts/instant-backtest/bench.ts.
import { runInstantBacktestBench } from "./instant-backtest/bench.ts";

process.exitCode = await runInstantBacktestBench(process.argv.slice(2), {
  bunVersion: process.versions["bun"],
  env: process.env,
  stderr: process.stderr,
  stdout: process.stdout,
});
