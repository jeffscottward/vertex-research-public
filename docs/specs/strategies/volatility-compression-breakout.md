# Volatility Compression Breakout (research definition and validation)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- Instagram carousel `DfFnuSOkqi9` (daytrading, 2026-10-29), slide 3: "This strategy focuses on periods when price trades in a very tight range. Low volatility often leads to a strong move. You enter when price breaks out of that range with momentum." The slide gives no range measure or entry level.
- Owner decision 2026-10-29 (card vertex-ig-carousel-strategies): rebuild from a published implementation and list only after a reference result is reproduced.
- Published rule: Toby Crabel, *Day Trading With Short-Term Price Patterns and Opening Range Breakout* (1990), NR7 pattern.
- Reference backtest: Open Alpha Lab study 190 "NR7" (MIT licence, data fingerprinted): <https://github.com/Guillain-RDCDE/Open-Alpha-Lab/tree/main/studies/190-nr7>.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|NR7 day: the high-low range is the narrowest of the last 7 sessions, including that day. Ties count.|Reference|
|2|Range expansion check: next-day range / mean range of the 20 sessions ending on the NR7 day.|Reference|
|3|Entry on the next session: an open above the NR7 high fills long at the open; an open below the NR7 low fills short at the open. Otherwise a trade above the NR7 high fills long at that high, else a trade below the NR7 low fills short at that low. No break: no trade.|Reference|
|4|Daily bars cannot show which level traded first; the long side is checked first, as in the reference.|Reference|
|5|Exit at the close of the entry session. Returns are gross.|Reference|
|6|Prices: Yahoo daily OHLC adjusted for splits and dividends.|Reference|

## Code and tests

- Rules: `services/research/strategies/published_rules.py` (`nr7_days`, `range_expansion_ratios`, `nr7_breakout_trades`).
- Tests: `services/research/tests/test_published_rules.py` (`TestNr7`).
- Validation: `research/backtests/carousel/validate.py`; result `research/backtests/carousel/validation.json`.

## Validation (2026-10-29)

Reference: Open Alpha Lab study 190 results, SPY 2000-01-03 to 2026-06-15, as-of 2026-06-15.

Reference quality: a third-party open-source study (Open Alpha Lab, MIT licence; a small repository with 2 GitHub stars on 2026-10-29), not peer reviewed. The tolerances below were set on 2026-10-29 after a first prototype run on the same data. They are not pre-registered.

|Check|Reference|Reproduced|Tolerance|Result|
|---|---|---|---|---|
|SPY sessions|6,652|6,652|exact|pass|
|NR7 days|1,035|1,036|±1%|pass|
|Next-day range / 20-day mean range|0.910|0.911|±0.005|pass|
|Breakout trades|1,009|1,010|±1%|pass|
|Breakout mean gross return|+5.4 bps|+4.9 bps|±1.0 bps|pass|

This run has one NR7 day and one trade more than the reference. Without the trade on the 2022-10-12 NR7 day (short on 2022-10-13, -479.9 bps), the mean is +5.407 bps over 1,009 trades, equal to the reference. Why the reference lacks this trade is not known. The ±1 bps tolerance is about 19% of the reference value.

## Limits

- The reference refutes the "coiled spring" claim on SPY: the day after an NR7 has a narrower range than average (ratio 0.91). The SPY breakout edge is about zero after 5 bps of round-trip cost.
- A completed backtest does not authorize a trade. Vertex has no paper or live execution path for this strategy. The short side and share entries conflict with the owner's options-only rule.
- Data: Yahoo prices are not redistributed; `research/backtests/carousel/fetch_data.py` fetches them and records SHA-256 values.
