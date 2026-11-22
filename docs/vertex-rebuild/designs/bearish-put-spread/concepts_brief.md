# Bearish put-spread rule: backtest, spread pricing and option strategies in the engine comparison

* **Author:** Jeff Scott Ward (agent job, card vertex-bearish-put-spread-backtest)
* **Date:** 2026-11-22

## Overview

A market consult on 2026-11-19 proposed a bearish entry rule for QQQ and priced one put debit spread by hand. Vertex has three gaps that this work closes. Research only: a backtest result never authorizes a trade, and nothing here arms trading or places orders.

1. Vertex has no tool that prices a vertical spread. The consult added up leg quotes by hand (QQQ 2027-01-15 640/595 puts: debit 13.06 at the mids, 13.37 at the worse sides; the Vertex option model gave 12.76).
2. The bearish rule has no backtest.
3. The daily engine comparison (TypeScript engine against the Python/Nautilus worker) contains only long-only stock rules.

The rule (check near 15:45 New York, all four on one session):

1. QQQ traded at or above the dealer gamma flip level that day.
2. QQQ closes below the flip, at most 2% below it.
3. The day is not a heavy down-volume day (NYSE up-volume above 20%).
4. The re-struck spread costs 30% of its width or less.

Structure: long put near delta -0.40 to -0.45, short put near delta -0.25, monthly expiry 45 to 60 days out. After entry, close when QQQ closes above its 200-day average. Owner exit rule: a spread in profit may run to expiry (closed 15:45 on expiry day); a spread at a loss closes 3 trading days before expiry.

## Facts found in the code and the live database (2026-11-22)

* Both backtest engines already trade defined-risk verticals from a strategy definition (DSL `options` block, structure `putDebitVertical`): TypeScript `packages/api/src/options-engine/*`, Python `services/research/strategies/qc_ports/book.py`. A live run is computed by the Nautilus worker and the API re-runs the TypeScript runner and refuses a ledger gap above 1e-6. The live server runs every new backtest run on the Nautilus engine.
* The options runner puts the long leg at a target |delta| (`longDelta`) and the short leg `widthSigma` × ATM IV × √T × spot further out. It has no target delta for the short leg of a debit spread. It closes at expiry, at `exitDte` calendar days, at a profit target or on the exit signal. A signal at the close of bar i trades at the close of bar i + 1.
* The model: Black-Scholes, ATM IV = 0.9 × VXN for QQQ, linear skew -0.25 per standardized moneyness unit, rate from IRX, half-spread 1.5% of mid per leg plus $0.65 commission. With VXN 33.12, rate 4.00%, spot 645.04 and 57 days, the existing model gives 12.758 for the 640/595 spread, deltas -0.433 and -0.244.
* Gamma flip history: `flow_gex` has QQQ flips only for 2026-11-16 to 2026-11-20 (5 sessions). `openbb_option_iv_daily.gamma_flip` is empty for QQQ. The flip condition cannot be tested over the 4-year period.
* Breadth: `breadth90_days` holds 1,011 final sessions from 2022-11-10 to 2026-11-20 with `up_pct`. The 59 heavy down-volume days (kind DOWN_80 or DOWN_90) are exactly the days with `up_pct` ≤ 20. The strategy DSL cannot read breadth: its series list (`STRATEGY_SERIES_IDS`) holds only prices, volatility indices and rates from `market_daily_points`.
* Prices: `market_daily_points` holds QQQ, VXN and IRX daily to 2026-11-20.
* Option quotes: no stored chain table. The live `optionsChain.chain` API returns bid, ask, IV and Greeks per contract.
* The payoff lab (`apps/web/src/features/research-reports/payoff.ts`) is expiry-only browser code with no bear put spread and no Greeks; the server cannot import it.
* The daily engine comparison driver (`scripts/engine-comparison-driver/driver.ts`, rig timer 06:15 New York) sends only smaCross/breakout instant runs. Option strategies reach the comparison only through `academy/backtest` (feature `academy`, structures such as cash-secured put, iron condor, put credit spread; last run 2026-11-10, all succeeded).

## Method decisions (from the trading knowledge bases; answers saved in the job report)

* **Proxy for the gamma flip.** All four knowledge bases asked (options, quant, macro, DeltaTrend) say no price-only proxy is a gamma flip. Decision: test a named price-level proxy, "SMA20 failed-rally rule" (yesterday's 20-day SMA of closes), label it as a proxy and never as a gamma result, and run the same options block without the level conditions as the baseline. Report the 5 sessions with a real flip separately.
* **Scope.** QQQ, 2022-11-10 to 2026-11-20 (the breadth window). One open spread at a time (no overlapping trades). Fixed chronological split: in-sample to 2025-08-31, out-of-sample from 2025-09-01.
* **Decision rule, fixed before the runs.** Pass only when all hold: at least 30 trades; mean result per trade after costs above 0 with a bootstrap 95% interval above 0; the mean beats the always-on baseline (bootstrap of the difference); the out-of-sample mean is above 0. Win rate is reported, not a criterion. Drawdown is reported from a Monte Carlo resample of trades. Fewer than 30 trades: the result is descriptive only ("not proven").
* **Model limits.** Cross-check the model against the consult quotes (model 2.3% below the mid). Engine costs are the model half-spread (about twice the quoted half-spread) on both sides. Sensitivity: reprice the trades with ATM IV ±4 vol points with the same model functions.
* **Parameters.** longDelta 0.425; widthSigma 0.6 (puts the short leg near delta 0.25 at QQQ's usual IV; checked by the pricing tool); dte target 52, minimum 45; maxLossPct 2 (owner 2% rule); exit signal close > SMA200. Owner exit rule: the DSL cannot close losers and winners at different times, so two runs bracket it: exitDte 3 (all close 3 days before expiry) and no exitDte (all held to expiry).
* **Condition 4 (cost ≤ 30% of width) is not testable** with a constant-skew model: at fixed deltas the model's cost per width hardly changes. The report gives the model cost per width at each entry.
* **Entry timing.** The engine enters one session after the signal (no look-ahead). The rule enters the same session. Reported as a limitation.

## Proposed changes

1. **Spread pricing tool.** A pure function in `packages/api/src/options-engine/` that prices a vertical (put or call, either side) from the option model and from leg quotes: debit at the mids and at the worse sides, max loss, max gain, breakeven, cost as percent of width, net delta, gamma, theta and vega. A new oRPC procedure `optionsChain.spread` reads the live chain for the quotes and the latest stored spot, IV index and IRX for the model, and returns both with the model-to-mid gap. Model prices use the backtest model's own functions (`bsPrice`, `smileIv`, `atmIv`); Greeks use `blackScholes` of `options-chain-greeks.ts`.
2. **Breadth in the DSL.** A new series id `NYSE_UPVOL_PCT` (one value per session: final `breadth90_days.up_pct`). `market-daily-series` `loadSeries` serves it from `breadth90_days`, so no data is copied. Added to `STRATEGY_SERIES_IDS` (TypeScript) and `SERIES_IDS` (Python worker and qc_ports data).
3. **The rule as a strategy definition.** Python `ideas.py` constants (rule, two exit variants, baseline) and a spec page `docs/specs/strategies/bearish-put-spread.md` with the JSON definitions. Tests run the definition through both runners on fixture data. The live runs are submitted with `backtestRuns.submit` (QQQ, 1d, 2022-11-10 to 2026-11-20).
4. **Engine comparison.** The daily driver also requests academy option backtests on QQQ (cash-secured put and iron condor lessons), so option and short-premium strategies appear in `backtestRuns.comparisons.list` every day.
5. **Job report** with the knowledge-base answers, the decision record and the pathway to proving the rule.

## Goals vs. Non-Goals

* **In-Scope Goals:** the pricing tool and procedure; the breadth series; the rule definition, tests and live runs; option strategies in the daily comparison; the report.
* **Out-of-Scope Non-Goals:** orders, arming, risk settings, live trading units; a historical gamma-flip data set; option chain storage; calibration of the model constants (card vertex-option-model-calibration); the web payoff lab UI; a short stock rule in the instant backtest contract.

## Alternatives Weighed

* **Store breadth as a copied series in `market_daily_points`** (as `EY_TNX_RATIO` is). Rejected by author: a second copy needs a writer and a backfill and can drift from `breadth90_days`.
* **Add a short-leg target delta (`shortDelta`) for debit verticals in the options block.** Rejected by author: a contract and golden-ledger change in both engines; `widthSigma` 0.6 places the short leg near delta 0.25 already.
* **An asymmetric owner exit mode in the runner.** Rejected by author for this job: both engines and golden ledgers change; two runs bracket the rule.
* **Put the pricing tool in the web payoff lab.** Rejected by author: the server cannot import web code, and agents need the tool through the API.
* **A short stock rule (`side: short`) in the instant backtest for the comparison.** Deferred: it changes the instant contract and the comparison spec; academy option runs already reach the comparison with no contract change.
* **Use a different proxy (50-day SMA, prior high, VWAP).** Rejected by author: none is a gamma estimate either; SMA20 sits nearest to price, like the observed flips (666 against a 645 close on 2026-11-19).

## Key Decisions & Staging for Next Steps

* All method gates above are decided from the knowledge bases (owner rule 2026-11-14 for trading research jobs).
* One PR with focused commits: pricing tool, breadth series, rule definition, driver change, docs.
* Deploy: web on QuantVPS through `infra/quantvps/restart-when-idle.sh` (outside market hours), the research worker on the rig, the driver runner checkout on the rig.
