# Option Expiration Week Effect (QuantConnect port)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- QuantConnect Strategy Library: [Option Expiration Week Effect](https://www.quantconnect.com/learning/articles/investment-strategy-library/option-expiration-week-effect). Read 2026-11-08. The page cites research on returns and option activity over the option-expiration week for S&P 100 stocks: large-cap stocks with actively traded options have higher average weekly returns in expiration weeks.
- Rule as stated: hold the S&P 100 ETF (OEF) during the option-expiration week (the week of the monthly expiry, the third Friday, or the Thursday before when that Friday is a holiday); cash otherwise. QuantConnect buys on the Monday of that week; its backtest runs 2007-01-01 to 2018-08-01 with USD 10,000.
- Port request: call debit vertical, `opexWeek` window.
- Port request: owner, 2026-11-08 (QuantConnect idea ports; owner decision 2026-11-08: full strategy DSL with defined-risk option legs and reusable entry gates, TypeScript and Python engines in parity). This port does not reproduce QuantConnect's backtest. It trades the idea as defined-risk option spreads on modeled option prices, because the owner's options-only rule forbids share positions and naked futures.

## Classification

- Type: standalone calendar signal (DSL filter `calendarWindow`, window `opexWeek`).
- Direction: long, defined risk (call debit verticals only).

Basis codes: S = stated by the source page; O = set by the owner's port request (2026-11-08); A = Vertex default, fixed before the first run.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Universe: SPY, QQQ, DIA, IWM. OEF is not in Core 7; SPY is the nearest large-cap ETF, and the other three are tested in the same portfolio.|A|
|2|Expiration: the standard monthly expiry (third Friday, or the prior trading day when that Friday is a holiday). The OpEx week is the Monday-to-Friday week that contains it.|S|
|3|Holding: over the trading days of the OpEx week up to and including expiration day: open at the close of the last trading day before the week, close at the close of expiration day.|S|
|4|Signal timing: the entry signal is the close one trading day before the opening trade, and the exit signal the close of the trading day before expiration (signal at close i, trade at close i+1).|A|
|5|Literal variant (run A-L): the contract filter `{type: "calendarWindow", window: "opexWeek"}` evaluated on signal bars (it passes from the last trading day before the week through expiration). With the one-bar delay it opens at the close of the first trading day of the week and closes at the close of the trading day after expiration. Reported, not the pass test.|A|
|6|Structure: call debit vertical, `longDelta` 0.5, `widthSigma` 1.0, expiry nearest 30 DTE with DTE ≥ 21, `maxLossPct` 2, no profit-take, no `exitDte`. In the OpEx week the current month's expiry is under 7 days away, so the spread uses the next monthly expiry (about 5 weeks). One spread per member per week.|A|

## Backtest design (fixed 2026-11-08, before the first run)

- Members from their IV index start: SPY 1993-01-29, QQQ 2001-01-23, DIA 2005-11-22, IWM 2009-09-16. One shared-equity portfolio. Sample end 2026-11-06 (last full OpEx week: the week of 2026-10-16). Per-member attribution, the window with all four live (from 2009-09-16) and the source page's window (2007-01-01 to 2018-08-01) are reported from the same runs.
- Baseline B: the same call debit vertical on the same four ETFs, always on: opened at the close of the first trading day of each month (signal at the month-end close) and closed at the close of the first trading day of the next month, when the next one opens (monthly roll).

|Run|Definition|Counted|
|---|---|---|
|A|OpEx week held as in the source (primary)|yes|
|A-L|Literal `opexWeek` filter on signal bars|yes|
|B|Always-on monthly call debit verticals (baseline)|yes|

Runs in this spec: 3. Family total: 32.

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
- DSL: the `calendarWindow` filter (`opexWeek`) and the `options` block (`callDebitVertical`) in `packages/api/src/strategy-dsl.ts`, mirrored in `services/research/nautilus_backtest/signals.py` with golden parity fixtures (TypeScript and Python must agree).
- Tests (hand-computed, written with the engine and before the first run): expiration dates including holiday Fridays (for example Good Friday 2025-04-18, expiry 2025-04-17); OpEx weeks whose Monday is a holiday; entry and exit bars for runs A and A-L.
- Data: `research/backtests/qc-ports/fetch_data.py`.
- Results: stored in Postgres `research_studies` (id `qc-opex-week`) with `bun run vertex:research-studies:import`. No results JSON file is committed (AGENTS.md rule 13).

## Results

Run 2026-11-08 with `python -m strategies.qc_ports study --ran 2026-11-08` (services/research), data manifest sha256(SHA256SUMS) `95fc3a54ce009761b2818f8fd79c0cfb2880eb5d86aba33099e60f56b0c55348`, data to 2026-11-06, code revision `b1d945c50bfceac8d482ac5b013dcfa89469893e` (run id `qc-ports-2026-11-08-b1d945c50bfc`). The JSON document of the same command (without --report) goes to Postgres `research_studies` (id `qc-opex-week`) through `bun run vertex:research-studies:import`. Deflated Sharpe: n_trials 32, variance of the per-day Sharpe across the 32 runs 0.000218. Ledger and NautilusTrader agreed on every trade and on daily equity (1e-6 relative).

Implementation: `services/research/strategies/qc_ports/ideas.py` (DSL definitions, derived series, runs) and `study.py` (compile with `nautilus_backtest/signals.py`, book, ledger, Nautilus parity, metrics). One open spread per member is decided from the priced book; a spread the ledger refuses for size (0 contracts) still holds its member until its priced exit, and such refusals count in Skipped (with book skips such as a missing IV index value). Max open risk = the largest share of equity at risk (contracts x max loss) in open spreads at any close (reported only, no cap). Native DSL `calendarWindow` `opexWeek`. Run A evaluates the same window one bar ahead (the trading calendar is known in advance; a shifted leg may hold only calendarWindow filters), so the spread opens at the close before the week and closes at the expiration close; run A-L uses the filter on signal bars. A spread opens on the first bar of each full window and closes after its last bar.

|Run|From|CAGR|Sharpe|Deflated Sharpe|Max drawdown|Worst month|Trades|Win rate|Exposure|Skipped|Max open risk|Stale-IV exits|
|---|---|---|---|---|---|---|---|---|---|---|---|---|
|A|1993-01-29|-2.8%|-0.44|0.000|-63.6%|2018-12 -5.5%|996|44.5%|23.2%|174|7.8%|0|
|B|1993-01-29|-0.8%|-0.01|0.002|-65.1%|2019-05 -7.1%|1147|48.2%|100.0%|27|8.2%|0|
|A-L|1993-01-29|-3.1%|-0.48|0.000|-67.3%|2015-08 -6.0%|989|44.8%|23.1%|181|7.9%|0|

- Per-member attribution, run A: SPY 345 trades, P&L USD -22,517, win 48%; QQQ 241 trades, P&L USD -18,155, win 44%; DIA 208 trades, P&L USD -11,822, win 40%; IWM 202 trades, P&L USD -9,623, win 45%.
- All four live, run A (2009-09-16 to 2026-11-06): Sharpe -0.40, CAGR -3.0%, max drawdown -44.3%.
- All four live, run A-L (2009-09-16 to 2026-11-06): Sharpe -0.36, CAGR -2.6%, max drawdown -42.2%.
- All four live, run B (2009-09-16 to 2026-11-06): Sharpe 0.27, CAGR 2.9%, max drawdown -29.8%.
- Source window, run A (2007-01-03 to 2018-08-01): Sharpe -0.40, CAGR -3.6%, max drawdown -46.0%.
- Source window, run B (2007-01-03 to 2018-08-01): Sharpe 0.14, CAGR 1.0%, max drawdown -39.4%.
- Runs B of qc-opex-week and qc-turn-of-the-month are the same definition and dates (both pre-registered and counted).

### Sanity checks

Reported only; no run or parameter changed. `python -m strategies.qc_ports audit` (reference ledger).

|Run A|Sharpe|Deflated Sharpe|CAGR|Max drawdown|Run B Sharpe|Verdict|Failing clauses|
|---|---|---|---|---|---|---|---|
|Net (as run)|-0.44|0.000|-2.8%|-63.6%|-0.01|FAIL|Sharpe above 0.5; deflated Sharpe above 0.9 (n_trials 32); max drawdown smaller than 25%; Sharpe above run B|
|Gross (zero costs)|-0.06|0.001|-0.6%|-32.5%|0.26|FAIL|Sharpe above 0.5; deflated Sharpe above 0.9 (n_trials 32); max drawdown smaller than 25%; Sharpe above run B|
|ATM IV 1.0 x index, no skew|-0.49|0.000|-2.6%|-59.3%|0.25|FAIL|(sensitivity, not deciding)|

- Mean round-trip cost per contract of run A (996 booked trades): 5.48% of the max loss, 6.30% of the premium (debit paid or credit received).
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

**FAIL**. Run A: Sharpe above 0.5: no; deflated Sharpe above 0.9 (n_trials 32): no; max drawdown smaller than 25%: no; Sharpe above run B: no (A Sharpe -0.44, B Sharpe -0.01, deflated 0.000, max drawdown -63.6%).

## Deviations (bug fixes after the first run)

Review round 1 (2026-11-08) found these bugs after the first run of the 32 runs; all 32 were run again with the fixes, and the results above are from that rerun. No rule or parameter of the pre-registration changed except as listed. First run, superseded: run A Sharpe -0.44, verdict FAIL.

- Max loss per contract now includes the worst-case exit cost (both legs: USD 0.65 commission + the half-spread of a leg worth the spread width), and every closing cost is capped at that worst case: the vertical closes as a package, so a deep in-the-money exit costs no more. Sizing (2% of equity over the max loss) therefore bounds the realized loss of a trade at 2%; before the fix a crash exit could cost more than the max loss (test: a -30% move with implied volatility doubling). The 2% bound holds under this package-close cost model only; legging out of a spread in a wide market could cost more than modeled.
- An open spread whose IV index is stale for more than 5 trading days (no value after the 5-day carry) is closed at that close, priced with the last IV used (exit reason `stale-iv`, counted per run). Before, the last value was carried for the whole trade.
- Inputs are validated: the option model refuses NaN, infinite or negative time, rate, dividend yield, spot or volatility; market columns must be finite (closes and IV above 0, rates not negative); instrument value and sizing refuse NaN instead of treating it as 0; the deflated Sharpe is left empty when its standard-error radicand is not positive (never a square root of a negative number).
- Data rows with a missing open, high, low or adj_close are dropped instead of filled with the close (no row of the current files is affected).
- Reported, not changing a run: the largest concurrent open risk per run.
- The DSL calendar (`calendarWindow`) now follows the NYSE calendar with its special closures (2001-09-11 to 14, 2004-06-11, 2007-01-02, 2012-10-29 and 30, 2018-12-05, 2025-01-09) instead of the presence of a bar (strategy DSL commits 737c3717 and b1d945c5). A few windows near those dates moved; the numbers above are from the rerun on b1d945c5.
- Guard: a leg read one bar ahead (run A) may hold only calendarWindow filters, an always-true entry and no exit condition; anything else is refused (no look-ahead through price or series data).

## Limits

- Option prices are modeled from 30-day CBOE volatility indices with Black-Scholes, not real chains: no real skew surface or term structure, no early exercise or assignment, no pin risk, no liquidity limit. Real fills could be worse, mostly for DIA, SLV and USO spreads.
- Some sample years predate listed options on the ETF (SPY options, for example, listed in January 2005). Results for those years are hypothetical.
- Costs are modeled; no market impact, no tax. Uninvested cash earns nothing, which lowers CAGR for the rule and the baseline alike.
- Yahoo data from one vendor, not checked against a second source.
- The effect is reported for S&P 100 stocks; QQQ, DIA and IWM are not S&P 100 portfolios, and IWM holds small caps.
- A one-week holding pays a full round-trip spread cost each month.
