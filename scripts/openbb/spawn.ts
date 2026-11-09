// Node child-process adapter for the OpenBB tick (OpenbbTickIo.spawn): runs the fetcher with no
// stdin, collects stdout and stderr as UTF-8 and resolves with the exit code (1 when the process
// was killed by a signal). A process that cannot start rejects, so the tick records a failed run.
import { spawn } from "node:child_process";

import type { OpenbbTickIo } from "./tick.ts";

export const spawnOpenbbFetcher: OpenbbTickIo["spawn"] = (
  command,
  args,
  options
) => {
  const { promise, resolve, reject } = Promise.withResolvers<{
    exitCode: number;
    stderr: string;
    stdout: string;
  }>();
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr += text;
  });
  child.on("error", reject);
  child.on("close", (code) => resolve({ exitCode: code ?? 1, stderr, stdout }));
  return promise;
};
