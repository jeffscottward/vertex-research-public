import { runCoverageLane } from "./lib/coverage-lane.ts";
import { spawnInherited } from "./lib/test-env.ts";

process.exitCode = await runCoverageLane(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  spawn: spawnInherited,
  error: (line) => process.stderr.write(`${line}\n`),
});
