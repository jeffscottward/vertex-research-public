# Dividend Growth Buy Zones (research definition and backtest)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- FreeStockAlerts.ai alert template: <https://freestockalerts.ai/templates/dividend-growth-buy-zones> (category: Entry timing; page as of Oct 24, 2026; read 2026-10-26).
- The rules below are restated in Vertex's own words. No site text or code was copied.
- Owner request 2026-10-26 (card vertex-strategies-buildout): add the 12 FreeStockAlerts strategies to Vertex and backtest each trigger.

Summary: Dividend growers with a covered payout, alerted when the yield reaches the top of its own five-year range.

## Classification

Basis codes: S = stated on the template page; I = implied; A = Vertex default, fixed before the first backtest run. The site alerts research candidates; it states no exit, so the backtest measures forward returns after each alert instead of trades.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Universe: dividend payers, market cap over $10B, average volume over 1M shares.|S|
|2|Calendar-year dividend total rose in each of the last 5 completed years (specials included); the latest payment is not below the payment about a year earlier.|S|
|3|Payout covered: earnings payout under 75% or free-cash-flow payout under 90%; net debt under 3.5 × EBITDA or net cash (skipped for banks and insurers).|S|
|4|Forward yield = latest payment × the number of payments in the last 365 days; at least 1.5%.|S / A|
|5|Buy-zone yield = 80th percentile (nearest rank) of the forward yields on each ex-date in the last 5 years; at least 8 ex-dates needed.|S / A|
|6|Trigger: when the yield is below the zone, an alert at price = forward dividend ÷ buy-zone yield (session low reaches it). When the yield is already in the zone and the close is below the 200-day average, a reclaim of the 200-day average.|S|
|7|Refresh: monthly (site: also after a dividend change or a report).|S / A|
|8|Bars: daily OHLCV from Yahoo Finance, split-adjusted; forward returns use the dividend-adjusted close. The site uses Twelve Data prices and SEC fundamentals.|A|
|9|An intraday cross above an average uses the previous session's average as the level: previous close below it, session high above it.|A|
|10|List refresh: screen at the close of the first session of each month (weekly lists: each ISO week). A passing name is armed from the next session to the next refresh day and alerts once per armed window.|S / A|
|11|Average volume = mean volume of the 30 sessions before the screen day; applied with the stated share threshold.|S / A|
|12|The market-cap and fundamental rules are coded (`fundamental_screen`) but NOT applied in the backtest: no point-in-time fundamentals or market caps are available. The backtest tests the price rules only.|A|

## Code and tests

- Rules: `services/research/strategies/alert_templates.py` (`dividend_growth_buy_zones`, `dividend_buy_zone_state`, `buy_zone_yield`, `dividend_growth_years`, `DIVIDEND_FUNDAMENTALS`).
- Unit tests on hand-made fixtures with known trigger sessions: `services/research/tests/test_alert_templates.py`.
- Library entry: migration `packages/db/migrations/0031_strategy_catalog.sql` (portal page `/library`).

## Data

Prices and dividends: tested (Yahoo dividend history, split-adjusted). Payout coverage, leverage and market cap: not tested.

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
|Price and dividend rules|927|-0.05% / -0.35% (t -2.75)|+1.39% / -0.41% (t -1.77)|+4.29% / -1.23% (t -3.03)|+0.01% (462)|-0.84% (458)|fail|

Verdict: Fail. Alerts trailed the universe at every horizon; the 60-session excess is about −1.2%.

Raw output: `research/backtests/freestockalerts/results.json`.

### Real-data spot checks

|Symbol|Trigger date|Kind|Independent check|Chart|
|---|---|---|---|---|
|AMT|2026-10-09|reclaims-200-day|pass: level 176.66, prev close 166.73, high 182.52, low 175.02|`dividend-growth-buy-zones_AMT_2026-10-09.png`|
|ABT|2026-10-13|reclaims-200-day|pass: level 103.23, prev close 101.82, high 103.44, low 100.63|`dividend-growth-buy-zones_ABT_2026-10-13.png`|
|KR|2026-10-13|reclaims-200-day|pass: level 63.44, prev close 62.56, high 63.80, low 60.58|`dividend-growth-buy-zones_KR_2026-10-13.png`|

## Limits

- A completed backtest does not authorize a trade. Any live use needs its own options spec and the per-name premium caps (no new share positions).
- Survivorship bias: the test universe uses today's companies.
- Daily bars only; intraday alert timing is approximated as described in the rules.
