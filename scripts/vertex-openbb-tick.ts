// OpenBB tick for the scheduler (research only, no orders). See scripts/openbb/tick.ts.
import { spawnOpenbbFetcher } from "./openbb/spawn.ts";
import { runOpenbbTick } from "./openbb/tick.ts";

process.exitCode = await runOpenbbTick({
  argv: process.argv.slice(2),
  env: process.env,
  now: () => new Date(),
  post: (url, init) => globalThis.fetch(url, init),
  spawn: spawnOpenbbFetcher,
  stderr: process.stderr,
  stdout: process.stdout,
});
