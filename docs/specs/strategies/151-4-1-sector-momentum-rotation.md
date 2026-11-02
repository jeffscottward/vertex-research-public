# 151 Trading Strategies 4.1: sector momentum rotation (research definition and backtest)

Status: research only. No live or paper orders. No broker changes. Long-only test; live use would need its own options spec (no new share positions).

## Source

- Zura Kakushadze and Juan Andrés Serur, *151 Trading Strategies*, sections 4.1 (Sector Momentum Rotation), 4.1.1 (with MA filter) and 4.1.2 (Dual-Momentum Sector Rotation). SSRN: <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3247865>. Planning summary: `research/backtests/151-strategies/index.md`.
- Built for card vertex-strategies-buildout (Part B: daily-testable 151 entries).

## Rules

Basis codes: S = stated in the book section; A = Vertex default, fixed before the first run.

|#|Rule|Basis|
|---|---|---|
|1|Universe: the Select Sector SPDR ETFs (XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU, XLB; XLRE from 2016 and XLC from 2019 once they have 12 months of history).|S / A|
|2|Formation: total return (dividend-adjusted) over the last 252 sessions, measured at the last session of each month.|S (6-12 months) / A (12)|
|3|Hold the top 2 ETFs, equal weight, for one month, then re-rank. The book says top decile; with 9-11 ETFs a decile is one ETF.|S / A|
|4|4.1.1: hold a top-2 ETF only while its close is above its 200-session average; otherwise that half is cash at 0%.|S (T' 100-200 days) / A (200)|
|5|4.1.2: when SPY closes above its 200-session average hold the top 2; otherwise hold TLT (Treasury ETF).|S / A|
|6|Long only. The dollar-neutral (short bottom decile) version is not tested.|A|
|7|Cost: 10 bp per side on the traded weight at each rebalance. Weights drift with prices between rebalances.|A|
|8|Benchmark: equal weight in every rankable sector ETF, rebalanced monthly. Pass = CAGR and Sharpe above the benchmark in both halves.|A|

## Code and tests

- `services/research/strategies/sector_rotation.py` (`target_weights`, `simulate`, CLI `python -m strategies.sector_rotation`).
- `services/research/tests/test_sector_rotation.py`: hand-made fixtures with known rankings, the MA filter, the TLT switch, costs and compounding.
- Library entry: migration `packages/db/migrations/0031_strategy_catalog.sql` (slug `151-4-1-sector-momentum-rotation`).

## Backtest (2026-10-26, rig)

Data: Yahoo Finance daily bars 2005-2026 (same files and manifest as the FreeStockAlerts tests: `~/Documents/reports/vertex-strategies-buildout/data/`). First rebalance 2006-01-31; halves split at 2016-06-10. Raw output: `research/backtests/151-strategies/results-4-1-sector-rotation.json`.

|Variant|CAGR|Sharpe|Max DD|1st half CAGR / Sharpe|2nd half CAGR / Sharpe|Verdict|
|---|---|---|---|---|---|---|
|4.1 base (top 2)|10.4%|0.6|-46.2%|5.4% / 0.365|15.6% / 0.841|fail|
|4.1.1 MA filter|8.5%|0.573|-25.4%|4.8% / 0.365|12.4% / 0.778|fail|
|4.1.2 dual momentum|10.7%|0.677|-29.7%|11.9% / 0.736|9.5% / 0.616|fail|
|Equal-weight sectors|10.1%|0.62|-53.5%|7.8% / 0.478|12.5% / 0.796|benchmark|

SPY buy and hold over the same dates: CAGR 11.0%, Sharpe 0.641, max drawdown -55.2%.

Verdict: fail for all three variants. The base rotation lost to equal weight in the first half and won in the second. Dual momentum won in the first half (it held TLT through 2008) and lost in the second. The MA filter and dual momentum cut the maximum drawdown (−25% and −30% against −54% for equal weight), but the return did not beat equal weight in both halves.

### Real-data spot checks

The last three rebalances were recomputed from the raw CSV with separate code (12-month return per ETF): 2026-07-31 top XLE +40.1%, XLK +33.2%; 2026-08-31 XLE +46.7%, XLK +40.7%; 2026-09-30 XLK +40.4%, XLE +40.1%. All three match the runner's picks. Chart: `~/Documents/reports/vertex-strategies-buildout/charts/151-4-1-sector-rotation.png` (rig): XLE and XLK lead over those formation windows.

## Limits

- Today's sector ETFs only; 11 assets make the ranking coarse.
- One parameter set; no sweep was run, so the result is not tuned.
- A completed backtest does not authorize a trade.
