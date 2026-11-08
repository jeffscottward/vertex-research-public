// Real files and the Python process for Nautilus batches of the research CLIs (dsl-engine.ts).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NautilusIo } from "./dsl-engine.ts";

export const nautilusProcessIo = (
  prefix: string
): Omit<NautilusIo, "python" | "root"> => ({
  readText: (path) => readFileSync(path, "utf8"),
  spawn: (python, args, cwd) =>
    spawnSync(python, args, { cwd, encoding: "utf8" }),
  tempDir: () => mkdtempSync(join(tmpdir(), prefix)),
  writeText: (path, text) => writeFileSync(path, text),
});
