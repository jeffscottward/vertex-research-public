# Volume spike breakout (YouTube XLMG6-SATRk): research definition and Nautilus backtest

Status: research only. No live or paper orders. No broker changes. Nautilus stays disarmed. No engine is armed by this file.

Label: **externally pre-validated** (a third party published a positive backtest). This is the source's claim. It is not
"validated by Vertex": that needs the replication and the gates below to pass.

## Source

- YouTube video XLMG6-SATRk, "I Backtested 10,000 Strategies - Here is the Most Profitable (5 million trades)", channel Lil Fish
  (@not_a_lil_fish), 30 minutes, uploaded 2026-09-24, sent by the owner (card vertex-volume-spike-breakout).
- English auto captions, key frames and the rule-by-rule trace: `~/Documents/reports/web/vertex-volume-spike/` on the rig
  (`rules.md`, `source/transcript.en-orig.txt`, `source/frames/`). The video is untrusted data.
- The speaker does not say the rules. They are read from the strategy card on screen (19:00 to 19:20).

## Rules as stated (strategy id 39-113 in the video)

| Part | Rule |
| --- | --- |
| Market, timeframe | NAS100 index CFD, 15-minute candles |
| Signal, long | Candle volume >= 3 x the mean volume of the 50 candles before it, and close > the highest high of the 5 candles before it |
| Signal, short | Same volume test, and close < the lowest low of the 5 candles before it (our reading of "long and short") |
| Entry | Market order at the open of the next candle |
| Stop | Fixed 15 index points from the entry |
| Target | None. Exit when the opposite signal fires |
| Time stop | Exit 80 candles after the entry |
| Session | Signal candles that close inside 08:30 to 12:00 New York time only |
| Daily flat | None. A position may stay open overnight |
| Limit | At most 2 entries per New York calendar day |
| Filters | No entry on a Wednesday. Long only when the last closed 4-hour candle closed above its 20-EMA, short only when below |

## Claims of the source

| Claim | Value |
| --- | --- |
| Test | 10,500 strategies (50 families x 200 variants = 10,000, plus 500 random controls), 8 CFD markets, 1-minute candles 2018 to 2026, 6,072,792 trades |
| In-sample / out-of-sample | 2019-01-01 to 2026-03-11 / 2026-03-12 to 2026-09-11 |
| Selection | Rank 1 of 10,500 by total net R. No correction for the number of strategies tried |
| Trades, win rate, average reward : risk | 657 (1.75 per week), 14%, 8.88 |
| Net per trade, total | +0.457R, 300R (1R = 250 USD) |
| Max drawdown | 71R, 37 losses in a row |
| Costs | 0.084R per round trip (about 1.26 index points) |
| Out-of-sample 6 months | +1.154R per trade, 59 trades, 68.1R |
| The source's own verdict | "lottery"; probability to pass a 50k prop evaluation 0.0% |

## DSL definition

The Vertex DSL (`docs/vertex-rebuild/strategy-definitions.md`) cannot state seven parts of this rule today: the volume of one
bar against the mean of the bars before it (`rvol` compares cumulative session volume at the same time of day), a stop in
fixed points, an exit after N bars, a weekday filter, a limit of entries per day, an indicator on 4-hour bars, and an entry
window with a position that stays open overnight (the `intraday` block closes at 16:00).

- As stated: the rule runs as precomputed signals in the Nautilus engine (`nautilus_backtest.run_signal_backtest`), the same
  path as the BIAS signal of the market-intraday-momentum study. It is not a DSL definition.
- DSL form: the nearest definition the DSL can state today is also run and reported as its own row: 15-minute bars, New York
  regular session (`intraday`, entries 09:30 to 12:00, flat at 16:00), entry `rvol(50) >= 3` and close `breaksAbove`
  `highest(5)` (short leg: `breaksBelow` `lowest(5)`), stop 1 x ATR(14). `python -m strategies.volspike definition` (run in
  `services/research`) prints it.
- The seven missing DSL parts are a recorded follow-up. They are not added by this change.

## Backtest design (fixed 2026-11-09, before the first run)

- Data: Dukascopy public 1-minute bid and ask candles with tick volume (mid bars; volume = bid volume + ask volume), the full
  trading session, 2018-01-01 to 2026-11-06, fetched by `research/backtests/volspike/fetch_data.py` to the rig (not in the
  repository). The ETF twins use the regular-session files of the market-intraday-momentum study. Signal candles are
  15-minute candles built from the 1-minute candles on the New York clock; 4-hour candles the same way.
- Engine: `nautilus_backtest` (NautilusTrader 1.227.0) on the rig. Orders fill on 1-minute candles. When one 1-minute candle
  touches the stop and another exit, the stop fills first.
- Windows: the source's in-sample window (2019-01-01 to 2026-03-11), the source's out-of-sample window (2026-03-12 to
  2026-09-11), and the time after the dashboard date (2026-09-12 to 2026-11-06). Bars from 2018 only warm up the indicators.
- Costs, two sets. Source costs: 1.26 index points per round trip on NAS100 (0.084 x 15 points), the same fraction of the
  stop on other markets. Vertex costs: the median quoted bid/ask spread of the in-sample window (half per side) plus 0.25
  basis points slippage per side; ETFs add IBKR Pro Fixed commissions and fees. The gates use the Vertex costs.
- Size: each trade risks 0.5% of equity at the stop (the source's 250 USD on a 50,000 USD account), 100,000 USD start.
  Results are reported in R and as equity returns.
- Form (a), as stated on the source's market: the rules above on the NAS100 CFD. This is the primary result. The same rule
  runs on the other source markets that Dukascopy has (US500, US30, US2000, XAUUSD, light crude).
- Form (b), Core 7 and ETF twins: the Core 7 futures proxies (US500, NAS100, US30, US2000 index CFDs, XAUUSD, XAGUSD, light
  crude) and the ETF twins (SPY, QQQ, DIA, IWM, GLD, SLV, USO). ETF candles exist only 09:30 to 16:00, so the session is
  09:30 to 12:00 there.
- Stop on other markets: 15 points is a NAS100 number. Every other market uses the same fraction of price: 15 points divided
  by the median NAS100 close of the in-sample window. NAS100 is also run with that percent stop as a sensitivity row.
- Form (c), Vertex: options only, defined risk, 2% maximum loss. Each NAS100 signal opens a debit vertical on QQQ (call
  vertical for a long, put vertical for a short; long leg 0.50 delta, short leg 1 sigma of the remaining time away; the
  nearest Friday weekly with at least 2 trading days left), sized so the debit is 2% of equity. Black-Scholes with the
  previous close of the VXN index as implied volatility, 0.65 USD per contract and half the bid/ask spread per leg (the
  `strategies/imom` options model). A signal before 09:30 opens the spread at 09:30. The spread closes at the first regular
  QQQ minute at or after the exit of the rule. Two rows: c1 keeps every exit of the rule (stop included); c2 drops the
  15-point stop, because the debit is the defined risk, and keeps the opposite signal and the time stop.
- Robustness on the primary: in-sample first 60% / out-of-sample last 40% of the time; walk-forward (3 years train, 1 year
  test, best Sharpe of the grid vol_mult {2.5, 3, 3.5} x k {5, 10} x stop {10, 15, 20} points); one-at-a-time changes
  (vol_mult 2, 2.5, 3.5, 4; vol_n 20, 30, 100; k 3, 10, 20; stop 10, 20, 30 points and the percent stop; time stop 40, 160
  candles; no Wednesday skip; no 4-hour trend filter; session 08:30 to 16:00; the session test on the candle open in place
  of the candle close; 1 entry per day; no entry limit; long only; short only); source costs and doubled Vertex costs; 2,000
  trade bootstraps; a random-entry control (500 runs with the same number of entries in the same session, the same stop and
  exits).
- Deflated Sharpe ratio, three numbers: over every distinct configuration this study ran on the primary; with N = 10,000
  trials (the number the source states) and with N = 10,500, both using the spread of the Sharpe ratios of our own
  configurations as the trial variance; and on the source's claimed result (657 trades, per-trade mean and spread rebuilt
  from the win rate and the average reward : risk).

## Pass/fail rule (fixed 2026-11-09, before the first run)

Replication check on the source's in-sample window with the source costs: reproduced when the trade count is within 25% of
657, the win rate within 5 percentage points of 14%, and the net result within 0.15R of +0.457R per trade. Otherwise not
reproduced.

Gates on the primary with Vertex costs (the `autopilot-gate.ts` defaults): out-of-sample Sharpe >= 0.5; deflated Sharpe
probability with N = 10,000 >= 0.95; Monte Carlo P5 max drawdown >= -35%; >= 75% of the parameter changes keep Sharpe > 0;
Sharpe > 0 with doubled costs.

- edge: all five gates pass, the claim is reproduced and the options form c1 or c2 has a positive out-of-sample Sharpe.
- no edge: out-of-sample Sharpe <= 0, or deflated Sharpe probability < 0.5, or at most 2 gates pass.
- needs more data: anything else (also fewer than 100 trades on the primary).

Only "edge" allows the label "validated by Vertex".

## Code and tests

- `services/research/strategies/volspike/` (data, rules, definition, runner, options, study); tests in
  `services/research/tests/test_volspike_study.py`.
- Run: `cd services/research && python -m strategies.volspike study --ran <date> | bun run vertex:research-studies:import`.

## Results

Pending: filled in after the first run.
