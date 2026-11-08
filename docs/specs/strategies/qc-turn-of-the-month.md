# Turn of the Month (QuantConnect port)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- QuantConnect Strategy Library: [Turn of the Month in Equity Indexes](https://www.quantconnect.com/learning/articles/investment-strategy-library/turn-of-the-month-in-equity-indexes) (references Quantpedia, "Turn of the Month in Equity Indexes"). Read 2026-11-08.
- Rule as stated: equity indexes rise on the last trading day of the month and the first three trading days of the next month. QuantConnect buys SPY (100%) one minute after the open on the last trading day of the month and sells it after three more trading days; cash otherwise. Suggested cause: pension cash flows and month-end rebalancing.
- Port request: call debit vertical on SPY, QQQ, DIA and IWM, window −2..+3.
- Port request: owner, 2026-11-08 (QuantConnect idea ports; owner decision 2026-11-08: full strategy DSL with defined-risk option legs and reusable entry gates, TypeScript and Python engines in parity). This port does not reproduce QuantConnect's backtest. It trades the idea as defined-risk option spreads on modeled option prices, because the owner's options-only rule forbids share positions and naked futures.

## Classification

- Type: standalone calendar signal (DSL filter `calendarWindow`, window `turnOfMonth`).
- Direction: long, defined risk (call debit verticals only).

Basis codes: S = stated by the source page; O = set by the owner's port request (2026-11-08); A = Vertex default, fixed before the first run.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Universe: SPY, QQQ, DIA, IWM (the Core 7 equity index ETFs).|O|
|2|Day offsets count SPY trading days around the month end: −1 = last trading day of the month, +1 = first trading day of the next month; there is no day 0.|O (contract)|
|3|Holding window −2..+3, read as trade dates: open at the close of day −2, close at the close of day +3. The spread is held over the returns of days −1, +1, +2 and +3: the last trading day and the first three trading days, as on the source page.|O / S|
|4|Signal timing: the entry signal is the close of day −3 and the exit signal the close of day +2, so the one-bar trade delay (signal at close i, trade at close i+1) lands on the window. DSL: `{type: "calendarWindow", window: "turnOfMonth", fromDay: -3, toDay: 2}` evaluated on signal bars, with the exit on the first signal bar outside the window.|A|
|5|Literal variant (run A-L): the filter `fromDay: -2, toDay: 3` on signal bars. With the one-bar delay it opens at the close of day −1 and closes at the close of day +4, holding days +1 to +4 and missing day −1. Pre-registered because the owner's window can be read either way; reported, not the pass test.|A|
|6|Structure: call debit vertical, `longDelta` 0.5, `widthSigma` 1.0, expiry nearest 30 DTE with DTE ≥ 21, `maxLossPct` 2, no profit-take, no `exitDte`. One spread per member per window.|A|

## Backtest design (fixed 2026-11-08, before the first run)

- Members from their IV index start: SPY 1993-01-29, QQQ 2001-01-23, DIA 2005-11-22, IWM 2009-09-16. One shared-equity portfolio; a member trades from its first full window after its start. Sample end 2026-11-06. Per-member attribution and the window with all four live (from 2009-09-16) are reported from the same runs.
- Baseline B: the same call debit vertical on the same four ETFs, always on: opened at the close of the first trading day of each month (signal at the month-end close) and closed at the close of the first trading day of the next month, when the next one opens (monthly roll).

|Run|Definition|Counted|
|---|---|---|
|A|Turn-of-month window −2..+3 as trade dates (primary)|yes|
|A-L|Literal filter −2..+3 on signal bars|yes|
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
- DSL: the `calendarWindow` filter (`turnOfMonth`) and the `options` block (`callDebitVertical`) in `packages/api/src/strategy-dsl.ts`, mirrored in `services/research/nautilus_backtest/signals.py` with golden parity fixtures (TypeScript and Python must agree).
- Tests (hand-computed, written with the engine and before the first run): trading-day offsets around month ends that fall on weekends and holidays (for example 2025-12-31 / 2026-01-02); entry and exit bars for runs A and A-L; window holdings never overlap.
- Data: `research/backtests/qc-ports/fetch_data.py`.
- Results: stored in Postgres `research_studies` (id `qc-turn-of-the-month`) with `bun run vertex:research-studies:import`. No results JSON file is committed (AGENTS.md rule 13).

## Results

Not run yet. Results are stored in Postgres `research_studies` (id `qc-turn-of-the-month`) and filled in here after the run: run date, data manifest, the metrics of every run in this spec and the verdict.

## Limits

- Option prices are modeled from 30-day CBOE volatility indices with Black-Scholes, not real chains: no real skew surface or term structure, no early exercise or assignment, no pin risk, no liquidity limit. Real fills could be worse, mostly for DIA, SLV and USO spreads.
- Some sample years predate listed options on the ETF (SPY options, for example, listed in January 2005). Results for those years are hypothetical.
- Costs are modeled; no market impact, no tax. Uninvested cash earns nothing, which lowers CAGR for the rule and the baseline alike.
- Yahoo data from one vendor, not checked against a second source.
- A holding of four trading days pays two round-trip spread costs per month on top of the option time decay; the structure, not only the effect, decides the result.
- Day −1 is the core day of the effect, so the timing reading in rule 3 matters; run A-L shows the cost of reading it the other way.
