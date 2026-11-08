# VIX Term-Structure Gate (QuantConnect port)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- QuantConnect Strategy Library: [Exploiting Term Structure of VIX Futures](https://www.quantconnect.com/learning/articles/investment-strategy-library/exploiting-term-structure-of-vix-futures). Read 2026-11-08. Rule as stated: trade VIX futures on the slope of the VIX futures curve (contango or backwardation), hedged with E-mini S&P 500 futures; volatility is assumed to mean-revert.
- QuantConnect Strategy Library: [VIX Predicts Stock Index Returns](https://www.quantconnect.com/learning/articles/investment-strategy-library/vix-predicts-stock-index-returns). Read 2026-11-08. Rule as stated: rank the VIX close against 20 equally spaced percentiles of its last two years (504 daily values); go long the S&P 100 ETF (OEF) when VIX is at a two-year high or in the top two percentile boxes, short when at a two-year low or in the bottom two boxes; backtest 2006-01-01 to 2018-08-01.
- Port request: a VIX term-structure gate (contango: VIX/VIX3M below 1) and the "VIX predicts index returns" quintile table.
- Port request: owner, 2026-11-08 (QuantConnect idea ports; owner decision 2026-11-08: full strategy DSL with defined-risk option legs and reusable entry gates, TypeScript and Python engines in parity). This port does not reproduce QuantConnect's backtest. It trades the idea as defined-risk option spreads on modeled option prices, because the owner's options-only rule forbids share positions and naked futures. The spot VIX/VIX3M ratio stands in for the VIX futures curve; VIX futures are not traded.

## Classification

- Type: entry gate (reusable DSL filter `vixTermStructure`), tested on the SPY put credit vertical and before/after on two existing strategies, plus a descriptive quintile table.
- Direction: short premium, defined risk (credit verticals only).

Basis codes: S = stated by the source page; O = set by the owner's port request (2026-11-08); A = Vertex default, fixed before the first run.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Ratio at the close of bar i = VIX / VIX3M on that date. A missing value fails the gate.|O (contract)|
|2|Gate: entry allowed in contango, ratio < 1.0. An exact 1.00 is not contango; the number of tie days is reported. DSL: `{type: "vixTermStructure", maxRatio: 1.0}` with a strict bound.|O / A|
|3|Primary use: the SPY put credit vertical of [qc-regime-put-vrp](qc-regime-put-vrp.md) with this gate in place of `volRegime`: put credit vertical, short put at 25 delta (`shortDelta` 0.25), long put `widthSigma` 0.5 further out of the money, expiry nearest 45 DTE with DTE ≥ 30, `profitTakePct` 50 (close when the spread value is at or below 50% of the credit received), `exitDte` 21, `maxLossPct` 2; month-end entry signal, trade at the first trading day close; at most one open spread.|A|
|4|Exits: profit-take or `exitDte`; the gate never blocks an exit.|A|

## Backtest design (fixed 2026-11-08, before the first run)

- Sample: from 2006-07-17 (VIX3M starts) to 2026-11-06. First entry signal at month-end 2006-07-31.
- Baseline B: the SPY put credit vertical with no gate, shared with [qc-regime-put-vrp](qc-regime-put-vrp.md) (counts once).
- Overlap with `volRegime` (share of month-ends where both pass, and where only one passes) is reported from the signal series; it is not a run.
- Existing strategy sma30 (runs S): the DSL form of [sma30-market-timing](sma30-market-timing.md) on SPY. Entry when close > SMA(30) of close; exit when close < SMA(30). It uses SPY `close`, not the French total-return index of that spec. From 1993-01-29.
- Existing strategy donchianBreakout (runs D): `STRATEGY_TEMPLATES.donchianBreakout` in `packages/api/src/strategy-dsl.ts`, unchanged (entry: close above the highest high of the prior 20 bars; exit: close below the lowest low of the prior 10 bars), on each Core 7 ETF in one shared-equity portfolio; each member from its IV index start (SPY 1993-01-29, QQQ 2001-01-23, DIA 2005-11-22, IWM 2009-09-16, GLD 2008-06-03, SLV 2011-03-16, USO 2007-05-10).
- Options expression for runs S and D: call debit vertical, `longDelta` 0.5, `widthSigma` 1.0, expiry nearest 30 DTE with DTE ≥ 21, `exitDte` 5, `maxLossPct` 2, no profit-take. A spread closes on the strategy's exit signal or at `exitDte`. While flat, a new spread opens at the close after any bar on which the entry condition holds (so sma30 re-enters after an `exitDte` close while SPY stays above its SMA; Donchian waits for a new breakout).
- The gate is a DSL filter on entries only; exits are never blocked. Runs S0 and D0 (no gate) are shared by [qc-iv-rank-gate](qc-iv-rank-gate.md), [qc-regime-put-vrp](qc-regime-put-vrp.md) and [qc-vix-term-gate](qc-vix-term-gate.md) and count once.

|Run|Definition|Counted|
|---|---|---|
|A|SPY put credit vertical, contango gate (primary)|yes|
|B|SPY put credit vertical, no gate (baseline)|yes (shared)|
|S0|sma30 options expression, no gate|yes (shared)|
|S3|S0 + contango gate|yes|
|D0|donchianBreakout options expression over Core 7, no gate|yes (shared)|
|D3|D0 + contango gate|yes|

Runs in this spec: 6 (3 own, 3 shared). Family total: 32. The quintile table below is descriptive and is not a run.

Common to all QuantConnect ports:

- Data: `research/backtests/qc-ports/fetch_data.py`, output in `~/Documents/reports/vertex-qc-ports/data` on the rig (fetched 2026-11-08: Yahoo daily bars and indices to 2026-11-06, CBOE history for RVX and VXSLV, Shiller monthly data to 2026-06). Not committed (the Yahoo, CBOE and Shiller terms do not allow redistribution); the study records the SHA-256 values from `SHA256SUMS`.
- Calendar: NYSE trading days from the SPY bars. Month-end = the last SPY trading day of the month. Other series are aligned to these dates with the last value on or before each date.
- Prices: option strikes and spot use `close` (split-adjusted, not dividend-adjusted). Signals that say total return use `adj_close`.
- Option prices: modeled with Black-Scholes, not real chains. ATM implied volatility = 0.9 × the symbol's CBOE index for VIX, VXN, VXD and RVX, 0.95 × for GVZ, OVX and VXSLV, with the per-symbol skew slope in `options.py`. Index per symbol: SPY VIX, QQQ VXN, DIA VXD, IWM RVX, GLD GVZ, SLV VXSLV, USO OVX. r from IRX; constant dividend yield q: SPY 1.5%, QQQ 0.7%, DIA 1.8%, IWM 1.2%, others 0. Strike grid USD 1 when spot ≥ 25, else USD 0.50.
- Expiry: the standard monthly expiry (third Friday, or the prior trading day when that Friday is a holiday) nearest the target DTE among expiries with DTE ≥ the minimum.
- Legs: debit vertical = long leg at `longDelta`, short leg `widthSigma` × ATM IV × √T × spot further out of the money (at least one strike step). Credit vertical = short leg at `shortDelta`, long leg the same distance further out of the money.
- Costs, charged on every opening and closing trade: USD 0.65 per contract per leg plus half the modeled bid-ask spread per leg, max(USD 0.01, pct × leg mid), pct SPY 1%, QQQ 1.5%, IWM 2%, DIA 3%, GLD 2.5%, SLV 4%, USO 4%. A spread held to expiry settles at intrinsic value without costs.
- Sizing: starting capital USD 100,000. Contracts = floor(2% × current equity / maximum loss per contract), also limited by the cash left; maximum loss per contract = the entry value plus entry costs (debit vertical: debit × 100; credit vertical: (width − credit) × 100, fully collateralised). An order risking more than 2% is refused. A signal that sizes to 0 contracts is skipped and counted. A missing IV index or rate on the entry bar means no trade.
- Execution: a signal at the close of bar i trades at the close of bar i+1 at the modeled price after costs. Profit-take, `exitDte` and expiry are checked at each close and executed at that close. Exits are processed before entries each day.
- Marks and cash: open spreads are marked daily at the modeled value (per contract: debit = spread value × 100; credit = (width − spread value) × 100, fully collateralised). Uninvested cash earns no interest.
- Engines: the pure-Python reference ledger (`ledger.py`) and the Nautilus runner (`nautilus_runner.py`) must agree on every trade and on daily equity before a result is recorded.
- Metrics: CAGR, Sharpe ratio (daily equity returns, risk-free rate 0, × √252), deflated Sharpe probability (Bailey and López de Prado, `deflated_sharpe_ratio` in `services/research/backtesting/optimizer.py`), maximum drawdown, worst calendar month, trades, win rate, exposure (share of days with an open spread).
- Multiple testing: the 11 QuantConnect port specs (`docs/specs/strategies/qc-*.md`) pre-register 32 distinct runs; a run shared by several specs counts once. Deflated Sharpe uses n_trials = 32, the variance of the per-day Sharpe ratio across those 32 runs, and the run's own skew, kurtosis and day count. Any added run raises n_trials and is recorded in the study.

### VIX predicts index returns: quintile table (descriptive; not a run, not in the verdict)

- Observations: every month-end from 1993-01-29 to 2026-09-30 (the last month-end with a complete next month).
- VIX percentile at month-end t = 100 × (number of the previous 503 VIX closes below the close at t) / 503, using the 504-value two-year window of the source page (VIX history from 1990 fills the first window).
- Quintile: Q1 below 20, Q2 20 to below 40, Q3 40 to below 60, Q4 60 to below 80, Q5 80 and above.
- Outcome: SPY total return (`adj_close`) from month-end t to month-end t+1. Non-overlapping monthly observations.
- Table per quintile: count, mean, median, share positive, standard deviation and t-statistic of the mean, and the Q5 − Q1 difference with its Welch t-statistic. Also shown: the same table on full-sample VIX level quintiles (uses future data; labelled as such) and a two-row split of month-ends by contango (ratio < 1) versus not, from 2006-07-31.
- The source page's trading rule (long OEF in the top two of 20 boxes, short in the bottom two) is not run: shorting needs a put debit vertical and would be a further trial; the table answers whether high VIX precedes higher returns.

## Pass/fail rule (fixed 2026-11-08, before the first run)

The rule passes only if run A, after costs, over its full sample to 2026-11-06, meets ALL of:

1. Sharpe ratio above 0.5.
2. Deflated Sharpe probability above 0.9 with n_trials = 32.
3. Maximum drawdown smaller than 25% (peak to trough of daily equity).
4. Sharpe ratio above run B, the same structure without the signal (always on, monthly), over the same dates.

Return alone is not the bar. Other runs are reported and do not change the verdict. No parameter changes after the first run; a changed rule is a new run and raises n_trials.

Secondary (reported, not part of the verdict): the contango gate is measured before and after on the two existing strategies, over the dates from 2006-07-17: Sharpe, maximum drawdown, CAGR, trades and exposure of the gated run against the ungated run on the same dates. The gate is reported as helping a strategy only when the gated Sharpe is higher and the gated maximum drawdown is no worse.

## Code and tests

Planned paths; this spec is committed before the code.

- Rules, option model and ledger: `services/research/strategies/qc_ports/` (`data.py`, `calendar.py`, `options.py`, `book.py`, `ledger.py`, `metrics.py`, `nautilus_runner.py`).
- DSL: the `vixTermStructure` filter and the `options` block (`putCreditVertical`) in `packages/api/src/strategy-dsl.ts`, mirrored in `services/research/nautilus_backtest/signals.py` with golden parity fixtures (TypeScript and Python must agree).
- Tests (hand-computed, written with the engine and before the first run): ratio below, at and above 1.0; missing VIX3M; the percentile and quintile edges of the table (ties, exactly 20/40/60/80).
- Data: `research/backtests/qc-ports/fetch_data.py`.
- Results: stored in Postgres `research_studies` (id `qc-vix-term-gate`) with `bun run vertex:research-studies:import`. No results JSON file is committed (AGENTS.md rule 13).

## Results

Not run yet. Results are stored in Postgres `research_studies` (id `qc-vix-term-gate`) and filled in here after the run: run date, data manifest, the metrics of every run in this spec and the verdict. The quintile table is stored in the same study.

## Limits

- Option prices are modeled from 30-day CBOE volatility indices with Black-Scholes, not real chains: no real skew surface or term structure, no early exercise or assignment, no pin risk, no liquidity limit. Real fills could be worse, mostly for DIA, SLV and USO spreads.
- Some sample years predate listed options on the ETF (SPY options, for example, listed in January 2005). Results for those years are hypothetical.
- Costs are modeled; no market impact, no tax. Uninvested cash earns nothing, which lowers CAGR for the rule and the baseline alike.
- Yahoo data from one vendor, not checked against a second source.
- VIX3M is the 3-month spot index, not a VIX future; the futures curve can differ, mostly in the front month.
- The quintile table has about 400 monthly observations; quintile means have wide confidence intervals and are not a trading result.
