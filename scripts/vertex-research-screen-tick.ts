// Research screen tick for the scheduler (research only, no orders). See scripts/research-screen/tick.ts.
import { stat } from "node:fs/promises";

import { runResearchScreenTick } from "./research-screen/tick.ts";

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
  stderr: process.stderr,
  stdout: process.stdout,
});
