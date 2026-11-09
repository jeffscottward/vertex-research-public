// Node child-process adapter for the OpenBB tick (OpenbbTickIo.spawn): runs the fetcher with no
// stdin, collects stdout and stderr as UTF-8 and resolves with the exit code (1 when the process
// was killed by a signal). A process that cannot start, or whose stdout grows past the cap, rejects
// (the latter after killing it), so the tick records a failed run.
import { spawn } from "node:child_process";

import type { OpenbbTickIo } from "./tick.ts";

/** Largest fetcher document the tick accepts (a full backfill stays well below it). */
export const OPENBB_STDOUT_MAX_BYTES = 64 * 1024 * 1024;

/** The spawn adapter with a stdout cap in bytes. */
export const createOpenbbFetcherSpawn =
  (maxStdoutBytes: number): OpenbbTickIo["spawn"] =>
  (command, args, options) => {
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
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > maxStdoutBytes) {
        overflow = true;
        chunks.length = 0;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (overflow)
        reject(new Error(`fetcher stdout exceeded ${maxStdoutBytes} bytes`));
      else
        resolve({
          exitCode: code ?? 1,
          stderr,
          stdout: Buffer.concat(chunks).toString("utf8"),
        });
    });
    return promise;
  };

export const spawnOpenbbFetcher = createOpenbbFetcherSpawn(
  OPENBB_STDOUT_MAX_BYTES
);
