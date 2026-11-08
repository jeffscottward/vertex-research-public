// Generates migration 0059 (qc-port strategy definitions) and its rollback (research only).
// See scripts/research/qc-port-definitions.ts.
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

import { runQcPortDefinitions } from "./research/qc-port-definitions.ts";

process.exitCode = await runQcPortDefinitions(process.argv.slice(2), {
  env: process.env,
  readText: (url) => readFile(url, "utf8"),
  spawn: (command, args, options) =>
    spawnSync(command, args, {
      ...options,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  stderr: process.stderr,
  stdout: process.stdout,
  writeText: (url, text) => writeFile(url, text),
});
