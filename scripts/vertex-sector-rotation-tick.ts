// Sector rotation tick for the scheduler (research only, no orders). See scripts/sector-rotation/tick.ts.
import { runSectorRotationTick } from "./sector-rotation/tick.ts";

process.exitCode = await runSectorRotationTick({
  argv: process.argv.slice(2),
  env: process.env,
  post: (url, init) => globalThis.fetch(url, init),
  stderr: process.stderr,
  stdout: process.stdout,
});
