import { readGitHead, runWithBuildSha } from "./lib/build-sha.ts";
import { spawnInherited } from "./lib/test-env.ts";

process.exitCode = await runWithBuildSha(process.argv.slice(2), {
  env: process.env,
  error: (line) => process.stderr.write(`${line}\n`),
  readHead: readGitHead,
  spawn: spawnInherited,
});
