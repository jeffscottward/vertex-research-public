// Paper forward tick for the scheduler (paper only, no broker calls). See scripts/paper-forward/tick.ts.
import { runPaperForwardTick } from "./paper-forward/tick.ts";

process.exitCode = await runPaperForwardTick(process.argv.slice(2), {
  env: process.env,
  post: (url, init) => globalThis.fetch(url, init),
  stderr: process.stderr,
  stdout: process.stdout,
});
