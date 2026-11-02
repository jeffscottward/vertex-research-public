# Quality Compounders on Pullback (research definition and backtest)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- FreeStockAlerts.ai alert template: <https://freestockalerts.ai/templates/quality-compounders-on-pullback> (category: Entry timing; page as of Oct 24, 2026; read 2026-10-26).
- The rules below are restated in Vertex's own words. No site text or code was copied.
- Owner request 2026-10-26 (card vertex-strategies-buildout): add the 12 FreeStockAlerts strategies to Vertex and backtest each trigger.

Summary: Durable large caps 12–30% below their highs, alerted when the price reclaims the 50-day average.

## Classification

Basis codes: S = stated on the template page; I = implied; A = Vertex default, fixed before the first backtest run. The site alerts research candidates; it states no exit, so the backtest measures forward returns after each alert instead of trades.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Universe: market cap $20B or more, average volume over 1M shares; banks, insurers and other financials excluded.|S|
|2|Trailing free cash flow positive; profitable in each of the last 3 fiscal years; revenue grew in the latest year; net debt under 3 × EBITDA or net cash; last quarter did not miss the EPS estimate by more than 10%.|S|
|3|Close 12–30% below the 52-week high, no more than 8% below the 200-day average, and below the 50-day average.|S|
|4|Trigger: a move back above the 50-day average after a close below it (intraday).|S|
|5|Refresh: monthly (site: also after each listed company reports).|S / A|
|6|Bars: daily OHLCV from Yahoo Finance, split-adjusted; forward returns use the dividend-adjusted close. The site uses Twelve Data prices and SEC fundamentals.|A|
|7|An intraday cross above an average uses the previous session's average as the level: previous close below it, session high above it.|A|
|8|List refresh: screen at the close of the first session of each month (weekly lists: each ISO week). A passing name is armed from the next session to the next refresh day and alerts once per armed window.|S / A|
|9|Average volume = mean volume of the 30 sessions before the screen day; applied with the stated share threshold.|S / A|
|10|The market-cap and fundamental rules are coded (`fundamental_screen`) but NOT applied in the backtest: no point-in-time fundamentals or market caps are available. The backtest tests the price rules only.|A|

## Code and tests

- Rules: `services/research/strategies/alert_templates.py` (`quality_compounders_on_pullback`, `quality_compounder_price`, `QUALITY_COMPOUNDER_FUNDAMENTALS`).
- Unit tests on hand-made fixtures with known trigger sessions: `services/research/tests/test_alert_templates.py`.
- Library entry: migration `packages/db/migrations/0031_strategy_catalog.sql` (portal page `/library`).

## Data

Prices: tested. Fundamentals, the financial-sector exclusion and market cap: not tested.

## Backtest

Method (fixed before the first run; `services/research/strategies/alert_templates_run.py`):

- Event = one alert. Forward return from the alert-day close to the close 5, 20 and 60 sessions later (dividend-adjusted). The alert is known by the alert-day close, so there is no look-ahead.
- Benchmark = equal-weight mean forward return, same date and horizon, of every symbol in the universe. Excess = event return − benchmark.
- Cost: 10 bp per side (0.20% round trip), charged to the event return.
- Halves: events split at the median event date.
- Pass rule at 20 sessions: at least 30 events, mean net excess > 0 with t ≥ 2, and mean net excess > 0 in both halves. Fewer than 30 events = inconclusive. Overlapping events make t too high; treat it as an upper bound.
- Universe: `research/backtests/freestockalerts/universe.py` — 145 large US stocks with data (S&P 100 names as of 2026 plus the tickers the template pages listed on 2026-10-24). Today's names over 2005–2026 add survivorship bias. BK had no data.
- Data: Yahoo Finance via yfinance, 2005-01-03 to 2026-10-23, fetched 2026-10-26 (`fetch_yahoo.py`; CSV copies and `manifest.json` with SHA-256 per file: `~/Documents/reports/vertex-strategies-buildout/data/` on the rig).
- Spot checks: `spot_check.py` recomputes the three most recent real-data triggers from the raw CSV with separate code and draws one chart each (charts: `~/Documents/reports/vertex-strategies-buildout/charts/` on the rig). One chart per strategy was reviewed by eye: the trigger marker sits on the stated cross, breakout or move.

Results (net of costs; excess = net − benchmark):

|Test|Events|5 sessions: net / excess|20 sessions: net / excess|60 sessions: net / excess|20-session excess, 1st half (n)|2nd half (n)|Verdict|
|---|---|---|---|---|---|---|---|
|Price rules|3009|+0.29% / -0.11% (t -1.47)|+1.43% / -0.15% (t -1.03)|+4.00% / +0.06% (t 0.24)|-0.28% (1502)|-0.01% (1474)|fail|

Verdict: Fail. 20-session excess is negative in both halves; 60-session excess is near zero.

Raw output: `research/backtests/freestockalerts/results.json`.

### Real-data spot checks

|Symbol|Trigger date|Kind|Independent check|Chart|
|---|---|---|---|---|
|ABT|2026-10-21|reclaims-50-day|pass: level 105.67, prev close 102.45, high 106.35, low 97.67|`quality-compounders-on-pullback_ABT_2026-10-21.png`|
|COF|2026-10-21|reclaims-50-day|pass: level 207.35, prev close 201.56, high 211.49, low 205.24|`quality-compounders-on-pullback_COF_2026-10-21.png`|
|SPG|2026-10-22|reclaims-50-day|pass: level 208.30, prev close 205.55, high 212.74, low 205.79|`quality-compounders-on-pullback_SPG_2026-10-22.png`|

## Limits

- A completed backtest does not authorize a trade. Any live use needs its own options spec and the per-name premium caps (no new share positions).
- Survivorship bias: the test universe uses today's companies.
- Daily bars only; intraday alert timing is approximated as described in the rules.
