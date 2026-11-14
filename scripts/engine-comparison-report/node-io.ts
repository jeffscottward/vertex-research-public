// The real I/O of the report script: fetch, journalctl, files. Research only; no orders.
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import type { ReportIo } from "./run.ts";

/** Runs a program with arguments and returns its standard output. */
export type ExecFile = (
  file: string,
  args: readonly string[],
  options: Readonly<{ maxBuffer: number }>
) => Promise<Readonly<{ stdout: string }>>;

const JOURNAL_MAX_BYTES = 512 * 1024 * 1024;

export const nodeReportIo = (
  env: Readonly<Record<string, string | undefined>>,
  exec: ExecFile = promisify(execFile)
): ReportIo => ({
  env,
  exists: async (path) =>
    access(path).then(
      () => true,
      () => false
    ),
  fetch: (url, init) => fetch(url, init),
  now: () => new Date(),
  readJournal: async (unit, sinceIso) =>
    (
      await exec(
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
        { maxBuffer: JOURNAL_MAX_BYTES }
      )
    ).stdout,
  readText: async (path) => readFile(path, "utf8"),
  stderr: process.stderr,
  stdout: process.stdout,
  // The page replaces the old one whole (temporary file, then rename); owner-only like the
  // rest of the reports folder, which the same user serves.
  writeText: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, path);
  },
});
