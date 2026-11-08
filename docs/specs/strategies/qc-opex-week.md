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

Run 2026-11-08 with `python -m strategies.qc_ports study --ran 2026-11-08` (services/research), data manifest sha256(SHA256SUMS) `95fc3a54ce009761b2818f8fd79c0cfb2880eb5d86aba33099e60f56b0c55348`, data to 2026-11-06. The JSON document of the same command (without --report) goes to Postgres `research_studies` (id `qc-opex-week`) through `bun run vertex:research-studies:import`. Deflated Sharpe: n_trials 32, variance of the per-day Sharpe across the 32 runs 0.000232. Ledger and NautilusTrader agreed on every trade and on daily equity (1e-6 relative).

Implementation: `services/research/strategies/qc_ports/ideas.py` (DSL definitions, derived series, runs) and `study.py` (compile with `nautilus_backtest/signals.py`, book, ledger, Nautilus parity, metrics). One open spread per member is decided from the priced book; a spread the ledger refuses for size (0 contracts) still holds its member until its priced exit, and such refusals count in Skipped (with book skips such as a missing IV index value). Native DSL `calendarWindow` `opexWeek`. Run A evaluates the same window one bar ahead (the trading calendar is known in advance), so the spread opens at the close before the week and closes at the expiration close; run A-L uses the filter on signal bars. A spread opens on the first bar of each full window and closes after its last bar.

|Run|From|CAGR|Sharpe|Deflated Sharpe|Max drawdown|Worst month|Trades|Win rate|Exposure|Skipped|
|---|---|---|---|---|---|---|---|---|---|---|
|A|1993-01-29|-3.2%|-0.44|0.000|-67.4%|2018-12 -6.0%|995|44.4%|23.2%|175|
|A-L|1993-01-29|-3.4%|-0.48|0.000|-69.9%|2015-08 -7.0%|980|44.9%|23.2%|190|
|B|1993-01-29|-1.1%|-0.02|0.001|-68.7%|2019-05 -8.0%|1147|48.2%|100.0%|27|

- Per-member attribution, run A: SPY 340 trades, P&L USD -22,889, win 48%; QQQ 241 trades, P&L USD -20,394, win 44%; DIA 212 trades, P&L USD -13,076, win 40%; IWM 202 trades, P&L USD -10,212, win 45%.
- All four live, run A (2009-09-16 to 2026-11-06): Sharpe -0.43, CAGR -3.5%, max drawdown -48.5%.
- All four live, run A-L (2009-09-16 to 2026-11-06): Sharpe -0.36, CAGR -2.9%, max drawdown -43.7%.
- All four live, run B (2009-09-16 to 2026-11-06): Sharpe 0.26, CAGR 2.9%, max drawdown -31.7%.
- Source window, run A (2007-01-03 to 2018-08-01): Sharpe -0.42, CAGR -4.2%, max drawdown -50.0%.
- Source window, run B (2007-01-03 to 2018-08-01): Sharpe 0.14, CAGR 0.9%, max drawdown -42.0%.
- Runs B of qc-opex-week and qc-turn-of-the-month are the same definition and dates (both pre-registered and counted).

### Verdict

**FAIL**. Run A: Sharpe above 0.5: no; deflated Sharpe above 0.9 (n_trials 32): no; max drawdown smaller than 25%: no; Sharpe above run B: no (A Sharpe -0.44, B Sharpe -0.02, deflated 0.000, max drawdown -67.4%).

## Limits

- Option prices are modeled from 30-day CBOE volatility indices with Black-Scholes, not real chains: no real skew surface or term structure, no early exercise or assignment, no pin risk, no liquidity limit. Real fills could be worse, mostly for DIA, SLV and USO spreads.
- Some sample years predate listed options on the ETF (SPY options, for example, listed in January 2005). Results for those years are hypothetical.
- Costs are modeled; no market impact, no tax. Uninvested cash earns nothing, which lowers CAGR for the rule and the baseline alike.
- Yahoo data from one vendor, not checked against a second source.
- The effect is reported for S&P 100 stocks; QQQ, DIA and IWM are not S&P 100 portfolios, and IWM holds small caps.
- A one-week holding pays a full round-trip spread cost each month.
