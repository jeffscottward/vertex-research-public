// QuantVPS deploy migration guard checker; invoked by infra/quantvps/restart-when-idle.sh.
// See scripts/migrations/check-applied.ts.
import { readFileSync } from "node:fs";

import { runMigrationCheckCli } from "./migrations/check-applied.ts";

process.exitCode = runMigrationCheckCli(process.argv.slice(2), {
  readStdin: () => readFileSync(0, "utf8"),
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
});
