// One-time freeze of the sector rotation backtest data (read-only GET, research only); IBKR first
// when the history service is configured, Yahoo otherwise.
// See scripts/sector-rotation-backtest/freeze.ts.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runFreeze } from "./sector-rotation-backtest/freeze.ts";

process.exitCode = await runFreeze({
  // IBKR first when VERTEX_HISTORY_URL and VERTEX_DEPLOY_STATUS_TOKEN are set (bun loads .env).
  env: process.env,
  fetch: (url, init) => globalThis.fetch(url, init),
  log: (line) => console.log(line),
  now: new Date(),
  out: resolve(
    import.meta.dirname,
    "../research/backtests/sector-rotation/closes.json"
  ),
  write: (path, content) => writeFileSync(path, content),
});
