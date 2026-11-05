# Backtest lab default states

Each Backtest lab page shows useful content on open, with no input. The default universe is Core 7 futures ([core7-universe.md](core7-universe.md)). The page choices live in the URL query, so a view can be linked and restored. A missing or unknown parameter falls back to the default, and default values are left out of the URL.

Helper: `apps/web/src/components/portal/backtest-lab-query.ts` (URL read and write, a debounce hook and a small result cache).

## Load rules

- Automatic work on open uses only stored data and read or in-request compute procedures: `setupReplay.run`, `backtestRuns.sweep`, `backtestRuns.combine`, and list/get reads.
- A durable job is never submitted on open or on a filter change. `backtestRuns.submit`, "Start campaign" and "Run full backtest" stay explicit buttons.
- An automatic re-run after a change waits 300-350 ms. Results are cached per request (20 entries), so a return to an earlier choice makes no server call.

## Pages

|Page|Default on open|URL parameters|
|---|---|---|
|`/setup-replay`|Replays the first setup on the first stored Core 7 futures daily series; every change replays again|`symbol`, `setup`, `stop`, `target`, `hold`, `paths`|
|`/backtest-sweeps`|Runs the default grid (48 cells for the moving-average rule, 36 for breakout) on the first Core 7 series over its stored range. Changes of universe, series or rule re-run only while the grid is the default; an edited grid runs with "Run sweep"|`universe`, `symbol`, `metric`, `rule`|
|`/strategy-builder`|Opens the default SMA cross rule on the first Core 7 series and the result of the newest succeeded builder (DSL) run; with none, a notice says "Run backtest" queues one|`run`, `symbol`|
|`/backtest-runs`|Opens the newest succeeded run's report|`run`, `universe`, `strategy`|
|`/portfolio-combos`|Combines up to 4 of the newest succeeded runs (Core 7 futures first, then ETF twins, then others; one run per symbol first) at equal weights|`runs` (comma-separated ids)|
|`/autopilot`|Opens the newest completed campaign (else the newest campaign) with its leaderboard and gated candidates|`campaign`|

`/instant-backtest`, `/backtests`, `/forward-drift`, `/optimizations`, `/strategies` and `/library` already showed content on open.

Tests: the `*-workspace.test.tsx` file beside each page workspace (default state with fake gateways, URL parsing) and the Playwright specs in `tests/e2e/` (`setup-replay`, `backtest-sweeps`, `strategy-builder`, `backtest-runs`, `portfolio-combos`, `autopilot`, `core7-universe`).
