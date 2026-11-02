// Autopilot tick for the scheduler (research only, no broker calls). See scripts/autopilot/tick.ts.
import { runAutopilotTick } from "./autopilot/tick.ts";

process.exitCode = await runAutopilotTick(process.argv.slice(2), {
  env: process.env,
  post: (url, init) => globalThis.fetch(url, init),
  stderr: process.stderr,
  stdout: process.stdout,
});
