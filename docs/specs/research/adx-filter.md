# ADX and RVOL-at-time as strategy filters (frozen test rules)

Status: research only. No live or paper orders. No broker changes. Nothing here arms an engine or deploys to QuantVPS. A test result does not authorize trades.

Rules frozen: 2026-10-31, before the first study run. This file is committed before the run. Results are added below the line "Results" later; the rules above that line do not change after the first run. A deviation found later is listed under "Deviations" with its reason.

## Source

- Matteo Conti (MatFinOg), YouTube short `de3waxEh8Kk`: "The ADX tells you how strongly a market is trending and you can use it as a filter for trend following strategies, like open a position if ADX is higher than 20, or for mean reverting strategies if the ADX is decreasing, meaning it's losing momentum." Transcript: `~/Github/knowledge-bases/trading/matteo-conti/exhaustive/curated-markdown/transcripts/` (machine ASR, routine-caution review).
- Matteo Conti, YouTube short `7mRloLktmb8`: favorite indicators ADX, VWAP and "Relative Volume at Time, telling you how current volume compares with its historical average at the very same point in the session". He gives no parameters for RVOL.
- Owner request 2026-10-31, card `vertex-adx-filter`.

Basis codes: S = stated by the source; T = stated by the owner task; A = Vertex default, fixed here before the run.

## Data

|#|Rule|Basis|
|---|---|---|
|D1|Universe (14): SPY, QQQ, IWM, SOXX and 10 liquid large caps with a continuous listing since 2004: AAPL, MSFT, AMZN, GOOGL, JPM, XOM, JNJ, PG, WMT, HD.|T / A|
|D2|Daily bars from Yahoo Finance (chart API), fetched 2026-10-31, range 2004-01-02 to 2026-10-30. Bars before 2005-01-03 are indicator warm-up only.|T / A|
|D3|Prices: open, high, low and close are multiplied by adj_close / close of the same bar, so returns include dividends and splits. Volume as Yahoo reports it (split-adjusted).|A|
|D4|Evaluation window: 2005-01-03 to 2026-10-30. Halves: the trading days of the window split into two halves of equal count (first half gets the extra day).|T / A|
|D5|A symbol with a missing or invalid bar (low above high, non-positive price) is reported; the bar is dropped before indicators are computed.|A|
|D6|Survivorship: the 10 large caps are today's large caps. This biases absolute returns upward. The test compares a filter with no filter on the same symbols, so the bias affects both sides.|A|

## Execution model (all daily strategies)

|#|Rule|Basis|
|---|---|---|
|E1|Signals use data up to the close of the signal bar. Fills are at the next bar's open.|A (same as the Vertex DSL engine)|
|E2|Cost: 5 bp of the fill price per side (entry and exit).|T|
|E3|One position per symbol, all of the symbol's sleeve. Long only, except the EMT proxy, which keeps its own long and short rules.|A|
|E4|While flat, an entry signal opens a position at the next open. While in a position, an exit signal closes it at the next open. A new entry can follow on a later bar.|A (Vertex DSL engine)|
|E5|Percent stop (only where a strategy has one): checked inside each bar after the entry bar's open. A gap through the stop fills at the open; otherwise at the stop price.|A (Vertex DSL engine)|
|E6|A position still open on the last bar is closed at that bar's close, without an exit cost, and counts as a trade.|A|
|E7|Daily return of a sleeve: entry day close / fill − 1; later days close / previous close − 1; exit day exit price / previous close − 1 (short: the negative). Each fill subtracts 5 bp from that day's return. Flat days return 0.|A|
|E8|Portfolio of one variant: the mean of the 14 sleeve returns each day (equal-weight sleeves, rebalanced daily, no cash yield).|A|

## Strategies and filter variants

ADX = Wilder ADX(14) (`services/research/indicators` `adx`, TA-Lib convention). "ADX falling over 5 bars" = ADX(14) on the signal bar < ADX(14) 5 bars earlier. All filters apply to the entry signal bar only; exits are unchanged.

|#|Strategy|Entry signal|Exit signal|Variants|
|---|---|---|---|---|
|S1|SMA 20/50 cross (Vertex template `smaCross`)|SMA(20) crosses above SMA(50) (above now, not above on the previous bar)|SMA(20) ≤ SMA(50)|none; ADX > 20|
|S2|20-day breakout (Vertex template `donchianBreakout`)|close > highest high of the 20 bars before the signal bar|close < lowest low of the 10 bars before the signal bar|none; ADX > 20|
|S3|Noise-band intraday momentum|Not run: the noise-band code is not merged into the Vertex base branch (task says "if merged").|—|—|
|S4|RSI(2) dip (Connors form)|RSI(2) < 10 and close > SMA(200)|close > SMA(5)|none; ADX < 20; ADX falling over 5 bars|
|S5|RSI(14) dip (Vertex template `rsiReversion`)|RSI(14) < 30 and close > SMA(200)|RSI(14) > 55; 8% stop (E5)|none; ADX < 20; ADX falling over 5 bars|
|S6|EMT daily proxy (frozen `run()` of `~/Documents/reports/vertex-emt/bt.py`, daily mode, as in `docs/specs/strategies/exhaustion-mean-reversion.md`)|EMT rules 2, 3, 5, 6 with the 9 EMA as the only mean; long and short|EMT stop (+0.02 ATR beyond the extreme, stop first), target = 9 EMA, time stop 10 bars|none; ADX < 20; ADX falling over 5 bars|

S6 changes from the EMT file: cost 5 bp per side (E2) instead of 1 bp, and daily sleeve returns (E7) instead of per-trade returns. Its entry and exit rules are not changed. The source names "ADX < 20" for neither mean-reversion case; Matteo Conti names "ADX decreasing". Both are run because the owner task names both; they are separate variants (13 variants in total).

## Metrics

|#|Metric|Basis|
|---|---|---|
|M1|Per variant portfolio (E8): Sharpe = mean daily return / standard deviation (sample, n−1) × √252, no risk-free rate; CAGR from compounded daily returns over 252-day years; maximum drawdown of the compounded equity; trades = round trips over all 14 symbols; trades per year = trades / (window trading days / 252).|T / A|
|M2|The same Sharpe, CAGR, maximum drawdown and trades for each half (D4). A trade belongs to the half of its entry day.|T|
|M3|Deflated Sharpe ratio (Bailey and López de Prado 2014) for every variant over the full window: trials = 13 (all variants), Sharpe variance = sample variance of the 13 daily Sharpe ratios, skew and raw kurtosis of the variant's daily returns, observations = window trading days. Same formula as `packages/api/src/quant-multiple-testing.ts`. The probability is reported; 0.95 or more is "significant after deflation".|T|
|M4|Per-symbol Sharpe and trades for each variant (information only; not used by the decision).|A|

## Decision rule (per strategy and filter)

KEEP the filter for a strategy only if both are true:

1. The filtered variant's Sharpe is higher than the unfiltered variant's Sharpe in the first half AND in the second half (M2).
2. The filtered variant has at least 30 trades per year in total over the 14 symbols (M1, full window).

Otherwise DROP. If the unfiltered variant itself has fewer than 30 trades per year, the result is DROP (trade floor) and the report says so. The deflated Sharpe (M3) is reported with every verdict; a KEEP with a probability below 0.95 is labeled "kept, not significant after deflation". A KEEP does not authorize trades.

## RVOL-at-time test (intraday)

RVOL-at-time: `services/research/indicators` `rvol_at_time` (definition in `docs/indicators.md`), lookback 20 sessions.

|#|Rule|Basis|
|---|---|---|
|R1|Data: the only intraday history on the rig, SPY 1-minute bars 2008-01-22 to 2021-05-06 (Kaggle `rockinbrock/spy-1-minute-data`, file `spy_1min_2008_2021_cleaned.csv`, SHA-256 `81d936c7462b07b178f1f4075b319662f219757acc9e24b977f1946c3729c49b`, the file of the noise-band test on branch `ws/noise-band`), aggregated to 5-minute bars (bar start time, America/New_York, regular session 09:30–16:00). Sessions with missing minutes are dropped (same check as the noise-band loader). No other symbol has 5-minute history here, so the test is SPY only.|T / A|
|R2|Strategy (first-half-hour momentum): at 10:00 ET, the return from the 09:30 open to the close of the 09:55 bar sets the direction: long if positive, short if negative, no trade if zero. Fill at the 10:00 bar open; exit at the close of the last bar of the session.|A|
|R3|Filter variant: trade only when RVOL-at-time(20) on the 09:55 bar is above 1.0. Base variant: no filter.|A|
|R4|Cost: 1 bp per side (primary, SPY intraday spread level, as in the noise-band test); 5 bp per side reported as a sensitivity.|A|
|R5|Metrics: daily returns (0 on days without a trade), Sharpe, CAGR, maximum drawdown and trades, full window and both halves (sessions split into two equal-count halves).|T / A|
|R6|Decision: KEEP the RVOL filter only if its Sharpe is higher than the base Sharpe in both halves and it has at least 30 trades per year. Otherwise DROP. Secondary (information only): Spearman rank correlation between RVOL at 09:55 and the absolute return from the 10:00 open to the session close, per half.|T / A|
|R7|Limits: one symbol, 2008–2021 only, third-party data. No claim is made for other symbols, other periods or daily bars.|T|

## Code and outputs

- Study code: `services/research/strategies/adx_filter.py` (strategies, engine, metrics, deflated Sharpe), `services/research/strategies/adx_filter_run.py` (data loading and report), `services/research/strategies/rvol_intraday.py` (R1–R6). Tests: `services/research/tests/test_adx_filter.py`.
- Raw outputs (rig): `~/Documents/reports/vertex-adx/` (`results.json`, `report.md`, `report.pdf`, `data/`).
- Summary shown in Vertex: `/backtests`, section "Filter studies".

## Results

Run 2026-10-31 on the rig, after the rules above were committed (commit `d3980c5b`). Raw output: `~/Documents/reports/vertex-adx/results.json` and `rvol_intraday.json` (rig).

### Data

- Yahoo daily bars, 14 symbols, 2004-01-02 to 2026-10-30 (GOOGL from 2004-08-19), 5,744 rows per symbol (GOOGL 5,586). No bar was dropped by D5. SHA-256 per file: `~/Documents/reports/vertex-adx/data/manifest.json` (rig).
- Window 2005-01-03 to 2026-10-30, 5,492 trading days. Second half starts 2015-11-30.

### ADX filter (5 bp per side, equal-weight 14-symbol portfolio)

|Strategy|Filter|Sharpe|1st half|2nd half|CAGR|Max DD|Trades|Trades/yr|DSR prob.|Verdict|
|---|---|---|---|---|---|---|---|---|---|---|
|SMA 20/50 cross|none|0.80|0.68|0.92|8.1%|22.3%|830|38.1|0.85|baseline|
|SMA 20/50 cross|ADX > 20|0.55|0.32|0.77|2.6%|14.0%|309|14.2|0.46|DROP (trade floor; Sharpe also lower in both halves)|
|20-day breakout|none|0.85|0.67|1.04|6.7%|17.6%|1,322|60.7|0.90|baseline|
|20-day breakout|ADX > 20|0.66|0.49|0.83|4.1%|15.4%|952|43.7|0.66|DROP (Sharpe lower in both halves)|
|RSI(2) dip|none|0.59|0.58|0.61|2.6%|8.6%|2,330|106.9|0.54|baseline|
|RSI(2) dip|ADX < 20|0.20|0.10|0.29|0.4%|7.2%|1,038|47.6|0.04|DROP (Sharpe lower in both halves)|
|RSI(2) dip|ADX falling 5 bars|0.52|0.51|0.52|1.8%|7.6%|1,747|80.2|0.40|DROP (Sharpe lower in both halves)|
|RSI(14) dip|none|0.32|0.41|0.28|0.6%|7.1%|119|5.5|0.12|baseline|
|RSI(14) dip|ADX < 20|−0.01|−0.11|0.06|0.0%|3.3%|22|1.0|0.00|DROP (trade floor: base below 30/yr)|
|RSI(14) dip|ADX falling 5 bars|0.35|0.31|0.41|0.2%|2.8%|20|0.9|0.16|DROP (trade floor: base below 30/yr)|
|EMT daily proxy|none|−0.26|0.02|−0.58|0.0%|1.4%|43|2.0|0.00|baseline|
|EMT daily proxy|ADX < 20|0.08|0.16|−0.02|0.0%|0.3%|10|0.5|0.01|DROP (trade floor: base below 30/yr)|
|EMT daily proxy|ADX falling 5 bars|0.06|0.03|0.12|0.0%|0.3%|9|0.4|0.01|DROP (trade floor: base below 30/yr)|

DSR prob. = deflated Sharpe probability over 13 trials (daily Sharpe variance across trials 4.47e-4). No variant reaches 0.95, including the unfiltered ones.

Verdict: no strategy keeps an ADX filter. For the two trend strategies the ADX > 20 entry filter lowers the Sharpe ratio in both halves; for the SMA cross it also removes 63% of the trades (14.2 per year, below the floor). For RSI(2) both mean-reversion filters lower the Sharpe ratio in both halves. RSI(14) and the EMT proxy trade fewer than 30 times per year even without a filter, so the rule cannot keep a filter for them; their filtered variants have 9–22 trades in 22 years and prove nothing.

### RVOL-at-time filter (SPY, 5-minute bars, first-half-hour momentum)

Sessions 2008-02-20 to 2021-05-06 (3,325 sessions; second half from 2014-09-30). Two sessions were dropped for missing minutes (2009-07-27, 2013-12-23).

|Cost per side|Variant|Sharpe|1st half|2nd half|CAGR|Max DD|Trades|Trades/yr|
|---|---|---|---|---|---|---|---|---|
|1 bp (primary)|none|0.05|0.31|−0.31|−0.3%|57.8%|3,293|250|
|1 bp (primary)|RVOL > 1.0|0.18|0.58|−0.29|1.3%|36.5%|1,347|102|
|5 bp|none|−1.33|−0.89|−1.97|−18.4%|95.7%|3,293|250|
|5 bp|RVOL > 1.0|−0.59|−0.15|−1.12|−6.6%|69.5%|1,347|102|

Spearman correlation of RVOL at 09:55 with the absolute 10:00-to-close move: 0.11 (first half), 0.14 (second half), 0.13 (full); about 1,660 sessions per half.

Verdict (R6): KEEP the RVOL filter for this strategy: its Sharpe is higher in both halves at 1 bp and at 5 bp, with 102 trades per year. At 1 bp the second-half gain is small (−0.31 to −0.29). The strategy itself does not work: the filtered version still loses in the second half (Sharpe −0.29) and at 5 bp in both halves. The filter mostly removes losing low-volume days. Higher RVOL goes with larger rest-of-day moves in both halves, which matches the source's description of RVOL as an activity measure. This result covers SPY 2008–2021 only (R7) and does not authorize trades.

### Checks

- EMT port: `emt_daily` gives the same signal dates, sides and exit reasons as the frozen `run()` of `bt.py` on all 14 symbols (43 trades).
- Engine parity: for SPY, QQQ, AAPL and XOM the Vertex strategy DSL engine (`runStrategyDefinition`, with the new `adx` indicator and `offset`) gives the same entry and exit days as the Python study kernel for SMA cross and breakout (with and without ADX > 20) and for RSI(2) with "ADX falling 5 bars". The only difference: one AAPL breakout trade on 2005-01-10, because the DSL run started with a position opened in the 2004 warm-up.
- Tests: `services/research/tests/test_adx_filter.py`, `test_rvol_intraday.py`, `test_study_runners.py`, `test_rvol_at_time.py` (100% branch coverage of the study modules except the `__main__` lines).

### Deviations and clarifications

- R5 does not say how to treat the first 20 sessions, where RVOL is undefined. Both variants start at the first session with a defined RVOL (2008-02-20).
- The RVOL at 09:55 is computed from the bars that start at or before 09:55 only. The values are the same; the full input is above the indicator row limit.
- The decision function reports the first failed check. For the SMA cross the Sharpe check also fails.
- E6 also applies to the EMT proxy. No EMT trade was open on the last bar, so this changes nothing.
- Editorial change after the run: R1 named the noise-band spec file, which is not on the base branch, so the docs check failed. R1 now gives the data file name and its SHA-256 (the same file; checked with `sha256sum` on 2026-10-31). The rule is unchanged.
