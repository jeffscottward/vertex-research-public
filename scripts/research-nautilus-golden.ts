// Writes the Nautilus golden fixture (research only). The logic is in scripts/research/nautilus-golden.ts.
//   bun run research:nautilus-golden
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGoldenCli } from "./research/nautilus-golden.ts";

process.exitCode = runGoldenCli({
  readText: (path) =>
    readFileSync(
      join(fileURLToPath(new URL("..", import.meta.url)), path),
      "utf8"
    ),
  stdout: process.stdout,
  writeText: (path, text) =>
    writeFileSync(
      join(fileURLToPath(new URL("..", import.meta.url)), path),
      text
    ),
});
