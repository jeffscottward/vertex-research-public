// One-time freeze of the sector rotation backtest data (read-only GET, research only).
// See scripts/sector-rotation-backtest/freeze.ts.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runFreeze } from "./sector-rotation-backtest/freeze.ts";

process.exitCode = await runFreeze({
  fetch: (url, init) => globalThis.fetch(url, init),
  now: new Date(),
  out: resolve(
    import.meta.dirname,
    "../research/backtests/sector-rotation/closes.json"
  ),
  write: (path, content) => writeFileSync(path, content),
});
