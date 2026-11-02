# Z-Score Mean Reversion (research definition and validation)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- Instagram carousel `DfFnuSOkqi9` (daytrading, 2026-10-29), slide 6: "Z-score mean reversion uses statistics to identify when price is stretched far from its average. When the deviation is extreme, you position for a move back toward the mean." The chart marks z-scores of +2 and -2. The slide gives no window or exit.
- Owner decision 2026-10-29 (card vertex-ig-carousel-strategies): rebuild from a published implementation and list only after a reference result is reproduced.
- Published rule: John Bollinger's bands (20-day mean ± 2 standard deviations). A close below the lower band is a z-score below -2.
- Reference backtest: Open Alpha Lab study 104 "Bollinger-Reversion" (MIT licence, data fingerprinted): <https://github.com/Guillain-RDCDE/Open-Alpha-Lab/tree/main/studies/104-bollinger-reversion>.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|z(t) = (close(t) - mean of the last 20 closes) / sample standard deviation of the last 20 closes.|Reference|
|2|Entry signal: the first close with z < -2 after a close with z ≥ -2.|Reference|
|3|Buy at the next session's open.|Reference|
|4|Exit at the close 20 sessions after entry (horizon-fair exit used for the reference result), or at the last bar.|Reference|
|5|Long only. Returns are gross.|Reference|
|6|Prices: Yahoo daily OHLC adjusted for splits and dividends.|Reference|

The reference also describes an exit at the mean (z ≥ 0) but publishes no number for it, so that exit is not included.

## Code and tests

- Rules: `services/research/strategies/published_rules.py` (`rolling_zscore`, `lower_band_entries`, `time_exit_trades`).
- Tests: `services/research/tests/test_published_rules.py` (`TestZScore`).
- Validation: `research/backtests/carousel/validate.py`; result `research/backtests/carousel/validation.json`.

## Validation (2026-10-29)

Reference: Open Alpha Lab study 104 results, SPY, QQQ, AAPL, MSFT, JPM and XLE, 2005-01-03 to 2026-06-12.

Reference quality: a third-party open-source study (Open Alpha Lab, MIT licence; a small repository with 2 GitHub stars on 2026-10-29), not peer reviewed. The tolerances below were set on 2026-10-29 after a first prototype run on the same data. They are not pre-registered.

|Check|Reference|Reproduced|Tolerance|Result|
|---|---|---|---|---|
|Trades per symbol (SPY, QQQ, AAPL, MSFT, JPM, XLE)|149, 140, 112, 119, 139, 152|149, 140, 112, 119, 139, 152|exact|pass|
|Mean gross 20-day return per symbol (bps)|140, 226, 116, 219, 354, 105|140.4, 226.0, 115.6, 218.5, 353.5, 104.9|±1 bps|pass|
|Pooled trades|811|811|exact|pass|
|Pooled mean gross 20-day return|+193.09 bps|+193.09 bps|±0.5 bps|pass|
|Pooled win rate|64.6%|64.61%|±0.1 pp|pass|

## Limits

- The reference finds that random entry dates on the same symbols earn +141 bps over the same hold, and upper-band breakouts earn +118 bps. Most of the return is market drift; the band adds about 52 bps per trade, not significant.
- A completed backtest does not authorize a trade. Vertex has no paper or live execution path for this strategy. Share entries conflict with the owner's options-only rule.
- Data: Yahoo prices are not redistributed; `research/backtests/carousel/fetch_data.py` fetches them and records SHA-256 values.
