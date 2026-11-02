// Price alert tick for the scheduler (research only, no orders). See scripts/price-alerts/tick.ts.
import { runPriceAlertTick } from "./price-alerts/tick.ts";

process.exitCode = await runPriceAlertTick({
  env: process.env,
  post: (url, init) => globalThis.fetch(url, init),
  stderr: process.stderr,
  stdout: process.stdout,
});
