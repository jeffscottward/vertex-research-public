# Close-to-Open Edge (research definition and validation)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- Instagram carousel `DfFnuSOkqi9` (daytrading, 2026-10-29), slide 8: "Close-to-open edge tests the return from one day's close to the next day's open. It checks whether holding positions overnight offers a consistent advantage compared to intraday trading." The slide gives no further rules.
- Owner decision 2026-10-29 (card vertex-ig-carousel-strategies): rebuild each carousel strategy from a published implementation and list it only after a reference result is reproduced within a stated tolerance.
- Published references:
  - Cliff, Cooper and Gulen (2008), "Return Differences between Trading and Non-trading Hours: Like Night and Day" (SSRN 1004081).
  - Knuteson (2020), "Strikingly Suspicious Overnight and Intraday Returns" (arXiv 2010.01727), and his public letters with SPY totals.
  - Open Alpha Lab study 01 "Overnight Anomaly" (MIT licence, data fingerprinted): <https://github.com/Guillain-RDCDE/Open-Alpha-Lab/tree/main/studies/01-overnight-anomaly>.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Overnight return of session t = open(t) / close(t-1) - 1.|Reference|
|2|Intraday return of session t = close(t) / open(t) - 1.|Reference|
|3|The edge is the comparison of the compounded overnight and intraday legs over the same sessions.|Reference|
|4|Prices: Yahoo daily OHLC, split-adjusted only ("split_only" in the reference). Dividends are excluded unless `include_dividends` is set; then the ex-date cash dividend is added to that day's open (overnight leg).|Reference / A|

## Code and tests

- Rules: `services/research/strategies/published_rules.py` (`session_split`).
- Tests: `services/research/tests/test_published_rules.py` (`TestCloseToOpen`).
- Validation: `research/backtests/carousel/validate.py`; result `research/backtests/carousel/validation.json`.

## Validation (2026-10-29)

Reference: Open Alpha Lab study 01 results, SPY 1993-01-29 to 2026-06-01, as-of 2026-06-01.

Reference quality: a third-party open-source study (Open Alpha Lab, MIT licence; a small repository with 2 GitHub stars on 2026-10-29), not peer reviewed. The tolerances below were set on 2026-10-29 after a first prototype run on the same data. They are not pre-registered.

|Check|Reference|Reproduced|Tolerance|Result|
|---|---|---|---|---|
|SPY sessions|8,391|8,391|exact|pass|
|Overnight cumulative return|+1,185%|+1,185.45%|±1 pp|pass|
|Intraday cumulative return|+34%|+34.21%|±1 pp|pass|
|Overnight mean|+3.27 bps/day|+3.269 bps/day|±0.01 bps|pass|

Secondary, not reproduced (recorded only): Knuteson's letter of 2018-11-02 (<https://bruceknuteson.github.io/spy-day-and-night/correspondence/1/OFR.pdf>) gives +1,171% overnight and -21% intraday for 1993-01-29 to 2018-10-31. The same rules on the data used here give +1,087% (dividends in the overnight leg) and -16%. His data source and adjustment are not stated, so the difference is unexplained.

## Limits

- A reproduced result is not a trading edge. The reference finds the effect statistically real but mostly gap-risk beta that sits below trading costs, decaying over time and limited in capacity.
- A completed backtest does not authorize a trade. Vertex has no paper or live execution path for this strategy, and any live use must follow the options-only rule and the per-name premium caps.
- Data: Yahoo prices are not redistributed; `research/backtests/carousel/fetch_data.py` fetches them and records SHA-256 values.
