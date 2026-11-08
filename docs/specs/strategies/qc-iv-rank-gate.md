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

Run 2026-11-08 with `python -m strategies.qc_ports study --ran 2026-11-08` (services/research), data manifest sha256(SHA256SUMS) `95fc3a54ce009761b2818f8fd79c0cfb2880eb5d86aba33099e60f56b0c55348`, data to 2026-11-06. The JSON document of the same command (without --report) goes to Postgres `research_studies` (id `qc-iv-rank-gate`) through `bun run vertex:research-studies:import`. Deflated Sharpe: n_trials 32, variance of the per-day Sharpe across the 32 runs 0.000232. Ledger and NautilusTrader agreed on every trade and on daily equity (1e-6 relative).

Implementation: `services/research/strategies/qc_ports/ideas.py` (DSL definitions, derived series, runs) and `study.py` (compile with `nautilus_backtest/signals.py`, book, ledger, Nautilus parity, metrics). One open spread per member is decided from the priced book; a spread the ledger refuses for size (0 contracts) still holds its member until its priced exit, and such refusals count in Skipped (with book skips such as a missing IV index value). Native DSL `ivRank` filter (length 252, min 50). Gated host runs start where the gate is first defined (1993-01-29, the same dates as S0/D0).

|Run|From|CAGR|Sharpe|Deflated Sharpe|Max drawdown|Worst month|Trades|Win rate|Exposure|Skipped|
|---|---|---|---|---|---|---|---|---|---|---|
|A|1993-01-29|-0.5%|-0.22|0.000|-21.4%|2020-03 -9.0%|305|71.5%|21.2%|22|
|B|1993-01-29|-2.4%|-0.61|0.000|-58.5%|2018-10 -7.7%|1420|69.9%|71.8%|324|
|S0|1993-01-29|-2.2%|-0.45|0.000|-57.0%|2000-01 -4.3%|514|32.9%|57.5%|44|
|S1|1993-01-29|-0.5%|-0.23|0.000|-16.8%|1996-12 -3.2%|89|30.3%|9.4%|0|
|D0|1993-01-29|-4.7%|-0.44|0.000|-82.9%|2011-05 -12.9%|700|35.0%|58.5%|328|
|D1|1993-01-29|-1.4%|-0.31|0.000|-41.9%|2018-02 -7.7%|130|29.2%|17.7%|3|

|Gate|Host|Before Sharpe|After Sharpe|Before max DD|After max DD|Before CAGR|After CAGR|Before trades|After trades|Before exposure|After exposure|Helps|
|---|---|---|---|---|---|---|---|---|---|---|---|---|
|ivRank >= 50|sma30-market-timing (SPY) from 1993-01-29|-0.45|-0.23|-57.0%|-16.8%|-2.2%|-0.5%|514|89|57.5%|9.4%|yes|
|ivRank >= 50|donchianBreakout (Core 7) from 1993-01-29|-0.44|-0.31|-82.9%|-41.9%|-4.7%|-1.4%|700|130|58.5%|17.7%|yes|

- Per-member attribution, run A: SPY 74 trades, P&L USD -880, win 72%; QQQ 54 trades, P&L USD -2,161, win 72%; DIA 49 trades, P&L USD -2,275, win 73%; IWM 28 trades, P&L USD -484, win 82%; GLD 30 trades, P&L USD 1,829, win 80%; SLV 27 trades, P&L USD -4,355, win 56%; USO 43 trades, P&L USD -6,882, win 65%.
- Per-member attribution, run B: SPY 325 trades, P&L USD -8,089, win 70%; QQQ 218 trades, P&L USD -10,270, win 69%; DIA 185 trades, P&L USD -6,695, win 72%; IWM 181 trades, P&L USD -2,934, win 73%; GLD 192 trades, P&L USD -1,699, win 77%; SLV 136 trades, P&L USD -16,728, win 50%; USO 183 trades, P&L USD -8,967, win 72%.
- All 7 live, run A (2012-03-14 to 2026-11-06): Sharpe -0.27, CAGR -0.7%, max drawdown -16.3%.
- All 7 live, run B (2012-03-14 to 2026-11-06): Sharpe -0.72, CAGR -3.5%, max drawdown -44.8%.
- Member join (252 IV index values): SPY 1993-01-29, QQQ 2002-01-28, DIA 2006-11-22, IWM 2010-09-15, GLD 2009-06-02, SLV 2012-03-14, USO 2008-05-08.

### Verdict

**FAIL**. Run A: Sharpe above 0.5: no; deflated Sharpe above 0.9 (n_trials 32): no; max drawdown smaller than 25%: yes; Sharpe above run B: yes (A Sharpe -0.22, B Sharpe -0.61, deflated 0.000, max drawdown -21.4%).

## Limits

- Option prices are modeled from 30-day CBOE volatility indices with Black-Scholes, not real chains: no real skew surface or term structure, no early exercise or assignment, no pin risk, no liquidity limit. Real fills could be worse, mostly for DIA, SLV and USO spreads.
- Some sample years predate listed options on the ETF (SPY options, for example, listed in January 2005). Results for those years are hypothetical.
- Costs are modeled; no market impact, no tax. Uninvested cash earns nothing, which lowers CAGR for the rule and the baseline alike.
- Yahoo data from one vendor, not checked against a second source.
- IV rank uses the 30-day index of the ETF, not the implied volatility of the traded strikes and expiry.
- Members join at different dates, so the portfolio before 2012-03-14 holds fewer than 7 symbols (SPY alone before 2002).
