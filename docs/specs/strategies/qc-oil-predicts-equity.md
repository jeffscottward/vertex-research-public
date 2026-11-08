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

Run 2026-11-08 with `python -m strategies.qc_ports study --ran 2026-11-08` (services/research), data manifest sha256(SHA256SUMS) `95fc3a54ce009761b2818f8fd79c0cfb2880eb5d86aba33099e60f56b0c55348`, data to 2026-11-06, code revision `b1d945c50bfceac8d482ac5b013dcfa89469893e` (run id `qc-ports-2026-11-08-b1d945c50bfc`). The JSON document of the same command (without --report) goes to Postgres `research_studies` (id `qc-oil-predicts-equity`) through `bun run vertex:research-studies:import`. Deflated Sharpe: n_trials 32, variance of the per-day Sharpe across the 32 runs 0.000218. Ledger and NautilusTrader agreed on every trade and on daily equity (1e-6 relative).

Implementation: `services/research/strategies/qc_ports/ideas.py` (DSL definitions, derived series, runs) and `study.py` (compile with `nautilus_backtest/signals.py`, book, ledger, Nautilus parity, metrics). One open spread per member is decided from the priced book; a spread the ledger refuses for size (0 contracts) still holds its member until its priced exit, and such refusals count in Skipped (with book skips such as a missing IV index value). Max open risk = the largest share of equity at risk (contracts x max loss) in open spreads at any close (reported only, no cap). The 60-month OLS prediction is computed in Python and read by the DSL `series` filter `qc:oilPrediction:<ETF>` > 0.

|Run|From|CAGR|Sharpe|Deflated Sharpe|Max drawdown|Worst month|Trades|Win rate|Exposure|Skipped|Max open risk|Stale-IV exits|
|---|---|---|---|---|---|---|---|---|---|---|---|---|
|A|2011-05-31|3.0%|0.42|0.386|-15.4%|2019-05 -4.0%|341|52.5%|93.5%|0|4.0%|0|
|B|2011-05-31|3.4%|0.44|0.425|-16.2%|2019-05 -4.0%|372|52.4%|99.9%|0|4.1%|0|

- SPY: 186 regressions, months in 89.8%, mean a1 -0.001, |t(a1)| > 2 in 3.8%, last a1 -0.003 (t -0.05).
- QQQ: 186 regressions, months in 93.5%, mean a1 0.000, |t(a1)| > 2 in 4.8%, last a1 0.039 (t 0.55).
- Per-member attribution, run A: SPY 167 trades, P&L USD 26,577, win 55%; QQQ 174 trades, P&L USD 32,131, win 50%.

### Sanity checks

Reported only; no run or parameter changed. `python -m strategies.qc_ports audit` (reference ledger).

|Run A|Sharpe|Deflated Sharpe|CAGR|Max drawdown|Run B Sharpe|Verdict|Failing clauses|
|---|---|---|---|---|---|---|---|
|Net (as run)|0.42|0.386|3.0%|-15.4%|0.44|FAIL|Sharpe above 0.5; deflated Sharpe above 0.9 (n_trials 32); Sharpe above run B|
|Gross (zero costs)|0.60|0.663|4.6%|-17.0%|0.62|FAIL|deflated Sharpe above 0.9 (n_trials 32); Sharpe above run B|
|ATM IV 1.0 x index, no skew|0.71|0.799|4.7%|-13.7%|0.74|FAIL|(sensitivity, not deciding)|

- Mean round-trip cost per contract of run A (341 booked trades): 3.91% of the max loss, 4.31% of the premium (debit paid or credit received).
- Costs decide the verdict: no (the verdict is the same at zero costs).

Known-edge case (SPY call debit vertical, 0.5 delta, opened at every month start of the period, closed at the next one; must be clearly profitable):

|Period|Expression|Trades|Winners|P&L USD|Account return|SPY total return|
|---|---|---|---|---|---|---|
|2013|60 DTE, monthly roll|12|10|8,078|8.1%|31.0%|
|2013|30 DTE, monthly roll|12|9|8,524|8.5%|31.0%|
|2023-2024|60 DTE, monthly roll|24|15|7,395|7.4%|57.2%|
|2023-2024|30 DTE, monthly roll|24|15|7,832|7.8%|57.2%|

Priced-trade check (5 random SPY call debit verticals of the 30 DTE monthly roll and 3 random SPY put credit verticals of the unfiltered put credit run, seed 20261108; values per contract (credit: width - spread value, collateralised); held = the same spread priced to expiration; intrinsic = from the leg payoffs at the expiry close):

|Structure|Entry|Expiry|Spot|Long/short strike|Entry value|Width|Spot at expiry|Held value|Intrinsic|Settles at intrinsic|Marks in [0, width]|Values in [0, width], spot 0.7x-1.3x|Largest move against spot (USD)|
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
|callDebitVertical|2007-01-03|2007-02-16|141.37|142/147|186.73|500|145.73|373.00|373.00|yes|yes|yes|0.62|
|callDebitVertical|2012-04-02|2012-05-18|141.84|142/149|243.59|700|129.74|0.00|0.00|yes|yes|yes|0.93|
|callDebitVertical|2002-08-01|2002-09-20|88.78|89/100|389.73|1100|84.35|0.00|0.00|yes|yes|yes|0.00|
|callDebitVertical|2005-10-03|2005-11-18|122.60|123/128|175.44|500|125.13|213.00|213.00|yes|yes|yes|0.48|
|callDebitVertical|2009-07-01|2009-08-21|92.33|92/100|305.88|800|102.97|800.00|800.00|yes|yes|yes|0.00|
|putCreditVertical|2013-07-01|2013-08-16|161.36|150/154|348.50|400|165.83|400.00|400.00|yes|yes|yes|4.17|
|putCreditVertical|2016-03-01|2016-04-15|198.11|183/189|522.07|600|207.78|600.00|600.00|yes|yes|yes|3.64|
|putCreditVertical|2011-05-02|2011-06-17|136.22|127/130|261.46|300|127.05|5.00|5.00|yes|yes|yes|3.63|

Largest move of a spread value against the spot over the grid: USD 4.17 per contract. It comes from the clamp of the skew model (options.py: standardized moneyness clamped at +-3), which flattens the smile of a deep in-the-money leg while the other leg's IV still moves; it is a small model artifact far from the money, not a pricing error in the runs.

### Verdict

**FAIL**. Run A: Sharpe above 0.5: no; deflated Sharpe above 0.9 (n_trials 32): no; max drawdown smaller than 25%: yes; Sharpe above run B: no (A Sharpe 0.42, B Sharpe 0.44, deflated 0.386, max drawdown -15.4%).

## Deviations (bug fixes after the first run)

Review round 1 (2026-11-08) found these bugs after the first run of the 32 runs; all 32 were run again with the fixes, and the results above are from that rerun. No rule or parameter of the pre-registration changed except as listed. First run, superseded: run A Sharpe 0.45, verdict FAIL.

- Max loss per contract now includes the worst-case exit cost (both legs: USD 0.65 commission + the half-spread of a leg worth the spread width), and every closing cost is capped at that worst case: the vertical closes as a package, so a deep in-the-money exit costs no more. Sizing (2% of equity over the max loss) therefore bounds the realized loss of a trade at 2%; before the fix a crash exit could cost more than the max loss (test: a -30% move with implied volatility doubling). The 2% bound holds under this package-close cost model only; legging out of a spread in a wide market could cost more than modeled.
- An open spread whose IV index is stale for more than 5 trading days (no value after the 5-day carry) is closed at that close, priced with the last IV used (exit reason `stale-iv`, counted per run). Before, the last value was carried for the whole trade.
- Inputs are validated: the option model refuses NaN, infinite or negative time, rate, dividend yield, spot or volatility; market columns must be finite (closes and IV above 0, rates not negative); instrument value and sizing refuse NaN instead of treating it as 0; the deflated Sharpe is left empty when its standard-error radicand is not positive (never a square root of a negative number).
- Data rows with a missing open, high, low or adj_close are dropped instead of filled with the close (no row of the current files is affected).
- Reported, not changing a run: the largest concurrent open risk per run.

## Limits

- Option prices are modeled from 30-day CBOE volatility indices with Black-Scholes, not real chains: no real skew surface or term structure, no early exercise or assignment, no pin risk, no liquidity limit. Real fills could be worse, mostly for DIA, SLV and USO spreads.
- Some sample years predate listed options on the ETF (SPY options, for example, listed in January 2005). Results for those years are hypothetical.
- Costs are modeled; no market impact, no tax. Uninvested cash earns nothing, which lowers CAGR for the rule and the baseline alike.
- Yahoo data from one vendor, not checked against a second source.
- USO is a rolled front-month futures fund: in contango its return falls below the oil price change, so x measures fund return, not oil.
- IRX is a 13-week discount yield used as the T-bill rate without conversion to a bond-equivalent yield.
- Like the source page notes, the rule may be in almost every month; then it differs little from the baseline.
