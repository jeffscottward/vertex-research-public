# Sector rotation map: frozen weekly backtest

Research only. This report does not give investment advice. No code here creates, routes or simulates orders.

## Question

Does holding the sectors that sit in the **leading** quadrant of our weekly sector rotation map beat an equal-weight sector portfolio after costs?

## Method

- Formula: ratio and momentum use our own documented formula at the top of [`packages/api/src/sector-rotation.ts`](../../../packages/api/src/sector-rotation.ts). The backtest calls `computeTimeframePoints(closes, SPY, "weekly", ...)` for each sector.
- Weekly points use the last close of each ISO week (normally Friday).
- Each week `t`, the target is equal weight across the sectors whose weekly quadrant at `t` is `leading`. If no sector is leading, the portfolio holds SPY.
- The target set at close `t` earns the return from close `t` to close `t + 1`. The signal at `t` uses only data up to `t` (no lookahead).
- Cost: 10 bps per unit of one-way turnover (sum of |change in weight|), charged in the rebalance week. Turnover is measured against weights after one week of price drift. The start state is cash.
- Baselines: equal-weight 11 sectors, rebalanced weekly with the same cost model; SPY buy and hold (one entry cost).
- The test window starts at the first week where every sector has a weekly point.
- Metrics: CAGR, annualized volatility (weekly × √52), Sharpe (risk-free rate 0), maximum drawdown, average weekly turnover.

## Parameters

Weekly parameters from `SECTOR_ROTATION_PARAMS.weekly`: rsSmoothing 4, trendWindow 26, momentumLag 4, momentumSmoothing 3. They were set before this test and were not optimized on this data.

## Data

- Source: Yahoo Finance v8 chart API, daily adjusted closes (`range=10y`, `interval=1d`), read-only public GET.
- Symbols: SPY and XLB, XLC, XLE, XLF, XLI, XLK, XLP, XLRE, XLU, XLV, XLY.
- Dates kept: 2018-06-19 (XLC start) to 2026-10-30. Frozen on 2026-11-02 in [`closes.json`](closes.json), rounded to 4 decimals.
- Code: [`scripts/sector-rotation-backtest/backtest.ts`](../../../scripts/sector-rotation-backtest/backtest.ts). The test `backtest.test.ts` checks that the numbers below match.

## Results

Window: 2019-03-08 to 2026-10-30, 399 weekly returns. The leading-sector rule held sectors in 97.99% of weeks and SPY in 2.01%.

| Portfolio | CAGR | Volatility | Sharpe | Max drawdown | Avg weekly turnover |
| --- | --- | --- | --- | --- | --- |
| Leading sectors | 0.0950 | 0.1873 | 0.5778 | -0.3064 | 0.4520 |
| Equal-weight sectors | 0.1345 | 0.1755 | 0.8063 | -0.3391 | 0.0166 |
| SPY buy and hold | 0.1586 | 0.1810 | 0.9027 | -0.3183 | 0.0025 |

In this sample the leading-sector rule did worse than both baselines. It traded about 45% of the portfolio each week; at 10 bps that costs about 2.3% a year.

## Limits

- One sample, one period (about 7.6 years), one parameter set. Results can change with a different window.
- The ETFs have no survivorship problem, but the history is short because XLC started in 2018.
- No taxes, no slippage beyond 10 bps, no dividends timing detail beyond adjusted closes.
- Fills are assumed at the weekly close where the signal is computed.
- Parameters were not optimized; this is not a search for the best rule.
- Not investment advice. Research only. No trading.
