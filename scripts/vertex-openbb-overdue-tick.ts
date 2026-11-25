// Source-overdue tick entrypoint for QuantVPS (research only, no orders). See scripts/openbb-overdue/tick.ts.
import { runOpenbbOverdueTick } from "./openbb-overdue/tick.ts";

process.exitCode = await runOpenbbOverdueTick({
  argv: process.argv.slice(2),
  env: process.env,
  post: (url, init) => globalThis.fetch(url, init),
  stderr: process.stderr,
  stdout: process.stdout,
});
