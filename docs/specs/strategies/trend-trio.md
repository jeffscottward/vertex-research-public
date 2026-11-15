# Trend Trio (Technical Trading reel, Vertex reconstruction): pre-registered study

Status: research only. No live or paper orders. No broker changes. NautilusTrader stays disarmed. Rules, datasets,
variants and tests below were fixed on 2026-11-14 before the first full run (card `vertex-trend-trio`); the freeze is
the commit that first sets `SPEC_SHA256` in `services/research/strategies/trend_trio/rules.py`, which is the SHA-256 of
this file above the "Results" heading. `research/backtests/trend-trio/run.py` refuses to run when that part changes.

Label: **rules guessed**. The source sells its rules behind a paywall; Vertex did not buy or copy them. Every result here
is about "Trend Trio (Vertex reconstruction, rules guessed)". A failure does not disprove the source's own rules; a pass
does not confirm them. Design and reasons: [trend-trio-design.md](trend-trio-design.md).

## Source

- Instagram reel <https://www.instagram.com/reel/DfuMtdWKDB7/> by Technical Trading, 2026-11-14, 60 s, sent by the owner on
  2026-11-14 (<https://discord.com/channels/1511468532876185770/1559295973912477737/1571329416657633432>).
- The reel names SuperTrend, Ultimate MA and AlphaTrend, plus Slingshot as a filter and Chandelier Exit to exit. The
  full Pine code and the test report are on the author's Patreon (paid; not used).

## Claims of the source (untrusted)

| Claim | Text |
| --- | --- |
| Years | "made money in every one of the last 16 years" |
| Last year | "over $100,000 in the last 12 months ... on one Nasdaq futures contract, after fees" |
| Setting | 1 NQ contract, fees included, no slippage |
| Timeframes | trades on the 1-minute chart; signals from higher timeframes (5-minute shown) |
| SuperTrend | flipped 23 times in one session on 1-minute, 5 times on 5-minute |

## Indicators (public definitions)

Re-implemented from the formulas; no source code copied. Code: `services/research/indicators/trend.py` and
`packages/shared/src/indicators/trend.ts`, checked against `services/research/tests/fixtures/trend-indicator-reference.json`.

| Indicator | Source | Default |
| --- | --- | --- |
| SuperTrend | TradingView built-in `ta.supertrend`, <https://www.tradingview.com/pine-script-reference/v6/#fun_ta.supertrend> | ATR 10, factor 3, hl2 |
| Ultimate MA | ChrisMoody, CM_Ultimate_MA_MTF_V2, <https://www.tradingview.com/script/8KVcQiJM-CM-Ultimate-MA-MTF-V2/> | SMA 20, rising = value >= value 2 bars ago |
| AlphaTrend | KivancOzbilgic, <https://www.tradingview.com/script/o50NYLAZ-AlphaTrend/> (MPL-2.0) | 14, coefficient 1, MFI of hlc3 |
| Chandelier Exit | Chuck LeBeau; everget, <https://www.tradingview.com/script/AqXxNS7j-Chandelier-Exit-everget/> (GPL-3.0, formula only) | ATR 22 x 3 from the highest high / lowest low |
| Slingshot | ChrisMoody, CM Sling Shot System, <https://www.tradingview.com/script/GE7tSQK1-CM-Sling-Shot-System/> | EMA 38 against EMA 62 |

## Classification

Basis key: **V** = stated by the reel; **KB Qn** = knowledge-base decision record question n
(`~/Documents/reports/web/vertex-trend-trio/kb-consult/decision-record.md` on the rig, 2026-11-14); **A** = Vertex
assumption with no source.

## Rules (frozen 2026-11-14)

| # | Rule | Basis |
| --- | --- | --- |
| 1 | Signal buckets of 5 minutes (P1); 15 minutes is row P2. Buckets start at 09:30 New York. | V |
| 2 | An execution bar that closes at time T reads the newest bucket that ends at or before T. | A (TradingView `lookahead_off`) |
| 3 | Long alignment at a bucket close: SuperTrend, Ultimate MA and AlphaTrend directions +1 and Slingshot +1. Short: all -1. | V + KB Q4 |
| 4 | An alignment episode starts at a bucket close where the alignment holds and did not hold at the previous bucket close, or at the first bucket close of a session; it lasts while the alignment holds at each bucket close. | KB Q4 |
| 5 | Entry: within an episode, at the first execution-bar close (from the episode's first bucket close on) where the Chandelier Exit direction on the execution bars agrees with the side; fill at the next open; one entry per episode; decisions from 09:35 to 15:50 New York (to 10 minutes before an early close). | KB Q4 + A |
| 6 | Exit: at the first execution-bar close where the Chandelier Exit direction is against the position, fill at the next open; an opposite entry closes and reverses at the same open; else market on close at the last regular bar. One position at a time. | V + KB Q2, Q5 |
| 7 | Parameters: published defaults (table above). | KB Q6 |
| 8 | 1 NQ = $20 per index point; tick 0.25 point = $5; fees $4.50 per round trip; slippage 0, 1 and 2 ticks per side on every fill. | KB Q3 (QuantStackAI raw file `ig-DfbYUD6xSin.md`) |

## Datasets

| Id | Data | Execution bars | Fill price | Role |
| --- | --- | --- | --- | --- |
| (a) | Dukascopy `usatechidxusd` 1-minute bid and ask, regular session, 2013-01-02 to 2026-11-06 | 1 minute | mid; P&L points = price change | graded, execution primary |
| (b) | IBKR QQQ 5-minute trades, regular session, 2004-12-01 to 2026-11-06 | 5 minutes; signals on 15-minute buckets; Chandelier on 5-minute bars | QQQ; points = scale x change, scale = NDX close / QQQ close of the latest earlier date both have (Yahoo) | graded, long history |
| (c) | NQ futures 5-minute, 2024-08-28 to 2025-09-19, front month by prior-session volume | as (b) | NQ | tracking check, reported |

Why not IBKR NQ: IBKR keeps expired futures history only for a short time and `vertex-history` cannot fetch expired
contracts, so Vertex has no NQ 1-minute history; the Dukascopy index CFD is used under the data policy exception
(`docs/vertex-rebuild/data-sources/intraday.md`: Dukascopy only when IBKR has no history for the market). Session filter as
`strategies/imom/data.py`: closed days skipped, early closes at 13:00, sessions with fewer than 150 minutes of bars dropped
and counted. The CFD spread is never charged (reported as a diagnostic).

## Variants (N = 33)

| Row | Dataset | Change from P1 |
| --- | --- | --- |
| P1 | (a) | none |
| P2 | (a) | 15-minute signal buckets |
| P3 | (b) | "(b) 15/5": 15-minute buckets on 5-minute execution bars |
| V1 | (a) | re-entry: several entries per episode (the DSL form) |
| V2 | (a) | event entry: an episode counts only when one trio indicator flipped into the side while the other two already agreed and the filter allowed at both bucket closes |
| V3 | (a) | also exit at a bucket close where any trio indicator is against the position |
| V4 | (a) | Chandelier Exit on the signal buckets (entries and exits at bucket closes) |
| V5 | (a) | AlphaTrend momentum RSI |
| V6 | (a) | no Slingshot filter |
| V7 | (a) | two of the trio agree with the side and none is against it |
| V8 | (a) | indicators on full-session 1-minute bars (trading unchanged); still counted if it cannot run |
| S1-S22 | (a) | one parameter at a time: SuperTrend length 7 / 14, factor 2.1 / 4.2; Ultimate MA length 14 / 28, smoothing 1 / 3; AlphaTrend length 10 / 20, coefficient 0.7 / 1.4; Chandelier length 15 / 31, multiple 2.1 / 4.2; Slingshot fast 27 / 53, slow 43 / 87; entry end 15:40 / 15:55 |

Diagnostics outside N and outside the tests: look-ahead (each bar reads the full bucket that contains it), random-entry
control, bridge ("(b) 15/5" rules on dataset (a) aggregated to 5 minutes).

## Pass/fail rule (fixed 2026-11-14, before the first full run)

All at 1 tick per side on P1 unless stated. "Reconstruction passed" when T1-T7 all pass; otherwise "reconstruction
failed", and the first failing test decides.

| Test | Pass when |
| --- | --- |
| T1 | Net P&L > 0 over 2013-01-02 to 2026-11-06, and over the stitched walk-forward test years 2016-2025 (anchored; training years pick the (a) row with the highest net P&L at 1 tick) |
| T2 | Day-block bootstrap 95% interval of the mean net P&L per session (sessions without a trade count 0) above 0; 10,000 resamples, seed 7 |
| T3 | At least 75% of full calendar years profitable on P1 (2013-2025) and on P3 (2005-2025); the reel's window 2010-2025 is reported for P3 |
| T4 | Deflated Sharpe probability > 0.95 (Bailey and Lopez de Prado 2014): per-session net P&L, raw N = 33, variance of the per-session Sharpes of the rows that ran, skew and kurtosis of P1 |
| T5 | Average gross P&L per trade >= $80 per contract (master rule `matteo-conti:risk:2`) |
| T6 | Net P&L > 0 at 2 ticks per side |
| T7 | Mean net P&L per trade above the 95th percentile of 1,000 random-entry draws (same minute of day, same side, same holding minutes, other session; seed 7) |

## DSL definition

The DSL form (PR 2, `services/research/strategies/trend_trio/dsl.py`) enters whenever the book is flat and the
alignment and the Chandelier agree, so it equals row V1, not P1. Entry `all`: `supertrend` direction > 0, `sma(20)` >=
`sma(20, offset 2)`, `alphaTrend` direction > 0, `ema(38)` > `ema(62)` (all `timeframe "5m"`), `chandelierExit` direction > 0
(execution bars); exit `any`: `chandelierExit` direction < 0; intraday block 09:30-16:00, market on close. A short twin
mirrors it.

## Options form

Decision record Q8: no translation unless the futures test passes. If it fails, the report gives the average move per
trade in QQQ terms next to the cost of crossing a 0-1 DTE QQQ option spread twice.

## Code and tests

- Indicators: `services/research/indicators/trend.py`, `services/research/tests/test_trend_indicators.py`.
- Rules: `services/research/strategies/trend_trio/rules.py`, `services/research/tests/test_trend_trio_rules.py` (timeline
  table, future-data test).
- Study: `services/research/strategies/trend_trio/study.py`, `document.py`, `report.py`, `research/backtests/trend-trio/run.py`.

## Results

Run 2026-11-14 on the rig, commit `5f2a2721` (results identical to the first run on the pre-rebase commit), spec SHA-256 `35b52eec`, 286 s with 8 workers. Report:
`~/Documents/reports/web/vertex-trend-trio/index.html` (tailnet:
<https://omarchy-rig.roadrunner-gopher.ts.net/reports/vertex-trend-trio/>); full numbers in `run/results.json` next to it.

### Verdict

**Reconstruction failed.** T1 decides (P1 loses money); T2-T7 also fail. The reel's "16 of 16 years" does not reproduce
with these public indicators and these guessed rules. A look-ahead mistake (diagnostic below) does reproduce "every year
profitable"; the honest rules do not.

| Test | Value | Result |
| --- | --- | --- |
| T1 | P1 net -$108,564 (2013-2026); walk-forward test years 2016-2025 +$98,953 | fail |
| T2 | 95% interval of mean P&L per session [-$70.85, +$7.63] | fail |
| T3 | P1 6/13 full years profitable; P3 8/21 | fail |
| T4 | deflated Sharpe probability 0.001 (N = 33) | fail |
| T5 | average gross per trade $4.14 on 10,480 trades | fail |
| T6 | P1 net at 2 ticks -$213,364 | fail |
| T7 | P1 mean net per trade -$10.36 vs random-entry 95th percentile -$2.19 | fail |

### Claim vs reconstruction (full calendar years profitable)

| Row | Fees only (reel setting) | 1 tick per side |
| --- | --- | --- |
| P1, (a) CFD 1-minute, 2013-2025 | 7/13 | 6/13 |
| P3, (b) QQQ 15/5, 2005-2025 | 11/21 | 8/21 |
| P3 in the reel's window 2010-2025 | 10/16 | 7/16 |
| Look-ahead diagnostic, (a), 2013-2025 | 13/13 | 11/13 |
| Reel claim | 16/16 | not stated |

### Per year (P1, dataset (a), net dollars on 1 NQ)

| Year | Fees only | 1 tick | Year | Fees only | 1 tick |
| --- | --- | --- | --- | --- | --- |
| 2013 | -1,180 | -6,140 | 2020 | -7,604 | -16,024 |
| 2014 | -4,264 | -11,624 | 2021 | 25,002 | 17,092 |
| 2015 | 3,417 | -4,363 | 2022 | 13,013 | 5,283 |
| 2016 | 8,040 | 580 | 2023 | 7,988 | 88 |
| 2017 | -4,017 | -11,637 | 2024 | -31,332 | -39,492 |
| 2018 | 12,256 | 4,336 | 2025 | -11,805 | -19,425 |
| 2019 | 11,313 | 3,773 | 2026 (to 11-06) | -24,590 | -31,010 |

P1 totals: 10,480 trades (about 3 a day), gross +$43,396, fees $47,160, net -$3,764 fees only, -$108,564 at 1 tick,
-$213,364 at 2 ticks; win rate 33.9%; max drawdown $117,244 at 1 tick; in the market 19.8% of regular-session minutes.

### Variants and walk-forward

- P2 (15-minute buckets): -$97,609 at 1 tick. P3 ((b) QQQ 15/5, 2004-12 to 2026-11): +$127,841 at 1 tick (+$67,591 at 2
  ticks, max drawdown $36,969, 6,025 trades, $21.22 net per trade) but only 8 of 21 full years profitable; most of the gain is
  2022, 2024 and 2026.
- The slower exit helps: V4 (Chandelier on the signal buckets) +$114,458 at 1 tick on (a); every other (a) row loses at 1 tick
  (best: S16, Chandelier multiple 4.2, -$8,719).
- V7 gives the same trades as P1: each trio direction is +1 or -1, so "two agree and none against" means all three agree. It
  still counts in N.
- Walk-forward picks V4 in every test year; stitched 2016-2025 +$98,953, with 2025 at -$73,001.

### Diagnostics (outside N)

- Look-ahead (reads the forming 5-minute bucket): +$581,964 fees only, profitable in all 13 full years and in 2026; +$476,914 at
  1 tick. A higher-timeframe request with look-ahead is enough to produce a reel-like record.
- NautilusTrader booked P1, P2 and P3 with the same entry and exit bars and fill prices as the rule module (10,480, 4,608 and
  6,025 trades).
- NQ tracking (2024-08-29 to 2025-09-19, 246 sessions): P3 rules on real NQ vs on QQQ per session, correlation 0.95; vs CFD
  P1, 0.34.
- AlphaTrend MFI state, CFD tick volume vs NQ volume: 90.7% agree.
- Bridge ("(b) 15/5" rules on (a) at 5 minutes): +$137,854 at 1 tick, close to P3, so the 1-minute execution with the
  1-minute Chandelier, not the data source, makes P1 lose.
- Data: (a) 3,409 sessions (5 dropped), 697 five-minute buckets with missing minutes; (b) 5,513 sessions (6 incomplete
  sessions skipped by the shared loader); V8 full-session bars ran (165 months). CFD median spread 1.23 points, never charged.

### Options form

Not translated (decision record Q8). P1's average gross move is $4.14 per NQ per trade = 0.21 index points = about $0.005 per
QQQ share; a 0-1 DTE at-the-money QQQ option (delta about 0.5) would gain about $0.25 per contract, while QQQ options trade
in $0.01 steps, so entering and leaving costs at least $1.00 per contract before time decay.
