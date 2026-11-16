// Research screen tick for the scheduler (research only, no orders). See scripts/research-screen/tick.ts.
import { readFile, stat } from "node:fs/promises";

import { runResearchScreenTick } from "./research-screen/tick.ts";

process.exitCode = await runResearchScreenTick({
  env: process.env,
  now: Date.now,
  post: (url, init) => globalThis.fetch(url, init),
  readText: (file) => readFile(file, "utf8"),
  scriptUrl: import.meta.url,
  stat: (path) => stat(path),
  stderr: process.stderr,
  stdout: process.stdout,
});
