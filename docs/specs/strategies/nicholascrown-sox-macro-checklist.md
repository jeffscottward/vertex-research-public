# Nicholas Crown SOX macro checklist as a direction filter (research definition and backtest)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file. Nothing here is deployed to QuantVPS.

## Source

- Creator: Instagram @nicholascrown (Nicholas Crown).
- Reel: <https://www.instagram.com/reel/DereARRnPNS/>, published 2026-10-19T14:27:56Z, 2:00. Caption: "Gotta do your homework."
- Knowledge base: `~/Github/knowledge-bases/trading/nicholas-crown-instagram/sources/DereARRnPNS.md` (commit 245370c2).
- Transcript: faster-whisper large-v3, machine-generated and unverified. Quotes are from that transcript. Timestamps are elapsed video time (m:ss). Bracketed words are our reading of a transcription error.
- Owner decision 2026-10-19: "Backtest as SOX direction filter".

## Classification

The Reel gives a discretionary checklist, not a full rule set. It names the checks but gives no thresholds, entry trigger, instrument, stop, target or size. This spec turns the checklist into a daily direction filter for semiconductors. Every threshold is a Vertex default (A), fixed before the backtest ran. Basis codes: S = stated by the creator; I = implied by the creator's words; A = our default.

## Rules

|#|Rule|Basis|Quote and timestamp|
|---|---|---|---|
|1|Target: semiconductor index SOX. Short (or risk-off) when the checks align; long (relief rally) when they reverse.|S|0:00 "a semiconductor short"; 1:28 "this is the framework I use just to get short, but you can use the exact same thing to get long."|
|1a|Traded series in the backtest: SOXX total return (dividends included). Signal series for levels: ^SOX index.|A|No instrument was stated.|
|2|Check A, narrative: AI-infrastructure spending sentiment and article frequency.|S|0:07 "I track the narrative around AI infrastructure spending"; 0:10 "a press listener to measure shifts in narrative sentiment, frequency".|
|2a|Not tested. No point-in-time history of his press-listener data exists for us.|A|—|
|3|Check B, credit: high-yield spreads widen and stress spills into equities.|S|0:19 "high-yield spreads, credit deterioration in general".|
|3a|Bearish when HYG/IEF falls more than 2% over 20 sessions. Proxy, because FRED HY OAS (BAMLH0A0HYM2) history now starts 2023-10-20.|A|No threshold stated.|
|4|Check C, options positioning: put/call flows, implied vs realized vol, skew, dealer gamma; positioning around major expirations.|S|0:26 "put-call flows, implied versus realized vol, skew, deal, or gamma [dealer gamma] exposure"; 0:33 "a big OPEX where the market resets".|
|4a|Bearish when S&P 500 21-day realized volatility is above VIX (realized above implied; a proxy for a short-gamma, stress regime). Put/call, skew, dealer gamma and the OPEX timing are not in the test (no free point-in-time history).|A|No threshold stated.|
|5|Check D, rates: the speed of the 10-year move matters more than its level; MOVE or momentum.|S|0:38 "how quickly yields are moving"; 0:46 "The rate of increase in rates matters a whole lot more than the absolute level."|
|5a|Bearish when the 10-year yield (FRED DGS10) rose more than 0.25 percentage points in 20 sessions, or MOVE is above its 252-day 80th percentile.|A|No threshold stated.|
|6|Check E, oil: range versus fresh breakout; a breakout supports the short.|S + I|0:52 "if we're still boxed in there, or if we have just entered a fresh breakout". That a breakout is bearish for semis is implied (I).|
|6a|Bearish when WTI (FRED DCOILWTICO) closed above its prior 60-day high at any time in the last 10 sessions.|A|No threshold stated.|
|7|Timing confirmation: a KOSPI reversal after consecutive down sessions leads the US open.|S|1:01 "South Korea's COPSE [KOSPI], specifically for reversal patterns after consecutive down sessions"; 1:13 "A bounce in Korea more often than not translates to a bounce in U.S."; 1:16 "that hit rate exceeds 80%".|
|7a|Tested separately as a claim, not in the daily filter: KOSPI up day after 2 down days, then the same-date US close-to-close and SOXX open-to-close returns.|A|"Certain parameters" not stated.|
|8|Levels: SOX technical levels and moving averages (CTA flows).|S|1:19 "mapping this all against major technical levels in SOX"; 1:24 "CTA flows that flip on a dime depending on what the moving averages are doing".|
|8a|Check G: bearish when SOX closes below its 200-day simple moving average.|A|No level stated.|
|9|Decision: act when "enough boxes" are checked.|S|1:44 "when we check enough boxes here in this criteria".|
|9a|Score = number of bearish checks among B, C, D, E, G (0–5). Long/flat variant: hold SOXX when score < 3, else cash. Long/short variant: long when score ≤ 1, short when score ≥ 3, flat at 2.|A|"Enough boxes" is undefined.|
|10|Execution in the test: signal at the close of day t, position for day t+1; 5 bp cost per unit of turnover; cash earns 0%.|A|Not stated.|
|11|Exit, stop, size, instrument for real use: not stated. Any options expression (for example SMH/SOXX put spreads) needs its own spec and the 2% NLV per-name premium cap.|A|Not stated.|

## Backtest

- Code and data: `~/Github/tools/crown-sox-filter/` (`fetch.py`, `backtest.py`, `results.json`). Data: Yahoo Finance daily closes, adjusted for dividends (SOXX, plus SOXX opens, ^SOX, ^MOVE, ^VIX, ^GSPC, HYG, IEF, ^KS11) and FRED (DGS10, DCOILWTICO), fetched 2026-10-19.
- Period: 2007-04-11 (first HYG day) to 2026-10-19. In-sample: to 2016-12-31. Out-of-sample: 2017-01-01 to 2026-10-19.
- Default parameters (SMA 200, cut 3) were fixed before the run. A 12-point grid (SMA 100/200, cut 2/3/4, two modes) was ranked by in-sample Sharpe only, and the pick was then run out of sample.
- "Always long SOXX" is the SOXX buy-and-hold result inside the same engine. The S&P 500 buy-and-hold row is a price-only market reference.
- Hit rate: DayHit = share of in-market days with a positive net return. TradeHit = share of positions (runs of the same position) that ended with a gain.

### Results, default parameters

|Period|Strategy|CAGR|Max drawdown|Sharpe|Exposure|DayHit|Trades|TradeHit|
|---|---|---|---|---|---|---|---|---|
|Full|Filter long/flat|17.6%|−43.2%|0.74|87%|54.1%|109|51.4%|
|Full|Filter long/short|5.8%|−59.0%|0.34|78%|53.1%|322|43.2%|
|Full|Always long SOXX|19.1%|−66.8%|0.71|100%|53.7%|1|—|
|Full|S&P 500 buy-and-hold|9.0%|−56.8%|0.54|100%|54.3%|1|—|
|In-sample|Filter long/flat|7.8%|−43.2%|0.45|83%|53.1%|70|51.4%|
|In-sample|Filter long/short|0.7%|−47.5%|0.15|75%|52.3%|191|42.9%|
|In-sample|Always long SOXX|8.5%|−66.8%|0.43|100%|52.7%|1|—|
|In-sample|S&P 500 buy-and-hold|4.6%|−56.8%|0.32|100%|53.9%|1|—|
|Out-of-sample|Filter long/flat|28.2%|−39.9%|0.96|92%|55.0%|40|52.5%|
|Out-of-sample|Filter long/short|11.1%|−59.0%|0.49|81%|53.9%|132|43.2%|
|Out-of-sample|Always long SOXX|30.7%|−45.8%|0.94|100%|54.7%|1|—|
|Out-of-sample|S&P 500 buy-and-hold|13.4%|−33.9%|0.78|100%|54.7%|1|—|

### Grid pick (chosen in-sample, reported out of sample)

- Pick: SMA 200, cut 4, long/flat (in-sample Sharpe 0.63). Out of sample: CAGR 35.3%, max drawdown −41.4%, Sharpe 1.07, exposure 98%, 16 trades, TradeHit 68.8%.
- Every long/short grid point had a lower in-sample Sharpe than the matching long/flat point.

### Single checks (full period, long/flat on one check)

|Check|CAGR|Max drawdown|Sharpe|Exposure|
|---|---|---|---|---|
|B credit|15.4%|−47.7%|0.67|84%|
|C realized > implied|20.5%|−44.1%|0.81|84%|
|D rates|13.8%|−47.0%|0.66|69%|
|E oil breakout|13.4%|−56.8%|0.59|69%|
|G SOX < 200-day|14.6%|−39.7%|0.70|72%|

### KOSPI claim (rule 7)

- Since 2002 there were 663 KOSPI bounce days (up day after 2 down days). The KOSPI session of date t closes before the US open of date t.
- Close-to-close (US close t−1 to close t): SOX was up 57.8% of the time (base rate 52.9%); the S&P 500 was up 58.5% (base 54.1%). This window includes the US overnight move that KOSPI itself reacts to.
- Open-to-close (SOXX open t to close t, the part a trader can still act on after KOSPI closes): up 49.3% of the time (base rate 50.6%). No edge.
- The stated "exceeds 80%" is not supported by either measure. His "certain parameters" are unknown, so the claim is not fully refuted.

## Findings

1. The long/flat filter kept most of the SOXX return (17.6% vs 19.1% CAGR full period) and cut the worst drawdown from −66.8% to −43.2% (out of sample −39.9% vs −45.8%). Sharpe was about the same (0.74 vs 0.71 full; 0.96 vs 0.94 out of sample).
2. Using the same checklist to go short did worse than long/flat in every period and grid point. The test does not support the short side as defined here.
3. The largest single-check drawdown reductions came from the SOX 200-day check (G) and the realized-vs-implied volatility check (C). The oil breakout check (E) had the weakest single-check result (13.4% CAGR, −56.8% drawdown).
4. The KOSPI bounce gives no edge after the US open. The close-to-close edge comes from the overnight gap.
5. The checks are proxies. Narrative, put/call, skew, dealer gamma and OPEX timing were not tested. The result does not test Crown's full process.

## Limits

- Daily close data, no slippage model beyond 5 bp, cash earns 0% (this understates the long/flat result in high-rate years).
- One asset and one 19.5-year history. The out-of-sample period (2017–2026) was a strong semiconductor bull market.
- Thresholds were chosen by us and are not Crown's. The grid has 12 points, so some selection bias remains.
- Next step, if the owner wants one: test an options expression (defined-risk put spreads only when the score is high) as a separate spec. No engine change without explicit owner approval.

## Risk notes

- The 135% two-session return (0:00) and the >80% KOSPI hit rate (1:16) are unverified marketing claims.
- The Reel promotes Crown's paid letter (1:53). Paid-letter content is not part of this research spec.
- A completed backtest does not authorize a trade.
