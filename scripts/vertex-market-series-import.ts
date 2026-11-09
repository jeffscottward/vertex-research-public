// QC-ports daily research series importer (research data only). See scripts/market-series/import.ts.
import { runMarketSeriesImport } from "./market-series/import.ts";

process.exitCode = await runMarketSeriesImport(process.argv.slice(2), {
  env: process.env,
  stderr: process.stderr,
  stdout: process.stdout,
});
