# Backtest statistics

The server derives these statistics from the stored (agent-reported) equity series and trades of one backtest result. The code is in `packages/api/src/backtest-analytics.ts` and the `quant-*.ts` modules beside it. The portal shows them in the backtest detail view (`apps/web/src/components/portal/backtest-quant-panels.tsx`).

All values are research output. They do not authorize a trade and are not sizing instructions.

## Conventions

- Returns are simple per-period returns of the equity series. The risk-free rate is 0.
- Annualization uses the observed frequency: periods divided by elapsed years.
- Resampling is deterministic for one result. Each section uses a seeded generator derived from the backtest id.
- Every p-value tests H0: the true mean return (or Sharpe ratio) is zero or below, against H1: it is above zero. p-values are one-sided unless the label says two-sided.

## Significance (Validation tab)

| Test | Method | Output |
| --- | --- | --- |
| t-test | One-sample Student t-test of the mean per-period return | t, degrees of freedom, one-sided and two-sided p-values, 95% confidence interval of the mean |
| Stationary bootstrap | Politis and Romano (1994). Blocks start at random positions, wrap around the series and have geometric lengths with mean `round(n^(1/3))`. 1000 resamples | 95% percentile interval and p-value for the mean return and the annualized Sharpe ratio |

The bootstrap p-value uses the centred bootstrap distribution: `p = (1 + #{theta* - theta >= theta}) / (B + 1)`, where `theta` is the observed estimate and `B` is the number of finite resamples. The block structure keeps short-range dependence (for example volatility clustering) in the resamples. The t-test assumes independent returns, so compare both rows.

Minimum input: three returns with some variation. With fewer, the section says so.

## Multiple testing (Validation tab)

A backtest is one trial among all the backtests run for the same idea. The trial ledger of a backtest is every result recorded for its strategy. A result without a strategy link uses its ledger task instead. The database computes the per-period return mean and standard deviation of each other result (`trialLedger` in `packages/db/src/server/repositories.ts`). It reads the newest 49 other results (this bounds the cost of the detail view); the trial count uses all of them. The `backtests.record` response omits this section (`multipleTesting: null`); `backtests.get` computes it.

| Statistic | Method |
| --- | --- |
| Deflated Sharpe ratio | Bailey and Lopez de Prado (2014). N is the number of trials in the ledger. The variance of the trial Sharpe ratios is taken from the annualized Sharpe ratio of each usable trial and converted to this backtest's per-period units. Skew and kurtosis come from this backtest's returns. With one trial the expected maximum Sharpe is 0, so the value equals the probabilistic Sharpe ratio against zero. |
| Benjamini-Hochberg | q-value of this backtest from each usable sampled trial's one-sided t-test p-value. Results outside the sample count as tests with p = 1, so the number of tests equals the trial count when all results are usable and the q-value stays conservative. Discoveries are trials with q at or below 0.05 (5% false discovery rate). |

A usable trial has at least three returns, a nonzero standard deviation and a positive elapsed time. The section states a reason instead of a value in these cases: this backtest has no usable returns; other trials exist but none is usable, so the Sharpe variance is unknown; or the skew and kurtosis make the deflation term undefined.

The optimizer (`services/research/backtesting/optimizer.py`) computes its own deflated Sharpe ratio from its trials. Walk-forward runs count every distinct trial of every fold and test the last fold's selection. Market-only runs count one trial per market and test the top-ranked market. Pareto runs have no single selection and state that reason.

## Volatility clustering (Risk tab)

| Statistic | Method |
| --- | --- |
| Ljung-Box on squared returns | Ljung and Box (1978) Q statistic on the demeaned squared returns, with `min(10, floor(n / 5))` lags and a chi-square p-value. H0: no autocorrelation. A small p-value means volatility clusters. Needs 20 returns. |
| GARCH(1,1) | Gaussian maximum likelihood with variance targeting: `omega = v (1 - alpha - beta)`, where `v` is the sample variance of the demeaned returns, and the first conditional variance is `v`. Nelder-Mead from three starting persistences (0.5, 0.9, 0.98); the best fit is kept. The constraints `alpha, beta >= 0` and `alpha + beta < 1` hold by construction. Needs 50 returns. |

Outputs: alpha, beta, persistence, the half-life of a volatility shock in periods, the long-run volatility, the next-period volatility and the average forecast volatility over the next 21 periods. Volatility values are annualized with the observed periods per year. The section flags a fit that did not converge from every starting point.

The volatility forecast is for options sizing research. It is a display value only. No code path uses it to size an order.

## Pairs research lens (Validation tab)

`services/research/strategies/pairs.py` is a research-only statistical-arbitrage lens. It places no orders and has no broker access. It reads two CSV files (`date,close`), runs the lens and prints a backtest record in the agent-ops record shape. An agent records that output like any other backtest, so the portal derives all statistics on this page from it.

| Step | Method |
| --- | --- |
| Hedge ratio | OLS of Y on a constant and X, on the formation window only (default: the first 50% of the shared dates) |
| Cointegration | Engle and Granger (1987): ADF test without constant on the residual spread, lags chosen by AIC (as statsmodels `coint`). p-value: MacKinnon (1994) for two series with constant. Critical values: MacKinnon (2010). H0: no cointegration |
| Half-life | AR(1) fit `ds_t = a + b s_(t-1)` of the formation spread; half-life `ln(0.5) / ln(1 + b)` bars, or none without mean reversion |
| Spread backtest | After the formation window: z-score of the spread over a rolling lookback (default 60). Long spread at `z <= -entry`, short at `z >= entry`, exit at `abs(z) <= exit`, stop at `abs(z) >= stop`, close at the last bar. Signals at bar t fill at the close of bar t + 1. Costs: `cost_bps` of the traded notional of both legs at each fill |

The record stores the diagnostics as `pair.*` metrics (hedge ratio, ADF t, Engle-Granger p, 5% critical value, half-life, settings and round trips). The Validation tab shows them in a Pairs lens section only when these metrics exist. Trade prices are the Y leg; trade P&L is the net pair P&L after costs. A pair that is not cointegrated at the 5% level in the formation window is flagged.

Run example (research only):

```sh
cd services/research
python -m strategies.pairs --y EWA.csv --x EWC.csv --y-label EWA --x-label EWC \
  --task-id <ledger task id> --data-source "<source>" --formation-fraction 0.4 > record.json
```

## Shuffled-rating placebo (Placebo tab)

A backtest record may carry a `ratingSeries`: the research ratings an agent gave one daily symbol, one per decision date, on a five-tier scale (`buy`, `overweight`, `hold`, `underweight`, `sell`). A rating of `null` marks a failed or unparseable run. A series has 2 to 520 decisions with strictly increasing dates and a cost (`costBps`, default 10, at most 500). Ratings are research stance labels only. No code path turns a rating into an order.

`backtests.record` and `backtests.get` replay the series against the stored daily bars of the symbol (`market_bar_series`, timeframe `1d`, imported with `bun run vertex:bars:import`). The code is in `packages/api/src/agent-rating-placebo.ts`. The result is `ratingEvaluation`: `null` without a series, `unavailable` with a reason (`no_bars`, `bad_bars` for a zero, negative or missing price in the replay window, `outside_history`, `too_few_decisions`, `storage_error` or `evaluation_error`), or `ready`. An unavailable evaluation never fails the call, so a stored result is never reported as failed.

Bar dates are UTC: the replay reads the UTC calendar date of each bar's open time `t` as its trading date. Daily bars must be stamped at UTC midnight or during the UTC trading day (as `vertex:bars:import` does); a bar stamped at local midnight east of UTC would map to the previous date.

| Rule | Method |
| --- | --- |
| Start | Equity is 100 at the close of the bar of the first decision. A decision on date D uses the last bar whose UTC date is on or before D |
| Fills | A decision trades at the open of the next bar. A later decision on the same bar replaces the earlier one. A decision on the last bar does not trade |
| Targets | `buy` 100% long, `overweight` 50%, `underweight` and `sell` flat. `hold` and a failed run (`null`) keep the position; a failed run is counted, never read as hold |
| Costs | `costBps` of the traded notional on every position change. Long only, no leverage; cash earns nothing |
| Buy and hold | Fully invested at the first fill open, same cost |
| 50/200-day MA rule | On each decision date: buy when the 50-day simple average of closes (up to and including the decision bar) is above the 200-day average, else sell; same fills. Omitted when the first decision has fewer than 200 bars of history |
| Metrics | Daily returns of the equity curve: total and annual return (252 days a year), volatility (sample standard deviation), Sharpe (risk-free rate 0), max drawdown, time in market (mean weight, each bar capped at 100%), trades and cost drag (costs over starting equity) |
| Placebo | The same ratings shuffled across the same dates. When there are at most 1,000 distinct orderings, every ordering runs once; otherwise 1,000 seeded draws (Fisher-Yates, seed from the backtest id). The work is bounded to 5 million bar steps (simulations times bars), so a long history draws fewer orderings; the result states the number. The band is the 5th, 50th and 95th percentile of the placebo equity at each charted point (at most 500). The agents percentile is the share of placebo final equities below the agents final equity, plus half the ties |
| By rating | For each rating: the decision count, the mean close-to-close return from the decision bar close to the next decision bar close (the last bar for the final decision), as in Glassbench. It is a forecast check of the rating, not the return of the fills, which trade at the next open, and the hit rate (share of positive returns for `buy` and `overweight`, negative for `underweight` and `sell`; none for `hold`) |

A rating series that beats most placebo orderings has timing skill beyond its mix of ratings. One that sits near the 50th percentile does no better than the same ratings in random order.

The method adapts the rating-only replay and placebo of [Glassbench](https://github.com/davidalmeida90/glassbench) by David Arias (Apache License 2.0, commit `255414b`); see `NOTICE`. A unit test checks the replay against Glassbench output for a fixed fixture.
