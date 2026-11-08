// Long calendar spread payoff and modeled backtest (research only). See scripts/research/calendar-spread.ts.
import { runCalendarSpreadCli } from "./research/calendar-spread.ts";

process.exitCode = await runCalendarSpreadCli(process.argv.slice(2), {
  now: () => new Date(),
  stderr: process.stderr,
  stdout: process.stdout,
});
