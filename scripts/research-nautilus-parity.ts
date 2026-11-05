// Parity suite CLI: TypeScript backtest engine against NautilusTrader (research only, no orders).
// The logic is in scripts/research/nautilus-parity.ts.
//   bun run research:nautilus-parity -- --data ~/Documents/reports/vertex-core7/data \
//     --python /tmp/nbt-venv/bin/python --out research/backtests/nautilus-parity
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runNautilusParity } from "./research/nautilus-parity.ts";

process.exitCode = runNautilusParity(process.argv.slice(2), {
  clock: () => performance.now(),
  makeDir: (path) => mkdirSync(path, { recursive: true }),
  now: () => new Date(),
  readText: (path) => readFileSync(path, "utf8"),
  root: fileURLToPath(new URL("..", import.meta.url)),
  spawn: (python, args, cwd) =>
    spawnSync(python, args, { cwd, encoding: "utf8" }),
  stdout: process.stdout,
  tempDir: () => mkdtempSync(join(tmpdir(), "nautilus-parity-")),
  writeText: (path, text) => writeFileSync(path, text),
});
