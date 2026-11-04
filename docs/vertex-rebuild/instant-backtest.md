# Instant backtest

Updated: 2026-10-18. Research and paper use only. Nothing in this feature creates, routes or simulates broker orders.

## Purpose

The portal page `/instant-backtest` runs a parameterized long-only rule over stored bars. When an operator changes a parameter, the page sends one run request and replaces the result in place. The page does not reload. At most one run request is in flight; changes made meanwhile replace one queued request, so a slider drag runs the newest values next. The result shows an equity curve and summary statistics.

## Parts

| Part | File |
| --- | --- |
| Engine (pure, typed arrays, one pass) | `packages/api/src/instant-backtest-engine.ts` |
| oRPC contract `instantBacktest.series`, `instantBacktest.run`, `instantBacktest.universes` | `packages/api/src/contracts/instant-backtest.ts` |
| Named universes and the default (Core 7 futures) | `packages/shared/src/universes/index.ts`, see [Core 7 universe](core7-universe.md) |
| Procedures, operator gate, bar cache | `packages/api/src/server/instant-backtest.ts` |
| Tables `market_bar_series`, `market_bars` | `packages/db/src/schema/index.ts`, migration `0025_market_bars`, rollback `packages/db/rollback/0025_market_bars.down.sql` |
| Repository (columnar reads, whole-series replace) | `packages/db/src/server/market-bars.ts` |
| Page | `apps/web/src/app/(portal)/instant-backtest/`, `apps/web/src/components/portal/instant-backtest-workspace.tsx` |
| Import | `scripts/instant-backtest/import.ts`, entry `scripts/vertex-market-bars-import.ts` (`bun run vertex:bars:import`) |
| Server benchmark | `scripts/instant-backtest/bench.ts`, entry `scripts/vertex-instant-backtest-bench.ts` (`bun run vertex:instant-backtest:bench`) |
| Browser test and browser latency run | `tests/e2e/instant-backtest.spec.ts`, `tests/e2e/instant-backtest-latency.spec.ts` |

## Default universe

Every backtest, sweep and Autopilot form opens with the universe "Core 7 futures" (ES=F, NQ=F, YM=F, RTY=F, GC=F, SI=F, CL=F) selected; "Core 7 ETF twins" (SPY, QQQ, DIA, IWM, GLD, SLV, USO) and "All stored series" are the other choices. The series list shows the stored members of the chosen universe in market order. When no member has stored bars, the form shows a note and lists all stored series. `instantBacktest.universes` returns the same universes, the default id and the stored timeframes of each member. Stored symbols match `^[A-Z0-9.^=-]{1,20}$` (migration `0045_market_bar_futures_symbols` added `=`).

## Execution model

- Rules: moving-average cross (enter on the bar where the fast average moves above the slow average, exit when it is at or below; after a stop or target exit the rule waits for the next cross up) and breakout (enter when the close is above the highest high of the prior N bars and, optionally, above a trend average; exit when the close is below the lowest low of the prior M bars). The engine also has an RSI mean-reversion rule (`rsiReversion`: enter while Wilder RSI is below the oversold level, exit while it is above the overbought level). The oRPC contract and the page do not expose it yet; the [golden battery](../golden-battery/README.md) uses it.
- Signals use data up to and including the close of a bar. Signal fills happen at the open of the next bar.
- Stop-loss and take-profit levels are checked inside each bar. A gap through a level fills at the open. When both levels are inside one bar, the stop fills first.
- Cost is charged in basis points of the traded value on each side.
- Statistics use simple per-bar returns, a risk-free rate of 0 and the observed bar frequency for annualization. The equity curve sent to the browser has at most 2,000 points; statistics always use every bar.
- Limits: one symbol, long only, no position sizing, no slippage model beyond the cost setting, no borrow, no dividends beyond what the stored prices include. This is a fast screening tool. Confirm a candidate in the full engine (NautilusTrader is planned) before any further step.
- Proof: the [golden battery](../golden-battery/README.md) compares this engine with an independent pandas implementation on 10 years of SPY and QQQ daily bars.

## Bar cache

The server keeps the bars of up to 4 series in process memory as typed arrays. The cache key includes the series SHA-256, import time and bar count, so a new import loads the new bars. The first run after a start or an import is cold (bars load from Postgres); later runs are warm (engine only).

## Load bars

The importer reads a normalized CSV (`t,o,h,l,c,v`, `t` in epoch milliseconds, ascending) and a manifest:

```json
{
  "symbol": "SPY",
  "timeframe": "1d",
  "source": "Yahoo Finance daily SPY, OHLC scaled by adj_close/close",
  "sourceSha256": "<SHA-256 of the original download>",
  "normalizedSha256": "<SHA-256 of the CSV>"
}
```

```sh
DATABASE_URL=... bun run vertex:bars:import -- path/to/SPY-1d.csv path/to/SPY-1d.manifest.json
```

The import refuses a CSV whose SHA-256 differs from `normalizedSha256`, and it replaces the whole series in one transaction. Keep downloaded data under `private/` (git-ignored); do not commit or redistribute vendor data. The one exception is the frozen golden-battery fixture under `tests/fixtures/golden/` (see [its README](../golden-battery/README.md#data)).

## Measure latency

- Definitions: warm = bars already in the server cache (each run still reads the series row from Postgres); cold = server cache miss, so all bars load from Postgres, while Postgres and the operating system caches stay warm (not a first read from disk). With 10 runs, the nearest-rank p95 equals the slowest run.
- Server path (in-process oRPC handler and real Postgres, no browser): `DATABASE_URL=... bun run vertex:instant-backtest:bench -- 10`. It prints JSON with every sample, the median and the p95 for cold and warm runs.
- Browser path (headless Chrome through the real app): set `INSTANT_BACKTEST_EVIDENCE_DIR` to the folder with the normalized files and run `bun scripts/with-test-env.ts pnpm exec playwright test --project=e2e instant-backtest-latency.spec.ts` after `bun run build`. It writes `browser-latency.json` to that folder. Without the variable the spec is skipped; it is evidence, not a gate.

## Open-source options considered

| Option | License | Decision |
| --- | --- | --- |
| In-repo TypeScript engine over typed arrays | project | Chosen. No new dependency, same code on server and in tests, sub-second on one year of 1-minute bars. |
| NautilusTrader | LGPL-3.0 | Keep as the planned event-driven engine for confirmation runs; too heavy for a run on every parameter change. |
| vectorbt | Apache-2.0 with Commons Clause | Reference design only (vectorized, parameter grids). Python, and the license condition restricts selling. |
| backtesting.py, PineTS | AGPL-3.0 | Not used: network-use copyleft. |
| DuckDB-WASM, nodejs-polars | MIT | Not needed now. Revisit for multi-symbol scans or SQL screens. |
| Grademark | MIT | Not used: object-per-bar design, last release 2024. |
