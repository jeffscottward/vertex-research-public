// Quant Lab record CLI. See scripts/quant-lab/record.ts.
import { runQuantLabRecord } from "./quant-lab/record.ts";

process.exitCode = await runQuantLabRecord(process.argv.slice(2), {
  env: process.env,
  stderr: process.stderr,
  stdout: process.stdout,
});
