# LD34 nested Donchian long-only breakout (research definition and Nautilus backtest)

Status: research only. No live or paper orders. No broker changes. Nautilus stays disarmed. No engine is armed by this file.

## Source

- Instagram reel DffCOSDBMoC (hooper.algo.fxx, 93 s, 2026-11-08), sent by the owner (card vertex-reel-backtest-dffcosd). The caption has no rules ("Comment VIDEO for free training"; not requested). The rules are on a strategy sheet shown in the video and spoken in the voice-over.
- Transcript (faster-whisper large-v3 on the rig GPU), key frames and the rule-by-rule trace with timestamps: `~/Documents/reports/web/vertex-reel-dffcosd/` on the rig (`transcript.md`, `frames/`, `rules.md`).
- Claimed: "over 450 % in the last 12 months" (this is the whole multi-system Darwinex account page shown at 88 s, not this system); an MT5 optimisation table with profit factors 1.12 to 1.47, 188 to 268 trades and drawdowns of 8 to 30 % on USDJPY, GBPJPY, AUDJPY, XAUUSD, CHFJPY, EURJPY and NDX, test window and costs not shown.

## Rules as stated

| Item | Rule | Where |
| --- | --- | --- |
| Direction | Long only, never short | sheet title, "The Idea" |
| Markets | SPX500, NAS100, BTCUSD (sheet); FX JPY crosses, gold, NDX (results) | chips at 1.5 s; table at 61 s |
| Signal | H1 | "SIGNAL · H1", step 1 |
| Levels | 20 / 50 / 100 / 200-bar Donchian highs and lows of the Daily; keep the nearest 4 each side of price | "The Idea", step 1 |
| Entry | An H1 candle closes above one of the upper levels; market order long; each level fires once | steps 2 and 3 |
| Stop | 2 x ATR(14) | step 3 |
| Sizing | 1 % risk per trade | step 3 |
| Target | None | step 4 |
| Trail | From +1R a 2 x ATR trail ratchets behind price | step 4 |
| Breakeven | At +2R | step 4 |

## Gaps and the defaults chosen

The full list with reasons is stored in the study (`services/research/strategies/ld34/rules.py`). The ones that change trades:
completed daily bars only (no look-ahead); a trading day starts at 17:00 New York; a breakout is the previous H1 close at or below the
current level and the H1 close above it (DSL `breaksAbove`); a level value fires once (DSL `oncePerLevel`); one position per market;
ATR(14) of the H1 bars; the trail anchors on the highest H1 close since entry; 1 % risk with leverage capped at ESMA retail CFD limits
(2 for ETFs).

## DSL definition

`python -m strategies.ld34 definition` (run in `services/research`) prints it. It uses the DSL additions made for this strategy
(documented in `docs/vertex-rebuild/strategy-definitions.md`): indicator `timeframe: "1d"`, operator `breaksAbove`, condition flag
`oncePerLevel`, `entry.any`, `management.trail` and `management.breakevenR`, and `sizing.maxLeverage`.

## Backtest design (fixed 2026-11-08, before the first run)

- Data: Dukascopy public H1 bid and ask candles (mid bars), fetched by `research/backtests/ld34/fetch_data.py` to the rig (not in the
  repository). Markets: the sheet (SPX500, NAS100, BTCUSD), the reel's result table (USDJPY, GBPJPY, AUDJPY, CHFJPY, EURJPY, XAUUSD),
  the Core 7 (index, metal and oil CFDs stand in for ES, NQ, YM, RTY, GC, SI, CL) and the Core 7 ETF twins (SPY, QQQ, DIA, IWM, GLD,
  SLV, USO). Each market runs on its full history.
- Engine: `nautilus_backtest` (NautilusTrader 1.227.0) on the rig, 100,000 USD start.
- Costs: the measured median bid/ask spread per market, slippage 0.5 bps (FX) to 5 bps (BTC), IBKR Pro Fixed commissions and fees for
  ETFs, and interest on the borrowed part of each position at the 13-week T-bill rate + 1.5 %.
- Form (a), as stated: the rules above. Form (b), Vertex: each Core 7 signal opens a 45-DTE call debit vertical (long 0.50 delta,
  1 sigma wide) on the ETF twin at the signal day's close, sized so the maximum loss is 2 % of equity, closed on the underlying exit day
  (next day when entry and exit fall on one day) or at 7 DTE; Black-Scholes with IV-index proxies, $0.65 per contract and half the
  bid/ask spread per leg (`strategies/qc_ports` model); booked by Nautilus.
- Primary result: the reel-sheet portfolio (SPX500, NAS100, BTCUSD), equal capital, rebalanced daily, on the common window.
- Robustness: in-sample first 60 % / out-of-sample last 40 % of the time; walk-forward (3 years train, 1 year test, best Sharpe of a
  3 x 3 stop x trail multiple grid); 18 one-at-a-time parameter changes; doubled spread and slippage; 2,000 trade bootstraps; deflated
  Sharpe over every distinct configuration tried (23).
- Comparisons: buy and hold of the same markets and windows; the library strategies re-run on the Core 7 ETF twins
  (`research/backtests/core7/rerun-results.json`).

## Pass/fail rule (fixed 2026-11-08, before the first run)

Gates on the reel-sheet portfolio (the `autopilot-gate.ts` defaults): OOS Sharpe >= 0.5; deflated Sharpe probability >= 0.95; Monte
Carlo P5 max drawdown >= -35 %; >= 75 % of the parameter changes keep Sharpe > 0; Sharpe > 0 with doubled costs.

- edge: all five gates pass and the options form has a positive OOS Sharpe.
- no edge: OOS Sharpe <= 0, or deflated Sharpe probability < 0.5, or at most 2 gates pass.
- needs more data: anything else (also fewer than 100 trades on the reel-sheet markets).

## Deviations (after the first run, from the fresh-context review)

- The trial count is 23 distinct configurations, not 27: four walk-forward grid points are also sensitivity rows.
- An underlying exit in the 16:00-17:00 New York bar closes the spread at the next ETF close (that bar ends after the ETF close).
- The Monte Carlo resamples trades net of financing and only inside the portfolio window; the trade count of the rule uses the same trades.
- The Russell 2000 CFD leverage cap is 10 (not an ESMA major index).
- The verdict checks "no edge" first, then fewer than 100 trades, then "edge", as the rule reads.

## Code and tests

- `services/research/strategies/ld34/` (data, definition, runner, metrics, study, rules); tests in `services/research/tests/test_ld34_study.py`.
- Run: `cd services/research && python -m strategies.ld34 study --ran <date> | bun run vertex:research-studies:import`.

## Results

Recorded after the run in the stored study (`/library?id=strategy-seed-ld34-nested-donchian-breakout`).
