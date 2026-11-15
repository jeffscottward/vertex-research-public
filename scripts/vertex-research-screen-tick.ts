// Research screen tick for the scheduler (research only, no orders). See scripts/research-screen/tick.ts.
import { readFile, stat } from "node:fs/promises";

import {
  readSourceSha,
  runResearchScreenTick,
} from "./research-screen/tick.ts";

const fileAgeMs = async (path: string): Promise<number | null> => {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return null;
    throw error;
  }
};

process.exitCode = await runResearchScreenTick({
  env: process.env,
  fileAgeMs,
  now: Date.now,
  post: (url, init) => globalThis.fetch(url, init),
  // SOURCE_SHA lies beside the installed bundle (infra/research-screen/quantvps/install.sh).
  sourceSha: await readSourceSha(import.meta.url, (file) =>
    readFile(file, "utf8")
  ),
  stderr: process.stderr,
  stdout: process.stdout,
});
