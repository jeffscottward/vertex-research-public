# Portfolio combos

Updated: 2026-10-23. Research and paper use only. Nothing in this feature creates, routes or simulates broker orders. A combination is a screening result; it does not authorize a trade.

## Purpose

An operator combines up to 10 finished backtest runs on one shared deposit. Each run is a slot with a weight (0 to 1; the weights may add up to at most 1). The page shows the combined equity curve, CAGR, Sharpe, maximal drawdown, drawdown overlap, the return correlation matrix, a diversification check and a verdict per slot.

## Parts

| Part | File |
| --- | --- |
| oRPC procedure `backtestRuns.combine` (operator-only, not callable by read keys) | `packages/api/src/contracts/backtest-runs.ts`, `packages/api/src/server/backtest-runs.ts` |
| Calculation (pure) | `packages/api/src/portfolio-combination.ts` |
| Page `/portfolio-combos` | `apps/web/src/app/(portal)/portfolio-combos/`, `apps/web/src/components/portal/portfolio-combos-workspace.tsx` |

Nothing is stored. The procedure reads the runs and calculates the result for each request.

## Revision pin

A backtest run is immutable after it finishes: its spec, strategy snapshot, strategy revision (SHA-256) and report do not change. Each slot can send `expectedRevision`. When it differs from the run's `strategyRevision`, the procedure rejects the request (`BAD_REQUEST`). The page always sends the revision that it listed. Each result slot returns `runId`, `strategyRevision`, `engineVersion` and the bar `seriesSha256`, so a result names exactly what it combined. Only runs with status `succeeded` can be combined.

## Calculation

- Slot money: allocation = deposit x weight. Cash = deposit - sum of allocations; cash does not change.
- Slot path: the run's equity divided by the run's initial capital (a ratio that starts at 1). The time axis is the union of all slot equity points (the stored chart series, at most 2,000 points per run). Before its first point a slot stays at ratio 1; after its last point it keeps its last ratio.
- Combined equity at each time = cash + sum of (allocation x slot ratio). Slot P&L = allocation x (final ratio - 1), so final combined equity = deposit + sum of slot P&L.
- Slot statistics (full period and recent window) use only that run's own equity points. Correlation and pairwise drawdown overlap use only the dates both runs of the pair cover (no correlation and 0 overlap when they share no dates). Combined statistics and the joint drawdown share use the shared time axis.
- CAGR uses calendar time (365.25-day years). Sharpe is annualized from per-point returns with risk-free rate 0: mean / sample standard deviation x sqrt(returns per year). Maximal drawdown is the largest fall from a running peak, in percent of that peak.
- Correlation: Pearson correlation of per-point returns for each pair of slots. A flat slot has no correlation (shown as n/a).
- Drawdown overlap: for each pair, the share of time points where both slots are below their own running peak. The joint drawdown share is the share of time points where two or more slots are below their peak at the same time.
- Diversification check, on the invested part only (cash removed): volatility ratio = weighted average of slot volatilities / volatility of the invested sum. The combination is "diversified" when it has two or more slots, the volatility ratio is above 1, and the maximal drawdown of the invested sum is not larger than the weighted average of the slot maximal drawdowns.

## Verdict per slot

The recent window is the last 25% of the run's own equity points. Each slot's recent-window Sharpe and maximal drawdown are compared with its full-period values.

| Verdict | Rule |
| --- | --- |
| Insufficient | Fewer than 10 returns in the recent window. |
| Degrading | Full-period Sharpe is positive and the recent Sharpe is missing or below 0.5 x the full-period Sharpe; or the full-period Sharpe is not positive and the recent return is negative; or the recent maximal drawdown is above 1.5 x the full-period maximal drawdown. |
| Robust | None of the degrading conditions apply. |

The page shows the reason as text below the verdict, and the first 12 characters of the pinned revision below the slot name. The correlation and overlap matrix uses the slot numbers of the Slots table.

## Limits

- The equity series of a run has at most 2,000 points, so statistics are on that sampled series, not every bar.
- Slots with different bar timeframes are combined on the union time axis with forward fill; this lowers the measured volatility of the coarser slot.
- No rebalancing: each slot keeps its allocation for the whole period.
