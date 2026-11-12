// Leveraged ETF universe importer (stdin → leveraged_etf_universe). See scripts/leveraged-etf-universe/import.ts.
import { runLeveragedEtfUniverseImport } from "./leveraged-etf-universe/import.ts";

process.exitCode = await runLeveragedEtfUniverseImport(process.argv.slice(2), {
  env: process.env,
  stdin: process.stdin,
  stderr: process.stderr,
  stdout: process.stdout,
});
