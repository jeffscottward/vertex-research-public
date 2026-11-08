# Same-Calendar-Month Seasonality (QuantConnect port)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- QuantConnect Strategy Library: [Seasonality Effect based on Same-Calendar Month Returns](https://www.quantconnect.com/learning/articles/investment-strategy-library/seasonality-effect-based-on-same-calendar-month-returns). Read 2026-11-08. It draws on the paper "Common Factors in Return Seasonalities".
- Rule as stated: universe of the 100 most liquid US securities and ETFs priced above USD 5; each month, rank by the return in the same calendar month of the previous year; long the top and short the bottom; rebalance monthly.
- Port request: on the Core 7, top 2 by average same-calendar-month return over all prior years, only when that average is above 0.
- Port request: owner, 2026-11-08 (QuantConnect idea ports; owner decision 2026-11-08: full strategy DSL with defined-risk option legs and reusable entry gates, TypeScript and Python engines in parity). This port does not reproduce QuantConnect's backtest. It trades the idea as defined-risk option spreads on modeled option prices, because the owner's options-only rule forbids share positions and naked futures.

## Classification

- Type: standalone monthly seasonality rotation.
- Direction: long, defined risk (call debit verticals only); the short side of the source is not ported.

Basis codes: S = stated by the source page; O = set by the owner's port request (2026-11-08); A = Vertex default, fixed before the first run.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Universe: Core 7 ETFs.|O|
|2|Monthly return of a member: month-end `adj_close` return (total return); the first, partial month of each ETF is not used.|A|
|3|Score at month-end t, for the calendar month m of t+1: the mean of the member's returns in month m over all earlier years with data. At least 5 earlier observations of month m are needed; with fewer the member is not eligible.|O (minimum of 5: A)|
|4|Selection: the top 2 eligible members by score with score > 0. Fewer than two positive: hold those that are positive (possibly none). Ties: symbol order.|O / A (ties: A)|
|5|Monthly rebalance: the signal is computed at the month-end close; trades execute at the close of the first trading day of the next month. At each rebalance every open spread is closed and the selected spreads are opened fresh (a monthly roll), so a member that stays selected is rolled, not held.|A|
|6|Structure: call debit vertical, `longDelta` 0.5, `widthSigma` 1.0, expiry nearest 60 DTE with DTE ≥ 45, `maxLossPct` 2, no profit-take, no `exitDte` (the monthly roll closes it at about 30 to 40 DTE).|A|

## Backtest design (fixed 2026-11-08, before the first run)

- A member is eligible at month-end t when its IV index is live and rule 3 is met. SPY is first eligible at month-end 1998-01-30 (for February: five Februaries 1993 to 1997); the first month-end at which each member is eligible, and from which it stays eligible every month, is QQQ 2004-03-31, DIA 2005-11-30 (VXD start), IWM 2009-09-30 (RVX start), GLD 2009-11-30, SLV 2011-04-29 and USO 2011-04-29. One shared-equity portfolio. Sample end 2026-11-06 (last rebalance 2026-11-02).
- Scores use only data before the target month (no look-ahead). The window with all 7 eligible (from 2011-04-29) is reported from the same runs.
- Baseline B: the same call debit vertical on every eligible member every month (always on, monthly roll), same structure, members and dates. B holds up to 7 spreads where A holds at most 2; each spread risks 2%, and the Sharpe comparison is scale-free.

|Run|Definition|Counted|
|---|---|---|
|A|Top 2 by same-month average return, score > 0 (primary)|yes|
|B|Always-on monthly call debit verticals on all eligible members (baseline)|yes|

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
- DSL: the `options` block (`callDebitVertical`); scoring runs in the qc_ports runner (the `calendarWindow` `months` filter covers fixed-month variants) in `packages/api/src/strategy-dsl.ts`, mirrored in `services/research/nautilus_backtest/signals.py` with golden parity fixtures (TypeScript and Python must agree).
- Tests (hand-computed, written with the engine and before the first run): same-month means on hand-built monthly series; the five-observation minimum; exclusion of the partial first month; ties.
- Data: `research/backtests/qc-ports/fetch_data.py`.
- Results: stored in Postgres `research_studies` (id `qc-same-month-seasonality`) with `bun run vertex:research-studies:import`. No results JSON file is committed (AGENTS.md rule 13).

## Results

Run 2026-11-08 with `python -m strategies.qc_ports study --ran 2026-11-08` (services/research), data manifest sha256(SHA256SUMS) `95fc3a54ce009761b2818f8fd79c0cfb2880eb5d86aba33099e60f56b0c55348`, data to 2026-11-06. The JSON document of the same command (without --report) goes to Postgres `research_studies` (id `qc-same-month-seasonality`) through `bun run vertex:research-studies:import`. Deflated Sharpe: n_trials 32, variance of the per-day Sharpe across the 32 runs 0.000232. Ledger and NautilusTrader agreed on every trade and on daily equity (1e-6 relative).

Implementation: `services/research/strategies/qc_ports/ideas.py` (DSL definitions, derived series, runs) and `study.py` (compile with `nautilus_backtest/signals.py`, book, ledger, Nautilus parity, metrics). One open spread per member is decided from the priced book; a spread the ledger refuses for size (0 contracts) still holds its member until its priced exit, and such refusals count in Skipped (with book skips such as a missing IV index value). The same-month score and top-2 selection are computed in Python and read by DSL `series` filters on `qc:seasonSelected:<ETF>` (run A) and `qc:seasonEligible:<ETF>` (run B).

|Run|From|CAGR|Sharpe|Deflated Sharpe|Max drawdown|Worst month|Trades|Win rate|Exposure|Skipped|
|---|---|---|---|---|---|---|---|---|---|---|
|A|1998-01-30|-1.8%|-0.22|0.000|-53.0%|2005-01 -4.7%|514|45.1%|89.9%|30|
|B|1998-01-30|-5.2%|-0.36|0.000|-81.3%|2012-05 -12.0%|1170|44.4%|99.1%|445|

- All 7 eligible, run A (2011-04-29 to 2026-11-06): Sharpe -0.04, CAGR -0.6%, max drawdown -25.8%.
- All 7 eligible, run B (2011-04-29 to 2026-11-06): Sharpe -0.40, CAGR -6.3%, max drawdown -66.8%.
- Per-member attribution, run A: SPY 119 trades, P&L USD -25,054, win 42%; QQQ 59 trades, P&L USD -8,833, win 44%; DIA 90 trades, P&L USD 9,576, win 58%; IWM 81 trades, P&L USD 1,371, win 44%; GLD 65 trades, P&L USD -5,427, win 40%; SLV 60 trades, P&L USD -10,600, win 42%; USO 40 trades, P&L USD -1,301, win 42%.
- First eligible month-ends: SPY 1998-01-30, QQQ 2004-03-31, DIA 2005-11-30, IWM 2009-09-30, GLD 2009-11-30, SLV 2011-04-29, USO 2011-04-29.

### Verdict

**FAIL**. Run A: Sharpe above 0.5: no; deflated Sharpe above 0.9 (n_trials 32): no; max drawdown smaller than 25%: no; Sharpe above run B: yes (A Sharpe -0.22, B Sharpe -0.36, deflated 0.000, max drawdown -53.0%).

## Limits

- Option prices are modeled from 30-day CBOE volatility indices with Black-Scholes, not real chains: no real skew surface or term structure, no early exercise or assignment, no pin risk, no liquidity limit. Real fills could be worse, mostly for DIA, SLV and USO spreads.
- Some sample years predate listed options on the ETF (SPY options, for example, listed in January 2005). Results for those years are hypothetical.
- Costs are modeled; no market impact, no tax. Uninvested cash earns nothing, which lowers CAGR for the rule and the baseline alike.
- Yahoo data from one vendor, not checked against a second source.
- With 13 to 33 years per member, a same-month mean rests on 5 to 33 observations; most of the ranking is noise unless the effect is large.
- The source ranks 100 securities and trades long and short; a top-2 long-only pick from 7 ETFs is a much smaller test of the idea.
