// Writes the Academy golden fixture (research only). The logic is in scripts/research/academy-golden.ts.
//   bun run research:academy-golden
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAcademyGoldenCli } from "./research/academy-golden.ts";

process.exitCode = runAcademyGoldenCli({
  stdout: process.stdout,
  writeText: (path, text) =>
    writeFileSync(
      join(fileURLToPath(new URL("..", import.meta.url)), path),
      text
    ),
});
