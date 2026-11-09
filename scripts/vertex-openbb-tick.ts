// OpenBB tick for the scheduler (research only, no orders). See scripts/openbb/tick.ts.
import { spawn } from "node:child_process";

import { runOpenbbTick } from "./openbb/tick.ts";

process.exitCode = await runOpenbbTick({
  argv: process.argv.slice(2),
  env: process.env,
  now: () => new Date(),
  post: (url, init) => globalThis.fetch(url, init),
  spawn: (command, args, options) => {
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
    child.on("close", (code) =>
      resolve({ exitCode: code ?? 1, stderr, stdout })
    );
    return promise;
  },
  stderr: process.stderr,
  stdout: process.stdout,
});
