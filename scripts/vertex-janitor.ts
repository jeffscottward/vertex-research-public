import { createJanitorDeps } from "./janitor/system.ts";
import { runJanitorWeekly } from "./janitor/weekly.ts";

process.exitCode = runJanitorWeekly(
  process.argv.slice(2),
  process.env,
  createJanitorDeps()
);
