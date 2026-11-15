// CLI of the deployment-request step of the paper path rehearsal (paper only). No database, no network.
// See scripts/research/paper-path-requests.ts.
import { readFileSync } from "node:fs";

import { runPaperPathRequestsCli } from "./research/paper-path-requests.ts";

process.exitCode = runPaperPathRequestsCli({
  readInput: () => readFileSync(0, "utf8"),
  stderr: process.stderr,
  stdout: process.stdout,
});
