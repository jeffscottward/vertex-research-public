# IV Rank Gate for Put Credit Spreads (QuantConnect port)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- No QuantConnect Strategy Library page defines this rule. It is the common practitioner rule "sell option premium when implied volatility is high relative to its own past", from the owner's QuantConnect idea list (2026-11-08). Nearest library page: [Volatility Risk Premium Effect](https://www.quantconnect.com/learning/articles/investment-strategy-library/volatility-risk-premium-effect) (monthly short one-month ATM straddle on GOOG with a 15% out-of-the-money put bought as a hedge).
- Rule as requested: open put credit spreads only when the IV rank is at least 50, with a 252-day look-back.
- Port request: owner, 2026-11-08 (QuantConnect idea ports; owner decision 2026-11-08: full strategy DSL with defined-risk option legs and reusable entry gates, TypeScript and Python engines in parity). This port does not reproduce QuantConnect's backtest. It trades the idea as defined-risk option spreads on modeled option prices, because the owner's options-only rule forbids share positions and naked futures.

## Classification

- Type: entry gate (reusable DSL filter `ivRank`). Tested on put credit verticals on the Core 7 ETFs and before/after on two existing strategies.
- Direction: short premium, defined risk (credit verticals only).

Basis codes: S = stated by the source page; O = set by the owner's port request (2026-11-08); A = Vertex default, fixed before the first run.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Universe: Core 7 ETFs SPY, QQQ, DIA, IWM, GLD, SLV, USO, each with its own CBOE implied-volatility index (SPY VIX, QQQ VXN, DIA VXD, IWM RVX, GLD GVZ, SLV VXSLV, USO OVX).|O|
|2|IV rank at the close of bar i = 100 × (v_i − min) / (max − min) over the last L = 252 index values including v_i. Undefined (no entry) with fewer than 252 values or when max = min.|O / A|
|3|Gate: entry allowed when IV rank ≥ 50. DSL: `{type: "ivRank", length: 252, min: 50}`.|O|
|4|Entry cadence: at each month-end close, each member with no open spread signals an entry if the gate passes; the trade is at the close of the first trading day of the next month.|A|
|5|Structure: put credit vertical, short put at 25 delta (`shortDelta` 0.25), long put `widthSigma` 0.5 further out of the money, expiry nearest 45 DTE with DTE ≥ 30, `profitTakePct` 50 (close when the spread value is at or below 50% of the credit received), `exitDte` 21, `maxLossPct` 2. The same structure as [qc-regime-put-vrp](qc-regime-put-vrp.md).|A|
|6|Exits: profit-take or `exitDte`, whichever comes first; there is no signal exit, and the gate never blocks an exit.|A|
|7|At most one open spread per member.|A|

## Backtest design (fixed 2026-11-08, before the first run)

- Members join on the first date with 252 IV index values: SPY 1993-01-29 (VIX history from 1990), QQQ 2002-01-28, DIA 2006-11-22, IWM 2010-09-15, GLD 2009-06-02, SLV 2012-03-14, USO 2008-05-08. First entry signals at the next month-end (SPY 1993-01-29, QQQ 2002-01-31, DIA 2006-11-30, IWM 2010-09-30, GLD 2009-06-30, SLV 2012-03-30, USO 2008-05-30). Runs A and B use the same member dates. Sample end 2026-11-06.
- One shared-equity portfolio. Per-member attribution and the window with all 7 members live (from 2012-03-14) are reported from the same runs; they are not separate runs.
- Baseline B: the same portfolio and structure with the gate removed (a spread opens every month for each flat member).
- Existing strategy sma30 (runs S): the DSL form of [sma30-market-timing](sma30-market-timing.md) on SPY. Entry when close > SMA(30) of close; exit when close < SMA(30). It uses SPY `close`, not the French total-return index of that spec. From 1993-01-29.
- Existing strategy donchianBreakout (runs D): `STRATEGY_TEMPLATES.donchianBreakout` in `packages/api/src/strategy-dsl.ts`, unchanged (entry: close above the highest high of the prior 20 bars; exit: close below the lowest low of the prior 10 bars), on each Core 7 ETF in one shared-equity portfolio; each member from its IV index start (SPY 1993-01-29, QQQ 2001-01-23, DIA 2005-11-22, IWM 2009-09-16, GLD 2008-06-03, SLV 2011-03-16, USO 2007-05-10).
- Options expression for runs S and D: call debit vertical, `longDelta` 0.5, `widthSigma` 1.0, expiry nearest 30 DTE with DTE ≥ 21, `exitDte` 5, `maxLossPct` 2, no profit-take. A spread closes on the strategy's exit signal or at `exitDte`. While flat, a new spread opens at the close after any bar on which the entry condition holds (so sma30 re-enters after an `exitDte` close while SPY stays above its SMA; Donchian waits for a new breakout).
- The gate is a DSL filter on entries only; exits are never blocked. Runs S0 and D0 (no gate) are shared by [qc-iv-rank-gate](qc-iv-rank-gate.md), [qc-regime-put-vrp](qc-regime-put-vrp.md) and [qc-vix-term-gate](qc-vix-term-gate.md) and count once.

|Run|Definition|Counted|
|---|---|---|
|A|Core 7 put credit verticals, IV rank ≥ 50 gate (primary)|yes|
|B|Core 7 put credit verticals, no gate (baseline)|yes|
|S0|sma30 options expression, no gate|yes (shared)|
|S1|S0 + IV rank gate (SPY, VIX)|yes|
|D0|donchianBreakout options expression over Core 7, no gate|yes (shared)|
|D1|D0 + IV rank gate (each member's own index)|yes|

Runs in this spec: 6 (4 own, 2 shared). Family total: 32.

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

Secondary (reported, not part of the verdict): the IV rank gate is measured before and after on the two existing strategies, over the dates from 1993-01-29 (the first date the gate is defined, SPY): Sharpe, maximum drawdown, CAGR, trades and exposure of the gated run against the ungated run on the same dates. The gate is reported as helping a strategy only when the gated Sharpe is higher and the gated maximum drawdown is no worse.

## Code and tests

Planned paths; this spec is committed before the code.

- Rules, option model and ledger: `services/research/strategies/qc_ports/` (`data.py`, `calendar.py`, `options.py`, `book.py`, `ledger.py`, `metrics.py`, `nautilus_runner.py`).
- DSL: the `ivRank` filter and the `options` block (`putCreditVertical`) in `packages/api/src/strategy-dsl.ts`, mirrored in `services/research/nautilus_backtest/signals.py` with golden parity fixtures (TypeScript and Python must agree).
- Tests (hand-computed, written with the engine and before the first run): IV rank values and the undefined cases (fewer than 252 values, max = min); gate on entries only; month-end cadence; profit-take and `exitDte` exits on hand-built price paths.
- Data: `research/backtests/qc-ports/fetch_data.py`.
- Results: stored in Postgres `research_studies` (id `qc-iv-rank-gate`) with `bun run vertex:research-studies:import`. No results JSON file is committed (AGENTS.md rule 13).

## Results

Run 2026-11-08 with `python -m strategies.qc_ports study --ran 2026-11-08` (services/research), data manifest sha256(SHA256SUMS) `95fc3a54ce009761b2818f8fd79c0cfb2880eb5d86aba33099e60f56b0c55348`, data to 2026-11-06, code revision `b1d945c50bfceac8d482ac5b013dcfa89469893e` (run id `qc-ports-2026-11-08-b1d945c50bfc`). The JSON document of the same command (without --report) goes to Postgres `research_studies` (id `qc-iv-rank-gate`) through `bun run vertex:research-studies:import`. Deflated Sharpe: n_trials 32, variance of the per-day Sharpe across the 32 runs 0.000218. Ledger and NautilusTrader agreed on every trade and on daily equity (1e-6 relative).

Implementation: `services/research/strategies/qc_ports/ideas.py` (each run is one strategy DSL definition with an options block and a portfolio block; run A is stored as the definition `qc-iv-rank-gate`) and `portfolio.py` (compile with `nautilus_backtest/signals.py`, policies, book, ledger, Nautilus parity, metrics); the same definition runs in backtest runs (TypeScript options engine and the Nautilus worker). One open spread per member is decided from the priced book; a spread the ledger refuses for size (0 contracts) still holds its member until its priced exit, and such refusals count in Skipped (with book skips such as a missing IV index value). Max open risk = the largest share of equity at risk (contracts x max loss) in open spreads at any close (reported only, no cap). Native DSL `ivRank` filter (length 252, min 50). Gated host runs start where the gate is first defined (1993-01-29, the same dates as S0/D0).

|Run|From|CAGR|Sharpe|Deflated Sharpe|Max drawdown|Worst month|Trades|Win rate|Exposure|Skipped|Max open risk|Stale-IV exits|
|---|---|---|---|---|---|---|---|---|---|---|---|---|
|A|1993-01-29|-0.4%|-0.20|0.000|-19.3%|2020-03 -7.3%|303|71.3%|21.0%|24|12.5%|0|
|B|1993-01-29|-2.1%|-0.57|0.000|-53.7%|2018-10 -6.8%|1443|70.0%|72.1%|301|13.7%|0|
|S0|1993-01-29|-2.0%|-0.45|0.000|-54.5%|2000-01 -3.7%|513|32.9%|57.5%|45|2.0%|0|
|S1|1993-01-29|-0.5%|-0.25|0.000|-17.2%|1996-12 -3.0%|89|30.3%|9.4%|0|2.0%|0|
|D0|1993-01-29|-3.9%|-0.40|0.000|-78.5%|2011-05 -11.5%|723|35.3%|59.3%|305|13.0%|0|
|D1|1993-01-29|-1.2%|-0.29|0.000|-36.5%|2018-02 -6.9%|129|29.5%|17.6%|4|9.0%|0|

|Gate|Host|Before Sharpe|After Sharpe|Before max DD|After max DD|Before CAGR|After CAGR|Before trades|After trades|Before exposure|After exposure|Helps|
|---|---|---|---|---|---|---|---|---|---|---|---|---|
|ivRank >= 50|sma30-market-timing (SPY) from 1993-01-29|-0.45|-0.25|-54.5%|-17.2%|-2.0%|-0.5%|513|89|57.5%|9.4%|yes|
|ivRank >= 50|donchianBreakout (Core 7) from 1993-01-29|-0.40|-0.29|-78.5%|-36.5%|-3.9%|-1.2%|723|129|59.3%|17.6%|yes|

- Per-member attribution, run A: SPY 74 trades, P&L USD -895, win 72%; QQQ 53 trades, P&L USD -2,299, win 72%; DIA 49 trades, P&L USD -2,319, win 73%; IWM 28 trades, P&L USD -387, win 82%; GLD 30 trades, P&L USD 1,778, win 80%; SLV 27 trades, P&L USD -3,650, win 56%; USO 42 trades, P&L USD -5,678, win 64%.
- Per-member attribution, run B: SPY 334 trades, P&L USD -8,058, win 70%; QQQ 221 trades, P&L USD -10,079, win 69%; DIA 190 trades, P&L USD -6,878, win 72%; IWM 188 trades, P&L USD -2,970, win 73%; GLD 195 trades, P&L USD -1,170, win 77%; SLV 136 trades, P&L USD -15,555, win 50%; USO 179 trades, P&L USD -5,932, win 73%.
- All 7 live, run A (2012-03-14 to 2026-11-06): Sharpe -0.23, CAGR -0.6%, max drawdown -13.8%.
- All 7 live, run B (2012-03-14 to 2026-11-06): Sharpe -0.68, CAGR -3.1%, max drawdown -41.0%.
- Member join (252 IV index values): SPY 1993-01-29, QQQ 2002-01-28, DIA 2006-11-22, IWM 2010-09-15, GLD 2009-06-02, SLV 2012-03-14, USO 2008-05-08.

### Sanity checks

Reported only; no run or parameter changed. `python -m strategies.qc_ports audit` (reference ledger).

|Run A|Sharpe|Deflated Sharpe|CAGR|Max drawdown|Run B Sharpe|Verdict|Failing clauses|
|---|---|---|---|---|---|---|---|
|Net (as run)|-0.20|0.000|-0.4%|-19.3%|-0.57|FAIL|Sharpe above 0.5; deflated Sharpe above 0.9 (n_trials 32)|
|Gross (zero costs)|0.11|0.013|0.2%|-8.4%|0.32|FAIL|Sharpe above 0.5; deflated Sharpe above 0.9 (n_trials 32); Sharpe above run B|
|ATM IV 1.0 x index, no skew|0.07|0.007|0.1%|-12.4%|0.06|FAIL|(sensitivity, not deciding)|

- Mean round-trip cost per contract of run A (303 booked trades): 3.70% of the max loss, 20.27% of the premium (debit paid or credit received).
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

**FAIL**. Run A: Sharpe above 0.5: no; deflated Sharpe above 0.9 (n_trials 32): no; max drawdown smaller than 25%: yes; Sharpe above run B: yes (A Sharpe -0.20, B Sharpe -0.57, deflated 0.000, max drawdown -19.3%).

## Deviations (bug fixes after the first run)

Review round 1 (2026-11-08) found these bugs after the first run of the 32 runs; all 32 were run again with the fixes, and the results above are from that rerun. No rule or parameter of the pre-registration changed except as listed. First run, superseded: run A Sharpe -0.22, verdict FAIL.

- Max loss per contract now includes the worst-case exit cost (both legs: USD 0.65 commission + the half-spread of a leg worth the spread width), and every closing cost is capped at that worst case: the vertical closes as a package, so a deep in-the-money exit costs no more. Sizing (2% of equity over the max loss) therefore bounds the realized loss of a trade at 2%; before the fix a crash exit could cost more than the max loss (test: a -30% move with implied volatility doubling). The 2% bound holds under this package-close cost model only; legging out of a spread in a wide market could cost more than modeled.
- An open spread whose IV index is stale for more than 5 trading days (no value after the 5-day carry) is closed at that close, priced with the last IV used (exit reason `stale-iv`, counted per run). Before, the last value was carried for the whole trade.
- Inputs are validated: the option model refuses NaN, infinite or negative time, rate, dividend yield, spot or volatility; market columns must be finite (closes and IV above 0, rates not negative); instrument value and sizing refuse NaN instead of treating it as 0; the deflated Sharpe is left empty when its standard-error radicand is not positive (never a square root of a negative number).
- Data rows with a missing open, high, low or adj_close are dropped instead of filled with the close (no row of the current files is affected).
- Reported, not changing a run: the largest concurrent open risk per run.
- Card vertex-qc-ports-opt3 (pure DSL runs): run B is the same put credit definition with the filter `ivRank` min 0 (a rank exists) instead of a per-member start date. Its trades, daily equity and every metric are unchanged; `skipped` is 262 instead of 301, because the 39 month-ends where the IV index has no value on the date are no longer entry signals (they were counted as skipped entries before). Run A is unchanged.

## Limits

- Option prices are modeled from 30-day CBOE volatility indices with Black-Scholes, not real chains: no real skew surface or term structure, no early exercise or assignment, no pin risk, no liquidity limit. Real fills could be worse, mostly for DIA, SLV and USO spreads.
- Some sample years predate listed options on the ETF (SPY options, for example, listed in January 2005). Results for those years are hypothetical.
- Costs are modeled; no market impact, no tax. Uninvested cash earns nothing, which lowers CAGR for the rule and the baseline alike.
- Yahoo data from one vendor, not checked against a second source.
- IV rank uses the 30-day index of the ETF, not the implied volatility of the traded strikes and expiry.
- Members join at different dates, so the portfolio before 2012-03-14 holds fewer than 7 symbols (SPY alone before 2002).
