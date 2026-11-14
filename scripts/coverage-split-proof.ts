import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { runCoverageSplitProof } from "./lib/coverage-split-proof.ts";

process.exitCode = await runCoverageSplitProof(process.argv.slice(2), {
  git: (arguments_) =>
    promisify(execFile)("git", [...arguments_], {
      maxBuffer: 64 * 1024 * 1024,
    }).then(
      ({ stdout }) => stdout,
      () => undefined
    ),
  readText: (path) => readFile(path, "utf8"),
  output: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
});
