# Pairs Trading Divergence (research definition and validation)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- Instagram carousel `DfFnuSOkqi9` (daytrading, 2026-10-29), slide 2: "Pairs trading divergence works with two related stocks that usually move together. When the price gap between them becomes unusually wide, you expect it to return to normal. You go long the weaker one and short the stronger one, betting on convergence." The slide gives no thresholds.
- Owner decision 2026-10-29 (card vertex-ig-carousel-strategies): rebuild from a published implementation and list only after a reference result is reproduced.
- Published reference: Ernest Chan, *Quantitative Trading* (Wiley, 2008), example 3.6 (GLD/GDX), with the author's MATLAB code and data files (copy: <https://github.com/egorpe/EPChan-QuantitativeTrading>, `example3_6.m`, `GLD.xls`, `GDX.xls`).
- Related Vertex code: `services/research/strategies/pairs.py` is a different method (Engle-Granger test, rolling z-score, next-bar fills). It is not used here.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Training set: the first 252 joint trading days. Test set: the remaining days.|Reference|
|2|Hedge ratio h: least squares of Y on X without intercept, on the training set.|Reference|
|3|Spread = Y - h X. z-score = (spread - training mean) / training sample standard deviation.|Reference|
|4|z ≤ -2: long the spread (long Y, short X). z ≥ 2: short the spread. \|z\| ≤ 1: flat. Otherwise hold the previous position.|Reference|
|5|A position decided at the close of day t earns day t+1's return. Each leg holds one unit of capital: P&L = position × (return Y - return X).|Reference|
|6|Sharpe ratio = √252 × mean / sample standard deviation of daily P&L. Days before the first signal have no P&L.|Reference / A|

## Code and tests

- Rules: `services/research/strategies/published_rules.py` (`pair_spread_backtest`).
- Tests: `services/research/tests/test_published_rules.py` (`TestPairs`).
- Validation: `research/backtests/carousel/validate.py`; result `research/backtests/carousel/validation.json`.

## Validation (2026-10-29)

Data: the author's GLD.xls and GDX.xls (adjusted close, last column, as the reference code reads it); 385 joint days, 2006-05-23 to 2007-11-30. Hedge ratio 1.6310.

Reference quality: the author's book code and data files. The tolerances below were set on 2026-10-29 after a first prototype run on the same data. They are not pre-registered. The joint-day count and hedge ratio are data provenance, not reference results.

|Check|Reference (code comment)|Reproduced|Tolerance|Result|
|---|---|---|---|---|
|Training-set Sharpe ratio|about 2.3|2.328|±0.05|pass|
|Test-set Sharpe ratio|about 1.5|1.508|±0.05|pass|

## Limits

- The reference covers 18 months in 2006-2007. A reproduced result says nothing about later periods. Open Alpha Lab study 05 ("Twin-Spread") finds no convergence edge in modern data for the Gatev-Goetzmann-Rouwenhorst distance method.
- The pair (GLD/GDX) and parameters are the reference's. Other pairs need their own selection rule, which the carousel does not give.
- The strategy shorts one leg. Owner rule (2026-10-16): options only, no new share positions, long or short. Vertex has no paper or live execution path for it.
- The book data is not redistributed; `research/backtests/carousel/fetch_data.py` downloads it and records SHA-256 values.
