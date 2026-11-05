# Parameter sweeps

Updated: 2026-10-23. Research and paper use only. Nothing in this feature creates, routes or simulates broker orders.

## Purpose

An operator or an agent runs the instant backtest engine once for every point of a grid over 1 to 4 numeric parameters. Each grid cell is then ranked by how its neighbours performed, so a robust region ranks above a single high cell. The page shows a heatmap of any two swept parameters for a selected metric. "Run full backtest" queues a backtest run (see `docs/vertex-rebuild/backtest-runs.md`) with exactly the settings of one cell.

## Parts

| Part | File |
| --- | --- |
| oRPC contract `backtestRuns.sweep` (POST `/backtest-runs/sweep`) | `packages/api/src/contracts/backtest-sweep.ts` |
| Grid, neighbours and robustness ranking (pure, shared with the browser) | `packages/api/src/backtest-sweep-grid.ts` |
| Sweep runner (pure) | `packages/api/src/backtest-sweep.ts` |
| Procedure (bar loading, size budget) | `packages/api/src/server/backtest-runs.ts` |
| Page `/backtest-sweeps` | `apps/web/src/app/(portal)/backtest-sweeps/`, `apps/web/src/components/portal/backtest-sweeps-workspace.tsx`, `backtest-sweeps-model.ts` |
| MCP tool | `backtest_runs_sweep` in `packages/api/src/server/mcp.ts` |

## Grid

Each dimension is a parameter with `from`, `to` and `step`. The values run from `from` in steps of `step` and include `to` when it falls on a step. They are rounded to 9 decimals, so steps such as 0.1 stay exact.

| Parameter | Rule | Values |
| --- | --- | --- |
| `fast`, `slow` | moving-average cross | whole numbers, 1 to 5000 |
| `entryLookback`, `exitLookback` | breakout | whole numbers, 1 to 5000 |
| `trendSma` | breakout | whole numbers, 0 to 5000 (0 = no trend filter) |
| `stopLossPct` | both | 0 to 99 |
| `takeProfitPct` | both | 0 to 10,000 |

Parameters that are not swept keep the values of the base rule and risk settings in the request. A cell whose settings the engine rejects (for example `fast` not shorter than `slow`) has no metric values and shows the engine's reason.

Limits: at most 4 dimensions, 50 values per dimension and 1,000 cells. Cells multiplied by the bars in the date range may not exceed 20,000,000. The procedure checks this before it runs any cell and returns `BAD_REQUEST` with the numbers.

## Robustness ranking

The metrics are total return, CAGR, Sharpe ratio, Sortino ratio, profit factor, win rate and maximum drawdown. Every metric is higher-is-better: drawdown is negative, so a value closer to 0 is higher.

- **Neighbours** of a cell are the cells one step away in exactly one swept parameter (4 in a 2-D grid, fewer at the edges). Diagonal cells are not neighbours.
- **Worst in neighbourhood** (the robust score) is the lowest metric value over the cell and its neighbours that have a value.
- **Rank** orders the cells with a value by robust score, then by their own value, then by cell index. A cell with no valued neighbour (for example all its neighbours were rejected) ranks after every cell that has one, because nothing shows that its value is stable. Cells without a value are not ranked and do not count as neighbours.
- **Isolated spike**: the cell value is above 0, at least one neighbour has a value, and the mean of the neighbour values is below 50% of the cell value. A cell whose neighbours all lack values is not flagged; the page shows its neighbour count (0).
- Edge cells have fewer neighbours, so their robust score uses fewer values. The page shows the neighbour count of each cell.

The server ranks the cells for the requested metric. The page re-ranks a finished sweep in the browser with the same code when the operator selects another metric, so no new sweep runs.

## Page

1. On open the page runs the default grid on the first Core 7 futures series ([backtest-lab-defaults.md](backtest-lab-defaults.md)). To change it, choose the series, rule, date range, fixed settings and 1 to 4 dimensions, then select **Run sweep**.
2. The heatmap shows one metric over two swept parameters (columns and rows). Other swept parameters are held at a chosen value; the default is the best-ranked cell. **Colour by** switches between the cell value and the worst value in its neighbourhood. Cells with a stronger colour are better within the shown slice. Isolated spikes carry a warning icon.
3. Select a cell to see its value, worst in neighbourhood, neighbour average, neighbour count, robust rank and trade count. **Run full backtest** queues a backtest run with the cell's settings and links to `/backtest-runs?run=<id>`, which opens that run's report.
4. **Most robust cells** lists the 20 best-ranked cells for the selected metric.

## Access

The procedure is operator-only. Agent API keys may call it, including read keys, because it stores nothing. The MCP tool returns the 20 best-ranked cells, the spike list and the full ranking by default; `includeCells` returns every cell.

## Limits

- The sweep runs inside the request and is not stored. There is no job list for sweeps.
- The execution model is that of the instant backtest engine: one symbol, long only, next-open fills, cost in basis points per side.
- A high robust score on past bars is a screening result. It does not authorize a trade. Many cells tested on the same bars raise the chance of a lucky fit; check a candidate on other dates before further work.
