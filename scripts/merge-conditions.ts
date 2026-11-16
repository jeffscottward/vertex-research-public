// Merge-condition gate entry point; CI's "Merge conditions" job runs it on ready PRs. See scripts/ci/merge-conditions.ts.
import { runCommand, runMergeConditionsCli } from "./ci/merge-conditions.ts";

process.exitCode = await runMergeConditionsCli(process.env, {
  run: runCommand,
  stderr: process.stderr,
  stdout: process.stdout,
});
