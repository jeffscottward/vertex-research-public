// Breadth-90 tick for the rig timer (research only, no orders). See scripts/breadth-90/tick.ts.
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

import { runBreadth90Tick } from "./breadth-90/tick.ts";
import { bunSocket } from "./breadth-90/tradingview.ts";

const ensureDir = (path: string) => mkdir(dirname(path), { recursive: true });

process.exitCode = await runBreadth90Tick({
  appendText: async (path, text) => {
    await ensureDir(path);
    await appendFile(path, text);
  },
  argv: process.argv.slice(2),
  env: process.env,
  fetch: (url, init) => globalThis.fetch(url, init),
  fileSize: (path) =>
    stat(path).then(
      (info) => info.size,
      () => 0
    ),
  home: homedir(),
  now: () => new Date(),
  readText: (path) => readFile(path, "utf8").catch(() => null),
  run: async (command, args, stdin) => {
    const child = spawn(command, [...args], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const done = new Promise<number>((resolve) => {
      child.on("error", (error) => {
        stderr += error.message;
        resolve(127);
      });
      child.on("close", (code) => resolve(code ?? 1));
    });
    child.stdin.end(stdin);
    return { code: await done, stderr };
  },
  socket: bunSocket,
  stderr: process.stderr,
  stdout: process.stdout,
  writeText: async (path, text) => {
    await ensureDir(path);
    await writeFile(`${path}.tmp`, text);
    await rename(`${path}.tmp`, path);
  },
});
