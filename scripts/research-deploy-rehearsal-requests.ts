// CLI of the deployment-request step of the deployability rehearsal (paper only). No database, no network.
// See scripts/research/deploy-rehearsal-requests.ts.
import { readFileSync } from "node:fs";

import { runDeployRehearsalRequestsCli } from "./research/deploy-rehearsal-requests.ts";

process.exitCode = runDeployRehearsalRequestsCli({
  readInput: () => readFileSync(0, "utf8"),
  stderr: process.stderr,
  stdout: process.stdout,
});
