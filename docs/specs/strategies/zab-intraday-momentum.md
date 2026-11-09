# ZAB intraday momentum: pre-registered study (IBKR)

Status: pre-registered 2026-11-09, before any ZAB run on IBKR QQQ, IWM or DIA (owner decision, 2026-11-09). Research only: no arm,
deploy or order path.

## Source

Zarattini, Aziz and Barbon (2024), "Beat the Market: An Effective Intraday Momentum Strategy for the S&P 500 ETF (SPY)",
SSRN 4824172. The rule is the ZAB row of `docs/specs/strategies/market-intraday-momentum.md` and its DSL definition in
`services/research/strategies/imom/definition.py`; nothing in the rule changes for this study.

## What was already seen (disclosed, not hidden)

- Dukascopy CFDs 2017-2026 (market-intraday-momentum study): ZAB SPY -0.12, ZAB 1x QQQ 0.56 (OOS 0.53), US500 -0.63.
- IBKR SPY 2004-2026 (same study, after the run, not pre-registered): ZAB Sharpe 0.34 full, 0.72 OOS; ZAB 1x 0.46 / 0.53.
- So SPY on IBKR is not out-of-sample any more. It is reported, but the confirmation rests on QQQ, IWM and DIA on IBKR, which
  have not been run.

## Design (fixed now)

- Data: IBKR 5-minute TRADES bars from the vertex-history service (`research/backtests/imom/fetch_ibkr.py`), regular session,
  each ETF from its first IBKR bar (SPY 2004) to the fetch date. Spread: the IBKR BID_ASK quarterly sample of each ETF,
  measured on its in-sample part only.
- Markets: SPY (reported), QQQ, IWM, DIA (confirmation).
- Forms: ZAB as published (volatility target 2 % / 14-day daily vol, at most 4x) is primary; ZAB 1x (no leverage) is reported.
- Engine and costs: as the market-intraday-momentum IBKR run: NautilusTrader 1.227.0, 100,000 USD start, half the measured
  spread per side plus 1 bp slippage per side, IBKR Pro Fixed commissions and fees; flat at 16:00.
- Split: first 60 % of each market's time in-sample, last 40 % out-of-sample. No parameter is tuned: lookback 14 days,
  decision times HH:00/HH:30 10:00-15:30, as in the paper.
- Parameter changes (one at a time, the 7 rows of `ZAB_SENSITIVITY` in `definition.py`): band length 10 and 20 days; band
  multiple 0.8 and 1.2; decision every 15 and 60 minutes; 1x sizing. The 75 % gate is therefore at least 6 of 7 with Sharpe > 0.
- Monte Carlo: 2,000 trade bootstraps, seed 31 (`metrics.MC_PATHS`, `metrics.MC_SEED`).
- Deflated Sharpe trial count: N = 80, fixed now. It covers the earlier ZAB runs (2 forms on 15 Dukascopy markets, 6 sensitivity
  rows, 2 forms on IBKR SPY) and this study (2 forms and 7 changes on 4 markets), rounded up.

## Pass/fail rule (fixed now)

Per market, the five `autopilot-gate.ts` gates on ZAB (primary form): OOS Sharpe >= 0.5; deflated Sharpe probability >= 0.95;
Monte Carlo P5 max drawdown >= -35 %; >= 75 % of one-at-a-time parameter changes keep Sharpe > 0; Sharpe > 0 with doubled costs.

Verdict:

- **edge**: at least 2 of QQQ, IWM, DIA pass all five gates.
- **weak**: no edge, but at least 2 of QQQ, IWM, DIA have OOS Sharpe > 0 and Sharpe > 0 with doubled costs.
- **no edge**: anything else.

SPY's gates are shown but cannot change the verdict. The study runs once; any later change to rule, costs or markets needs a new
pre-registration and counts as another configuration.

## Results

Not run yet (waiting for the QQQ, IWM and DIA IBKR backfill).
