// Signal alert and watch tick for the scheduler (research only, no orders). Same client as the price
// alert tick (scripts/price-alerts/tick.ts), calling priceAlerts.signals.tick: arithmetic evaluation
// of active rules on public bars, no model call in the tick loop.
import { runPriceAlertTick } from "./price-alerts/tick.ts";

process.exitCode = await runPriceAlertTick({
  env: process.env,
  post: (url, init) => globalThis.fetch(url, init),
  procedure: "priceAlerts/signals/tick",
  stderr: process.stderr,
  stdout: process.stdout,
});
