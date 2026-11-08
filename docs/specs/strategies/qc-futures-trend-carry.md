# Futures Trend and Carry on Core 7 (QuantConnect port)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- QuantConnect Strategy Library: [Commodities Futures Trend Following](https://www.quantconnect.com/learning/articles/investment-strategy-library/commodities-futures-trend-following). Read 2026-11-08. Rule as stated: at the start of each month, signal s = (last month's price − its exponential moving average) / last month's volatility; long or short each future by its sign, sized by 1/volatility; reported over four asset classes.
- QuantConnect Strategy Library: [Term Structure Effect in Commodities](https://www.quantconnect.com/learning/articles/investment-strategy-library/term-structure-effect-in-commodities) and [Momentum Effect Combined with Term Structure in Commodities](https://www.quantconnect.com/learning/articles/investment-strategy-library/momentum-effect-combined-with-term-structure-in-commodities). Read 2026-11-08. Rule as stated: roll return R = [ln(P_near) − ln(P_distant)] × 365 / (days between maturities); long the highest-roll-return futures and short the lowest, monthly; the combined page also sorts on one-month momentum.
- Port request: on the Core 7, signal on each `=F` future's 12-month trend divided by volatility, and a carry proxy = the ETF twin's total return minus the future's price change over 12 months; expressed as debit verticals on the ETF twin; no naked futures. RTY=F starts 2017-07.
- Port request: owner, 2026-11-08 (QuantConnect idea ports; owner decision 2026-11-08: full strategy DSL with defined-risk option legs and reusable entry gates, TypeScript and Python engines in parity). This port does not reproduce QuantConnect's backtest. It trades the idea as defined-risk option spreads on modeled option prices, because the owner's options-only rule forbids share positions and naked futures.

## Classification

- Type: standalone monthly cross-asset signal (DSL filter `series` on the `=F` ids; the carry proxy is computed by the runner from two series).
- Direction: long (call debit vertical) or short (put debit vertical), defined risk.

Basis codes: S = stated by the source page; O = set by the owner's port request (2026-11-08); A = Vertex default, fixed before the first run.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Pairs (ETF twin – future): SPY–ES=F, QQQ–NQ=F, DIA–YM=F, IWM–RTY=F, GLD–GC=F, SLV–SI=F, USO–CL=F. Futures are Yahoo continuous front-month series, not adjusted for rolls.|O|
|2|Trend at month-end t: T = (F_t / F_t−252 − 1) / (σ × √252), where F_t−252 is the future 252 SPY trading days earlier and σ the standard deviation of the last 252 daily simple returns of F.|O / A (exact form: A)|
|3|Carry proxy at month-end t: C = (E_t / E_t−252 − 1) − (F_t / F_t−252 − 1), with E = the ETF's `adj_close` (total return).|O|
|4|Position: long (call debit vertical) when T > 0 and C > 0; short (put debit vertical) when T < 0 and C < 0; flat otherwise.|A|
|5|Long-only variant (run A-L): rule 4 without the short side.|A|
|6|Monthly rebalance: the signal is computed at the month-end close; trades execute at the close of the first trading day of the next month. At each rebalance every open spread is closed and the selected spreads are opened fresh (a monthly roll), so a member that stays selected is rolled, not held.|A|
|7|Structure: debit vertical (call for long, put for short), `longDelta` 0.5, `widthSigma` 1.0, expiry nearest 60 DTE with DTE ≥ 45, `maxLossPct` 2 per spread, no profit-take, no `exitDte`.|O / A|

## Backtest design (fixed 2026-11-08, before the first run)

- A member is eligible from the first month-end on or after the later of its IV index start and its 253rd future and ETF bar: SPY 2001-09-28, QQQ 2001-09-28, DIA 2005-11-30, GLD 2008-06-30, USO 2007-05-31, SLV 2011-03-31, IWM 2018-07-31 (RTY=F starts 2017-07-10). One shared-equity portfolio. Sample end 2026-11-06 (last rebalance 2026-11-02).
- CL=F: the fetched file has no rows for 2020-04-20 (settlement USD −37.63) and 2020-04-21, because the fetch drops non-positive values; alignment carries 2020-04-17 forward. USO is the traded instrument; the futures series only feeds the signal.
- Per-member attribution, the long and short legs separately, and the window with all 7 live (from 2018-07-31) are reported from the same runs.
- Baseline B: a call debit vertical on every eligible member every month (always long, monthly roll), same structure and dates.

|Run|Definition|Counted|
|---|---|---|
|A|Trend and carry, long and short debit verticals (primary)|yes|
|A-L|Trend and carry, long side only|yes|
|B|Always-on monthly call debit verticals on eligible members (baseline)|yes|

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
- DSL: the `series` filter over the `=F` series ids and the `options` block (`callDebitVertical`, `putDebitVertical`) in `packages/api/src/strategy-dsl.ts`, mirrored in `services/research/nautilus_backtest/signals.py` with golden parity fixtures (TypeScript and Python must agree).
- Tests (hand-computed, written with the engine and before the first run): T and C on a hand-built futures and ETF path including a roll gap; the CL=F gap of 2020-04-20; long, short and flat cases; member eligibility dates.
- Data: `research/backtests/qc-ports/fetch_data.py`.
- Results: stored in Postgres `research_studies` (id `qc-futures-trend-carry`) with `bun run vertex:research-studies:import`. No results JSON file is committed (AGENTS.md rule 13).

## Results

Run 2026-11-08 with `python -m strategies.qc_ports study --ran 2026-11-08` (services/research), data manifest sha256(SHA256SUMS) `95fc3a54ce009761b2818f8fd79c0cfb2880eb5d86aba33099e60f56b0c55348`, data to 2026-11-06. The JSON document of the same command (without --report) goes to Postgres `research_studies` (id `qc-futures-trend-carry`) through `bun run vertex:research-studies:import`. Deflated Sharpe: n_trials 32, variance of the per-day Sharpe across the 32 runs 0.000232. Ledger and NautilusTrader agreed on every trade and on daily equity (1e-6 relative).

Implementation: `services/research/strategies/qc_ports/ideas.py` (DSL definitions, derived series, runs) and `study.py` (compile with `nautilus_backtest/signals.py`, book, ledger, Nautilus parity, metrics). One open spread per member is decided from the priced book; a spread the ledger refuses for size (0 contracts) still holds its member until its priced exit, and such refusals count in Skipped (with book skips such as a missing IV index value). T and C are computed in Python on the SPY calendar (futures aligned with the 5-day carry) and read by DSL `series` filters on the research-only ids `qc:futTrend:<ETF>` and `qc:futCarry:<ETF>` (> 0 for the call leg, < 0 for the put leg).

|Run|From|CAGR|Sharpe|Deflated Sharpe|Max drawdown|Worst month|Trades|Win rate|Exposure|Skipped|
|---|---|---|---|---|---|---|---|---|---|---|
|A|2001-09-28|-3.9%|-0.33|0.000|-67.0%|2018-10 -10.0%|816|45.3%|89.0%|187|
|A-L|2001-09-28|-1.3%|-0.06|0.002|-38.6%|2019-05 -8.7%|775|48.6%|86.4%|34|
|B|2001-09-28|-5.6%|-0.39|0.000|-80.2%|2011-05 -10.7%|1105|43.6%|98.9%|494|

- Per-member attribution, run A: SPY 178 trades, P&L USD -6,502, win 51%; QQQ 177 trades, P&L USD 7,917, win 49%; DIA 170 trades, P&L USD -9,426, win 52%; IWM 56 trades, P&L USD -8,000, win 32%; GLD 78 trades, P&L USD -10,939, win 40%; SLV 77 trades, P&L USD -24,782, win 38%; USO 80 trades, P&L USD -11,298, win 35%.
- Run A legs: long 644 trades, P&L USD -23,299, win 48%; short 172 trades, P&L USD -39,731, win 35%.
- All 7 live, run A (2018-07-31 to 2026-11-06): Sharpe -0.58, CAGR -5.8%, max drawdown -46.9%.
- All 7 live, run A-L (2018-07-31 to 2026-11-06): Sharpe -0.18, CAGR -3.0%, max drawdown -34.9%.
- All 7 live, run B (2018-07-31 to 2026-11-06): Sharpe -0.09, CAGR -1.3%, max drawdown -24.9%.
- First eligible month-ends: SPY 2001-09-28, QQQ 2001-09-28, DIA 2005-11-30, IWM 2018-07-31, GLD 2008-06-30, SLV 2011-03-31, USO 2007-05-31.

### Verdict

**FAIL**. Run A: Sharpe above 0.5: no; deflated Sharpe above 0.9 (n_trials 32): no; max drawdown smaller than 25%: no; Sharpe above run B: yes (A Sharpe -0.33, B Sharpe -0.39, deflated 0.000, max drawdown -67.0%).

## Limits

- Option prices are modeled from 30-day CBOE volatility indices with Black-Scholes, not real chains: no real skew surface or term structure, no early exercise or assignment, no pin risk, no liquidity limit. Real fills could be worse, mostly for DIA, SLV and USO spreads.
- Some sample years predate listed options on the ETF (SPY options, for example, listed in January 2005). Results for those years are hypothetical.
- Costs are modeled; no market impact, no tax. Uninvested cash earns nothing, which lowers CAGR for the rule and the baseline alike.
- Yahoo data from one vendor, not checked against a second source.
- The carry proxy is not a futures term-structure roll return. For USO (which holds and rolls oil futures) it tracks the roll yield; for GLD and SLV (physical metal) it is mostly the fund fee and the front-contract basis; for the equity ETFs it is mostly the dividend yield. Yahoo `=F` series also contain unadjusted roll gaps.
- Short exposure through put debit verticals is defined risk but pays premium; it is not the short futures position of the source pages, and there is no 1/volatility sizing (sizing is the 2% maximum-loss rule).
- IWM joins only in 2018-07, so most of the sample has six members.
