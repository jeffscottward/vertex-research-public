// 151 Trading Strategies research file generator (planning only). See scripts/research/backtest-151.ts.
import { fileURLToPath } from "node:url";
import { runBacktest151Cli } from "./research/backtest-151.ts";

process.exitCode = await runBacktest151Cli(process.argv.slice(2), {
  root: fileURLToPath(new URL("..", import.meta.url)),
  stderr: process.stderr,
  stdout: process.stdout,
});
