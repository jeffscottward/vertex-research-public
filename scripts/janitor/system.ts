// Real process and file system adapters for the weekly janitor runner.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { JanitorDeps } from "./weekly.ts";

export const createJanitorDeps = (now = new Date()): JanitorDeps => ({
  now,
  out: process.stdout,
  readFile: (path) =>
    existsSync(path) ? readFileSync(path, "utf8") : undefined,
  run: (command, args, { cwd, inherit }) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", inherit === true ? "inherit" : "pipe", "inherit"],
    });
    return { status: result.status ?? 1, stdout: result.stdout ?? "" };
  },
  writeFile: (path, text) => writeFileSync(path, text),
});
