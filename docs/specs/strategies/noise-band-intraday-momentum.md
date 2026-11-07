# Noise-band intraday momentum on SPY (research definition and backtest)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file. Nothing here is deployed to QuantVPS.

## Source

- Primary: Zarattini, Aziz, Barbon, "Beat the Market: An Effective Intraday Momentum Strategy for S&P500 ETF (SPY)", SSRN 4824172, Swiss Finance Institute Research Paper 24-97. Version read: "This Version: September 22, 2025" (43 pages), from the authors' site <https://concretumgroup.com/wp-content/uploads/2026/02/Beat-the-Market.pdf>. The printed page numbers equal the PDF page numbers. Copy: `~/Documents/reports/vertex-noiseband/papers/zarattini-2025-09-22.pdf` (rig).
- Authors' published Python code (used only to resolve details the paper does not state): <https://www.concretumgroup.com/python-backtesting-beat-the-market-an-effective-intraday-momentum-strategy-for-the-sp500-etf-spy/>.
- Not read: Delgado (2026) SSRN 7323419, Maróy (2025) SSRN 5095349, Chuk (2026) SSRN 7609644. SSRN returned a Cloudflare bot check (HTTP 403) to direct download and to a headless browser on 2026-10-25, and no open mirror was found. Their findings are not used here.
- Owner request 2026-10-25 (Discord, card `vertex-noise-band`), prompted by a social-media reel. The reel's claim that this is "1 of 50 strategies" is unverified.

## Classification

Basis codes: S = stated in the paper (page given); I = implied by the paper or taken from the authors' published code; A = Vertex default, fixed before the first backtest run.

## Rules

|#|Rule|Basis|Quote and page|
|---|---|---|---|
|1|Data: SPY 1-minute OHLCV, regular session 09:30–16:00 ET.|S|p. 6 "1-minute OHLCV (Open, High, Low, Close, and Volume) data from IQFeed".|
|2|Move from open: for each prior day and time HH:MM, move = \|Close(HH:MM) / Open(9:30) − 1\|.|S|p. 6 "For each day t − i and time-of-day HH:MM, calculate the absolute move from Open".|
|3|σ(t, HH:MM) = average of that move over the previous 14 days.|S|p. 6 "calculate the average move over the last 14 days".|
|3a|σ needs at least 13 of the 14 prior values at that minute; the window uses the last 14 sessions that have that minute (half-days skip later minutes).|I|Authors' code: `rolling(window=14, min_periods=13)` grouped by minute, then `shift(1)`.|
|4|UpperBound = max(Open_t, Close_t−1) × (1 + σ); LowerBound = min(Open_t, Close_t−1) × (1 − σ).|S|p. 7 "UpperBound = max(Open t,9:30 , Close t−1,16:00 ) × (1 + σ)".|
|4a|Close_t−1 is reduced by the cash dividend on an ex-date.|I|Authors' code: `prev_close_adjusted = prev close − dividend`.|
|5|Decisions only at HH:00 and HH:30 (first check 10:00, last 15:30), using the close of the minute bar that ends at that time.|S / I|p. 9 "trading is restricted to semi-hourly intervals, specifically at HH:00 and HH:30". Code: `min_from_open % 30 == 0`.|
|6|Long when price > UpperBound; short when price < LowerBound.|S|p. 9 "going long if the price is above the Noise Area and short if it is below".|
|7|Trailing stop (final model): long exits when price < max(UpperBound, VWAP); short exits when price > min(LowerBound, VWAP). Stops are checked only at rule 5 times. After an exit the strategy can enter again at a later check.|S|p. 13 formula: Long TrailingStop = max(UB, VWAP), Short TrailingStop = min(LB, VWAP); p. 9 "Stop losses can also be triggered only on semi-hourly intervals."|
|7a|Entry also requires price beyond VWAP (long above VWAP, short below), so a new position is not stopped at once.|I|Authors' code: `signals[(close > UB) & (close > vwap)] = 1`.|
|7b|Base model (comparison only): stop at the opposite band; a cross reverses the position.|S|p. 9 "the existing position is closed, and a new one is initiated in the opposite direction".|
|8|VWAP from regular-session bars only, typical price (H+L+C)/3 × volume.|S / I|p. 13 footnote 2 "VWAP is computed only using market hours data". Typical price: authors' code.|
|9|Flat at the close.|S|p. 9 "All positions are closed at market Close".|
|10|Size (final model): shares = AUM_t−1 × min(4, 0.02 / σ_SPY) / Open_t; σ_SPY = sample standard deviation of the previous 14 daily returns.|S|p. 14–15 "targets a daily market volatility of 2%"; "the leverage for the active strategy is capped at 4x".|
|10a|Daily return = close-to-close of the last regular-session bar. Before 15 prior sessions exist, no trade (warm-up).|A|The authors' code uses 4× leverage when σ is missing; Vertex skips those days.|
|11|Fill: the open of the minute after the decision bar (the order is sent at HH:MM). Exit at the close fills at the last bar close.|I|p. 25 "send market orders on SPY … just a few milliseconds before the start of minute HH:MM"; slippage measured against "Open HH:MM".|
|12|Costs (Vertex test): commission USD 0.0035 per share per side and 1 bp slippage per side. The paper used USD 0.0035 plus USD 0.001 per share slippage.|A / S|Owner task. Paper p. 10 "commission fee of $0.0035 per share"; "slippage of $0.001 per share".|
|13|Start capital USD 100,000, compounding daily.|S|p. 10 "starting with an initial capital of $100,000".|
|14|Instrument for any live use: options only, inside the 2% NLV per-name premium cap; no share positions. A backtest result does not authorize trades.|A|Owner trading rules.|

## Pass/fail rule (set before the first run)

PASS only if the primary run (rules 1–13, Vertex costs) has at least 300 trades and a net Sharpe ratio above 0.5 in both halves (sessions split into two equal-count halves by date). Otherwise FAIL (enough trades) or INCONCLUSIVE (fewer than 300 trades). Sharpe = mean daily return / standard deviation × √252, no risk-free rate.

## Backtest results (2026-10-25, rig)

Code: `services/research/strategies/noise_band.py` (kernel), `noise_band_run.py` (runner), tests `services/research/tests/test_noise_band.py` (14 tests). Output: `~/Documents/reports/vertex-noiseband/results.json`, `trades_primary.csv`, `slippage_sensitivity.json` (rig).

### Data provenance

- Source: Kaggle dataset `rockinbrock/spy-1-minute-data`, file `spy_1min_2008_2021_cleaned.csv` (SHA-256 `81d936c7…c49b`, 2,070,834 rows). Third-party upload; the columns (barCount, average) match an IBKR TWS export. Time stamps are bar starts in US Mountain time (07:30 = 09:30 ET). Prices are not adjusted.
- Cleaning: 579,660 duplicate regular-session rows (exact copies) skipped; pre- and post-market bars removed. 3,345 sessions used, 2008-01-22 to 2021-05-06 (25 half-days). Two sessions dropped for missing bars: 2009-07-27, 2013-12-23.
- Check against Yahoo daily bars: session open matched in the median (difference 0); last-bar close vs official close median difference 0.012%, 28 days above 0.5% (mostly 2008 closing auctions).
- Not available: 2021-05 to 2026-10. The QuantVPS IB gateway was still down on 2026-10-25 (`vertex-history` health `connected:false`). No vendor key or other minute data exists on the rig. Yahoo gives only 16 sessions of 1-minute bars (2026-10-02 to 2026-10-23), which is less than the 15-session warm-up, so it was not used.
- Dividends: Yahoo SPY cash dividends (53 ex-dates in range).

### Results (net of costs, primary = final paper model)

|Run|Trades|Trade hit|Daily hit|CAGR|Vol|Sharpe|Max DD|1st half Sharpe|2nd half Sharpe|
|---|---|---|---|---|---|---|---|---|---|
|Primary: band+VWAP stop, vol-target, Vertex costs|2,955|33.2%|38.6%|4.1%|14.5%|0.35|46.6%|0.59|0.12|
|Same, paper costs (USD 0.001/share slippage)|2,955|37.0%|41.9%|16.2%|14.4%|1.11|26.7%|1.29|0.94|
|Same, no costs|2,955|37.0%|42.3%|19.5%|14.4%|1.31|22.9%|1.54|1.10|
|Band+VWAP stop, 100% size, Vertex costs|2,955|33.2%|38.6%|4.2%|7.9%|0.56|17.9%|0.98|0.00|
|Opposite-band stop, 100% size, Vertex costs|2,117|49.9%|50.4%|1.9%|11.0%|0.22|21.9%|0.26|0.19|
|SPY buy-and-hold (dividends, no costs)|—|—|55.5%|11.3%|20.6%|0.62|51.4%|—|—|

Halves: 2008-02-12 to 2014-09-24 and 2014-09-25 to 2021-05-06 (1,665 sessions each). Trade = one round trip. The paper counts entries and exits separately (its 7,668 "trades" are about 3,834 round trips), so its trade rate matches this run (about 0.9 round trips per session).

Paper (Table 3, p. 15; 2007-05 to 2024-04, paper costs): final model CAGR 19.6%, volatility 14.3%, Sharpe 1.33, max DD 25%, daily hit 43%; trade hit 37% (Table 4, p. 16). This run with paper costs gives Sharpe 1.11 over 2008–2021, so the rules reproduce the paper's result in the same range.

Slippage sensitivity (primary rules, commission fixed): Sharpe 1.16 / 0.95 / 0.75 / 0.55 / 0.35 at 0 / 0.25 / 0.5 / 0.75 / 1.0 bp per side. The second-half Sharpe falls below 0.5 between 0.5 and 0.75 bp.

Verdict: FAIL under the pre-set rule (2,955 trades; second-half Sharpe 0.12 < 0.5). The result depends on execution cost: at 1 bp per side the strategy earns 4.1% a year with a 46.6% drawdown, below buy-and-hold. At the paper's measured slippage (USD 0.001 per share, about 0.03–0.08 bp at 2008–2021 prices) it would pass. This test does not cover 2021-05 to 2026-10. This result does not authorize trades. Live use needs its own options spec within the 2% NLV cap.

## Re-test 2026-11 (card `vertex-noise-band-retest`)

Owner picks (2026-11-06): (1) SPY with data after 2021-05-06, (2) the same signal expressed with SPY 0DTE options, (3) other ETFs. The rules above stay frozen (rules 1–13, primary = band+VWAP stop, vol-targeted size, Vertex costs USD 0.0035/share + 1 bp per side).

### Pre-registered pass/fail (written 2026-11-07 before any re-test backtest run)

The rule is the one used above: PASS only with at least 300 round trips and a net Sharpe above 0.5 in both halves (sessions split into two equal-count halves by date; Sharpe = mean daily return / standard deviation × √252, no risk-free rate). FAIL with 300+ trades otherwise; INCONCLUSIVE with fewer than 300 trades or without the data the variant needs.

|Variant|Window the verdict uses|Also reported (no verdict)|
|---|---|---|
|1. SPY fresh data|2021-05-07 to the latest session fetched. This window is out of sample: the rules were fixed on 2008–2021 data.|Full 2008-01 to latest, with the same rule applied; paper-cost and no-cost rows.|
|2. SPY 0DTE options|Every session in the window with real historical SPY 0DTE option bid/ask quotes. Signal = the primary run's round trips (same entry and exit minutes and side). Instrument A (verdict): buy the nearest-to-the-money 0DTE call (long signal) or put (short signal) at the ask at the entry minute, sell at the bid at the exit minute (close exit: bid at 15:45, see amendment; a zero bid counts as 0). Size: contracts = floor(2% of equity / (ask × 100)), so the premium at risk is at most 2% of equity per trade (owner 2% NLV per-name cap); skip the trade if one contract costs more. Commission USD 0.65 per contract per side. Defined risk: the premium paid.|Instrument B: debit vertical (buy the ATM strike at the ask, sell the strike USD 5 further OTM at the bid), same size cap.|
|3. Other ETFs|For each ETF separately: its full available window. QQQ, IWM, DIA; sector SPDRs XLB XLC XLE XLF XLI XLK XLP XLRE XLU XLV XLY where the bars exist.|2021-05-07 to latest per ETF.|

Multiple tests: variant 3 runs up to 14 tests. With that many, one pass can be luck. Any variant-3 PASS is reported as "PASS (single test among N; needs a forward check)", and a paper-trade ask, if any, says so.

Amendment 2026-11-07 (before any option data was loaded or run): owner exit rule 2026-11-03 (`docs/vertex-rebuild/pick-list-portfolio-construction.md`) closes open options at 15:45 ET on expiry day and never exercises. Every 0DTE position is on expiry day, so a stock exit after 15:45 (the 16:00 close exit) becomes an option exit at the 15:45 bid (instruments A and B). The first draft said 15:59.

Data substitution (fixed before the runs): if the new data are 5-minute bars instead of 1-minute bars, the rules run unchanged on 5-minute bars. The checks at HH:00/HH:30, the open, the last close and the next-bar-open fill are identical on 5-minute bars; only VWAP (rule 8) uses 5-minute typical prices. Before any re-test run the 2008–2021 SPY result is recomputed from 1-minute bars aggregated to 5 minutes; the difference is reported next to the results.
