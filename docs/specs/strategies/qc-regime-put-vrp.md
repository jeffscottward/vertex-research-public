# Regime-Gated Put Volatility Risk Premium (QuantConnect port)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- QuantConnect Strategy Library: [Volatility Risk Premium Effect](https://www.quantconnect.com/learning/articles/investment-strategy-library/volatility-risk-premium-effect). Read 2026-11-08.
- Rule as stated: sell volatility to earn the volatility risk premium. Each month QuantConnect sells a one-month ATM straddle on GOOG (weeklies included) and buys a 15% out-of-the-money put as crash insurance, holds to expiry and repeats monthly.
- Port request: SPY put credit vertical at 25 delta, about 45 DTE, 50% profit-take, close at 21 DTE, opened only in a calm regime (`volRegime`: VIX ≤ 25, VIX/VIX3M ≤ 1.0, SPY above its 200-day average).
- Port request: owner, 2026-11-08 (QuantConnect idea ports; owner decision 2026-11-08: full strategy DSL with defined-risk option legs and reusable entry gates, TypeScript and Python engines in parity). This port does not reproduce QuantConnect's backtest. It trades the idea as defined-risk option spreads on modeled option prices, because the owner's options-only rule forbids share positions and naked futures.

## Classification

- Type: standalone short-premium strategy with a reusable regime gate (DSL filter `volRegime`). The gate is also measured before/after on two existing strategies.
- Direction: short premium, defined risk (credit verticals only). The naked straddle of the source page is not allowed.

Basis codes: S = stated by the source page; O = set by the owner's port request (2026-11-08); A = Vertex default, fixed before the first run.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Underlying: SPY.|O|
|2|Regime at the close of bar i passes when VIX ≤ 25 AND VIX/VIX3M ≤ 1.0 AND SPY close > SMA(200) of SPY close. DSL: `{type: "volRegime", maxVix: 25, maxTermRatio: 1.0, trendLength: 200}`. A missing VIX or VIX3M value fails the gate.|O|
|3|Entry cadence: at each month-end close with no open spread, signal an entry if the regime passes; trade at the close of the first trading day of the next month.|A|
|4|Structure: put credit vertical, short put at 25 delta (`shortDelta` 0.25), long put `widthSigma` 0.5 further out of the money, expiry nearest 45 DTE with DTE ≥ 30, `profitTakePct` 50 (close when the spread value is at or below 50% of the credit received), `exitDte` 21, `maxLossPct` 2.|O / A (delta, DTE, profit-take and exit DTE: O; width and DTE minimum: A)|
|5|Exits: profit-take or `exitDte`, whichever comes first; the regime never blocks an exit.|O|
|6|At most one open spread.|A|

## Backtest design (fixed 2026-11-08, before the first run)

- Sample: from 2006-07-17 (VIX3M starts; SPY has 200 closes well before) to 2026-11-06. First entry signal at month-end 2006-07-31, first trade 2006-08-01. The 2008, 2020 and 2022 drawdowns are reported separately from the same runs.
- Baseline B: the same SPY put credit vertical with the gate removed (a spread opens every month when flat), over the same dates. Run B is shared with [qc-vix-term-gate](qc-vix-term-gate.md) and counts once.
- Existing strategy sma30 (runs S): the DSL form of [sma30-market-timing](sma30-market-timing.md) on SPY. Entry when close > SMA(30) of close; exit when close < SMA(30). It uses SPY `close`, not the French total-return index of that spec. From 1993-01-29.
- Existing strategy donchianBreakout (runs D): `STRATEGY_TEMPLATES.donchianBreakout` in `packages/api/src/strategy-dsl.ts`, unchanged (entry: close above the highest high of the prior 20 bars; exit: close below the lowest low of the prior 10 bars), on each Core 7 ETF in one shared-equity portfolio; each member from its IV index start (SPY 1993-01-29, QQQ 2001-01-23, DIA 2005-11-22, IWM 2009-09-16, GLD 2008-06-03, SLV 2011-03-16, USO 2007-05-10).
- Options expression for runs S and D: call debit vertical, `longDelta` 0.5, `widthSigma` 1.0, expiry nearest 30 DTE with DTE ≥ 21, `exitDte` 5, `maxLossPct` 2, no profit-take. A spread closes on the strategy's exit signal or at `exitDte`. While flat, a new spread opens at the close after any bar on which the entry condition holds (so sma30 re-enters after an `exitDte` close while SPY stays above its SMA; Donchian waits for a new breakout).
- The gate is a DSL filter on entries only; exits are never blocked. Runs S0 and D0 (no gate) are shared by [qc-iv-rank-gate](qc-iv-rank-gate.md), [qc-regime-put-vrp](qc-regime-put-vrp.md) and [qc-vix-term-gate](qc-vix-term-gate.md) and count once.

|Run|Definition|Counted|
|---|---|---|
|A|SPY put credit vertical, `volRegime` gate (primary)|yes|
|B|SPY put credit vertical, no gate (baseline)|yes (shared)|
|S0|sma30 options expression, no gate|yes (shared)|
|S2|S0 + `volRegime` gate|yes|
|D0|donchianBreakout options expression over Core 7, no gate|yes (shared)|
|D2|D0 + `volRegime` gate (the regime is market-wide: VIX, VIX3M, SPY trend)|yes|

Runs in this spec: 6 (3 own, 3 shared). Family total: 32.

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

Secondary (reported, not part of the verdict): the `volRegime` gate is measured before and after on the two existing strategies, over the dates from 2006-07-17 (VIX3M starts; before that the gate cannot pass): Sharpe, maximum drawdown, CAGR, trades and exposure of the gated run against the ungated run on the same dates. The gate is reported as helping a strategy only when the gated Sharpe is higher and the gated maximum drawdown is no worse.

## Code and tests

Planned paths; this spec is committed before the code.

- Rules, option model and ledger: `services/research/strategies/qc_ports/` (`data.py`, `calendar.py`, `options.py`, `book.py`, `ledger.py`, `metrics.py`, `nautilus_runner.py`).
- DSL: the `volRegime` filter and the `options` block (`putCreditVertical`, `profitTakePct`, `exitDte`) in `packages/api/src/strategy-dsl.ts`, mirrored in `services/research/nautilus_backtest/signals.py` with golden parity fixtures (TypeScript and Python must agree).
- Tests (hand-computed, written with the engine and before the first run): each of the three regime conditions failing alone; ties at VIX = 25 and ratio = 1.0 (pass); missing VIX3M; profit-take versus `exitDte` ordering on one close.
- Data: `research/backtests/qc-ports/fetch_data.py`.
- Results: stored in Postgres `research_studies` (id `qc-regime-put-vrp`) with `bun run vertex:research-studies:import`. No results JSON file is committed (AGENTS.md rule 13).

## Results

Run 2026-11-08 with `python -m strategies.qc_ports study --ran 2026-11-08` (services/research), data manifest sha256(SHA256SUMS) `95fc3a54ce009761b2818f8fd79c0cfb2880eb5d86aba33099e60f56b0c55348`, data to 2026-11-06. The JSON document of the same command (without --report) goes to Postgres `research_studies` (id `qc-regime-put-vrp`) through `bun run vertex:research-studies:import`. Deflated Sharpe: n_trials 32, variance of the per-day Sharpe across the 32 runs 0.000232. Ledger and NautilusTrader agreed on every trade and on daily equity (1e-6 relative).

Implementation: `services/research/strategies/qc_ports/ideas.py` (DSL definitions, derived series, runs) and `study.py` (compile with `nautilus_backtest/signals.py`, book, ledger, Nautilus parity, metrics). One open spread per member is decided from the priced book; a spread the ledger refuses for size (0 contracts) still holds its member until its priced exit, and such refusals count in Skipped (with book skips such as a missing IV index value). Native DSL `volRegime` filter. Gated host runs S2 and D2 start 2006-07-17 (VIX3M starts; the gate cannot pass before); the gate table compares them with S0 and D0 run over the same dates (same rule, not extra trials).

|Run|From|CAGR|Sharpe|Deflated Sharpe|Max drawdown|Worst month|Trades|Win rate|Exposure|Skipped|
|---|---|---|---|---|---|---|---|---|---|---|
|A|2006-07-17|0.1%|0.09|0.030|-3.7%|2018-10 -1.4%|167|76.6%|41.9%|2|
|B|2006-07-17|-0.0%|-0.03|0.007|-5.1%|2018-12 -1.7%|239|76.2%|57.1%|5|
|S0|1993-01-29|-2.2%|-0.45|0.000|-57.0%|2000-01 -4.3%|514|32.9%|57.5%|44|
|S2|2006-07-17|-1.1%|-0.25|0.000|-27.4%|2014-01 -3.4%|285|33.7%|56.7%|0|
|D0|1993-01-29|-4.7%|-0.44|0.000|-82.9%|2011-05 -12.9%|700|35.0%|58.5%|328|
|D2|2006-07-17|-5.5%|-0.39|0.000|-73.5%|2011-05 -14.6%|604|34.9%|64.1%|166|

|Gate|Host|Before Sharpe|After Sharpe|Before max DD|After max DD|Before CAGR|After CAGR|Before trades|After trades|Before exposure|After exposure|Helps|
|---|---|---|---|---|---|---|---|---|---|---|---|---|
|volRegime|sma30-market-timing (SPY) from 2006-07-17|-0.09|-0.25|-23.9%|-27.4%|-0.5%|-1.1%|338|285|65.2%|56.7%|no|
|volRegime|donchianBreakout (Core 7) from 2006-07-17|-0.35|-0.39|-74.8%|-73.5%|-5.5%|-5.5%|703|604|77.3%|64.1%|no|

- Run A drawdown within 2008 0.0%, 2020 -0.1%, 2022 -1.8%.
- Run B drawdown within 2008 -3.1%, 2020 -1.5%, 2022 -1.9%.
- Month-ends from 2006-07-31: 244; volRegime passes at 169.

### Verdict

**FAIL**. Run A: Sharpe above 0.5: no; deflated Sharpe above 0.9 (n_trials 32): no; max drawdown smaller than 25%: yes; Sharpe above run B: yes (A Sharpe 0.09, B Sharpe -0.03, deflated 0.030, max drawdown -3.7%).

## Limits

- Option prices are modeled from 30-day CBOE volatility indices with Black-Scholes, not real chains: no real skew surface or term structure, no early exercise or assignment, no pin risk, no liquidity limit. Real fills could be worse, mostly for DIA, SLV and USO spreads.
- Some sample years predate listed options on the ETF (SPY options, for example, listed in January 2005). Results for those years are hypothetical.
- Costs are modeled; no market impact, no tax. Uninvested cash earns nothing, which lowers CAGR for the rule and the baseline alike.
- Yahoo data from one vendor, not checked against a second source.
- Short premium has a skewed payoff: a sample without a crash at the wrong time overstates the result. The 2-percent cap bounds each loss, not the run of losses.
- The 25-delta short put is placed on a modeled skew; real 25-delta puts trade at higher implied volatility, which would raise both the credit and the loss.
