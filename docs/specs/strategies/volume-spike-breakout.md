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
| Signal, long | Volume >= 3 x the mean volume of the 50 candles before it, and close > the highest high of the 5 before it |
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
| Test | 10,500 strategies: 50 families x 200 variants = 10,000, plus 500 random controls |
| Test data | 8 CFD markets, 1-minute candles 2018 to 2026, 6,072,792 trades |
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

## Deviations

Readings chosen before the first run (the source and the design leave them open):

- Candles: 15-minute candles on the quarter hours and 4-hour candles at 00:00, 04:00, 08:00, 12:00, 16:00 and 20:00 New York,
  built from the 1-minute candles. A candle exists when it has at least one 1-minute bar; "the N candles before it" are the N
  existing candles before it.
- Session test: the signal candle closes at or after 08:30 and at or before 12:00 New York (both ends count). The
  sensitivity row "candle open": the candle opens at or after 08:30 and before 12:00.
- Trend test: the last 4-hour candle that ended at or before the close of the signal candle, against its 20-EMA. The EMA is
  seeded with the simple average of the first 20 closes (the DSL `ema`); bars of 2018 warm it up.
- Opposite signal: the volume test and the breakout test in the other direction on any candle, without the session, weekday,
  trend or entry-limit test. The position closes at the next open; the reverse entry is taken there only when every entry
  rule allows it. A signal on a candle that closes while a position is open is ignored, also when that position leaves at
  the next open by the time stop.
- Time stop: the open of the candle 80 existing candles after the entry candle. The Wednesday skip and the entry limit use
  the New York date of the entry bar.
- Stop and costs: the stop is 15 points from the entry open of the mid bars. Costs are charged next to the fill (as
  commission in the engine); they do not move the entry or the stop, so the source costs, the Vertex costs and the doubled
  Vertex costs have the same trades. R gross = side x (exit - entry) / stop distance; R net = R gross - round-trip cost /
  stop distance. A bar that opens beyond the stop fills at its open. A scheduled exit whose bar opens beyond the stop is
  recorded as a stop (same price). Prices are read at the engine's 9 decimals.
- Vertex spread: the median of (ask close - bid close) / mid close over all 1-minute bars of the source's in-sample window,
  in basis points of the price (as in the market-intraday-momentum study), half per side. NAS100: 1.96 bp
  (3.23 points is the median in points). The Vertex round trip is 0.23R at the median in-sample close
  (13,979) against the source's 0.084R. The quoted NAS100 spread is 3.1 to 3.4 points from 2018 to 2024 and 1.2
  to 1.5 points in 2025 and 2026, so a constant number of basis points is too low at the 2019 prices and too high at the
  2026 prices. The row "Vertex spread as fixed points" (the same median as 3.23 points, booked in Nautilus) was added
  after the first run, when the spread per year showed this. It and the median spread at the fill minutes are reported as
  information only; no gate uses them.
- Gates: "out-of-sample" is the last 40 % of the time of 2019-01-01 to 2026-11-06 (from 2023-09-15). The replication
  check uses the source's in-sample window and the source's costs. The verdict rule is applied in the order of the
  market-intraday-momentum study: no edge first, then fewer than 100 trades, then edge, else needs more data.
- Deflated Sharpe: the trial variance is the variance of the per-day Sharpe ratios of the 38 distinct configurations
  run on NAS100 (the stated rule, 24 one-at-a-time changes, 12 more walk-forward grid points, the DSL form). For the
  source's claim the per-trade result is rebuilt as two outcomes (+10.59R with 14 %, -1.19R otherwise;
  spread 4.09R, 657 trades); two trial variances are reported: the variance of the per-trade Sharpe ratios of our
  configurations, and 1 / 656 (unskilled strategies of 657 trades).

Deviations from the design:

- Nautilus bars: Nautilus does not get every 1-minute bar (2.9 million bars per market, three engine bars each, per run).
  `rules.py` decides the trades on all 1-minute bars; `runner.py` feeds Nautilus the bars each trade needs (the bar before
  the entry to the exit bar) with the entry signal, the stop distance and the exit mark, so fills, stop orders, costs and
  equity come from Nautilus. The account is flat on the bars left out. A run stops when Nautilus and `rules.py` disagree
  on the trade count, a fill bar or a fill price; the largest difference in this run is 9.6e-05 R per trade.
- Legs: the engine holds one side per run, so the long and the short trades are booked in two Nautilus runs of 100,000 USD
  each and the daily returns are summed (one position at a time, so the legs never hold together). The engine keeps the
  entry cost inside the spend, so a position is a little under 0.5 % of equity at risk.
- Financing: no overnight financing cost (the source has none). A position is up to about 10x the equity
  (0.5 % risk over a 15-point stop).
- Random-entry control: computed by `rules.py` in R (500 runs), not booked in Nautilus. Random signal candles of the same
  session and weekdays, random direction, the same stop, time stop, entry limit and one-position rule; the real opposite
  signals close a position. No volume, breakout or trend test decides an entry.
- DSL form: the DSL needs `entryFrom` after the session open, so entries start at 09:45 (the close of the first 15-minute
  candle), not 09:30. `highest(5)` and `lowest(5)` read the high and the low. Sizing is `riskPct` 0.5. Bars: the 15-minute
  candles of the NAS100 CFD from 09:30 to 16:00.
- US2000: the Dukascopy full-session feed starts on 2019-03-20, so its window starts there. The other CFD files start on
  2018-01-01 or 2018-01-02 and end on 2026-11-06.
- ETF twins (changed after the first run, on review of form (b)): the Dukascopy ETF files of the market-intraday-momentum study
  are ETF-CFD candles with regular-hours tick volume only. The rule makes 3 (SPY), 5 (QQQ), 28 (DIA), 22 (IWM), 161 (GLD), 433
  (SLV), 64 (USO) trades on them since 2019, so they are no test of a volume rule; they are not result rows. The twins with IBKR
  history (SPY, QQQ and IWM) run on real exchange volume: IBKR 5-minute TRADES bars, regular hours, from
  `~/Documents/reports/vertex-reel-dffkn31-data/ibkr5m` (fetched by another job; this study only reads them, bars from
  2018-01-01 to the end of the window). The 15-minute signal candles and the 4-hour candles are built from the 5-minute bars;
  the session is 09:30 to 12:00. Fills and the stop are resolved on the 5-minute bars, not on 1-minute bars: a 5-minute bar that
  touches the stop is a stop. Stop: the same percent of price. Costs: the ETF Vertex model; the SPY spread is the median of the
  IBKR BID_ASK sample in the source's in-sample window, the others keep the Dukascopy ETF-CFD spread (no IBKR sample). DIA, GLD,
  SLV and USO are not testable on this data (no exchange-volume intraday history on the rig; DIA: IBKR history pending); their
  Dukascopy trade counts are information only. The ETF rows do not enter the gates, and the equal-weight ETF-twin comparison
  rows are dropped.
- Options form: the exit and the marks at the session closes are priced with the VXN close and T-bill rate of the session
  before their own day (no intraday IV exists); the entry row must be at most 5 calendar days old. A spread open at expiry
  settles at intrinsic value. The size bounds the maximum loss (debit plus costs), not the debit alone, at 2 % of equity.
- Options form, no look-ahead (fixed after the first run, on a reviewer finding): the spread "closes at the first regular
  QQQ minute at or after the exit of the rule". A stop touched inside a 1-minute bar is known only when that minute ends,
  so its spread closes at the open of the next minute; the first run priced it at the open of the stop minute, before the
  stop. An exit at a bar open (opposite signal, time stop, a stop gapped through) is known at that open. A rule trade whose
  exit is already known when its spread would open (for example stopped before 09:30) opens no spread; a trade stopped
  inside its entry minute does open one (the first run dropped those). Both c1 and c2 are rerun; Results shows the first
  run's numbers next to the fixed ones.
- Information rows added after the first run (no gate uses them; the trades are the same): "Vertex spread as fixed
  points" and "Vertex spread at the fill minutes" (the median quoted spread at the entry and exit minutes of the in-sample
  trades, plus 0.25 bp slippage per side), both booked in Nautilus, also doubled; and, on a reviewer finding, "stop fill
  half-way to the bar extreme" (every stop filled half-way from the modelled fill to the low or high of its 1-minute bar,
  `rules.py` arithmetic on an R curve). The gate texts show the information values next to the gate values.
- ETF stop fills (information rows added after a review finding): the IBKR ETF rows fill every stop exactly at its level
  on 5-minute bars, which is more optimistic than 1-minute fills. Each tested ETF therefore also has the row "stops filled
  half-way to the 5-minute bar extreme" (the same `rules.py` method as on NAS100; Sharpe from the same R curve as its
  exact-fill twin row). Without that row an ETF result is untested against fill optimism.
- Entry candle: the "next 15-minute open" is the open of the next existing candle, also after a gap in the data.
- Source costs with a percent stop: exactly 0.084R of the trade's own stop distance at entry (`rules.py` arithmetic).
- Comparisons: buy and hold of the same markets and windows only. The runner reads no other study file (AGENTS.md rule
  13), so library strategies are not in the comparison table.
- Memory: bars are held as float32 with int64 times; at most 4 worker processes; one market is loaded at a time.

Data findings (the rule was not changed because of them; numbers in Results):

- The intraday volume profile of the Dukascopy NAS100 feed changes in June and July 2026. No candle of the signal session
  passes the 3x volume test after 2026-07-14, so the rule has no trade from then to 2026-11-06 and the window after the
  dashboard date (2026-09-12 to 2026-11-06) is empty. The other CFD markets show no such break.
- The candles that pass the volume test are mostly the first candles of the cash session (09:30 to 10:15 New York): the
  50 candles before them (12.5 hours) are overnight and pre-market candles. The "volume spike" is mostly a time-of-day
  effect of tick volume.

## Code and tests

- `services/research/strategies/volspike/`: `data.py` (Dukascopy and IBKR bars), `rules.py` (the rule on the bars),
  `runner.py` (Nautilus booking), `definition.py` (parameters, sensitivity rows, DSL form), `options.py` (form c),
  `metrics.py` (R statistics, replication check, deflated Sharpe), `diagnostics.py` (volume and spread findings),
  `source.py` (rules and gaps as text), `study.py` (the study document and the report data), `__main__.py` (commands).
- Fetcher: `research/backtests/volspike/fetch_data.py`.
- Tests: `services/research/tests/test_volspike_study.py`, listed in `services/research/tests/ci-suites.txt` (skips as a
  whole without numpy) and `services/research/tests/ci-suites-nautilus.txt` (runs every test).
- Run: `cd services/research && python -m strategies.volspike study --ran <date> | bun run vertex:research-studies:import`.
  Report data: `python -m strategies.volspike report-data --ran <date> --out <folder outside the repository>`.

## Results

Run 2026-11-09 (run id `volspike-2026-11-09`, commit `3d9bae10`, NautilusTrader 1.227.0, data hash `sha256:08b56ab8…`, 4 minutes
on the rig with 4 workers). The study document (`study.json`) and the report data (`report-data.json`) are on the rig in
`~/Documents/reports/web/vertex-volume-spike/results/`. The study document is imported into `research_studies` at the deploy of
this change (`/library?id=strategy-seed-volume-spike-breakout&tab=backtests`). The provenance data hash covers the Dukascopy
`m1` files; each IBKR twin carries the sha256 of the bars it used (`sha256OfBarsUsed`) in the report data.

Verdict: **no edge** (1 of 5 gates pass on the NAS100 primary with Vertex costs; the claim is reproduced with the source's
costs; options form OOS Sharpe c1 -2.57, c2 -1.94). The label stays "externally pre-validated"; it is not "validated by Vertex".

| NAS100 as stated, Vertex costs | Trades | Win rate | Net R per trade | Total R | Max DD (R) | Sharpe | CAGR | Max DD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Source in-sample (2019-01-01 to 2026-03-11) | 689 | 14.8 % | +0.265 | +182.5 | 99.4 | 0.60 | 10.8 % | -40.2 % |
| Source out-of-sample (6 months) (2026-03-12 to 2026-09-11) | 61 | 8.2 % | +0.269 | +16.4 | 25.3 | 0.44 | 11.3 % | -20.4 % |
| After the dashboard date (2026-09-12 to 2026-11-06) | 0 | no trades | n/a | n/a | n/a | 0.00 | 0.0 % | 0.0 % |
| Full (2019-01-01 to 2026-11-06) | 750 | 14.3 % | +0.265 | +198.8 | 107.7 | 0.52 | 10.6 % | -45.7 % |
| Our in-sample, first 60 % (to 2023-09-15) | 378 | 19.8 % | +0.691 | +261.2 | 24.5 | 1.42 | 29.2 % | -13.2 % |
| Our out-of-sample, last 40 % (after 2023-09-15) | 372 | 8.6 % | -0.168 | -62.4 | 107.7 | -0.27 | -12.4 % | -45.1 % |

| NAS100 as stated, the source's costs | Trades | Win rate | Net R per trade | Total R | Max DD (R) | Sharpe | CAGR | Max DD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Source in-sample (2019-01-01 to 2026-03-11) | 689 | 14.8 % | +0.444 | +305.7 | 69.5 | 1.02 | 20.7 % | -29.1 % |
| Source out-of-sample (6 months) (2026-03-12 to 2026-09-11) | 61 | 8.2 % | +0.637 | +38.9 | 18.4 | 0.80 | 39.1 % | -18.8 % |
| After the dashboard date (2026-09-12 to 2026-11-06) | 0 | no trades | n/a | n/a | n/a | 0.00 | 0.0 % | 0.0 % |
| Full (2019-01-01 to 2026-11-06) | 750 | 14.3 % | +0.459 | +344.5 | 69.5 | 0.89 | 21.3 % | -29.1 % |
| Our in-sample, first 60 % (to 2023-09-15) | 378 | 19.8 % | +0.798 | +301.8 | 22.9 | 1.64 | 34.9 % | -12.0 % |
| Our out-of-sample, last 40 % (after 2023-09-15) | 372 | 8.6 % | +0.115 | +42.8 | 69.5 | 0.25 | 3.5 % | -29.1 % |

| Claim against ours (source in-sample window) | Source | Ours, source costs | Ours, Vertex costs | Check |
| --- | --- | --- | --- | --- |
| Trades (source in-sample window) | 657 | 689 | 689 | within tolerance |
| Win rate | 14.0 % | 14.8 % | 14.8 % | within tolerance |
| Average reward : risk | 8.88 | 8.47 | 7.14 | information |
| Net R per trade | +0.457R | +0.444R | +0.265R | within tolerance |
| Gross R per trade | +0.541R | +0.528R | +0.528R | information |
| Total net R | 300.0 | 305.7 | 182.5 | information |
| Max drawdown (R) | 71.0 | 69.5 | 99.4 | information |
| Losses in a row | 37 | 37 | 37 | information |
| Share of stop exits | 85.0 % | 84.8 % | 84.8 % | information |
| Net R per trade, longs | +0.636R | +0.579R | +0.402R | information |
| Net R per trade, shorts | +0.133R | +0.173R | -0.010R | information |
| Average hold (minutes) | 400.0 | 379.6 | 379.6 | information |
| Trades per week | 1.75 | 1.84 | 1.84 | information |
| OOS 6 months: net R per trade | +1.154R | +0.637R | +0.269R | information |
| OOS 6 months: trades | 59 | 61 | 61 | information |
| OOS 6 months: total net R | 68.1 | 38.9 | 16.4 | information |

The pre-registered check covers the trade count, the win rate and the net R per trade of the source's in-sample window with the
source's costs: reproduced. The other rows are information. The source's 6-month out-of-sample result (+1.154R per trade) is not
matched (+0.637R with the source's costs); ours has 61 trades and 5 winners in that window.

- Net R per trade by entry year (trades; gross / source costs / Vertex costs): 2019 (94) +0.23 / +0.14 / +0.10; 2020 (86) +0.94
  / +0.85 / +0.76; 2021 (93) +1.23 / +1.14 / +0.99; 2022 (35) +1.40 / +1.32 / +1.19; 2023 (94) +0.80 / +0.71 / +0.56; 2024 (114)
  -0.17 / -0.26 / -0.48; 2025 (140) +0.52 / +0.44 / +0.14; 2026 (94) +0.15 / +0.07 / -0.29. The 15-point stop is 0.20 % of the
  median close in 2019, 0.12 % of the median close in 2022, 0.05 % of the median close in 2026.
- Gates (NAS100, Vertex costs): Out-of-sample Sharpe (last 40 % of the time): OOS Sharpe -0.27 (in-sample 1.42); OOS CAGR
  -12.4%; information, not the gate: -0.13 with the spread as fixed points, 0.01 with the fill-minute spread (fail); Deflated
  Sharpe probability, N = 10,000 trials: 0.176 with N = 10,000 (the source's count), trial variance from our own configurations;
  information, not the gate: 0.185 with the spread as fixed points, 0.400 with the fill-minute spread (fail); Monte Carlo
  drawdown P5: P5 max drawdown -53.6% over 2000 trade bootstraps; loss share 10% (fail); Parameter changes with Sharpe > 0: 96%
  of 24 one-at-a-time changes keep Sharpe > 0 (pass); Doubled Vertex costs: Sharpe -0.01, CAGR -3.2% with doubled spread and
  slippage; information, not the gate: 0.01 with the spread as fixed points, 0.42 with the fill-minute spread (fail).
- Deflated Sharpe probability of our result: 0.576 over our own 38 configurations, 0.176 with N = 10,000 and 0.174 with N =
  10,500 (per-day Sharpe 0.0322, expected best of 10,000 unskilled trials 0.0506). With the source's costs and N = 10,000:
  0.602. The source's claimed result (per-trade Sharpe 0.112, t = 2.87): 0.625 with N = 10,000 and the trial variance of our
  configurations (0.621 with N = 10,500); 0.130 with the variance of unskilled 657-trade strategies (0.127 with N = 10,500).
- Costs (full window): Vertex costs 0.230R a round trip at the median close: +0.265R per trade, +199R, Sharpe 0.52 (OOS -0.27);
  source costs 0.084R a round trip at the median close: +0.459R per trade, +345R, Sharpe 0.89 (OOS 0.25); doubled Vertex costs
  0.459R a round trip at the median close: -0.013R per trade, -10R, Sharpe -0.01 (OOS -0.94).

| Cost reading (only the first is a gate) | Round trip | Net R | Sharpe | OOS Sharpe | Deflated, N = 10,000 | Sharpe, 2x |
| --- | --- | --- | --- | --- | --- | --- |
| Vertex costs (the gates): all-minutes spread, basis points | 0.230R | +0.265 | 0.52 | -0.27 | 0.176 | -0.01 |
| Vertex spread as fixed points (all-minutes median) | 0.262R | +0.271 | 0.53 | -0.13 | 0.185 | 0.01 |
| Vertex spread at the fill minutes | 0.135R | +0.379 | 0.74 | 0.01 | 0.400 | 0.42 |
| Source costs | 0.084R | +0.459 | 0.89 | 0.25 | 0.602 | n/a |

- Round trips are in R at the median in-sample close. The quoted NAS100 spread per year (median of all minutes, points): 2018
  3.06, 2019 3.07, 2020 3.39, 2021 3.41, 2022 3.41, 2023 3.41, 2024 3.42, 2025 1.51, 2026 1.17. With every information row the
  out-of-sample Sharpe stays under 0.5 and the deflated Sharpe probability under 0.5: the verdict does not depend on the spread
  reading.
- Stop fills (information only, `rules.py` arithmetic, added on a reviewer finding): with every stop filled half-way from the
  modelled fill to the extreme of its 1-minute bar (640 stops, 0.215R more loss per stop on average) the rule makes +0.081R per
  trade with Vertex costs (+0.276R with the source's costs), Sharpe 0.16 (OOS -0.91); the same arithmetic on the modelled fills
  gives Sharpe 0.54 (Nautilus: 0.52).
- Sensitivity: 23 of 24 one-at-a-time changes keep Sharpe > 0 (best sides long only 0.77, worst stop 10 points -0.03).
  Walk-forward (3 years train, 1 year test, 18 grid points): stitched Sharpe 0.38 against 0.14 for the stated rule on the same
  years. Monte Carlo (2000 trade bootstraps): P5 max drawdown -53.6 %, P50 -34.4 %, P5 final return -17.7 %, loss share 10 %.
- Random-entry control (500 runs, 750 entries each, 0 runs short of that): random entries with the same stop and exits are
  positive on NAS100 before Vertex costs: mean R per trade +0.142 gross, +0.058 with the source's costs (P95 +0.338; 62 % of the
  runs make money), -0.121 with Vertex costs (P5 -0.394, P95 +0.156). The rule makes +0.543 gross, +0.459 and +0.265; 1.4 % of
  the control runs are at or above it with Vertex costs and 1.4 % with the source's costs.
- Form (a), the other source markets (percent stop, Vertex costs): US500 1027 trades, -0.011R per trade (source costs +0.071R),
  Sharpe -0.03; US30 1156 trades, -0.137R per trade (source costs -0.068R), Sharpe -0.52; US2000 1177 trades, -0.291R per trade
  (source costs -0.159R), Sharpe -0.93; XAUUSD 389 trades, +0.318R per trade (source costs +0.453R), Sharpe 0.54; WTI 865
  trades, -0.654R per trade (source costs -0.019R), Sharpe -1.34.
- Form (b), the rest of the Core 7 proxies: NAS100 733 trades, +0.214R per trade (source costs +0.360R), Sharpe 0.49; XAGUSD 699
  trades, -0.928R per trade (source costs +0.199R), Sharpe -1.66.

| ETF twin, IBKR 5-minute bars | Trades | Win rate | Net R, Vertex | Net R, source | Total R | Max DD (R) | Sharpe | OOS Sharpe |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPY (2019-01-02 to 2026-11-06) | 74 | 13.5 % | +0.696 | +0.727 | +51.5 | 32.6 | 0.38 | 1.07 |
| QQQ (2019-01-02 to 2026-11-06) | 200 | 11.0 % | +0.272 | +0.353 | +54.4 | 63.8 | 0.28 | 0.36 |
| IWM (2019-01-02 to 2026-11-06) | 210 | 5.7 % | +0.306 | +0.450 | +64.3 | 43.0 | 0.22 | 0.51 |

| ETF twin, stop fill (same-method R curve) | Net R, Vertex | Net R, source | Total R | Sharpe | OOS Sharpe |
| --- | --- | --- | --- | --- | --- |
| SPY, stops exactly at the level (as booked) | +0.696 | +0.727 | +51.5 | 0.34 | 0.77 |
| SPY, stops half-way to the 5-minute bar extreme | +0.238 | +0.269 | +17.6 | 0.11 | 0.48 |
| QQQ, stops exactly at the level (as booked) | +0.272 | +0.353 | +54.4 | 0.27 | 0.33 |
| QQQ, stops half-way to the 5-minute bar extreme | -0.214 | -0.134 | -42.9 | -0.20 | -0.17 |
| IWM, stops exactly at the level (as booked) | +0.306 | +0.450 | +64.3 | 0.21 | 0.45 |
| IWM, stops half-way to the 5-minute bar extreme | -0.375 | -0.232 | -78.8 | -0.25 | 0.06 |

- ETF stop fills (information rows, added after a review finding): the booked ETF rows fill every stop exactly at its level on
  5-minute bars, which is more optimistic than the 1-minute NAS100 case; without the half-way rows they are untested against
  fill optimism. The half-way rows fill every stop half-way from the modelled fill to the low or high of its 5-minute bar
  (`rules.py` arithmetic; both rows of a pair use the same R curve, so the Sharpe ratios are same-method numbers; the Nautilus
  Sharpe of the booked rows is in the table above). Mean extra loss per stop: SPY 0.538R (63 stops), QQQ 0.547R (178 stops), IWM
  0.723R (198 stops).
- ETF twins, method: 15-minute signal candles and 4-hour candles built from IBKR 5-minute TRADES bars (regular hours, bars from
  2018-01-01, results from 2019-01-01); session 09:30 to 12:00; fills and the stop on the 5-minute bars; stop 0.1073% of price;
  Vertex ETF costs (spread: SPY 0.29 bp, IBKR BID_ASK sample, source in-sample window; QQQ 0.76 bp, Dukascopy ETF-CFD quotes,
  source in-sample window; IWM 1.23 bp, Dukascopy ETF-CFD quotes, source in-sample window; 0.25 bp slippage per side; IBKR Pro
  Fixed commissions and fees), a round trip is 0.11R on SPY, 0.16R on QQQ, 0.23R on IWM. These rows do not enter the gates.
- Not testable on this data (no exchange-volume intraday history on the rig; the Dukascopy ETF-CFD files have regular-hours tick
  volume only): DIA (IBKR 5-minute history pending), GLD, SLV, USO. Trades of the rule on the Dukascopy ETF-CFD tick volume
  since 2019, as information only (not results): SPY 3, QQQ 5, DIA 28, IWM 22, GLD 161, SLV 433, USO 64.
- SPY on exchange volume: session candles that pass the 3x volume test per year: 2018 21, 2019 57, 2020 29, 2021 36, 2022 18,
  2023 7, 2024 26, 2025 43, 2026 32; by open time (source in-sample window): 09:30 61 %, 10:00 13 %, 09:45 8 %, 10:15 4 %.
- QQQ on exchange volume: session candles that pass the 3x volume test per year: 2018 87, 2019 126, 2020 81, 2021 112, 2022 50,
  2023 49, 2024 80, 2025 84, 2026 90; by open time (source in-sample window): 09:30 69 %, 10:00 10 %, 09:45 9 %, 10:30 3 %.
- IWM on exchange volume: session candles that pass the 3x volume test per year: 2018 42, 2019 76, 2020 72, 2021 102, 2022 88,
  2023 101, 2024 98, 2025 91, 2026 98; by open time (source in-sample window): 09:30 73 %, 09:45 10 %, 10:00 8 %, 10:15 3 %.
- Form (c), QQQ debit verticals on the NAS100 signals (2 % max loss): c1: 691 spreads of 750 signals (skipped: 59 closed before
  the open), Sharpe -1.12, OOS -2.57, CAGR -4.8 %, max drawdown -33.3 %, win rate 15 %, ledger against Nautilus max gap 0.00
  USD; c2: 628 spreads of 634 signals (skipped: 1 stale IV at the exit, 2 closed before the open), Sharpe -1.44, OOS -1.94, CAGR
  -9.5 %, max drawdown -56.3 %, win rate 37 %, ledger against Nautilus max gap 0.00 USD. Before the look-ahead fix (a stop
  inside a minute closed the spread at that minute's open, and a stop in the entry minute opened no spread) the first run showed
  c1 593 spreads, Sharpe 0.06, OOS -0.68 and c2 628 spreads, Sharpe -1.44, OOS -1.94.
- DSL form (15-minute regular-session candles, 58,445 bars): 0 trades in the window (7 before it, all in 2018-03). `rvol(50) >=
  3` (session volume up to the bar against the same time on the 50 sessions before) and a 5-bar breakout between 09:45 and 12:00
  never happen together from 2019 on, so this form has no result.
- Buy and hold of the NAS100 CFD in the same window: Sharpe 0.90, CAGR 20.3 %, max drawdown -35.5 %; QQQ: Sharpe 0.89, CAGR 20.3
  %.
- Data finding, volume regime: the last NAS100 candle of the signal session that passes the 3x volume test is on 2026-07-14;
  none of the 83 trading days after it to 2026-11-06 has one, so the rule has no trade after it and the window after the
  dashboard date is empty. The intraday volume profile of the Dukascopy NAS100 feed changes in June and July 2026: the median
  15-minute volume from 09:30 to 10:00 over the overnight median (20:00 to 04:00) is 10.5 in 2026-04, 8.4 in 2026-05, 3.6 in
  2026-06, 2.0 in 2026-07, 2.0 in 2026-08, 1.8 in 2026-09, 1.7 in 2026-10, 1.8 in 2026-11; candles of the signal session that
  pass the test per month: 199 (04), 151 (05), 98 (06), 26 (07), 0 (08), 0 (09), 0 (10), 0 (11). The other CFD markets show no
  such break (last candle that passes: US500 2026-11-06, US30 2026-11-05, US2000 2026-11-05, XAUUSD 2026-10-29, XAGUSD
  2026-10-30, WTI 2026-11-06). The rule was not changed.
- Data finding, time of day: in the source's in-sample window the session candles that pass the volume test open at 08:15 1 %,
  08:30 4 %, 08:45 2 %, 09:00 2 %, 09:15 2 %, 09:30 23 %, 09:45 19 %, 10:00 16 %, 10:15 11 %, 10:30 8 %, 10:45 5 %, 11:00 3 %,
  11:15 1 %, 11:30 1 %, 11:45 1 %. 70 % open from 09:30 to 10:15 and 4 % at 08:30. The 09:30 candle passes the test on 79 % of
  its days: the "volume spike" is mostly the jump in tick volume at the cash open against the overnight and pre-market candles
  in the 50-candle mean.
- Measured NAS100 spread (source in-sample window): all 1-minute bars 1.96 bp (3.23 points; the Vertex cost), signal session
  1.17 bp (1.46 points), fill minutes 0.95 bp (1.43 points; information only).
- Data (Dukascopy 1-minute mid bars on the timestamps both sides have): NAS100 2,991,582 bars 2018-01-02 to 2026-11-06; US500
  2,896,242 bars 2018-01-02 to 2026-11-06; US30 2,989,883 bars 2018-01-02 to 2026-11-06; US2000 2,586,429 bars 2019-03-20 to
  2026-11-06; XAUUSD 3,137,441 bars 2018-01-01 to 2026-11-06; XAGUSD 3,088,975 bars 2018-01-01 to 2026-11-06; WTI 3,048,233 bars
  2018-01-01 to 2026-11-06. IBKR 5-minute bars used: SPY 172,902 bars 2018-01-02 to 2026-11-06; QQQ 172,837 bars 2018-01-02 to
  2026-11-06; IWM 172,902 bars 2018-01-02 to 2026-11-06.
- Booking check: 43 NAS100 runs, the same trades in Nautilus and `rules.py`, largest difference 9.6e-05 R per trade; Nautilus
  got 164,670 of 2,685,935 1-minute bars for the stated rule.
