# Analog and seasonal regime flags (frozen test rules)

Status: research only. No live or paper orders. No broker changes. Nothing here arms an engine or deploys to QuantVPS. A test result does not authorize trades.

Rules frozen: 2026-11-09, before the first study run. This file is committed before the run. Results are added below the line "Results" later; the rules above that line do not change after the first run. A deviation found later is listed under "Deviations" with its reason.

## Source

- FlexTiger newsletter, 2026-11-06, "10 Out of 10 Said Sell. 19 Out of 19 Say Get Ready." (free preview; the owner forwarded it on 2026-11-06, card `vertex-analog-regime-flag`). The claims below are the author's. They are not trusted before they are tested.
- Claim 1, "stretched + calm": the author searched 25 years of Nasdaq-100 history for days with "a big six-month run, a record high, far above the 200-day average, and calm". He found ten. "Every one of them dropped at least 4.6% within six weeks." The alert went out on 2026-10-07. He gives no thresholds.
- Claim 2, nearest analog: "On November 3 the AI found that today most resembled February 25, 2025, four trading days after that year's top." He gives no method.
- Claim 3, net liquidity: "The Fed's net liquidity drained $48 billion in the four weeks to October 28." He names it as a cause of the sell-off. He gives no rule.
- Claim 4, midterm seasonal: "Since 1950, the S&P 500 has been higher one year after every midterm election: 19 out of 19, measured from October 31 of the election year to October 31 of the next, with an average gain of about 15%."
- Not tested: the author's weekly QQQ "OUT" indicator and his asset plan. Both are behind the paywall and not disclosed.

Basis codes: S = stated by the source; I = implied by the source; A = Vertex default, fixed here before the run.

## Data

|#|Rule|Basis|
|---|---|---|
|G1|Daily bars from Yahoo Finance (`yfinance`), fetched 2026-11-09, last bar 2026-11-06: QQQ (from 1999-03-10), SPY (from 1993-01-29), `^NDX` (from 1985-10-01), `^GSPC` (from 1927-12-30), `^IRX` (13-week Treasury bill yield, percent).|A|
|G2|`close` is the split-adjusted price close without dividends. `adj_close` includes dividends. Event studies (tests A, B, D) use `close`. The timing test (test C) uses `adj_close`.|A|
|G3|FRED (keyless `fredgraph.csv`), fetched 2026-11-09: `WALCL` (Fed total assets, USD millions, Wednesday level), `WDTGAL` (Treasury General Account, USD millions, Wednesday level), `RRPONTSYD` (overnight reverse repurchase agreements, USD billions, daily). All start in 2002-12 or 2003-02.|S (series) / A (the Wednesday-level TGA series)|
|G4|A bar with a missing or non-positive close is dropped and reported.|A|
|G5|The data is not committed: Yahoo terms do not allow redistribution. The fetch script writes a manifest with the row counts, date ranges and SHA-256 of every file.|A|

## Shared definitions

|#|Rule|Basis|
|---|---|---|
|O1|"Six weeks" = 30 trading days. `fwd(t) = C(t+30) / C(t) − 1`, where `C` is the close.|S / A|
|O2|`mdd(t)` = the lowest value of `C(t+k) / C(t) − 1` for k = 1..30, and 0 when no close in the window is below `C(t)`.|I|
|O3|A day is a "hit" when `mdd(t) ≤ −4.6%`. The 4.6% bar is the author's number. He took it from his own ten cases, so it is fitted to his sample.|S|
|O4|A day whose 30-day window ends after the last bar is "open". Open days are listed but not counted in any rate.|A|
|O5|Binomial test: exact, one-sided, `P(X ≥ k)` for `n` trials with success rate `p0`.|A|
|O6|A normal approximation gives the p-value of a Spearman rank correlation (`z = ρ √(n − 1)`) and of a difference of two means (Welch standard error). Both are one-sided.|A|
|O7|Verdict words: PASS, FAIL, INCONCLUSIVE (not enough events to decide).|A|

## Test A: "stretched + calm" (event study)

|#|Rule|Basis|
|---|---|---|
|A1|In-sample series: QQQ, 1999-03-10 to 2026-11-06. This period contains the author's 25 years. Holdout series: `^NDX`, events from 1985-10-01 to 1999-03-09. The author's 25-year search did not use this period.|S / A|
|A2|`run(t) = C(t) / C(t−126) − 1` (six months = 126 trading days).|S / A|
|A3|`stretch(t) = C(t) / SMA200(t) − 1`. SMA200 is the mean of the last 200 closes, including day t.|S / A|
|A4|`vol(t)` = sample standard deviation of the last 21 daily log returns, times √252.|I / A|
|A5|`since_high(t)` = trading days since the last record close of the series up to day t (0 = day t is a record close).|S / A|
|A6|Signal day: `run ≥ 20%` AND `stretch ≥ 10%` AND `vol ≤ 15%` AND `since_high ≤ 4`. The first 200 days of a series have no signal.|A (the author gives no thresholds)|
|A7|Episode start: the first signal day, and after that each signal day that is at least 30 trading days after the previous episode start. The 30-day windows of two episodes never overlap.|A|
|A8|Base rates, on days with all features defined and a complete window: (i) all days; (ii) near-record days (`since_high ≤ 4`).|A|
|A9|Grid (54 cells, robustness only): run 15 / 20 / 25%, stretch 8 / 10 / 12%, vol 12 / 15 / 18%, high = record close or 252-day closing high (each within the last 5 trading days). The base rate of a cell uses the near-high days of its own high type.|A|
|A10|Claim check: with the data cut at the 2026-10-06 close, list the episodes of rule A6 and of each grid cell. Report whether any cell gives exactly ten complete episodes that are all hits, and whether 2026-09-30 to 2026-10-06 contains a signal day.|S|

Pass rule (use: a risk-off input), fixed before the first run. With `n` = complete episodes of rule A6 on QQQ:

1. `n < 8`: INCONCLUSIVE.
2. Else FAIL unless all three are true: (a) the binomial p-value of the hits against the near-record base rate is at most 0.05; (b) the mean `fwd` of the episodes is below the mean `fwd` of all days; (c) at least half of the grid cells with 8 or more complete episodes have a hit rate above their base rate.
3. Else, holdout: fewer than 5 complete episodes: INCONCLUSIVE. Hit rate above the holdout near-record base rate: PASS. Otherwise FAIL.

## Test B: nearest analog of a past top (walk-forward)

|#|Rule|Basis|
|---|---|---|
|B1|Series: QQQ in-sample and `^NDX` 1985-10-01 to 1999-03-09 holdout, as in A1.|A|
|B2|Tops: a 10% zigzag on closes. A top is confirmed on the first day the close is at most 0.90 × the highest close since the last confirmed bottom. A bottom is confirmed on the first day the close is at least 1.10 × the lowest close since the last confirmed top. Before the first pivot, both conditions are checked against the running high and low from the first bar. The earliest day wins a tie for the extreme.|A|
|B3|Path of day t: `p(i) = ln(C(t−62+i) / C(t))`, i = 0..62 (63 closes, about three months).|A|
|B4|Distance between two days: the root mean square of the differences of their paths.|A|
|B5|Candidates for query day t: the days `s = T + k`, k = 0..10, for every top `T` that is confirmed on or before day t, with `s + 30 ≤ t` (the analog's own six-week outcome is known on day t) and at least 63 closes up to `s`.|I ("four trading days after that year's top") / A|
|B6|Nearest analog: the candidate with the smallest distance `d(t)`; the latest `s` wins a tie. Its outcomes are `fwd(s)` and `mdd(s)`.|A|
|B7|Sample days: the first day on which at least five tops have a candidate, then every 30th trading day. Forward windows do not overlap.|A|
|B8|A sample day is "top-like" when fewer than 20% of the earlier sample days have a smaller `d`. The first 20 sample days are not classified and are not counted.|A|
|B9|Test 1 (does resemblance carry risk): hits of the top-like days against the hit rate of the other classified sample days (binomial, O5), and mean `fwd` of both groups.|A|
|B10|Test 2 (does the name of the analog carry information): Spearman rank correlation of `fwd(s)` of the nearest analog with `fwd(t)`, over all classified sample days (O6).|A|
|B11|Variants (6, robustness only): path length 42 / 63 / 126 closes × zigzag 10% / 15%.|A|
|B12|Claim check: the nearest analogs of 2026-11-03. Report the three nearest tops and the rank of 2025-02-25 among all candidates.|S|

Pass rule (use: a risk-off input), fixed before the first run. With `n` = top-like sample days on QQQ:

1. `n < 8`: INCONCLUSIVE.
2. Else FAIL unless all four are true: (a) Test 1 p-value at most 0.05; (b) mean `fwd` of the top-like days below the mean `fwd` of the other days; (c) Test 2 `ρ > 0` with a p-value at most 0.05; (d) at least half of the variants have a top-like hit rate above the hit rate of their other days.
3. Else, holdout: fewer than 5 top-like days: INCONCLUSIVE. Top-like hit rate above the hit rate of the other holdout days: PASS. Otherwise FAIL.

## Test C: Fed net liquidity drain (timing rule)

|#|Rule|Basis|
|---|---|---|
|C1|`NL(w) = WALCL(w) − WDTGAL(w) − RRP(w)` in USD millions, on each `WALCL` date `w` (a Wednesday). `RRP(w)` is the last non-blank `RRPONTSYD` value dated from `w − 6` days to `w`, times 1,000; it is 0 when there is none. A week without a `WDTGAL` value is dropped and reported.|S / A|
|C2|`Δ4(w) = NL(w) / NL(w − 4 weeks) − 1`, where "4 weeks" is four observations earlier.|S / A|
|C3|Availability: week `w` is known at the close of the third trading day after `w`. (The Fed publishes on Thursday at 16:30 ET, and on Friday in some holiday weeks. Both are after the close, so the third day is one day later than the earliest possible trade.) The state at a close is the flag of the latest known week.|A|
|C4|Flag on (risk-off) when `Δ4(w) < 0`. Other thresholds, robustness only: `≤ −0.5%`, `≤ −1%`, `≤ −2%`.|I / A|
|C5|Timing rule: hold the asset over day d when the state at the close of day d−1 is off; hold cash when it is on. Asset return: `adj_close`. Asset: QQQ (primary) and SPY.|A|
|C6|Cash return of day d: `^IRX` close of day d−1 / 100 / 252. A missing yield takes the last known value.|A|
|C7|Cost: 0.05% of equity on each position change.|A|
|C8|Window: from the first day with a known state to 2026-11-06. Halves: the trading days of the window split into two halves of equal count (the first half gets the extra day).|A|
|C9|Statistics as in `strategies/sma_timing.py`: Sharpe ratio of daily returns in excess of cash, maximum drawdown, CAGR, trades, share of days out. Buy-and-hold is the same asset, fully invested.|A|
|C10|Event comparison: every fourth week `w` (windows do not overlap), the QQQ `close` return from the availability day of week `w` to the availability day of week `w + 4`. Mean of the flag-on weeks against the mean of the flag-off weeks (O6).|A|
|C11|Eras, report only: before 2008-09-01; 2008-09-01 to 2019-12-31; from 2020-01-01.|A|

Pass rule (use: a risk-off input), fixed before the first run: PASS only if, on QQQ with rule C4 (`Δ4 < 0`) and cost C7, the timing rule has a higher Sharpe ratio AND a smaller maximum drawdown than buy-and-hold in BOTH halves, AND the flag-on mean of C10 is below the flag-off mean with a p-value at most 0.05. Otherwise FAIL.

## Test D: midterm election seasonal (claim check)

|#|Rule|Basis|
|---|---|---|
|D1|Series: `^GSPC` close (price index, no dividends).|S|
|D2|`anchor(Y, m)` = the last close on or before the last calendar day of month `m` in year `Y`. Window return `R(Y, m) = anchor(Y+1, m) / anchor(Y, m) − 1`.|S|
|D3|Midterm years: `Y mod 4 = 2`. Claim sample: `m = 10`, `Y` = 1950 to 2022 (19 windows).|S|
|D4|Base rate `p0`: the share of positive `R(Y, 10)` over the non-midterm years 1950 to 2025.|A|
|D5|Significance: binomial p-value (O5) of the positive midterm windows against `p0`, times 48 (Bonferroni: 12 start months × 4 years of the election cycle), capped at 1.|A|
|D6|Scan, report only: positives, count and mean of `R(Y, m)` for all 48 combinations of `m` and `Y mod 4`, start years 1950 to 2025, complete windows only.|A|
|D7|Halves: mean `R(Y, 10)` of midterm years against non-midterm years, for start years 1950 to 1986 and 1987 to 2025.|A|
|D8|Holdout: the midterm years 1930, 1934, 1938, 1942, 1946 (`m = 10`). The author's "since 1950" does not use them.|A|
|D9|Risk inside the window, report only: the largest peak-to-trough fall of the close inside each midterm window.|A|

Pass rule (use: a risk-on bias input), fixed before the first run: PASS only if (a) all 19 midterm windows of D3 are positive; (b) the adjusted p-value of D5 is at most 0.05; (c) the midterm mean is above the non-midterm mean in both halves of D7; (d) at least 4 of the 5 holdout windows are positive. Otherwise FAIL.

## Trials

Each variant is one trial, and the primary rule of a test is one of its variants. A: 54 grid cells. B: 6 variants. C: 4 thresholds × 2 assets = 8. D: 48 scan cells. Only the primary rule of each test decides its verdict. The variants show whether the primary result depends on one parameter choice.

## Use

- A test that passes makes its flag a candidate input for manual review. It does not connect the flag to an engine, to the regime composite (`strategies/composite.py`) or to any order path. That needs its own card and an owner decision.
- A test that fails or is inconclusive: the flag is not used.

## Code and tests

- Rules: `services/research/strategies/regime_flags/` (pure functions; no orders, no network, no file access).
- Tests: `services/research/tests/test_regime_flags.py`.
- Fetch: `research/backtests/analog-regime-flags/fetch_data.py`; run: `research/backtests/analog-regime-flags/run.py`.

## Results

Not run yet.
