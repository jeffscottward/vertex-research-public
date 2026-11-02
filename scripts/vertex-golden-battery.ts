// Golden backtest battery (research only). See scripts/golden-battery/battery.ts.
import { join } from "node:path";

import { runGoldenBatteryCli } from "./golden-battery/battery.ts";

process.exitCode = runGoldenBatteryCli(process.argv.slice(2), {
  root: join(import.meta.dirname, ".."),
  stdout: process.stdout,
  stderr: process.stderr,
});
