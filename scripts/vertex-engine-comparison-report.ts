// Step-4 "current engine vs Nautilus" report page (research only). See scripts/engine-comparison-report/run.ts.
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { runEngineComparisonReport } from "./engine-comparison-report/run.ts";

const run = promisify(execFile);

process.exitCode = await runEngineComparisonReport(process.argv.slice(2), {
  env: process.env,
  exists: async (path) =>
    access(path).then(
      () => true,
      () => false
    ),
  fetch: (url, init) => fetch(url, init),
  now: () => new Date(),
  readJournal: async (unit, sinceIso) =>
    (
      await run(
        "journalctl",
        [
          "--user",
          "--unit",
          unit,
          "--output",
          "json",
          "--output-fields",
          "MESSAGE",
          "--no-pager",
          "--since",
          `${sinceIso.slice(0, 19).replace("T", " ")} UTC`,
        ],
        { maxBuffer: 512 * 1024 * 1024 }
      )
    ).stdout,
  readText: async (path) => readFile(path, "utf8"),
  stderr: process.stderr,
  stdout: process.stdout,
  writeText: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, path);
  },
});
