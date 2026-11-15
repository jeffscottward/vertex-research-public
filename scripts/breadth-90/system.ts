// What: the real file, process, network and clock access of the breadth-90 tick (TickIo).
// Used by: scripts/vertex-breadth-90-tick.ts.
// See: tick.ts (TickIo), alerts.ts (AlertIo), tradingview.ts (bunSocket).
import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { RunResult } from "./alerts.ts";
import type { TickIo } from "./tick.ts";
import { bunSocket } from "./tradingview.ts";

const ensureDir = (path: string) => mkdir(dirname(path), { recursive: true });

/** Appends to a file; creates the directory first. */
export const appendText = async (path: string, text: string): Promise<void> => {
  await ensureDir(path);
  await appendFile(path, text);
};

/** Size in bytes; 0 for a missing file. */
export const fileSize = (path: string): Promise<number> =>
  stat(path).then(
    (info) => info.size,
    () => 0
  );

/** File text; null for a missing or unreadable file. */
export const readText = (path: string): Promise<string | null> =>
  readFile(path, "utf8").catch(() => null);

/** Writes a temporary file and renames it, so a reader never sees a partial file. */
export const writeText = async (path: string, text: string): Promise<void> => {
  await ensureDir(path);
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
};

/** Runs a command with stdin; a command that cannot start gives exit code 127 and its error text. */
export const runCommand = async (
  command: string,
  args: readonly string[],
  stdin: string
): Promise<RunResult> => {
  const child = spawn(command, [...args], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = Promise.withResolvers<number>();
  child.on("error", (error) => {
    stderr += error.message;
    done.resolve(127);
  });
  child.on("close", (code) => done.resolve(code ?? 1));
  // A command that exits before it reads stdin breaks the pipe. That is the command's result, not
  // a failure here: without this listener the runtime reports an unhandled error.
  child.stdin.on("error", () => undefined);
  child.stdin.end(stdin);
  return { code: await done.promise, stderr };
};

export type SystemProcess = Pick<
  NodeJS.Process,
  "argv" | "env" | "stderr" | "stdout"
>;

export const systemTickIo = (host: SystemProcess): TickIo => ({
  appendText,
  argv: host.argv.slice(2),
  env: host.env,
  fetch: (url, init) => globalThis.fetch(url, init),
  fileSize,
  home: homedir(),
  now: () => new Date(),
  readText,
  run: runCommand,
  socket: bunSocket,
  stderr: host.stderr,
  stdout: host.stdout,
  writeText,
});
