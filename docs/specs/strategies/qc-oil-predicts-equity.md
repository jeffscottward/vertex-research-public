# Crude Oil Predicts Equity Returns (QuantConnect port)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- QuantConnect Strategy Library: [Can Crude Oil Predict Equity Returns?](https://www.quantconnect.com/learning/articles/investment-strategy-library/can-crude-oil-predict-equity-returns). Read 2026-11-08.
- Rule as stated: regress the monthly stock-index return on the previous month's oil return (r_stock,t = a0 + a1 × r_oil,t−1 + e_t) over the last 2 years (22 to 23 monthly observations), re-estimated each month; hold the S&P 500 (100%) when the predicted return beats the T-bill rate, T-bills otherwise. Oil is the OPEC basket price (Nasdaq Data Link `OPEC/ORB`). The page notes that the rule was long almost all of its 9-year test and made only 9 trades.
- Port request: a rolling 60-month regression of next-month SPY excess return on last-month USO return; long SPY and QQQ call debit verticals when the prediction beats the T-bill. USO, not CL=F: CL=F settled at a negative price on 2020-04-20.
- Port request: owner, 2026-11-08 (QuantConnect idea ports; owner decision 2026-11-08: full strategy DSL with defined-risk option legs and reusable entry gates, TypeScript and Python engines in parity). This port does not reproduce QuantConnect's backtest. It trades the idea as defined-risk option spreads on modeled option prices, because the owner's options-only rule forbids share positions and naked futures.

## Classification

- Type: standalone monthly predictive regression (computed in the runner; the DSL `series` filter reads the prediction as a derived series).
- Direction: long, defined risk (call debit verticals only).

Basis codes: S = stated by the source page; O = set by the owner's port request (2026-11-08); A = Vertex default, fixed before the first run.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Oil return for month s: USO month-end `adj_close` return.|O|
|2|Equity excess return for month s, per ETF (SPY, QQQ): month-end `adj_close` return − IRX at the previous month-end / 1200 (IRX is an annual percentage; divided by 12 and by 100).|O / A|
|3|Regression at month-end t, per ETF: ordinary least squares of excess return y_s on the oil return x_s−1 over the last 60 pairs with s ≤ t. The source used 2 years; the owner set 60 months.|O|
|4|Prediction: ŷ_t+1 = a0 + a1 × x_t. In when ŷ_t+1 > 0, that is, when the predicted return beats the T-bill rate.|O|
|5|Each ETF that is in gets one call debit vertical; out: flat. Each ETF uses its own regression.|A|
|6|Monthly rebalance: the signal is computed at the month-end close; trades execute at the close of the first trading day of the next month. At each rebalance every open spread is closed and the selected spreads are opened fresh (a monthly roll), so a member that stays selected is rolled, not held.|S / A|
|7|Structure: call debit vertical, `longDelta` 0.5, `widthSigma` 1.0, expiry nearest 60 DTE with DTE ≥ 45, `maxLossPct` 2, no profit-take, no `exitDte` (the monthly roll closes it at about 30 to 40 DTE).|A|

## Backtest design (fixed 2026-11-08, before the first run)

- Sample: USO starts 2006-04-10, so the first monthly oil return is May 2006 and 60 pairs exist at month-end 2011-05-31 (first signal; first trade 2011-06-01). End 2026-11-06 (last rebalance 2026-11-02). SPY and QQQ in one shared-equity portfolio.
- The regression coefficients (a1 and its t-statistic) per month, and the share of months in, are reported with the result.
- Baseline B: SPY and QQQ call debit verticals every month (always on, monthly roll), same structure and dates.

|Run|Definition|Counted|
|---|---|---|
|A|Oil-regression timing on SPY and QQQ (primary)|yes|
|B|Always-on monthly SPY and QQQ call debit verticals (baseline)|yes|

Runs in this spec: 2. Family total: 32.

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

## Pass/fail rule (fixed 2026-11-08, before the first run)

The rule passes only if run A, after costs, over its full sample to 2026-11-06, meets ALL of:

1. Sharpe ratio above 0.5.
2. Deflated Sharpe probability above 0.9 with n_trials = 32.
3. Maximum drawdown smaller than 25% (peak to trough of daily equity).
4. Sharpe ratio above run B, the same structure without the signal (always on, monthly), over the same dates.

Return alone is not the bar. Other runs are reported and do not change the verdict. No parameter changes after the first run; a changed rule is a new run and raises n_trials.

## Code and tests

Planned paths; this spec is committed before the code.

- Rules, option model and ledger: `services/research/strategies/qc_ports/` (`data.py`, `calendar.py`, `options.py`, `book.py`, `ledger.py`, `metrics.py`, `nautilus_runner.py`).
- DSL: the `series` filter and the `options` block (`callDebitVertical`) in `packages/api/src/strategy-dsl.ts`, mirrored in `services/research/nautilus_backtest/signals.py` with golden parity fixtures (TypeScript and Python must agree).
- Tests (hand-computed, written with the engine and before the first run): the 60-pair regression on a hand-built series with a known slope; alignment of x_s−1 with y_s; the IRX conversion; the first signal month.
- Data: `research/backtests/qc-ports/fetch_data.py`.
- Results: stored in Postgres `research_studies` (id `qc-oil-predicts-equity`) with `bun run vertex:research-studies:import`. No results JSON file is committed (AGENTS.md rule 13).

## Results

Run 2026-11-08 with `python -m strategies.qc_ports study --ran 2026-11-08` (services/research), data manifest sha256(SHA256SUMS) `95fc3a54ce009761b2818f8fd79c0cfb2880eb5d86aba33099e60f56b0c55348`, data to 2026-11-06. The JSON document of the same command (without --report) goes to Postgres `research_studies` (id `qc-oil-predicts-equity`) through `bun run vertex:research-studies:import`. Deflated Sharpe: n_trials 32, variance of the per-day Sharpe across the 32 runs 0.000232. Ledger and NautilusTrader agreed on every trade and on daily equity (1e-6 relative).

Implementation: `services/research/strategies/qc_ports/ideas.py` (DSL definitions, derived series, runs) and `study.py` (compile with `nautilus_backtest/signals.py`, book, ledger, Nautilus parity, metrics). One open spread per member is decided from the priced book; a spread the ledger refuses for size (0 contracts) still holds its member until its priced exit, and such refusals count in Skipped (with book skips such as a missing IV index value). The 60-month OLS prediction is computed in Python and read by the DSL `series` filter `qc:oilPrediction:<ETF>` > 0.

|Run|From|CAGR|Sharpe|Deflated Sharpe|Max drawdown|Worst month|Trades|Win rate|Exposure|Skipped|
|---|---|---|---|---|---|---|---|---|---|---|
|A|2011-05-31|3.5%|0.45|0.404|-17.8%|2019-05 -4.6%|341|52.5%|93.5%|0|
|B|2011-05-31|3.6%|0.44|0.395|-18.8%|2019-05 -4.2%|372|52.4%|99.9%|0|

- SPY: 186 regressions, months in 89.8%, mean a1 -0.001, |t(a1)| > 2 in 3.8%, last a1 -0.003 (t -0.05).
- QQQ: 186 regressions, months in 93.5%, mean a1 0.000, |t(a1)| > 2 in 4.8%, last a1 0.039 (t 0.55).
- Per-member attribution, run A: SPY 167 trades, P&L USD 31,018, win 55%; QQQ 174 trades, P&L USD 38,829, win 50%.

### Verdict

**FAIL**. Run A: Sharpe above 0.5: no; deflated Sharpe above 0.9 (n_trials 32): no; max drawdown smaller than 25%: yes; Sharpe above run B: yes (A Sharpe 0.45, B Sharpe 0.44, deflated 0.404, max drawdown -17.8%).

## Limits

- Option prices are modeled from 30-day CBOE volatility indices with Black-Scholes, not real chains: no real skew surface or term structure, no early exercise or assignment, no pin risk, no liquidity limit. Real fills could be worse, mostly for DIA, SLV and USO spreads.
- Some sample years predate listed options on the ETF (SPY options, for example, listed in January 2005). Results for those years are hypothetical.
- Costs are modeled; no market impact, no tax. Uninvested cash earns nothing, which lowers CAGR for the rule and the baseline alike.
- Yahoo data from one vendor, not checked against a second source.
- USO is a rolled front-month futures fund: in contango its return falls below the oil price change, so x measures fund return, not oil.
- IRX is a 13-week discount yield used as the T-bill rate without conversion to a bond-equivalent yield.
- Like the source page notes, the rule may be in almost every month; then it differs little from the baseline.
