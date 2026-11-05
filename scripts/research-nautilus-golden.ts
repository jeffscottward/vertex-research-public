// Writes the Nautilus golden fixture (research only). The logic is in scripts/research/nautilus-golden.ts.
//   bun run research:nautilus-golden
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGolden } from "./research/nautilus-golden.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = "services/research/tests/fixtures/nautilus_backtest/golden.json";
writeFileSync(
  join(root, out),
  buildGolden({ readText: (path) => readFileSync(join(root, path), "utf8") })
);
process.stdout.write(`wrote ${out}\n`);
