// Node child-process adapter for the OpenBB tick (OpenbbTickIo.spawn): runs the fetcher with an
// empty stdin (or `options.stdin`, then closed: the sec-form4 state), collects stdout and stderr as UTF-8 and resolves with the exit code (1 when the process
// was killed by a signal). A process that cannot start, whose stdout grows past the cap, or that
// is still running at the time limit rejects (the last two after killing it), so the tick records a
// failed run. Neither waits for "close": a descendant that keeps stdout open cannot hold the tick.
// When the fetcher itself exits, the adapter waits at most OPENBB_EXIT_GRACE_MS for the pipes to
// close and then settles with the output it has, so such a descendant does not turn a finished run
// into a time-limit failure. The fetcher stays in the tick's process group on purpose: tick-runner
// kills what is left of that group when the step ends, also when the tick itself is killed.
import { spawn } from "node:child_process";

import type { OpenbbTickIo } from "./tick.ts";

/** Largest fetcher document the tick accepts (a full backfill stays well below it). */
export const OPENBB_STDOUT_MAX_BYTES = 64 * 1024 * 1024;

/** After the fetcher exits, the time its pipes get to close before the adapter stops reading. */
export const OPENBB_EXIT_GRACE_MS = 2000;

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
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A child that exits before reading closes the pipe: its exit code tells what went wrong.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let grace: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = () => {
      clearTimeout(timer);
      clearTimeout(grace);
    };
    const dropStreams = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    // Stops without waiting for "close": kill the fetcher, drop its streams and reject. A later
    // "close" settles nothing, the promise is already settled.
    const stop = (message: string) => {
      clearTimers();
      child.kill("SIGKILL");
      dropStreams();
      reject(new Error(message));
    };
    const finish = (code: number | null) => {
      clearTimers();
      resolve({
        exitCode: code ?? 1,
        stderr,
        stdout: Buffer.concat(chunks).toString("utf8"),
      });
    };
    const timer = setTimeout(() => {
      stop(
        `fetcher still running after the ${options.timeoutMs / 1000} s time limit; killed`
      );
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxStdoutBytes) {
        chunks.length = 0;
        stop(`fetcher stdout exceeded ${maxStdoutBytes} bytes`);
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
    });
    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.on("exit", (code) => {
      // The fetcher finished: from here only the grace period applies, never the time limit.
      clearTimeout(timer);
      grace = setTimeout(() => {
        dropStreams();
        finish(code);
      }, OPENBB_EXIT_GRACE_MS);
    });
    child.on("close", finish);
    return promise;
  };

export const spawnOpenbbFetcher = createOpenbbFetcherSpawn(
  OPENBB_STDOUT_MAX_BYTES
);
