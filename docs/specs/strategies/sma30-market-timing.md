# 30-Day Moving Average Market Timing (research definition and backtest)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- Instagram post by @alanintelligence, sent by the owner on 2026-10-30 as a screenshot: owner Discord message (private) (card vertex-30dma-timing). The claims below are the creator's; they were not trusted before they were reproduced.
- Rule as stated: exit the US stock market when it closes below its 30-day moving average; re-enter when it closes above; hold Treasury bills while out.
- Claimed result, 1926-07 to 2026-06, from USD 1,000: USD 339.9 million with the rule vs USD 17.7 million buy-and-hold (19x), 1,936 trades, out of the market 36.12% of days, maximum drawdown 39.52% vs 84.07%, no costs. At 0.2% per trade the rule ends 60.13% behind buy-and-hold.
- Stated data: CRSP US market total return from the Kenneth R. French Data Library; nominal; before tax.

## Classification

Basis codes: S = stated by the creator; I = implied; A = Vertex default, fixed before the first full run.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Market: CRSP value-weighted US market total return, daily, from the French library (Mkt-RF + RF).|S|
|2|Level: a total-return index of rule 1. SMA = mean of the last 30 daily index levels, including today.|S / I|
|3|Signal at the close of day t: in when the index close is above the SMA, out when it is below. An exact tie keeps the previous state.|S / A|
|4|Execution: the new position earns the return of day t+1 (primary test). This equals a trade at the close of day t on that close's signal.|I (the creator's numbers match only this choice)|
|5|While out: earn the French RF series (1-month T-bill rate).|S|
|6|A trade is one position change (an exit or an entry). Cost per trade is a fraction of equity.|I (matches the 1,936 count)|
|7|Warm-up: invested until the first full 30-day window.|A|
|8|Sharpe ratio: annualized mean / standard deviation of daily returns in excess of the cash leg; annualized with the sample's own return days per calendar year (about 300 before 1952, when the NYSE traded on Saturdays).|A|
|9|Halves: the 1926-07 to 2026-06 sample split by day count at 1974-05-20 / 1974-05-21. The signal uses full history, so each half starts with its real state.|A|
|10|Modern proxy: SPY (Yahoo adjusted close, total return) for the market; BIL for cash from 2007-05-30 (SHV from 2007-01-11 as a check), French RF before that. The signal uses SPY's own adjusted index.|A|

## Pass/fail rule (fixed 2026-10-30, before the first full run)

The 30-day rule (rule 4 execution) passes only if, after 0.1% per trade, it has a higher Sharpe ratio AND a smaller maximum drawdown than buy-and-hold in BOTH halves of the French sample AND on the SPY + BIL proxy since 1993. Return alone is not the bar.

## Code and tests

- Rules: `services/research/strategies/sma_timing.py`.
- Tests: `services/research/tests/test_sma_timing.py` (17 hand-computed cases).
- Fetch: `research/backtests/sma30-timing/fetch_data.py`; run: `research/backtests/sma30-timing/run.py`; full output: `research/backtests/sma30-timing/results.json` (includes the data manifest with SHA-256 values).
- Data: French file `F-F_Research_Data_Factors_daily_CSV.zip` (fetched 2026-10-30, 1926-07-01 to 2026-09-30, 26,338 days); Yahoo SPY 1993-01-29, BIL 2007-05-30 and SHV 2007-01-11 to 2026-10-29. Not committed (terms do not allow redistribution).

## Results (2026-10-30, rig)

### Reproduction, 1926-07-01 to 2026-06-30

|Measure|Creator|Vertex (rule 4)|
|---|---|---|
|Final value from USD 1,000, rule|339.9 M|339.87 M|
|Final value, buy-and-hold|17.7 M|17.68 M|
|Trades|1,936|1,936|
|Days out|36.12%|36.12%|
|Max drawdown, rule / buy-and-hold|39.52% / 84.07%|39.52% / 84.07%|
|At 0.2% per trade vs buy-and-hold|−60.13%|−60.13%|

The claim reproduces exactly. CAGR 13.58% vs 10.27%; Sharpe 0.96 vs 0.47.

### Execution timing

|Execution|Final value (USD 1,000)|CAGR|Sharpe|Max DD|
|---|---|---|---|---|
|Same close (signal and return on day t; look-ahead, not tradable)|3.1 × 10^18|42.9%|3.14|−11.0%|
|Close t → day t+1 (creator)|339.9 M|13.6%|0.96|−39.5%|
|One day late (trade at the close of t+1)|9.6 M|9.6%|0.61|−34.4%|
|Buy-and-hold|17.7 M|10.3%|0.47|−84.1%|

A one-day delay removes 97% of the final value. The rule depends on next-day continuation of daily index moves. The creator's execution (close t → day t+1) needs the trade at, or just before, the same close that makes the signal. The French data has no opening prices, so "one day late" is the closest tradable proxy on this data.

### Costs (French sample, 30-day SMA)

|Cost per trade|Rule final (USD 1,000)|vs buy-and-hold|Sharpe|Max DD|One day late, Sharpe|
|---|---|---|---|---|---|
|0|339.9 M|+1,823%|0.96|−39.5%|0.61|
|0.05%|129.1 M|+630%|0.87|−40.2%|0.52|
|0.1%|49.0 M|+177%|0.78|−40.9%|0.43|
|0.2%|7.0 M|−60%|0.59|−43.5%|0.25|

Buy-and-hold: Sharpe 0.47, max DD −84.1%.

### Robustness (0.1% per trade unless stated)

|Test|Result|
|---|---|
|SMA 10/20/30/50/100/200, full sample|Every length beats buy-and-hold on Sharpe and max DD (Sharpe 0.65/0.64/0.78/0.70/0.69/0.69 vs 0.47). One day late, only 50/100/200 still beat it.|
|Start year 1930, 1940, 1950, 1960, 1970 (to 2026-06)|Beats on Sharpe and max DD; CAGR is below buy-and-hold from 1940 on.|
|Start year 1980, 1990, 2000, 2010, 2020|Fails: Sharpe 0.45/0.31/0.20/0.41/0.44 vs 0.52/0.52/0.42/0.76/0.65.|
|First half, 1926-07-01 to 1974-05-20|Pass: Sharpe 1.08 vs 0.43; max DD −40.9% vs −84.1%; CAGR 13.7% vs 8.3%.|
|Second half, 1974-05-21 to 2026-06-30|Fail: Sharpe 0.50 vs 0.51; max DD −40.0% vs −54.6%; CAGR 9.4% vs 12.1%. At 0.05% it still passes narrowly (0.60 vs 0.51).|

Explanation of the number: the first-order autocorrelation of daily market returns is +0.10 in the first half and −0.01 in the second half. A one-day-lag trend rule harvests positive autocorrelation. In the old daily index it most likely comes from stale prices of thinly traded stocks (a hypothesis; not tested here). It is gone in the modern market, and with it most of the edge.

### SPY + T-bill ETF proxy, 1993-02-01 to 2026-09-30

|Cost per trade|Rule Sharpe (close t → t+1)|Next open|One day late|Rule max DD|Buy-and-hold|
|---|---|---|---|---|---|
|0|0.39|0.37|0.31|−32.8%|Sharpe 0.52, max DD −55.2%|
|0.05% (estimated real cost for SPY/BIL)|0.29|0.27|0.21|−34.7%|same|
|0.1%|0.18|0.16|0.10|−36.6%|same|
|0.2%|−0.03|−0.05|−0.10|−49.1%|same|

CAGR at 0.1%: 3.8% vs 10.8% buy-and-hold (USD 1 grows to 3.55 vs 31.71). 777 trades; out 33.2% of days. SHV as cash gives the same picture (Sharpe 0.18 at 0.1%). The rule loses on Sharpe even at zero cost. Other lengths at 0.1%: 10/20/30/50/100 fail; 200-day gives Sharpe 0.54 vs 0.52 and max DD −24.8% vs −55.2%. That one window was not the tested rule and was found after the run, so it is not evidence.

"Next open" fills the switch at the next day's open (the overnight leg keeps the old position); "estimated real cost" assumes about 1 bp SPY and BIL spreads, near-zero commission and some close-auction slippage. It was not measured.

## Verdict: FAIL

|Check (0.1% per trade)|Sharpe|Max DD|Result|
|---|---|---|---|
|French first half|1.08 vs 0.43|−40.9% vs −84.1%|pass|
|French second half|0.5036 vs 0.5079|−40.0% vs −54.6%|fail by the strict rule; Sharpe is a near tie (difference 0.004)|
|SPY + BIL since 1993|0.18 vs 0.52|−36.6% vs −55.2%|clear fail (Sharpe)|

The second-half failure is a near tie and alone would not decide the verdict; the SPY + BIL failure is clear and does. The creator's numbers are correct for the data and execution he used. The result comes from the pre-1974 daily index and from trading at the signal close; it does not survive a one-day delay, realistic costs in the second half, or a tradable ETF since 1993. The drawdown reduction is real in every test, but it costs more return than it saves risk after 1980.

## Tax note (qualitative)

In a taxable account each exit realizes the gain; with about 20 trades per year almost every gain is short-term and taxed at ordinary income rates. Buy-and-hold defers tax. The tests are before tax, so they overstate the rule's after-tax result relative to buy-and-hold.

## Live expression

- No live use is proposed. The owner's options-only rule forbids new share positions, so the rule cannot be traded as share timing.
- The only compatible form is a regime filter: for example, "open new LEAPS calls only while the market is above its moving average". That is a different strategy. It needs its own pre-registered test on option data and must respect the per-name premium caps (6% of NLV for LEAPS, 2% for shorter options, including premium already open). The SPY results above give no support for a 30-day filter.
- A completed backtest does not authorize a trade.

## Limits

- French daily returns are rounded to 0.01%; the exact reproduction shows this does not change the result.
- Costs are a flat fraction per trade; no market impact, no borrow, no tax.
- The SPY proxy uses Yahoo adjusted prices (dividends reinvested at the ex-date close) and French RF as cash before BIL existed (1993-2007).
