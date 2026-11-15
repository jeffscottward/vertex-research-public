# Trend Trio: five public trend indicators and a test of the "16 of 16 years" claim

- **Author:** Jeff Scott Ward (written by the agent of card `vertex-trend-trio`)
- **Status:** Approved (EGM review 2026-11-14, resolved by auto accept; report in the card's report folder)
- **Date:** 2026-11-14

--------------------------------------------------------------------------------

## Overview

A public video (Technical Trading, Instagram reel <https://www.instagram.com/reel/DfuMtdWKDB7/>, 2026-11-14) claims that three free TradingView trend indicators, SuperTrend, "Ultimate MA" and AlphaTrend, with a "Slingshot" trend filter and a Chandelier Exit, made money on 1 NQ futures contract in each of the last 16 years, fees included and no slippage. Signals come from 5-minute bars; trades run on 1-minute bars. The exact rules are sold behind a paywall and are not bought or copied.

This design adds the five indicators to Vertex, rebuilt from their public formulas, and tests a reconstruction of the strategy, named "Trend Trio (Vertex reconstruction, rules guessed)", on the intraday data that Vertex has. It has three parts in two pull requests:

1. **Indicators** (PR 1): one TypeScript and one Python implementation, one shared table of reference values, chart menu entries, script templates, two script built-ins and five agent vocabulary terms.
2. **Study** (PR 1): a rule module that builds 5- and 15-minute bars from 1-minute bars, applies rules frozen before the first full run, books trades in a dollar ledger and in NautilusTrader, and grades the result with tests fixed in advance. Results go to the Strategy Library (Postgres) and a dark HTML report.
3. **DSL** (PR 2): intraday indicator timeframes (`"5m"`, `"15m"`) and three stateful DSL indicators, with a test that the DSL form of Trend Trio picks the same bars as the matching rule-module row.

Research only. Nothing here places, arms or sizes an order.

**Scope source.** The owner's request of 2026-11-14 (Discord message <https://discord.com/channels/1511468532876185770/1559295973912477737/1571329416657633432>, card `vertex-trend-trio`, task file `~/Documents/reports/web/firstmate/vertex-trend-trio-task.md` on the rig) asks for all five indicators in the TA library with tests and source citations, the Ultimate MA "public type options", the indicator picker, templates and agent terms, the strategy "in the DSL", a NautilusTrader backtest with per-year results, slippage, walk-forward, parameter sensitivity and deflated Sharpe, the options form, a Strategy Library entry and a report. These items do not depend on the outcome of the study.

## Glossary

- **The trio**: the three voting indicators, SuperTrend, Ultimate MA and AlphaTrend. **Filter**: Slingshot. **Exit**: Chandelier Exit.
- **Bucket**: a 5- or 15-minute bar built from 1-minute bars.
- **Rig**: `omarchy-rig`, the research workstation where the data files live and the backtests run (never the trading server, QuantVPS).
- **Decision record**: `~/Documents/reports/web/vertex-trend-trio/kb-consult/decision-record.md` on the rig. The owner's rule of 2026-11-14 sends trading research method questions to internal knowledge bases (KB): collections of public trading material, each with a question-answering agent. The record lists the eight questions (Q1 data, Q2 session, Q3 costs, Q4 entry, Q5 exit, Q6 parameters, Q7 pass/fail, Q8 options form), each answer with its sources, and the decision.
- **Intraday block**: the existing `intraday` object of a DSL definition (`StrategyIntradaySchema` in `packages/api/src/strategy-dsl.ts`: session open and close in New York time, decision and exit grids, market on close).
- **ETH / full session**: the CFD's extended trading hours (about 23 hours a day), against the regular session 09:30-16:00 New York.

## The Problem

The owner wants the indicators available in Vertex and wants to know whether the claim holds. Three facts make this hard:

- **Rules unknown.** Every parameter and the entry and exit logic are guesses. A failed test does not disprove the paywalled version; a pass does not confirm it.
- **Data.** Vertex has no long real NQ 1-minute history. It has a Nasdaq-100 CFD in 1-minute bid/ask bars (2013-01 to 2026-11), QQQ 5-minute bars (2004-12 to 2026-11) and real NQ 5-minute bars (2024-08 to 2025-09).
- **Platform.** The DSL knows only a daily indicator timeframe; the chart, the DSL and the script engine use different warm-up conventions; the study document has no per-year or dollar field.

## Goals

- **G-IND**: five indicators (SuperTrend, Ultimate MA with its eight types, AlphaTrend, Chandelier Exit, Slingshot) in Python and TypeScript. The three independent engines (Python module, TypeScript module, script interpreter) match one shared reference table within an absolute 1e-9. The chart studies and the TypeScript DSL use the TypeScript module; the Python DSL uses the Python module.
- **G-SURF**: the indicators appear in the chart indicator menu, the script templates (with `ta.supertrend` and `ta.mfi` built-ins), the agent vocabulary (semantic terms with source `none`) and the strategy builder labels.
- **G-STUDY**: the reconstruction runs on dataset (a) CFD 1-minute (2013-2026) and (b) QQQ 5-minute scaled to NQ (2005-2026), with three cost levels, per-year dollars for every year, max drawdown, trades, time in market, walk-forward, sensitivity, deflated Sharpe over every variant and a random-entry control; graded by tests T1-T7 fixed before the first full run.
- **G-NOLOOK**: a test checks that no signal at time T changes when bars after T change, and the bucket timeline table below holds in the study and in both DSL engines.
- **G-LIB**: one Strategy Library row and one study document in Postgres, status `backtested`, tags `research-only`, `backtest-study`, `futures`, `reconstruction` (and `failed` if the reconstruction fails).
- **G-DSL**: DSL intraday timeframes and three stateful indicators; the DSL Trend Trio definition gives the same entries and exits as variant V1 on the synthetic multi-session fixture; stored definitions keep their revision hashes.
- **G-REPORT**: `~/Documents/reports/web/vertex-trend-trio/index.html` (dark): indicators, claim against the reconstruction with per-year bars, with and without slippage, verdict.

## Non-Goals

- Buying, copying or reverse-engineering the paywalled Pine code.
- Any order, arming, risk or deployment path. Trend Trio is not added to `STRATEGY_TEMPLATES`.
- Futures accounting (point value, ticks, contracts) in the shared engine or the shared cost model.
- Multi-timeframe `request.security` in the script language.
- Enabling the new DSL vocabulary on server run paths (autopilot, backtest runs, engine comparisons); a later card does that after the rig worker ships.
- An options backtest while the futures test fails.
- Changing the warm-up convention of the existing chart (TA-Lib) or DSL indicators.

## Open Questions

- **Q-ETH**: the full-session CFD fetch (Dukascopy `usatechidxusd`, 2013-2026, running on the rig) may miss months. Variant V8 runs only if it completes; V8 counts in N either way.

## Critical User Journeys (CUJs)

### CUJ 1: Owner reads the verdict (G-REPORT, G-LIB)

- **Given**: the study ran on the rig and the library row is deployed.
- **When**: the owner opens the report link or the Strategy Library entry.
- **Then**: the report header shows the claim (16 of 16 years) next to the reconstruction's year count for datasets (a) and (b), per-year bars with fees only and with 1-tick slippage, the outcome ("reconstruction passed" or "reconstruction failed") with the first failing test, and the sentence "rules guessed; this tests a reconstruction". The library entry shows the same outcome and the per-year net dollars in its description. No arm or order control exists on either page.

### CUJ 2: Analyst adds SuperTrend to a chart (G-SURF)

- **Given**: a QQQ chart in the portal.
- **When**: the analyst picks "SuperTrend 10, 3" from the indicator menu.
- **Then**: the up and down lines appear over the candles, with values equal to the TypeScript module on the same bars.

### CUJ 3: Agent writes a script with SuperTrend (G-SURF)

- **Given**: the assistant's `chart_script` tool.
- **When**: the agent writes `[st, dir] = ta.supertrend(3, 10)`.
- **Then**: the script compiles and plots; `dir` uses Pine's sign (-1 up, +1 down), as on TradingView; today the script fails with "not supported in Vertex scripts yet".

### CUJ 4: Strategy author uses a 5-minute SuperTrend in the DSL (G-DSL)

- **Given**: a 1-minute run with an intraday block.
- **When**: the definition reads `{"type":"indicator","name":"supertrend","length":10,"multiple":3,"output":"direction","timeframe":"5m"}`.
- **Then**: each 1-minute bar reads the newest 5-minute bucket that ended at or before its close; both engines give the same values; a server path without the capability refuses the definition with `STRATEGY_INTRADAY_INDICATORS_UNSUPPORTED: intraday indicator timeframes (5m, 15m) and the supertrend, alphaTrend and chandelierExit indicators run only in research runs on the rig for now.`

## Technical Plan (Architecture)

### Indicator definitions (TradingView Pine Script v6 conventions)

Pine v5 and v6 define these built-ins the same way. Conventions used by every copy: `ta.rma` and `ta.ema` start with the simple mean of the first `length` defined values; `ta.atr` takes the first true range as high - low; the variable `ta.tr` is undefined on bar 0; windowed built-ins skip undefined values; `nz(x)` is 0 when x is undefined; `ta.highest` and `ta.lowest` include the current bar.

| Indicator | Source (licence) | Definition | Outputs |
| --- | --- | --- | --- |
| SuperTrend | TradingView built-in `ta.supertrend`, <https://www.tradingview.com/pine-script-reference/v6/#fun_ta.supertrend> (its "same in Pine" example) | src = hl2; atr = `ta.atr(length)` (default 10); upper = src + factor x atr (default 3), lower = src - factor x atr; lower keeps the previous lower unless it rose or the previous close fell below the previous lower; upper keeps the previous upper unless it fell or the previous close rose above the previous upper (previous bands are 0 when undefined); direction is down while the previous ATR is undefined; if the previous line was the upper band: up when close > upper, else down; otherwise down when close < lower, else up; line = lower when up, upper when down | `line`, `direction` |
| Ultimate MA | ChrisMoody, CM_Ultimate_MA_MTF_V2, <https://www.tradingview.com/script/8KVcQiJM-CM-Ultimate-MA-MTF-V2/> (no licence header; TradingView house rules) | type 1 SMA, 2 EMA, 3 WMA, 4 Hull = WMA(2 WMA(floor(n/2)) - WMA(n), round(sqrt n)), 5 VWMA, 6 RMA, 7 TEMA = 3 e1 - 3 e2 + e3, 8 Tilson T3 (factor 0.7, three nested GD = EMA x 1.7 - EMA(EMA) x 0.7); default SMA 20; rising when value >= value `smoothing` bars ago (default 2) | `value`, `direction` |
| AlphaTrend | KivancOzbilgic, <https://www.tradingview.com/script/o50NYLAZ-AlphaTrend/> (MPL-2.0) | band = SMA(`ta.tr`, length) (default 14); upT = low - coeff x band (default 1); downT = high + coeff x band; when momentum >= 50 (MFI of hlc3 with volume, or RSI of close; an explicit parameter): AT = upT unless upT is below the previous AT (then the previous AT); otherwise AT = downT unless downT is above the previous AT (then the previous AT); the previous AT is 0 when undefined. Direction: +1 when AT > AT 2 bars ago, -1 when below, else +1 when AT 1 bar ago > AT 3 bars ago, else -1 | `line`, `direction` |
| Chandelier Exit | Chuck LeBeau, StockCharts ChartSchool; everget, <https://www.tradingview.com/script/AqXxNS7j-Chandelier-Exit-everget/> (GPL-3.0; formula only) | band = multiple x `ta.atr(length)` (22, 3); long stop = highest high(length) - band, raised to the previous long stop while the previous close is above the previous long stop; short stop = lowest low(length) + band, lowered likewise; direction starts +1, turns +1 when close > previous short stop, -1 when close < previous long stop | `longStop`, `shortStop`, `direction` |
| Slingshot | ChrisMoody, CM Sling Shot System, <https://www.tradingview.com/script/GE7tSQK1-CM-Sling-Shot-System/> (no licence header) | fast = EMA(close, 38), slow = EMA(close, 62); +1 when fast > slow, -1 when fast < slow, 0 when equal | `fast`, `slow`, `direction` |

All five are re-implemented from these formulas; no Pine source is copied. `NOTICE` records author, URL, licence and the date checked (2026-11-14).

### Names, signs and parameters

| Indicator | Python (`indicators.trend`) | TypeScript (`@darkfactory/shared/indicators`) | Fixture key prefix | Script | Chart id | DSL `name` (PR 2) | Semantic term |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SuperTrend | `supertrend(high, low, close, length=10, factor=3.0)` | `supertrend(high, low, close, length = 10, factor = 3)` | `supertrend_10_3` | built-in `ta.supertrend(factor, atrPeriod)`; template `supertrend` | `supertrend` | `supertrend` | `supertrend` |
| Ultimate MA | `ultimate_ma(close, volume=None, ma_type="sma", length=20, smoothing=2, t3_factor=0.7)` | `ultimateMa(close, volume, maType = "sma", length = 20, smoothing = 2, t3Factor = 0.7)` | `ultimate_ma_<type>_20` | template `ultimate-ma` | `ultma` | none (DSL composes `sma`, F-C) | `ultimate_ma` |
| AlphaTrend | `alphatrend(high, low, close, volume=None, length=14, coeff=1.0, momentum="mfi")` | `alphaTrend(high, low, close, volume, length = 14, coeff = 1, momentum = "mfi")` | `alphatrend_14_1_<momentum>` | template `alphatrend` | `alphatrend` | `alphaTrend` | `alphatrend` |
| Chandelier Exit | `chandelier_exit(high, low, close, length=22, multiple=3.0)` | `chandelierExit(high, low, close, length = 22, multiple = 3)` | `chandelier_22_3` | template `chandelier-exit` | `chandelier` | `chandelierExit` | `chandelier_exit` |
| Slingshot | `slingshot(close, fast=38, slow=62)` | `slingshot(close, fast = 38, slow = 62)` | `slingshot_38_62` | template `slingshot` | `slingshot` | none (DSL composes `ema`) | `slingshot` |

- Python returns tuples of `list[float]`; TypeScript returns objects of `Float64Array` with the output names of the definition table (`line`, `direction`, `value`, `longStop`, `shortStop`, `fast`, `slow`). Undefined is `nan` / `NaN`.
- Direction sign: +1 up, -1 down everywhere, except the script built-in `ta.supertrend`, which keeps Pine's sign (-1 up, +1 down) so that TradingView scripts run unchanged. A test checks that the built-in equals -1 x the TypeScript direction. The `supertrend` semantic term states this.
- Parameter names: Python and TypeScript use the Pine names (`factor`, `coeff`, `multiple`). The DSL uses `multiple` for all three ATR multipliers, as the existing `noiseBand` does.
- Python owns small building blocks (`sma`, `wma`, `ema`, `rma`, `true_range`, `atr`, `highest`, `lowest`, `mfi`, `rsi`) instead of reusing `indicators/core.py`, because `core.atr` starts at bar `period` over the true ranges of bars 1..period (TA-Lib) while Pine's first true range is high - low, and `core`'s rolling mean raises on undefined values, so it cannot run Pine's na-skipping nested windows (Hull, T3, AlphaTrend's SMA of `ta.tr`). The TypeScript module has the same blocks in the same operation order.

### Three engines, one reference table

```text
 make_trend_reference.py: one loop per indicator, no shared helpers, written separately from the code
            |
            v
 services/research/tests/fixtures/trend-indicator-reference.json  (test fixture, 200 synthetic bars:
            |                                                       up trend, range, flat run, zero-volume
            |                                                       bar, down trend, gap, rally)
   +--------+-------------------+-------------------------------+
   |                            |                               |
 Python indicators/trend.py   TypeScript shared/indicators     script interpreter: ta.supertrend,
 (study; Python DSL, PR 2)    (chart studies; TS DSL, PR 2)    ta.mfi and the six templates
```

Each engine must match the table within an absolute 1e-9. The two DSL engines additionally match each other exactly (the existing golden-file rule of `services/research/tests/test_nautilus_backtest_signals.py`).

### Completed-bar rule (study and DSL)

- A session is one New York date. Buckets start at the session open (09:30 New York) and are `period` minutes long (5 or 15). A 1-minute bar belongs to the bucket that contains its open time. Bucket j of a session covers [09:30 + j x period, 09:30 + (j + 1) x period).
- A bucket bar = first open, highest high, lowest low, last close and summed volume of its 1-minute bars. Its end time is the end of its interval, or the session close when that is earlier (early-close days end at 13:00).
- A 1-minute bar that closes at time T reads the newest bucket whose end time is at or before T. Signals decided at the close of bar i fill at the open of bar i + 1 (the existing engine rule).
- Indicator state carries across sessions, as on a TradingView regular-session chart. Offset on a higher-timeframe indicator counts buckets and is applied before the mapping.
- A bucket is built from the 1-minute bars present; buckets with fewer bars than `period` are counted and reported.
- Diagnostic only (outside N and outside the tests): the look-ahead row reads the bucket that contains the bar while it is still forming.

Normative timeline for 5-minute buckets (the study test and the DSL golden cases assert it):

| 1-minute bar (open, New York) | Closes at | Reads bucket |
| --- | --- | --- |
| 09:30 ... 09:33 | 09:31 ... 09:34 | the last bucket of the previous session |
| 09:34 | 09:35 | 09:30-09:35 |
| 09:35 ... 09:38 | 09:36 ... 09:39 | 09:30-09:35 |
| 09:39 | 09:40 | 09:35-09:40 |
| 12:59 on an early-close day | 13:00 | 12:55-13:00 (the session's last bucket) |
| 10:02, with 10:01 missing | 10:03 | 09:55-10:00 (bucket 10:00-10:05 has 4 bars and ends at 10:05) |
| 09:34 on the first session after a DST change | 09:35 New York | 09:30-09:35 (New York time, not UTC) |

### Study design (frozen rules)

Rules come from the decision record and are frozen in `docs/specs/strategies/trend-trio.md` before the first full run. Basis key: **V** = stated by the video; **KB Qn** = decision record question n; **A** = Vertex assumption (no source).

#### Rules

| # | Rule | Basis |
| --- | --- | --- |
| 1 | Signal timeframe 5 minutes; 15 minutes is a second row | V |
| 2 | Long alignment at a bucket close: SuperTrend, Ultimate MA and AlphaTrend directions +1 (the trio agrees) and Slingshot +1 (the filter allows). Short alignment: all -1. | V (indicators named) + KB Q4 |
| 3 | An alignment episode starts at a bucket close where the alignment holds and did not hold at the previous bucket close, or at the first bucket close of a session. It lasts while the alignment holds at each bucket close. | KB Q4 |
| 4 | Entry: within an episode, at the first 1-minute bar close (at or after the episode's first bucket close) where the 1-minute Chandelier Exit direction agrees with the side; fill at the next 1-minute open; one entry per episode; entry decisions from 09:35 to 15:50 New York (to 10 minutes before an early close) | KB Q4 + A |
| 5 | Exit: at the first 1-minute bar close where the Chandelier Exit direction (1-minute bars) is against the position, fill at the next 1-minute open; an opposite entry closes the position and opens the other side at the same open; otherwise market on close at the last regular bar (the engine's `close_at` rule). One position at a time. | V (Chandelier) + KB Q2, Q5 |
| 6 | Defaults: SuperTrend 10 / 3; Ultimate MA SMA 20, smoothing 2; AlphaTrend 14 / 1 with MFI; Chandelier 22 / 3; Slingshot 38 / 62 | published defaults, KB Q6 |
| 7 | 1 NQ contract = $20 per point; tick 0.25 point = $5; fees $4.50 per round trip; slippage 0, 1 and 2 ticks per side (on every entry and exit fill) | KB Q3 (QuantStackAI raw file `ig-DfbYUD6xSin.md`: $4.50 and 1 tick each way) |

#### Datasets

| Id | Data | Volume used by MFI | Rules run on it | Fill price | Role |
| --- | --- | --- | --- | --- | --- |
| (a) | Dukascopy `usatechidxusd` 1-minute bid and ask, regular session, 2013-01-02 to 2026-11-06 (files of `research/backtests/imom/fetch_data.py`; 3,499 sessions) | Dukascopy tick volume (no bar has volume <= 0) | as frozen | mid = (bid + ask) / 2; P&L points = price change | graded, execution primary |
| (b) | IBKR QQQ 5-minute trades, regular session, 2004-12-01 to 2026-11-06 (`docs/vertex-rebuild/data-sources/intraday.md`; 5,519 sessions) | QQQ shares | signals on 15-minute buckets; entries, exits and the Chandelier on 5-minute bars ("(b) 15/5") | QQQ price; P&L points = scale x QQQ change, scale = NDX close / QQQ close of the latest earlier date both have (Yahoo daily, `noise_band_futures_run.qqq_scales`) | graded, long history |
| (c) | real NQ 5-minute bars 2024-08-28 to 2025-09-19, front month by prior-session volume (`noise_band_futures_run.load_nq`) | NQ contracts | as (b) | NQ price | tracking check, reported |

No position is held overnight, so QQQ dividends do not enter the P&L; the futures basis is ignored because P&L is in points. Session filter (copied from `strategies/imom/data.py`): closed days are skipped, early-close days end at 13:00, and sessions with fewer than 150 minutes of bars are dropped and counted. The CFD spread (median 1.23 points, about 5 NQ ticks) is reported as a diagnostic and never charged. The MFI-state agreement between CFD tick volume and NQ volume on the 2024-2025 overlap is reported.

#### Variants (N = 33)

| Row | Dataset | Change from P1 |
| --- | --- | --- |
| P1 | (a) | none (primary) |
| P2 | (a) | signal timeframe 15 minutes |
| P3 | (b) | the "(b) 15/5" rules |
| V1 | (a) | re-entry: several entries per episode (each time the Chandelier direction turns back with the side); this is the DSL form |
| V2 | (a) | event entry: an episode counts only when it starts because one trio indicator flipped into the side while the other two already agreed (not by a filter flip or a session start) |
| V3 | (a) | exit also at a bucket close where any trio indicator turns against the position |
| V4 | (a) | Chandelier Exit on the signal buckets instead of 1-minute bars (exit at a bucket close) |
| V5 | (a) | AlphaTrend momentum RSI |
| V6 | (a) | no Slingshot filter |
| V7 | (a) | two of the trio agree with the side and none is against it (filter still applies) |
| V8 | (a) | indicators on full-session 1-minute bars (trading still 09:35-16:00); "not run" if Q-ETH fails, still counted |
| S1-S22 | (a) | one parameter changed at a time, values below |

| Parameter | Default | Low | High |
| --- | --- | --- | --- |
| SuperTrend length | 10 | 7 | 14 |
| SuperTrend factor | 3.0 | 2.1 | 4.2 |
| Ultimate MA length | 20 | 14 | 28 |
| Ultimate MA smoothing | 2 | 1 | 3 |
| AlphaTrend length | 14 | 10 | 20 |
| AlphaTrend coeff | 1.0 | 0.7 | 1.4 |
| Chandelier length | 22 | 15 | 31 |
| Chandelier multiple | 3.0 | 2.1 | 4.2 |
| Slingshot fast | 38 | 27 | 53 |
| Slingshot slow | 62 | 43 | 87 |
| Entry window end | 15:50 | 15:40 | 15:55 |

Low = default x 0.7 and high = default x 1.4, rounded to the nearest integer for lengths and to 0.1 for multipliers; smoothing and the window end use one step down and up. Diagnostics outside N: the look-ahead row, the random-entry control and the bridge row ("(b) 15/5" rules on dataset (a) aggregated to 5 minutes, which measures the execution difference between (a) and (b) on 2013-2026).

#### Tests (all at 1 tick per side on P1 unless stated)

| Test | Pass when | Basis |
| --- | --- | --- |
| T1 | Net P&L > 0 over 2013-01-02 to 2026-11-06, and over the stitched walk-forward test years 2016-2025 | KB Q7 (DeltaTrend, QuantFinanceToGo) |
| T2 | Day-block bootstrap 95% interval of the mean net P&L per session (sessions without a trade count 0) is above 0 (10,000 resamples, seed 7, `noise_band_futures_run.bootstrap_ci`) | KB Q7 (DeltaTrend: bootstrap interval above 0) |
| T3 | At least 75% of full calendar years profitable on P1 (2013-2025) and on P3 (2005-2025); partial years (2004, 2026) are reported, not counted. The reel's 16-year window 2010-2025 is reported for P3. | KB Q7 (In The Money Adam, Josh Oldmixon) |
| T4 | Deflated Sharpe probability > 0.95: per-session net P&L series, per-session Sharpe, raw N = 33, variance of the per-session Sharpes of the rows that ran, skew and kurtosis of P1 (Bailey and Lopez de Prado (2014), "The Deflated Sharpe Ratio"; `backtesting.optimizer.deflated_sharpe_ratio`) | KB Q7 |
| T5 | Average gross P&L per trade >= $80 per contract | master rule `matteo-conti:risk:2` (`~/Github/knowledge-bases/trading/_master-rules/rules.jsonl`: "Require average trade above ~$80 per NQ mini contract to survive costs") |
| T6 | Net P&L > 0 at 2 ticks per side | KB Q3, Q7 |
| T7 | Mean net P&L per trade above the 95th percentile of 1,000 random-entry draws (each P1 trade moved to a random other session at the same minute of day, same side, same holding minutes cut at the close; seed 7) | QuantStackAI raw file `ig-DeCfzVix7xN.md` (random-entry control of SuperTrend 10/3 on NQ) |

Outcome: "reconstruction passed" when T1-T7 all pass; otherwise "reconstruction failed", and the first failing test decides. Walk-forward: anchored; the training years (2013 up to the year before the test year, at least 3 full years) pick, among the rows on dataset (a) that ran, the row with the highest net P&L at 1 tick; that row is booked in the test year (2016-2025).

#### Job order and budget

Tier 1: P1, P2, P3 (verdict inputs). Tier 2: V1-V8. Tier 3: S1-S22. Tier 4: walk-forward, random-entry control, look-ahead and bridge diagnostics. Each job writes its own JSON file; a restarted run skips finished jobs. The run starts with a one-year pilot (2024) and stops before a tier whose projected time exceeds 8 core-hours; every tier is required by the owner's task, so a stop is a blocked job, not a smaller study.

### Booking

- `study.py` books every trade in dollars from the rule module's trade list: points x $20 - $4.50 - 2 x slippage ticks x $5.
- NautilusTrader books the same entry and exit arrays of P1, P2 and P3 through `nautilus_backtest.engine.run_signal_backtest` (long and short as separate runs, one year at a time; no position crosses a session, so each year is independent). The run must give the same entry and exit bars and fill prices as the rule module; costs stay in the ledger.

### Storage

- `strategies` row (migration 0073), written after the verdict.
- Study document (`kind: strategy-backtest`, `StrategyBacktestStudySchema` in `packages/api/src/contracts/research-studies.ts`) through `bun run vertex:research-studies:import`. Its returns and drawdowns are fractions of a $100,000 capital basis per contract (stated in its notes; not comparable with equity studies). The per-year net dollars of P1 and P3 go into the library description and the study notes.

### DSL (PR 2)

```text
 IndicatorExpr (fields unchanged; timeframe gains "5m" and "15m")
 new strict members: supertrend {length, multiple, output, offset, timeframe?}
                     alphaTrend {length, multiple, momentum, output, offset, timeframe?}
                     chandelierExit {length, multiple, output, offset, timeframe?}
 compile: indicator --timeframe? --"1d"------> dailyIndicator (unchanged)
                                 \-"5m"/"15m"--> intradayIndicator: buckets from intradaySessions,
                                                  offset in buckets, completed-bar mapping
 signals.py mirrors every step; the cache key holds every field.
 serverStrategyRefusal: intradayIndicators capability; no server caller sets it in this card.
```

The Trend Trio DSL definition (study-only, in `services/research/strategies/trend_trio/dsl.py`): `side` long (and a short twin); entry `all` of SuperTrend `direction` > 0, `sma(20)` >= `sma(20, offset 2)`, AlphaTrend `direction` > 0, `ema(38)` > `ema(62)` (all `timeframe "5m"`) and Chandelier `direction` > 0 (1-minute); exit `any` of Chandelier `direction` < 0; intraday block 09:30-16:00 with market on close. The DSL enters whenever the condition holds and the book is flat, so it equals variant V1, not P1.

## Alternatives Considered

### Alternative A: Study only, no DSL change

- **Pros**: least code; no risk to the shared DSL contract.
- **Cons**: G-DSL stays unmet; the owner's request asks for the strategy in the DSL (scope source).
- **Reason for Rejection**: the DSL work ships in its own PR after the study and is refused on server paths, so it neither delays the verdict nor changes running server behaviour.

### Alternative B: A second bar series in NautilusTrader

- **Pros**: mirrors a TradingView chart with two timeframes.
- **Cons**: changes the shared engine and its parity tests.
- **Reason for Rejection**: the engine books precomputed signals; building buckets in the signal code matches the existing daily path and keeps the engine unchanged.

### Alternative C: New DSL indicators for Ultimate MA and Slingshot

- **Pros**: one DSL name per indicator.
- **Cons**: two more stateful kernels in two engines.
- **Reason for Rejection**: the default configurations are `sma(20) >= sma(20, offset 2)` and `ema(38) > ema(62)`, which the DSL expresses once offsets count buckets. The other seven Ultimate MA types stay in the chart, the templates and the study.

### Alternative D: Fill at the CFD bid and ask

- **Pros**: uses the data as quoted.
- **Cons**: adds about 5 NQ ticks per round trip, so the fees-only row cannot be produced.
- **Reason for Rejection**: NQ ticks model the cost; the CFD spread is reported as a diagnostic.

### Alternative E: Full factorial parameter grid

- **Pros**: covers every combination.
- **Cons**: the 11 parameters at three values give 3^11 = 177,147 rows; at that N the deflated Sharpe test needs a Sharpe no strategy in the decision record's sources reports.
- **Reason for Rejection**: one-at-a-time sensitivity keeps N at 33.

### Alternative F: TA-Lib warm-up for the new chart studies

- **Pros**: same convention as the existing chart studies.
- **Cons**: values differ from TradingView and from the study.
- **Reason for Rejection**: the indicators are defined by TradingView scripts; one convention for all copies.

### Alternative G: Buy real NQ 1-minute history

- **Pros**: tests the claim on the traded contract.
- **Cons**: a new paid data service; the owner's rule for this card is "no new paid anything".
- **Reason for Rejection**: cost rule; the CFD and QQQ proxies with the NQ tracking check are the free route.

### Alternative H: Grade dataset (c), real NQ 2024-2025

- **Pros**: real contract data.
- **Cons**: 13 months, one partial calendar year; T3 cannot be computed.
- **Reason for Rejection**: too short to grade; kept as a tracking check.

### Alternative I: TA-Lib or pandas-ta

- **Pros**: existing libraries.
- **Cons**: TA-Lib has none of the five; pandas-ta has a SuperTrend but no AlphaTrend, Ultimate MA types or Slingshot, and it adds a dependency.
- **Reason for Rejection**: incomplete coverage and a new dependency for five short formulas.

### Alternative J: One Python implementation; the chart reads its output

- **Pros**: one copy of the math.
- **Cons**: the chart computes studies in the browser on any bars; it would need a new API round trip per study.
- **Reason for Rejection**: the chart path is client-side today; a TypeScript module checked against the same table costs less.

## Risks & Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| The guessed rules differ from the paywalled rules | A fail does not disprove the video; a pass does not confirm it | Outcome named "reconstruction passed/failed"; 33 declared rows; report states the limit in its header |
| Proxy data (CFD, QQQ) differs from NQ | Per-trade P&L differs from NQ | NQ 2024-2025 tracking check; bridge row; mid prices; NQ tick costs |
| Regular-session bars put the overnight gap into the 09:30 ATR | Indicators differ from a full-session TradingView chart | V8 full-session row |
| CFD tick volume is not traded volume | AlphaTrend MFI state differs | V5 RSI row; MFI-state agreement on 2024-2025 reported |
| Overfitting across 33 rows | A lucky row looks good | T4 deflated Sharpe with N = 33; walk-forward T1; T7 random-entry control |
| Copies of the math drift | Chart, script and study disagree | Three engines checked against one table within 1e-9 |
| Licences of the source scripts (MPL-2.0, GPL-3.0, none) | Licence claims on the repository | Formulas only, no code copied; `NOTICE` entries |
| New DSL fields change stored revision hashes | Runs and presets lose their revision | Fields optional with no default; test recomputes `STRATEGY_TEMPLATES` hashes (`server/strategy-definitions.ts:55`) |
| Web app and rig worker on different DSL versions | Runs fail half-way | Server paths refuse the new vocabulary in this card |
| Rig is the only host with the data | Lost data stops reproduction | Data manifest with SHA-256 and sources in `results.json`; fetchers in the repository |
| Ledger and NautilusTrader disagree | Wrong dollars | Same entry/exit bars and prices required for P1-P3 |
| A pass is read as permission to trade | Money at risk | Research only; no arm or order path; options form only after a pass and a separate study |

## Non-Functional Requirements

- **Security & Privacy**: research only; no secrets; data stays on the rig (not in the repository); the report page shows no account data.
- **Performance**: indicator math is O(n) per series. The study runs on the rig with at most 8 workers (job order and budget above). The DSL keeps `BACKTEST_RUN_ENGINE_BARS_MAX`; the study calls the engine directly.
- **Rollout & Rollback**: PR 1 and PR 2 roll back separately. PR 2 fields are optional with no default. Migrations have rollback files that refuse to run when the row was edited after the seed (the pattern of `packages/db/rollback/0070_strategy_catalog_triple_rsi.down.sql`).

## Additional Resources

- Decision record and EGM reports: `~/Documents/reports/web/vertex-trend-trio/` on the rig.
- Precedents: `docs/specs/strategies/triple-rsi.md`, `docs/specs/strategies/session-open-momentum-nq.md`, `docs/vertex-rebuild/data-sources/intraday.md`.

## Future Improvements

- **Options form**: a QQQ 0-1 DTE debit vertical on real quotes, only after a futures pass (decision record Q8).
- **Real NQ 1-minute data**: would replace the CFD proxy.
- **Server paths**: enable the intraday indicator capability after the rig worker ships PR 2.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Python import root: `services/research` (pytest runs from it, `research/backtests/trend-trio/run.py` inserts it into `sys.path`, the worker runs `python -m nautilus_backtest` in it); imports are absolute, for example `from indicators.trend import supertrend`, as in `strategies/adx_filter.py`. Python tests run with `services/research/.venv/bin/python -m pytest <file>`; NautilusTrader tests with the rig venv `~/.cache/vertex-academy-nautilus-venv/bin/python` (the venv of `research/backtests/triple-rsi/README.md`).

### PR 1 phases

| Phase | Files (items) | Check before the next phase |
| --- | --- | --- |
| 1 | 1-4 (fixture, Python module) | `pytest tests/test_trend_indicators.py` green |
| 2 | 5 (TypeScript module) | `pnpm exec vitest run packages/shared/src/indicators` green, 100% lines/branches/functions/statements |
| 3 | 6 (chart) | vitest on `apps/web/src/features/charts/trend-studies.test.ts` and `vertex-studies.test.ts` green |
| 4 | 7 (scripting) | vitest on `packages/scripting` green |
| 5 | 8-11 (study, CLI, tests, spec) | pytest on the study tests green; spec committed (freeze) |
| 6 | run on the rig | `results.json`, `study.json`, `index.html` written |
| 7 | 12-13 (migrations, NOTICE), spec results | `bun run verify:prepush` green |

### PR 1 files

#### 1. `services/research/tests/fixtures/make_trend_reference.py` (Create)

- **Type / Scope**: fixture generator, run by hand only: `python3 services/research/tests/fixtures/make_trend_reference.py`, then `bunx --bun --no-install biome format --write services/research/tests/fixtures/trend-indicator-reference.json`. Standard library only, deterministic (fixed LCG seed, values rounded to 10 decimals).
- **Proposed Changes**: 200 synthetic bars: up trend (bars 0-49), range (50-89), flat run of 5 equal bars (90-94), one zero-volume bar (95), down trend (96-139), gap up at 140, rally (141-199); one literal loop per formula of the definition table; keys `supertrend_10_3.{line,direction}`, `ultimate_ma_{sma,ema,wma,hull,vwma,rma,tema,t3}_20.{value,direction}`, `alphatrend_14_1_{mfi,rsi}.{line,direction}`, `chandelier_22_3.{longStop,shortStop,direction}`, `slingshot_38_62.{fast,slow,direction}`, `mfi_hlc3_14`, `rsi_close_14`; undefined values as null.

#### 2. `services/research/tests/fixtures/trend-indicator-reference.json` (Create)

- **Type / Scope**: generated test fixture (AGENTS.md rule 13 allows test fixtures).

#### 3. `services/research/indicators/trend.py` (Create)

- **Type / Scope**: Python module, functions of the names table plus the building blocks `sma`, `wma`, `ema`, `rma`, `true_range(high, low, close, handle_na)`, `atr`, `highest`, `lowest`, `mfi(src, volume, length)`, `rsi(src, length)`, `moving_average(close, volume, ma_type, length, t3_factor)`.
- **Proposed Changes**: inputs `Sequence[float]`, outputs `list[float]` with `nan`; `ValueError` with these messages: "length must be an integer from 1 to 2000", "<name> must be a positive number", "input series must have the same length", "AlphaTrend momentum mfi needs volume; use momentum rsi", "vwma needs volume", "ma_type must be one of sma, ema, wma, hull, vwma, rma, tema, t3", "momentum must be mfi or rsi". Module docstring: conventions, sources, licences.

#### 4. `services/research/tests/test_trend_indicators.py` (Create)

- **Type / Scope**: pytest.
- **Proposed Changes**: every key of the fixture within an absolute 1e-9 (null = `nan`); hand cases: `sma([1,2,3,4],2)` = `[nan,1.5,2.5,3.5]`, `rma([2,2,2,4],2)` = `[nan,2,2,3]`, `true_range` first bar with and without `handle_na`, `mfi` of a rising series = 100; each error message above.

#### 5. `packages/shared/src/indicators/trend.ts`, `packages/shared/src/indicators/trend.test.ts`, `packages/shared/src/indicators/index.ts` (Create); `packages/shared/package.json` (Modify)

- **Type / Scope**: TypeScript module; `exports["./indicators"] = {"import": "./src/indicators/index.ts", "default": "./src/indicators/index.ts"}`.
- **Proposed Changes**: the functions of the names table and the same building blocks (`sma`, `wma`, `ema`, `rma`, `trueRange`, `atr`, `highest`, `lowest`, `mfi`, `rsi`, `movingAverage`), `ReadonlyArray<number> | Float64Array` in, `Float64Array` out, `RangeError` with the same messages; tests read the fixture by a path from the repository root (as `apps/web/src/features/charts/indicator-math.test.ts` reads `indicator-reference.json`) and assert each key within 1e-9, the hand cases and the errors; 100% coverage.

#### 6. `apps/web/src/features/charts/trend-studies.ts`, `apps/web/src/features/charts/trend-studies.test.ts` (Create); `apps/web/src/features/charts/vertex-studies.ts`, `apps/web/src/features/charts/chart-indicators.ts` and their tests (Modify)

- **Type / Scope**: chart studies, display only.
- **Proposed Changes**: `TREND_STUDIES`: five `VertexStudy` entries, `placement: "candle"`, values from `@darkfactory/shared/indicators`:

    | id | name | shortName / label | calcParams | figures (key: title) |
    | --- | --- | --- | --- | --- |
    | `supertrend` | `VX_SUPERTREND` | SuperTrend / "SuperTrend 10, 3" | [10, 3] | `up`: "Up: ", `down`: "Down: " (line where the direction is up or down, else NaN) |
    | `ultma` | `VX_ULTMA` | UMA / "Ultimate MA SMA 20" | [20, 2] | `rising`: "Rising: ", `falling`: "Falling: " |
    | `alphatrend` | `VX_ALPHATREND` | AT / "AlphaTrend 14, 1 (MFI)" | [14, 1] | `at`: "AT: ", `at2`: "AT[2]: " (MFI when every bar has volume, else RSI) |
    | `chandelier` | `VX_CHANDELIER` | CE / "Chandelier Exit 22, 3" | [22, 3] | `long`: "Long stop: ", `short`: "Short stop: " (by direction) |
    | `slingshot` | `VX_SLINGSHOT` | Sling / "Slingshot EMA 38, 62" | [38, 62] | `fast`: "EMA 38: ", `slow`: "EMA 62: " |

    The five ids join `VERTEX_STUDY_IDS`, the entries join `VERTEX_STUDIES`, and `vertexOption(id)` entries join `OVERLAY_OPTIONS`. Tests: each study's rows equal the TypeScript module on the fixture bars; the menu lists the five labels.

#### 7. `packages/scripting/src/ta.ts`, `packages/scripting/src/builtins.ts`, `packages/scripting/src/templates.ts`, `packages/scripting/src/ta.test.ts`, `packages/scripting/src/templates.test.ts`, `packages/scripting/src/interpreter.test.ts` (Modify)

- **Type / Scope**: script engine.
- **Proposed Changes**: streaming kernels `supertrend(site, bar, factor, length)` and `mfi(site, bar, src, len)` that return `null` while undefined; built-ins `ta.supertrend(factor, atrPeriod)` returning `[line, direction]` with Pine's sign and `ta.mfi(source, length)`; argument errors use the existing built-in error format. Templates (plot titles in `PLOT_TITLES`): `supertrend` ("Up", "Down"), `ultimate-ma` (input `maType` 1-8, "Ultimate MA"), `alphatrend` ("AlphaTrend", "AlphaTrend[2]"), `chandelier-exit` ("Long stop", "Short stop"), `slingshot` ("EMA 38", "EMA 62"), and `trend-trio` (shapes "Long alignment" and "Short alignment" when the trio, the filter and the Chandelier agree on the chart's own timeframe; no `strategy` calls, no alerts). Six templates: one per indicator plus the combined view. The `atr-trailing-stop` title becomes "ATR Trailing Stop" (shorttitle "ATR Stop" unchanged). The unsupported-`ta.supertrend` case in `interpreter.test.ts` is replaced by a case that compiles it. Tests: each template's plots equal the fixture within 1e-9 (null = `na`); `ta.supertrend` direction = -1 x the fixture direction.

#### 8. `services/research/strategies/trend_trio/__init__.py`, `rules.py`, `study.py`, `document.py`, `report.py` (Create)

- **Type / Scope**: study package; reuses the helpers below.

    | Need | Reused helper |
    | --- | --- |
    | CFD 1-minute mid bars | `strategies.imom.data.files_of("NAS100")`, `read_side`, `mid_minutes` |
    | Calendar | `strategies.imom.data.is_closed`, `is_early_close` |
    | Data hash | `strategies.imom.data.data_hash` |
    | QQQ 5-minute bars, NDX/QQQ scale | `strategies.noise_band_futures_run.load_qqq`, `load_yahoo`, `qqq_scales` |
    | NQ 5-minute front month | `strategies.noise_band_futures_run.load_nq` |
    | Day-block bootstrap | `strategies.noise_band_futures_run.bootstrap_ci` |
    | Deflated Sharpe | `backtesting.optimizer.deflated_sharpe_ratio` |
    | NautilusTrader booking | `nautilus_backtest.engine.run_signal_backtest` |

- **Proposed Changes**:
  - `rules.py`: `SPEC_SHA256` (hash of the spec above "## Results"); `Minutes` (frozen dataclass: `t` UTC ms of bar open, `o`, `h`, `l`, `c`, `v` lists, `session` index per bar, `minute` minutes after 09:30 New York of the bar open, `close_minute` per session (390 or 210), `scale` per session, `day` per session); `Params` (frozen dataclass: `signal_minutes`, `st_length`, `st_factor`, `uma_type`, `uma_length`, `uma_smoothing`, `at_length`, `at_coeff`, `at_momentum`, `ce_length`, `ce_multiple`, `ce_on_signal`, `sling_fast`, `sling_slow`, `filter_on`, `voters_needed`, `entry` in {"episode", "reentry", "event"}, `exit_on_voters`, `full_session`, `entry_end_minute`, `lookahead`; `key()` = sorted `name=value` joined by ","); `Trade` (frozen dataclass: `session`, `side`, `entry_bar`, `exit_bar`, `entry_price`, `exit_price`, `exit_reason` in {"chandelier", "voters", "reverse", "close"}, `points`); `buckets(minutes, period) -> (bucket bars, read index per minute)` (completed-bar rule); `trades(minutes, params, full=None) -> list[Trade]`; `signal_arrays(minutes, trades, side) -> (signals, exits, close_at)` for the engine.
  - `study.py`: `VARIANTS` (the 33 rows, ordered P1..S22), `DIAGNOSTICS`, `Job(dataset, row, params)`, `run_job(job, data_root, out_dir)` writing `<row>-<dataset>.json` (`{"row", "dataset", "params", "trades": [...], "sessions": n}`), `ledger(trades, slip_ticks)`, `per_year`, `max_drawdown`, `time_in_market`, `walk_forward`, `random_control(seed=7, draws=1000)`, `nautilus_check(row)`, `assemble(out_dir) -> results` (tests T1-T7, outcome, data manifest with SHA-256 of every input file).
  - `document.py`: `study_document(results) -> dict` that validates against `StrategyBacktestStudySchema` field by field (as `strategies/triple_rsi/document.py` does).
  - `report.py`: `render(results) -> str` (dark HTML: header with claim vs reconstruction and outcome, per-year bars for P1 and P3 at 0 and 1 tick, cost table, test table, variants, indicators added, limits).

#### 9. `research/backtests/trend-trio/run.py`, `research/backtests/trend-trio/README.md` (Create)

- **Type / Scope**: CLI on the rig.
- **Proposed Changes**: `run.py --out <dir> --workers <n> [--pilot]` (`--pilot` = 2024 only); refuses to run when the spec hash differs from `rules.SPEC_SHA256`; writes `results.json`, `study.json` and `index.html` into `--out` (outside the repository). README: data files, venv, commands, import of the study.

#### 10. `services/research/tests/test_trend_trio_rules.py`, `services/research/tests/test_trend_trio_study.py`, `services/research/tests/test_trend_trio_nautilus.py` (Create)

- **Type / Scope**: pytest.
- **Proposed Changes**: rules: the timeline table above on a synthetic two-session minute series (one early close, one missing minute, one DST date); future-data test (change every bar after T, assert no trade decided up to T changes); entry and exit cases for each rule and variant on hand-built series. Study: `len(VARIANTS) == 33`; ledger arithmetic (1 point = $20; 1 tick per side = $10 per round trip plus $4.50); per-year and drawdown on a hand series; bootstrap and random control reproducible with seed 7. Nautilus (rig venv, skipped without NautilusTrader): same entry/exit bars and fill prices as the rule module on a 3-session series.

#### 11. `docs/specs/strategies/trend-trio.md` (Create)

- **Type / Scope**: pre-registered spec in the layout of `triple-rsi.md`: Source; What the video claims; Classification of rules (V / KB / A); Rules (frozen); Datasets; Variants; Tests; DSL definition; Options form; Results (added after the run: Verdict, Per year, Costs, Variants, Walk-forward, Diagnostics). The Status line records the freeze commit.

#### 12. Migrations (Create unless marked)

- `packages/db/migrations/0073_strategy_catalog_trend_trio.sql`: `INSERT ... ON CONFLICT ("slug") DO NOTHING` into `strategies` with `id` `strategy-seed-trend-trio`, `slug` `trend-trio`, `name` "Trend Trio (Vertex reconstruction, rules guessed): SuperTrend + Ultimate MA + AlphaTrend on NQ", `description` (claim, reconstruction outcome, per-year net dollars of P1 and P3, "Research only"), `kind` `python`, `status` `backtested`, `source_ref` `docs/specs/strategies/trend-trio.md`, `tags` as in G-LIB plus topic tags (`nq`, `intraday`, `trend-following`, `supertrend`, `alphatrend`, `chandelier-exit`), `section` `Reel ideas` (the section of the other reel rows), `params` `[]` (the defaults live in the spec and the study document; `strategies_json_check` needs an array), `priority` `normal`, `external_validation` in the shape of migration 0065 (`sourceUrl`, `sourceTitle`, `sourceAuthor`, `publishedOn`, `claimedMethod`, `claimedMetrics`).
- `packages/db/migrations/0074_semantic_terms_trend_indicators.sql` (added by card `vertex-trend-semantic-terms`, see Implementation notes): five `semantic_terms` rows (`supertrend`, `ultimate_ma`, `alphatrend`, `chandelier_exit`, `slingshot`): `source` `none`, not certified, description = definition, where to use it (script built-in or template, chart study, DSL form) and "Vertex stores no series for it", synonyms (for example "Super Trend" / "UMA", "Ultimate Moving Average" / "Alpha Trend" / "Chandelier" / "Sling Shot", "EMA 38/62"). With it: `packages/db/migrations/meta/0074_snapshot.json`, `packages/db/rollback/0074_semantic_terms_trend_indicators.down.sql` (guarded), `packages/db/src/server/semantic-terms-trend-indicators-migration.test.ts`, `tests/integration/database/semantic-terms-trend-indicators.test.ts` and `tests/integration/semantic-layer/trend-terms.test.ts`.
- `packages/db/migrations/meta/_journal.json` (Modify), `packages/db/migrations/meta/0073_snapshot.json`.
- `packages/db/rollback/0073_strategy_catalog_trend_trio.down.sql` (guarded like the 0070 rollback).
- `packages/db/src/server/strategy-catalog-trend-trio-migration.test.ts`, `tests/integration/database/strategy-catalog-trend-trio.test.ts`.
- If the base branch takes 0073 first, `pnpm db:renumber` renumbers these files (CONVENTIONS.md "Migration numbers").

#### 13. `NOTICE` (Modify)

- **Proposed Changes**: entries for TradingView `ta.supertrend` (reference manual), ChrisMoody CM_Ultimate_MA_MTF_V2, KivancOzbilgic AlphaTrend (MPL-2.0), everget Chandelier Exit (GPL-3.0) with Chuck LeBeau's formula, ChrisMoody CM Sling Shot System: URL, licence, date checked 2026-11-14, "formulas re-implemented, no source copied".

### PR 2 files

#### 14. `packages/api/src/strategy-dsl.ts` (Modify)

- **Proposed Changes**: `STRATEGY_INDICATOR_TIMEFRAMES = ["1d", "5m", "15m"]`; new strict union members:

    | name | fields |
    | --- | --- |
    | `supertrend` | `length` (int 1-500), `multiple` (0.1-20), `output` in {`line`, `direction`}, `offset` (existing schema), `timeframe` optional |
    | `alphaTrend` | `length` (int 1-500), `multiple` (0.1-20), `momentum` in {`mfi`, `rsi`}, `output` in {`line`, `direction`}, `offset`, `timeframe` optional |
    | `chandelierExit` | `length` (int 1-500), `multiple` (0.1-20), `output` in {`longStop`, `shortStop`, `direction`}, `offset`, `timeframe` optional |

    Every field is required except `timeframe` (no defaults, so definitions without them keep their canonical JSON). A definition-level refinement refuses an intraday timeframe without an `intraday` block ("5m and 15m indicator timeframes need an intraday block"); options paths keep refusing non-daily timeframes. `StrategyServerSupport` gains `intradayIndicators?: boolean`; `serverStrategyRefusal` returns `STRATEGY_INTRADAY_INDICATORS_UNSUPPORTED` with the CUJ 4 message when a definition uses an intraday timeframe or a new name and the flag is not true.

#### 15. `packages/api/src/strategy-dsl-compile.ts` (Modify)

- **Proposed Changes**: `intradayIndicator(bars, expr, cache, layout)` beside `dailyIndicator`: buckets from `intradaySessions` with the completed-bar rule, the indicator on the bucket bars with `offset` in buckets, mapped to the signal bars; kernels from `@darkfactory/shared/indicators`; cache key `${name}:${length}:${multiple}:${output}${momentum ? ":" + momentum : ""}:${offset}${timeframe ? ":" + timeframe : ""}` for the new members.

#### 16. `services/research/nautilus_backtest/signals.py` (Modify)

- **Proposed Changes**: the same: `INDICATOR_TIMEFRAMES = ("1d", "5m", "15m")`; `_EXPR_KEYS` entries for the three names (unknown keys refused); `_normalize_expr` checks; `_intraday_indicator`; dispatch in `_Evaluator._current`; kernels from `indicators.trend`; the same cache key; the capability check in `server_refusal`.

#### 17. `apps/web/src/components/portal/strategy-builder-model.ts` and its test (Modify)

- **Proposed Changes**: `INDICATOR_LABELS` entries "SuperTrend", "AlphaTrend", "Chandelier Exit"; `describeExpr` text such as "SuperTrend 10 x 3 direction (5m)"; their extra fields are edited in the JSON view, like `noiseBand`.

#### 18. `scripts/research/nautilus-golden.ts`, `services/research/tests/fixtures/nautilus_backtest/golden.json`, `services/research/tests/test_nautilus_backtest_signals.py`, `packages/api/src/strategy-dsl.test.ts`, `packages/api/src/strategy-dsl-compile.test.ts` (Modify)

- **Proposed Changes**: golden cases `supertrend-direction-5m`, `supertrend-line-1m`, `supertrend-two-multiples`, `alphatrend-mfi-15m`, `alphatrend-rsi-5m`, `chandelier-direction-1m`, `chandelier-stops-5m`, `uma-offset-buckets-5m`, `timeline-boundaries` (the timeline table); the regenerated golden diff adds cases only; a test recomputes the revision hash of every `STRATEGY_TEMPLATES` entry and compares it with the value before the change; refusal and refinement tests.

#### 19. `services/research/strategies/trend_trio/dsl.py` (created in PR 1 as data), a new DSL test file in `services/research/tests/` (Create)

- **Proposed Changes**: the DSL definition above (long and short twins, as dicts, `definition(side, timeframe)`); the test (test_trend_trio_dsl.py) runs `nautilus_backtest.signals.plan_run` with `intradayIndicators` support on the synthetic multi-session series of item 10 and asserts the same entry and exit bars as `rules.trades` with variant V1.

### Verification Plan

- **Compilation/Build**: `bun run check`, `bun run build`.
- **Unit Tests**: `pnpm exec vitest run` on the touched packages; pytest on the new test files (commands above).
- **Static Analysis & Linting**: Biome (inside `bun run check`), `services/research/.venv/bin/ruff check services/research`, `bun run test:json-data`.
- **Test Coverage Requirement**: 100% lines, branches, functions and statements for every new TypeScript file; no file of `scripts/ci/coverage-baseline.json` below its minimum.
- **E2E/Integration**: migration integration tests; `bun run verify:prepush`; the eight required PR checks of AGENTS.md "Workflow" (four `Verification` lanes, `Analyze (actions)`, `Analyze (javascript-typescript)`, `CodeQL`, `Dependency Review`); live check = CUJ 1 Then-clause on the deployed library page and the report URL.

## Implementation notes (drift check 2026-11-14)

The EGM drift check of PR 1 (report in the card's report folder) found these differences between this plan and the code;
the code is the reference:

- Buckets are keyed by multiples of the bucket length in UTC milliseconds; 09:30 New York and the 13:00 early close are
  such multiples for 5 and 15 minutes, so the buckets equal the ones described above.
- `rules.buckets(t, o, h, low, c, v, bar_ms, period_minutes, *, read_at, session, lookahead) -> Buckets` (with `end_ms`,
  `session_first`, `read`); `Minutes` also has `bar_ms`; `rules.spec_sha256()` computes the freeze hash.
- `study.Job(kind, row, dataset, params, tier)` with kinds `trades`, `random`, `nautilus`, `mfi`; `run_job(job, out_dir,
  data)`; the walk-forward is computed in `assemble`, not as a job; tier 4 also holds the NQ tracking row, the
  NautilusTrader checks and the MFI agreement; `run.py` writes the data manifest (`data.json`) and has `--dry-run`,
  `--render-only`, `--allow-dirty` and per-input path options.
- A test that cannot be computed counts as not passed (it can decide the outcome).
- The report also shows the look-ahead diagnostic next to P1 and the options-form arithmetic.
- The 0074 descriptions name the script built-in, template, chart study and, for Ultimate MA and Slingshot, the DSL
  composition; the DSL names of SuperTrend, AlphaTrend and Chandelier Exit arrive with PR 2 (a later migration then
  updates the three descriptions and the eval is recorded again).
- PR 2 (items 14-19) is not implemented yet.
- Agent vocabulary: the five `semantic_terms` rows are not in PR 1. Every new term enters the catalog that the
  recorded semantic-layer eval (`tests/integration/semantic-layer/eval-recording.fixture.json`) replays, so adding
  them needed a re-recording of that eval (Postgres and model calls). Card `vertex-trend-semantic-terms` added them
  on 2026-11-15 with migration 0074 and recorded the 11 questions with stale trials again
  (`docs/vertex-rebuild/agent-semantic-layer.md`, "Re-recording 2026-11-15"). Differences from the plan text: the
  synonyms "ST", "AT" and "CE" are left out (short forms with other meanings), and the descriptions use the template
  titles of the code ("Ultimate MA (8 types)", "Slingshot (EMA 38/62)"). The agent also reaches the indicators
  through `ta.supertrend` / `ta.mfi` and the script templates (`chart_script` tool) and, with PR 2, the DSL names.
