// Merge-condition gate entry point; CI's "Merge conditions" job runs it on ready PRs. See scripts/ci/merge-conditions.ts.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runMergeConditionsCli } from "./ci/merge-conditions.ts";

const execFileAsync = promisify(execFile);

process.exitCode = await runMergeConditionsCli(process.env, {
  run: async (command, args) =>
    (await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 }))
      .stdout,
  stderr: process.stderr,
  stdout: process.stdout,
});
