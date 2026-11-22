// Price freshness tick entrypoint for QuantVPS (research only, no orders). See scripts/price-freshness/tick.ts.
import { runPriceFreshnessTick } from "./price-freshness/tick.ts";

process.exitCode = await runPriceFreshnessTick({
  argv: process.argv.slice(2),
  env: process.env,
  post: (url, init) => globalThis.fetch(url, init),
  stderr: process.stderr,
  stdout: process.stdout,
});
