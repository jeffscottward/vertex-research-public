// Forecast scorecard self-check on daily bar files (research only). See scripts/research/forecast-scorecard.ts.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { scoreForecasts } from "../packages/api/src/forecast-scorecard.ts";
import { runForecastScorecardCli } from "./research/forecast-scorecard.ts";

process.exitCode = await runForecastScorecardCli(process.argv.slice(2), {
  readFile: (path) => readFile(path, "utf8"),
  score: scoreForecasts,
  sha256: (text) => createHash("sha256").update(text).digest("hex"),
  stderr: process.stderr,
  stdout: process.stdout,
});
