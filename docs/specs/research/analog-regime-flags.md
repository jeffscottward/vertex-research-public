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
|A6|Signal day: `run ≥ 20%` AND `stretch ≥ 10%` AND `vol ≤ 15%` AND `since_high ≤ 4`. A day with fewer than 200 closes up to it has no signal.|A (the author gives no thresholds)|
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

- Rules: `services/research/strategies/regime_flags/` (no orders, no network; only `data.py` reads files: the fetched CSV files).
- Tests: `services/research/tests/test_regime_flags.py`.
- Fetch: `research/backtests/analog-regime-flags/fetch_data.py`; run: `research/backtests/analog-regime-flags/run.py`.

## Results (2026-11-09, rig)

The tables from "Data" to "Readings at the last bar" are the output of `run.py` (`--markdown`), not edited. Text marked "After the run" is not a frozen rule and decides no verdict.

### Data

|File|Rows|First|Last|Dropped bars (rule G4)|SHA-256 (first 12)|
|---|---|---|---|---|---|
|QQQ.csv|6960|1999-03-10|2026-11-06|0|`f3453a778ecd`|
|SPY.csv|8502|1993-01-29|2026-11-06|0|`1634fab0345a`|
|NDX.csv|10356|1985-10-01|2026-11-06|0|`db0ccb160809`|
|GSPC.csv|24831|1927-12-30|2026-11-06|0|`d16b2ecebf08`|
|IRX.csv|16698|1960-01-04|2026-11-06|0|`f214f269c1d0`|
|WALCL.csv|1247|2002-12-18|2026-11-04|n/a|`939724feb453`|
|WDTGAL.csv|1247|2002-12-18|2026-11-04|n/a|`a0964d0c7dd3`|
|RRPONTSYD.csv|6196|2003-02-07|2026-11-06|n/a|`bef48570f482`|

### Test A: stretched + calm

|Sample (rule A6)|Signal days|Episodes (complete)|Hits|Near-record days|All days|p against near-record|Mean `fwd`, episodes|Mean `fwd`, all days|
|---|---|---|---|---|---|---|---|---|
|QQQ 1999-03-10 to 2026-11-06|78|8 (7)|2/7 (29%)|254/829 (31%)|2525/6731 (38%)|0.6840|1.0%|1.3%|
|`^NDX` holdout to 1999-03-09|61|8 (8)|3/8 (38%)|224/697 (32%)|1066/3197 (33%)|0.5021|0.3%|2.9%|

Episodes of rule A6, QQQ:

|Start|Run|Stretch|Vol|`mdd`|`fwd`|Hit|
|---|---|---|---|---|---|---|
|2017-05-08|20.9%|12.4%|7.5%|−1.3%|1.1%|no|
|2019-07-10|20.7%|10.3%|11.7%|−6.1%|−2.0%|yes|
|2020-12-10|28.3%|20.2%|14.7%|−0.2%|8.6%|no|
|2021-08-31|22.9%|14.4%|10.4%|−7.2%|−5.3%|yes|
|2021-11-05|22.4%|14.6%|10.9%|−4.5%|−4.5%|no|
|2024-06-07|20.2%|13.4%|11.0%|0.0%|3.8%|no|
|2025-09-09|22.8%|11.5%|11.8%|0.0%|5.3%|no|
|2026-10-02|28.1%|12.1%|15.0%|open (−13.7% to 2026-11-06)|open|open|

Episodes of rule A6, `^NDX` holdout:

|Start|Run|Stretch|Vol|`mdd`|`fwd`|Hit|
|---|---|---|---|---|---|---|
|1987-03-18|36.4%|21.1%|13.9%|−3.5%|−0.7%|no|
|1987-06-18|34.5%|16.8%|11.9%|−2.6%|2.1%|no|
|1987-08-11|20.9%|19.4%|13.7%|−5.3%|−2.1%|yes|
|1989-05-26|29.4%|17.9%|8.9%|−4.6%|−2.1%|no|
|1989-08-25|20.1%|13.7%|11.6%|−0.2%|7.2%|no|
|1989-10-09|24.0%|17.0%|8.1%|−9.1%|−5.6%|yes|
|1993-01-06|23.3%|15.2%|14.5%|−5.7%|−5.1%|yes|
|1995-05-15|20.1%|17.2%|14.1%|−0.9%|8.5%|no|

Grid (rule A9), QQQ: 44 of 54 cells have 8 or more complete episodes; 32 of them have a hit rate above their base rate. 15 of the 54 cells with an episode have p ≤ 0.05 before a correction; 6 remain after Benjamini-Hochberg at q = 0.05.

|High|Run ≥|Stretch ≥|Vol ≤ 12%|Vol ≤ 15%|Vol ≤ 18%|
|---|---|---|---|---|---|
|record|15%|8%|4/15 (27%)|5/17 (29%)|11/28 (39%)|
|record|15%|10%|3/14 (21%)|4/16 (25%)|10/27 (37%)|
|record|15%|12%|3/9 (33%)|4/12 (33%)|10/21 (48%)|
|record|20%|8%|2/8 (25%)|2/8 (25%)|10/18 (56%)|
|record|20%|10%|2/7 (29%)|2/7 (29%)|10/17 (59%)|
|record|20%|12%|1/6 (17%)|1/6 (17%)|9/16 (56%)|
|record|25%|8%|2/4 (50%)|3/5 (60%)|9/11 (82%)|
|record|25%|10%|2/4 (50%)|2/4 (50%)|8/10 (80%)|
|record|25%|12%|2/4 (50%)|2/4 (50%)|8/10 (80%)|
|252-day|15%|8%|10/32 (31%)|14/41 (34%)|17/53 (32%)|
|252-day|15%|10%|7/28 (25%)|11/37 (30%)|14/49 (29%)|
|252-day|15%|12%|9/21 (43%)|14/30 (47%)|19/40 (48%)|
|252-day|20%|8%|3/14 (21%)|9/21 (43%)|14/32 (44%)|
|252-day|20%|10%|3/13 (23%)|9/20 (45%)|14/31 (45%)|
|252-day|20%|12%|3/11 (27%)|9/18 (50%)|14/29 (48%)|
|252-day|25%|8%|5/9 (56%)|9/14 (64%)|15/21 (71%)|
|252-day|25%|10%|5/9 (56%)|8/13 (62%)|14/20 (70%)|
|252-day|25%|12%|4/8 (50%)|7/12 (58%)|13/19 (68%)|

Hits / complete episodes per cell. Base rates: near-record days 254/829 (31%), near-252-day-high days 497/1634 (30%).

After the run (not a frozen rule): the cells that remain after Benjamini-Hochberg, and the same cells on the `^NDX` holdout.

|Cell|QQQ hits|QQQ p|QQQ mean `fwd`|Holdout hits|Holdout near-high days|Holdout mean `fwd`|
|---|---|---|---|---|---|---|
|252-day high, run ≥ 25%, stretch ≥ 8%, vol ≤ 18%|15/21 (71%)|0.0001|−2.0%|2/11 (18%)|227/734 (31%)|4.1%|
|252-day high, run ≥ 25%, stretch ≥ 10%, vol ≤ 18%|14/20 (70%)|0.0003|−1.9%|2/11 (18%)|227/734 (31%)|4.1%|
|record, run ≥ 25%, stretch ≥ 8%, vol ≤ 18%|9/11 (82%)|0.0007|−3.6%|2/11 (18%)|224/697 (32%)|4.1%|
|252-day high, run ≥ 25%, stretch ≥ 12%, vol ≤ 18%|13/19 (68%)|0.0007|−1.8%|2/11 (18%)|227/734 (31%)|4.1%|
|record, run ≥ 25%, stretch ≥ 10%, vol ≤ 18%|8/10 (80%)|0.0019|−3.7%|2/11 (18%)|224/697 (32%)|4.1%|
|record, run ≥ 25%, stretch ≥ 12%, vol ≤ 18%|8/10 (80%)|0.0019|−3.7%|2/11 (18%)|224/697 (32%)|4.1%|

After the run (not a frozen rule): the open episode is a hit already. When its window is complete, rule A6 has 3 hits in 8 episodes; the p-value against the near-record base rate of today is 0.4644.

Claim check (rule A10), data cut at 2026-10-06: rule A6 gives 8 episodes, 7 complete, 2 hits. Cells with exactly ten complete episodes that are all hits: 0 of 54. Signal days of rule A6 from 2026-09-30 to 2026-10-06: 2026-10-02, 2026-10-05, 2026-10-06.

Verdict A: **INCONCLUSIVE**

### Test B: nearest analog of a past top

|Sample|Tops|Sample days (counted)|Top-like hits|Other days hits|p (Test 1)|Mean `fwd`, top-like|Mean `fwd`, others|ρ (Test 2)|p (Test 2)|
|---|---|---|---|---|---|---|---|---|---|
|QQQ, path 63, zigzag 10%|56|223 (202)|20/93 (22%)|38/109 (35%)|0.9982|1.6%|2.2%|−0.01|0.5579|
|`^NDX` holdout to 1999-03-09|20|89 (69)|5/16 (31%)|18/53 (34%)|0.6802|1.5%|4.3%|0.09|0.2258|

The distance to the nearest analog falls as the library of tops grows, so rule B8 marks more than 20% of the later days as top-like.

Variants (rule B11), QQQ:

|Sample|Tops|Sample days (counted)|Top-like hits|Other days hits|p (Test 1)|Mean `fwd`, top-like|Mean `fwd`, others|ρ (Test 2)|p (Test 2)|
|---|---|---|---|---|---|---|---|---|---|
|path 42, zigzag 10%|56|223 (202)|29/87 (33%)|42/115 (37%)|0.7654|0.6%|3.0%|0.04|0.2740|
|path 42, zigzag 15%|26|217 (196)|19/91 (21%)|37/105 (35%)|0.9990|1.6%|2.0%|0.11|0.0546|
|path 63, zigzag 10%|56|223 (202)|20/93 (22%)|38/109 (35%)|0.9982|1.6%|2.2%|−0.01|0.5579|
|path 63, zigzag 15%|26|217 (196)|24/89 (27%)|32/107 (30%)|0.7623|0.6%|2.9%|0.06|0.1844|
|path 126, zigzag 10%|56|222 (201)|27/98 (28%)|32/103 (31%)|0.8045|1.2%|2.5%|−0.04|0.7086|
|path 126, zigzag 15%|26|217 (196)|25/89 (28%)|31/107 (29%)|0.6122|0.1%|3.2%|0.06|0.2203|

Claim check (rule B12): nearest analogs of 2026-11-03, one per top:

|Analog day|Top|Days after the top|Distance|`fwd` after the analog day|`mdd` after it|
|---|---|---|---|---|---|
|2025-03-04|2025-02-19|9|0.0253|−7.6%|−16.0%|
|2011-08-05|2011-07-26|8|0.0316|5.2%|−7.1%|
|2004-07-15|2004-06-30|10|0.0349|−1.9%|−7.4%|

2025-02-25 has rank 21 of 583 candidates (distance 0.0488; its top is 2025-02-19, 4 trading days earlier).

Verdict B: **FAIL**

### Test C: Fed net liquidity drain

1247 weeks from 2002-12-18 to 2026-11-04; 0 dropped (no `WDTGAL` value). `Δ4 < 0` in 516 of 1243 weeks.

Primary rule (C4, cost 0.05% per switch):

|Asset|Flag|Period|Sharpe, rule / hold|Max DD, rule / hold|CAGR, rule / hold|Trades|Days out|Better on both|
|---|---|---|---|---|---|---|---|---|
|QQQ|Δ4 < 0|full (2003-01-22 to 2026-11-06)|0.53 / 0.70|−49.7% / −53.4%|9.8% / 15.6%|337|41%|no|
|QQQ|Δ4 < 0|first half (2003-01-22 to 2014-12-10)|0.55 / 0.64|−49.7% / −53.4%|10.0% / 13.5%|178|35%|no|
|QQQ|Δ4 < 0|second half (2014-12-11 to 2026-11-06)|0.51 / 0.76|−25.7% / −35.1%|9.6% / 17.7%|159|48%|no|
|QQQ|Δ4 < 0|before 2008-09 (2003-01-22 to 2008-08-29)|0.19 / 0.54|−17.2% / −24.9%|4.6% / 11.9%|102|38%|no|
|QQQ|Δ4 < 0|2008-09 to 2019 (2008-09-02 to 2019-12-31)|0.71 / 0.78|−41.8% / −44.5%|11.6% / 15.6%|142|40%|no|
|QQQ|Δ4 < 0|from 2020 (2020-01-02 to 2026-11-06)|0.50 / 0.70|−25.7% / −35.1%|11.3% / 18.6%|93|47%|no|

Other thresholds and SPY (robustness only):

|Asset|Flag|Period|Sharpe, rule / hold|Max DD, rule / hold|CAGR, rule / hold|Trades|Days out|Better on both|
|---|---|---|---|---|---|---|---|---|
|QQQ|Δ4 ≤ −0.5%|full (2003-01-22 to 2026-11-06)|0.56 / 0.70|−54.0% / −53.4%|10.9% / 15.6%|288|32%|no|
|QQQ|Δ4 ≤ −0.5%|first half (2003-01-22 to 2014-12-10)|0.62 / 0.64|−54.0% / −53.4%|11.9% / 13.5%|138|22%|no|
|QQQ|Δ4 ≤ −0.5%|second half (2014-12-11 to 2026-11-06)|0.51 / 0.76|−28.6% / −35.1%|9.9% / 17.7%|150|41%|no|
|QQQ|Δ4 ≤ −1.0%|full (2003-01-22 to 2026-11-06)|0.65 / 0.70|−51.5% / −53.4%|13.0% / 15.6%|232|24%|no|
|QQQ|Δ4 ≤ −1.0%|first half (2003-01-22 to 2014-12-10)|0.74 / 0.64|−51.5% / −53.4%|15.0% / 13.5%|100|14%|yes|
|QQQ|Δ4 ≤ −1.0%|second half (2014-12-11 to 2026-11-06)|0.56 / 0.76|−28.6% / −35.1%|11.2% / 17.7%|132|34%|no|
|QQQ|Δ4 ≤ −2.0%|full (2003-01-22 to 2026-11-06)|0.71 / 0.70|−52.5% / −53.4%|15.0% / 15.6%|142|12%|yes|
|QQQ|Δ4 ≤ −2.0%|first half (2003-01-22 to 2014-12-10)|0.78 / 0.64|−52.5% / −53.4%|16.5% / 13.5%|42|6%|yes|
|QQQ|Δ4 ≤ −2.0%|second half (2014-12-11 to 2026-11-06)|0.63 / 0.76|−28.6% / −35.1%|13.6% / 17.7%|100|18%|no|
|SPY|Δ4 < 0|full (2003-01-22 to 2026-11-06)|0.45 / 0.58|−45.2% / −55.2%|7.7% / 11.3%|337|41%|no|
|SPY|Δ4 < 0|first half (2003-01-22 to 2014-12-10)|0.43 / 0.48|−45.2% / −55.2%|7.4% / 9.3%|178|35%|no|
|SPY|Δ4 < 0|second half (2014-12-11 to 2026-11-06)|0.48 / 0.68|−32.2% / −33.7%|8.1% / 13.3%|159|48%|no|
|SPY|Δ4 ≤ −0.5%|full (2003-01-22 to 2026-11-06)|0.48 / 0.58|−50.9% / −55.2%|8.5% / 11.3%|288|32%|no|
|SPY|Δ4 ≤ −0.5%|first half (2003-01-22 to 2014-12-10)|0.51 / 0.48|−50.9% / −55.2%|9.2% / 9.3%|138|22%|yes|
|SPY|Δ4 ≤ −0.5%|second half (2014-12-11 to 2026-11-06)|0.45 / 0.68|−33.7% / −33.7%|7.8% / 13.3%|150|41%|no|
|SPY|Δ4 ≤ −1.0%|full (2003-01-22 to 2026-11-06)|0.52 / 0.58|−51.5% / −55.2%|9.5% / 11.3%|232|24%|no|
|SPY|Δ4 ≤ −1.0%|first half (2003-01-22 to 2014-12-10)|0.59 / 0.48|−51.5% / −55.2%|10.9% / 9.3%|100|14%|yes|
|SPY|Δ4 ≤ −1.0%|second half (2014-12-11 to 2026-11-06)|0.45 / 0.68|−33.7% / −33.7%|8.0% / 13.3%|132|34%|no|
|SPY|Δ4 ≤ −2.0%|full (2003-01-22 to 2026-11-06)|0.61 / 0.58|−49.3% / −55.2%|11.4% / 11.3%|142|12%|yes|
|SPY|Δ4 ≤ −2.0%|first half (2003-01-22 to 2014-12-10)|0.67 / 0.48|−49.3% / −55.2%|12.9% / 9.3%|42|6%|yes|
|SPY|Δ4 ≤ −2.0%|second half (2014-12-11 to 2026-11-06)|0.53 / 0.68|−33.7% / −33.7%|9.8% / 13.3%|100|18%|no|

Event comparison (rule C10), QQQ `close`, four-week returns:

|Flag|Weeks on|Weeks off|Mean, flag on|Mean, flag off|p (on below off)|
|---|---|---|---|---|---|
|Δ4 < 0|132|178|0.87%|1.52%|0.1515|
|Δ4 ≤ −0.5%|100|210|0.62%|1.54%|0.0864|
|Δ4 ≤ −1.0%|73|237|0.10%|1.60%|0.0260|
|Δ4 ≤ −2.0%|36|274|−0.62%|1.49%|0.0316|

Verdict C: **FAIL**

### Test D: midterm election seasonal

Claim (rule D3): 19 of 19 midterm windows are positive; mean 16.6%. Non-midterm windows 1950 to 2025: 42 of 57 positive (74%); mean 6.9%. Binomial p = 0.0030; times 48 = 0.1450.

|Start years|Midterm mean|Non-midterm mean|
|---|---|---|
|1950-1986|17.9%|4.7%|
|1987-2025|15.2%|8.9%|

|Sample|Start|End|Return|Largest fall inside|
|---|---|---|---|---|
|holdout|1930-10-31|1931-10-30|−38.4%|−51.5%|
|holdout|1934-10-31|1935-10-31|41.4%|−15.9%|
|holdout|1938-10-31|1939-10-31|−2.6%|−24.4%|
|holdout|1942-10-30|1943-10-29|27.2%|−9.3%|
|holdout|1946-10-31|1947-10-31|4.0%|−14.7%|
|claim|1950-10-31|1951-10-31|17.5%|−8.1%|
|claim|1954-10-29|1955-10-31|33.6%|−10.6%|
|claim|1958-10-31|1959-10-30|12.1%|−9.2%|
|claim|1962-10-31|1963-10-31|30.9%|−4.1%|
|claim|1966-10-31|1967-10-31|16.3%|−6.5%|
|claim|1970-10-30|1971-10-29|13.2%|−10.7%|
|claim|1974-10-31|1975-10-31|20.5%|−14.1%|
|claim|1978-10-31|1979-10-31|9.3%|−10.1%|
|claim|1982-10-29|1983-10-31|22.3%|−7.1%|
|claim|1986-10-31|1987-10-30|3.2%|−33.2%|
|claim|1990-10-31|1991-10-31|29.1%|−6.1%|
|claim|1994-10-31|1995-10-31|23.1%|−5.7%|
|claim|1998-10-30|1999-10-29|24.1%|−12.1%|
|claim|2002-10-31|2003-10-31|18.6%|−14.7%|
|claim|2006-10-31|2007-10-31|12.4%|−9.4%|
|claim|2010-10-29|2011-10-31|5.9%|−19.4%|
|claim|2014-10-31|2015-10-30|3.0%|−12.4%|
|claim|2018-10-31|2019-10-31|12.0%|−16.4%|
|claim|2022-10-31|2023-10-31|8.3%|−10.3%|

Scan (rule D6): 2 of 48 cells have only positive windows. The claim's cell (October, midterm) has rank 2 by share positive, then by mean. Holdout (rule D8): 3 of 5 positive. The ten best cells:

|Start month end|Cycle year of the start|Positive|Mean|
|---|---|---|---|
|Jul|midterm|19/19|19.3%|
|Oct|midterm|19/19|16.6%|
|Aug|midterm|18/19|20.4%|
|Jun|midterm|18/19|19.7%|
|May|midterm|18/19|15.2%|
|Nov|midterm|18/19|14.7%|
|Sep|midterm|17/19|20.4%|
|Dec|midterm|17/19|17.2%|
|Apr|midterm|17/19|14.7%|
|Oct|pre-election|17/19|8.7%|

Verdict D: **FAIL**

### Readings at the last bar (2026-11-06)

Descriptive only. A reading is not a signal: see the verdicts.

|Flag|Reading|State|
|---|---|---|
|A stretched + calm|run −7.8%, stretch −3.6%, vol 32.1%, 23 trading days since the record close|off (last signal day: 2026-10-07)|
|B nearest analog|2011-08-09, 10 trading days after the top of 2011-07-26; distance 0.0415|77% of the sample days had a smaller distance (top-like needs under 20%)|
|C net liquidity|week 2026-10-28: USD 5.730 trillion, Δ4 −0.31% (USD −18 billion)|on (drain)|
|D midterm window|opened at the 2026-10-30 close (7580.07); −2.7% to 2026-11-06|open until the last close on or before 2027-10-31|

## Verdicts

|Test|Flag|Verdict|Reason|
|---|---|---|---|
|A|Stretched + calm|INCONCLUSIVE|7 complete episodes; the rule needs 8. The 7 show nothing: 2 hits (29%) against 31% on any near-record day, and a mean `fwd` of 1.0% against 1.3% on all days. The open eighth episode cannot turn this into a pass (see "Limits").|
|B|Nearest analog of a past top|FAIL|Top-like days had fewer hits than the other days (22% against 35%) and the analog's outcome did not rank the day's outcome (ρ = −0.01).|
|C|Fed net liquidity drain|FAIL|The timing rule had a smaller maximum drawdown than buy-and-hold in both halves (−49.7% against −53.4%; −25.7% against −35.1%) but a lower Sharpe ratio in both (0.55 against 0.64; 0.51 against 0.76). The four-week return after a drain was not reliably lower (p = 0.15).|
|D|Midterm election seasonal|FAIL|The count reproduces (19 of 19; the mean is 16.6% against the author's "about 15%") and the midterm mean is higher in both halves. But the adjusted p-value is 0.145, and the holdout has 3 of 5 positive windows with a loss of 38.4% in 1930 to 1931.|

No flag is used. No flag is connected to an engine, to the regime composite or to an order path.

## What the tests say about the four claims

- Claim 1 ("10 out of 10"). No cell of the grid gives ten episodes that are all hits. Rule A6 did signal on 2026-10-02, 2026-10-05 and 2026-10-06, the three trading days up to the record close of 2026-10-06, and again on 2026-10-07. That episode is a hit already. But the earlier signals of the same rule were hits no more often than any day near a record. The cells with the highest hit rate on QQQ (run ≥ 25%, vol ≤ 18%: 8 of 10 and 9 of 11) have 2 hits in 11 episodes on the `^NDX` holdout, below the holdout base rate, and a mean `fwd` of +4.1% there. The pattern depends on the thresholds and on the period. One correct call in 2026 is not evidence for it.
- Claim 2 (nearest analog). The finder agrees with the author on the top: for 2026-11-03 the nearest analog is 2025-03-04, nine trading days after the top of 2025-02-19. The author's day, 2025-02-25, has rank 21 of 583. But over 27 years a top-like day did not have a higher hit rate than another day, in any of the six variants or on the holdout. The mean `fwd` of the top-like days was lower in all of them (for example 1.6% against 2.2%); the rules do not test that difference. The analog's own outcome did not rank the day's outcome (the largest ρ of a variant is 0.11, p = 0.055).
- Claim 3 (net liquidity). Our series gives a fall of USD 18 billion (−0.31%) for the four weeks to 2026-10-28, and USD 37 billion with the weekly-average Treasury account (`WTREGEN`, checked after the run). The author's USD 48 billion was not reproduced; the sign agrees. Large drains (`Δ4 ≤ −1%`, `≤ −2%`) were followed by lower four-week QQQ returns (p about 0.03 each, not corrected for four thresholds). No threshold gave a timing rule that beat buy-and-hold in the second half. A drain is context, not a switch.
- Claim 4 ("19 out of 19"). The count is correct and the effect has the same direction in both halves. It is one of 48 comparable cells, a second cell (July, midterm) is also 19 of 19, and "since 1950" leaves out 1930 to 1931 (−38.4%) and 1938 to 1939 (−2.6%). The window also holds large falls: −33.2% inside 1986 to 1987. It does not carry a position.

## Deviations

- Before the first run (in the commit that added the rules code): rule A6 said "the first 200 days of a series have no signal". SMA200 is defined from the 200th day, so the text now says "a day with fewer than 200 closes up to it has no signal".
- Rule G4 is applied to the price series, to `close` and to `adj_close`. `^IRX` is a yield: a value of 0 or below is valid and is kept; a missing value is dropped. The loader counts the dropped bars (the "Data" table); no file has one.
- Rule C8 says the window starts on "the first day with a known state". Rule C5 takes the position of a day from the state of the day before, so the window starts one trading day later: the first state is known at the 2003-01-21 close and the first return is that of 2003-01-22.
- Added after the run and marked as such: the holdout rows of the best grid cells and the note on the open episode (test A), the sentence on the share of top-like days (test B), the `WTREGEN` check of claim 3. None of them changes a verdict.
- Fixed after the first review, with no change to a verdict or to another number: the "Tops" column of the test B holdout row counted the tops of the whole `^NDX` series (80); it now counts the tops confirmed by 1999-03-09 (20). The rank correlation now uses the function of `strategies/rvol_intraday.py`; the values are equal.
- After the second review the CSV loader moved from the runner into the rules package (`data.py`), and the "Code and tests" line above says so. No rule text changed.

## Limits

- Test A: 7 complete episodes. The episode of 2026-10-02 completes at the 2026-11-13 close. It is a hit already; with it the rule has 3 hits in 8 episodes and a p-value of about 0.46, which is a FAIL of check (a). Rules G1 and A1 fix the last bar at 2026-11-06, so INCONCLUSIVE is the verdict of this study; a run on later data is a new deviation.
- Test A: QQQ had no record close from 2000-03 to 2016, so the in-sample episodes of the record-close rule come from 2017 to 2026. The holdout is an older market (1985 to 1999).
- Test B: the distance to the nearest analog falls as the library of tops grows. Rule B8 therefore marks 46% of the counted days as top-like, not 20%. A rule that corrects for the library size was not tested.
- Test C: `RRPONTSYD` has 92 values before 2013-09-23, so before that date net liquidity is in effect `WALCL − WDTGAL`. Cash earns the bill yield of the day before. No tax.
- Test D: `^GSPC` before 1957 is the back-filled index of fewer stocks. It is a price index: no window includes dividends, midterm or not.
- All tests: Yahoo and FRED data as fetched on 2026-11-09; FRED series are revised. A second fetch on the same day gave the same `close` values and `adj_close` values of QQQ and SPY that differ by about 1e-6 (the cause was not checked), so the file hashes of a later fetch differ. The p-values are not corrected across the four tests.
- A completed backtest does not authorize a trade.
