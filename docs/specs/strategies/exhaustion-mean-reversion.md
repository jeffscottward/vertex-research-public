# EMT: Exhaustion Mean Theory (research definition and backtest)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file. Nothing here is deployed to QuantVPS.

## Source

- Creator: Instagram @gstreettradesofficial (Cody G, futures trading coach).
- Reel: <https://www.instagram.com/reel/Ddra9kmC4hk/>, uploaded 2026-09-24, about 1:25. Caption: "Comment EMT for the free checklist".
- Transcript: faster-whisper medium.en on CPU, machine-generated and unverified. Timestamps are elapsed video time (m:ss). Copy: `~/Documents/reports/vertex-emt/t.txt` (rig).
- Owner request 2026-10-23 (FIRSTMATE): add EMT to Vertex as a strategy and run the backtest.
- The creator's paid/free "EMT checklist" was not obtained. Its contents can change the rules.

## Classification

The Reel names five steps, a stop and a target. It gives no numbers for "sharp move", "big wick", "volume burst" or "far enough". Basis codes: S = stated; I = implied; A = Vertex default, fixed before the first backtest run.

## Rules

|#|Rule|Basis|Quote and timestamp|
|---|---|---|---|
|1|Chart: 5-minute bars. Mean = VWAP and 9 EMA.|S|0:13 "add VWAP and the 9 EMA"; 0:19 "watching on the 5 minute chart".|
|2|Step 1, acceleration: bar extreme is at least 1.5 × ATR(14) beyond both means.|S / A|0:26 "a sharp move with momentum, stretching way past the mean".|
|3|Step 2, exhaustion candle: rejection wick ≥ 50% of the bar range and volume ≥ 1.5 × prior 20-bar average.|S / A|0:34 "A big rejection wick accompanied with a volume burst."|
|4|Step 3, footprint: sellers stacking, buyers drying up (order-flow footprint).|S|0:41 "Diminishing acceptance. Sellers stacking while buyers dry up."|
|4a|Not tested. No footprint (bid/ask volume) history is available.|A|—|
|5|Step 4, distance: reward to the nearer mean ≥ 3 × risk to the stop.|S|0:47 "far enough away from the mean"; 0:51 "0.5 to 1R risk for a 3 plus R reward".|
|6|Step 5, liquidity sweep: exhaustion bar trades beyond the prior 20-bar high (low) and closes back inside.|S / A|0:56 "Breakout traders getting trapped above resistance".|
|7|Entry: next bar open, when all tested steps align. Both directions (the Reel shows a short).|S / I|1:02 "All 5 line up. Enter."|
|8|Stop: slightly beyond the exhaustion extreme (+0.02 ATR).|S / A|1:04 "Stops placed slightly above the exhaustion high."|
|9|Target: first touch of the nearer current mean.|S|1:06 "Targeting the mean."|
|10|Intraday test: no entry in the first 3 bars; flat at the session close. Stop counts first when stop and target hit in one bar; a gap through the stop fills at the open. Cost 1 bp per side.|A|Not stated.|
|11|Instrument: the creator trades futures. Test uses SPY, QQQ, IWM, SOXX (free data). Live use needs its own options spec and the 2% NLV per-name premium cap; no share positions.|A|Not stated.|

## Backtest results (2026-10-23, rig)

Script and raw output: `~/Documents/reports/vertex-emt/bt.py`, `results.json`. Data: Yahoo Finance via yfinance 5-minute bars (last 60 sessions, 2026-07-31 to 2026-10-23; Yahoo's limit) and daily bars 2005-01-03 to 2026-10-23.

|Test|Trades|Wins|Result|
|---|---|---|---|
|5-min, 60 sessions, 4 ETFs|5|3|+0.2% SOXX, +0.08% IWM, +0.02% SPY, −0.04% QQQ|
|Daily proxy (9 EMA only), 2005–2026, 4 ETFs|17|1|Negative on all 4 (−1.4% to −2.3% total); 16 of 17 hit the stop|

Verdict: inconclusive. With every tested step required, the rules fire about once per symbol per 60 sessions, so 5 intraday trades prove nothing. The daily proxy loses, but the creator's setup is intraday, so the daily result does not test his claim.

Next step for a real test (2026-10-23 plan): at least 2 years of 5-minute (or 1-minute) futures bars (ES/NQ) with volume, then rerun the frozen rules. A completed backtest does not authorize trades.

## Futures backtest results (2026-10-24, rig)

Script and raw output: `~/Documents/reports/vertex-emt/futures_bt.py`, `futures_results.json` (rig). The script runs the frozen `run()` from `bt.py` without changes. Pass/fail rule set before the run: positive net expectancy on ES and NQ, and in both halves (split by trade count, as in `bt.py`), with at least 30 trades per symbol. Fewer than 30 trades = inconclusive.

### Data provenance

- Source: IBKR historical data (`reqHistoricalData`, TRADES, 5 mins, useRTH=1), read-only one-shot fetch on QuantVPS, IB client id 91, 2026-10-23. CSV copies: `~/Documents/reports/vertex-emt/futures/` (rig). SHA-256 and row counts matched the VPS before the VPS copies were deleted.
- Session: IBKR RTH for CME equity index futures, 09:30–17:00 ET (90 bars per full session). Timestamps are UTC in the CSVs and are converted to America/New_York.
- Continuous series: each contract only in its front-month window. Roll 8 calendar days before expiry (expiry = third Friday). No back-adjustment. Indicators use each contract's own bars; earlier bars of the same contract are warm-up only.
- ES: 9 contracts (ESZ4 to ESZ6), 2024-09-12 to 2026-10-23, 532 sessions, 47,607 bars. No missing contracts.
- NQ: NQZ4, NQH5, NQM5 complete; NQU5 partial (2025-07-18 to 2025-09-10). Missing: NQU5 2025-06-12 to 2025-07-17, and NQZ5, NQH6, NQM6, NQU6, NQZ6 (2025-09-11 to 2026-10-23). 225 sessions, 20,160 bars. Cause: the IB gateway stopped answering during the fetch on 2026-10-23 at about 23:44 UTC (`504 Not connected`). On 2026-10-24 at 19:03 UTC it was still down (watchdog: `ibapi handshake timeout`, 2,105 consecutive failures). The gateway was not touched; it needs the human IBKR recovery step.
- Costs: 1 tick (0.25 point) slippage per side plus USD 2.50 commission per side per contract. Round trip: ES 0.60 point (USD 50/point), NQ 0.75 point (USD 20/point).

### Results (net of costs)

|Symbol|Trades|Hit rate|Avg R net|Expectancy (points)|Max DD (R)|Target / stop / EOD|1st half avg R (n)|2nd half avg R (n)|
|---|---|---|---|---|---|---|---|---|
|ES|12|25%|−0.34|−1.02|−9.15|3 / 9 / 0|−0.59 (6)|−0.09 (6)|
|NQ|7|29%|−0.23|+1.08|−3.28|2 / 5 / 0|−1.09 (3)|+0.41 (4)|

NQ expectancy in points is positive while average R is negative because one winner (2025-01-10, +103 points) had a large stop distance.

Sensitivity check (not the primary result): the same run with bars from 16:00 ET onward removed, so the session is the 09:30–16:00 ET cash-index session used in the ETF test. Run with `SESSION_END=16:00`; output `futures_results_to1600.json` (rig).

|Symbol|Trades|Hit rate|Avg R net|Expectancy (points)|Max DD (R)|Target / stop / EOD|1st half avg R (n)|2nd half avg R (n)|
|---|---|---|---|---|---|---|---|---|
|ES|5|40%|+0.22|−0.44|−2.36|2 / 3 / 0|−1.18 (2)|+1.15 (3)|
|NQ|4|25%|−0.01|+10.02|−2.25|1 / 3 / 0|−1.12 (2)|+1.11 (2)|

The session definition changes the trade list a lot (12 → 5 ES trades), because the VWAP, EMA, ATR and volume averages change. Both session choices give too few trades to judge.

Verdict: inconclusive (12 and 7 trades, below 30). Every R figure except NQ's second half (4 trades) is negative after costs. The rules fire about once per 44 ES sessions. IBKR documents that expired-futures data older than two years after expiry is not available ([TWS API Historical Data Limitations](https://interactivebrokers.github.io/tws-api/historical_limitations.html)). This run did not test that limit; it requested no contract older than Z4. Based on that documentation, a complete NQ fetch adds about 9 trades at most, so IBKR data cannot reach 30 trades per symbol. A test with 30 or more trades needs a longer 5-minute history from another vendor (about 5+ years). This result does not authorize trades.
