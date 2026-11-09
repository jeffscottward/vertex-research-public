# Market intraday momentum (reel DffkN31): research definitions and Nautilus backtest

Status: research only. No live or paper orders. No broker changes. Nautilus stays disarmed. No engine is armed by this file.

## Source

- Instagram reel DffkN31PrN7 (davidtrades_model, 70 s, 2026-11-08), sent by the owner (card vertex-reel-backtest-dffkn31). The
  caption sells a proprietary "bias tracker" ("Comment GATES"; not requested) on top of public intraday-momentum research.
- Transcript (faster-whisper large-v3 on the rig GPU), key frames and the rule-by-rule trace: `~/Documents/reports/web/vertex-reel-dffkn31/`
  on the rig (`transcript.md`, `frames/`, `rules.md`).
- The reel states no entry, exit, stop, target or sizing. It shows the paper Gao, Han, Li & Zhou, "Market Intraday Momentum"
  (J. Financial Economics 2018) and the read-out of an 8-factor bias panel (`BIAS: 50.00`, `STATE: Bullish`, factors Initial Move,
  VWAP, Daily Candle, Initial Hour HL, Session Delta, Value Area Shift, ORB, Gap). The task adds Zarattini, Aziz & Barbon, "Beat the
  Market: An Effective Intraday Momentum Strategy for SPY" (2024).

## Strategies tested

| Id | Rule | Where |
| --- | --- | --- |
| GHLZ | At 15:30 New York go long if the return from the previous 16:00 close to today's 10:00 price is > 0, short if < 0; flat at 16:00; no stop, 1x notional | paper on screen (k02) |
| GHLZ r1+r12 | Same, but only when the 15:00-15:30 return has the same sign | same paper |
| ZAB | Noise band = max/min(open, previous close) x (1 +/- mean 14-day absolute move from the open at that minute); at each HH:00/HH:30 from 10:00 to 15:30 enter long above the upper band, short below the lower band; exit when price crosses back through max(upper band, VWAP) (long) or min(lower band, VWAP) (short); flat at 16:00; volatility-target sizing 2 % / 14-day daily vol, at most 4x | task note; paper |
| BIAS | Reconstructed bias score = 100 x (#Long - #Short) / 8 over the eight panel factors (fits the shown 50.00 = (5 - 1) / 8); at 15:30 long if score >= 50, short if <= -50, flat at 16:00 | panel at 36-38 s; factor definitions are our defaults (`rules.md`) |

## DSL definition

GHLZ and ZAB are Vertex DSL definitions (long and short legs), using the intraday additions documented in
`docs/vertex-rebuild/strategy-definitions.md`: the `intraday` block (New York session, entry window, decision grid, flat at the close as
a market-on-close fill), `side: "short"`, indicators `sessionReturn`, `noiseBand` and `vwap`, and sizing `volTarget`.
`python -m strategies.imom definition` (run in `services/research`) prints them. BIAS needs a vote over eight factors whose
definitions are not shown in the reel; it runs as a research-only signal in the study runner (not a DSL definition).

## Backtest design (fixed 2026-11-08, before the first run)

- Data: Dukascopy public 1-minute bid and ask candles (mid bars, aggregated to 5 minutes), New York regular session, fetched by
  `research/backtests/imom/fetch_data.py` to the rig (not in the repository). Vertex has no stored intraday history (vertex-history is
  a live IBKR proxy that always ends "now"); an IBKR 5-minute backfill is a recorded follow-up.
- Markets: the reel's instrument (S&P 500 E-mini; the US500 index CFD stands in, 2012 onward), the Core 7 futures proxies (US500, NAS100,
  US30, US2000 index CFDs, XAUUSD, XAGUSD, light crude) and the Core 7 ETF twins (SPY, QQQ, DIA, IWM, GLD, SLV, USO; 2017 onward). Each
  market runs on its full history.
- Engine: `nautilus_backtest` (NautilusTrader 1.227.0) on the rig, 100,000 USD start.
- Costs: the measured median bid/ask spread per market (half per side), slippage 1 bp per side, IBKR Pro Fixed commissions and fees for
  ETFs. No overnight financing (positions never cross the close).
- Form (a), as stated: the rules above on the underlying. Form (b), Vertex: each signal opens a defined-risk debit vertical on the ETF
  twin (call vertical for long, put vertical for short; long 0.50 delta, short strike 1 sigma of the remaining time away; nearest
  expiry with at least 1 trading day left) at the entry time, closed at 16:00 the same day, sized so the maximum loss (the debit) is
  2 % of equity; Black-Scholes with the IV-index proxy of the previous close, $0.65 per contract and half the bid/ask spread per leg
  (`strategies/qc_ports` model); booked by Nautilus.
- Primary result: GHLZ on the US500 CFD (the instrument on screen, longest history). Every other strategy and market is reported.
- Robustness: in-sample first 60 % / out-of-sample last 40 % of the time; walk-forward (3 years train, 1 year test, best Sharpe of a
  small grid); one-at-a-time parameter changes; doubled spread and slippage; 2,000 trade bootstraps; deflated Sharpe over every
  distinct configuration tried.
- Comparisons: buy and hold of the same markets and windows; the library strategies re-run on the Core 7 ETF twins
  (`research/backtests/core7/rerun-results.json`); LD34.

## Pass/fail rule (fixed 2026-11-08, before the first run)

Gates on the primary (the `autopilot-gate.ts` defaults): OOS Sharpe >= 0.5; deflated Sharpe probability >= 0.95; Monte Carlo P5 max
drawdown >= -35 %; >= 75 % of the parameter changes keep Sharpe > 0; Sharpe > 0 with doubled costs.

- edge: all five gates pass and the options form has a positive OOS Sharpe.
- no edge: OOS Sharpe <= 0, or deflated Sharpe probability < 0.5, or at most 2 gates pass.
- needs more data: anything else (also fewer than 100 trades on the primary).

## Code and tests

- `services/research/strategies/imom/` (data, definition, runner, metrics reuse, study, rules); tests in
  `services/research/tests/test_imom_study.py`.
- Run: `cd services/research && python -m strategies.imom study --ran <date> | bun run vertex:research-studies:import`.

## Results

Recorded after the run in the stored study (`/library?id=strategy-seed-market-intraday-momentum`).
