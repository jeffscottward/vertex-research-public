// Instant backtest bar importer (research data only). See scripts/instant-backtest/import.ts.
import { runMarketBarsImport } from "./instant-backtest/import.ts";

process.exitCode = await runMarketBarsImport(process.argv.slice(2), {
  env: process.env,
  stderr: process.stderr,
  stdout: process.stdout,
});
