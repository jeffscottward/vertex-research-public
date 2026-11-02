# Under-the-Radar Breakouts (research definition and backtest)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- FreeStockAlerts.ai alert template: <https://freestockalerts.ai/templates/under-the-radar-breakouts> (category: Idea discovery; page as of Oct 24, 2026; read 2026-10-26).
- The rules below are restated in Vertex's own words. No site text or code was copied.
- Owner request 2026-10-26 (card vertex-strategies-buildout): add the 12 FreeStockAlerts strategies to Vertex and backtest each trigger.

Summary: A monthly list of profitable, liquid mid-caps in uptrends, alerted on a fresh 52-week high.

## Classification

Basis codes: S = stated on the template page; I = implied; A = Vertex default, fixed before the first backtest run. The site alerts research candidates; it states no exit, so the backtest measures forward returns after each alert instead of trades.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Universe: market cap $2B–$20B, average volume over 1.5M shares; names on the Quality Breakout Radar list are left out.|S|
|2|Trailing free cash flow and net margin positive; net debt under 3 × EBITDA or net cash (skipped for banks and insurers).|S|
|3|Close above the 50- and 200-day averages, within 8% of the 52-week high and at least 30% above the 52-week low.|S|
|4|Trigger: a fresh 52-week high.|S|
|5|Refresh: monthly.|S|
|6|The overlap exclusion with the Quality Breakout Radar is not applied in the backtest (it depends on market-cap tiers).|A|
|7|Bars: daily OHLCV from Yahoo Finance, split-adjusted; forward returns use the dividend-adjusted close. The site uses Twelve Data prices and SEC fundamentals.|A|
|8|A 52-week window is 252 sessions. A fresh 52-week high is a session high above the highest high of the 252 sessions before it.|A|
|9|List refresh: screen at the close of the first session of each month (weekly lists: each ISO week). A passing name is armed from the next session to the next refresh day and alerts once per armed window.|S / A|
|10|Average volume = mean volume of the 30 sessions before the screen day; applied with the stated share threshold.|S / A|
|11|The market-cap and fundamental rules are coded (`fundamental_screen`) but NOT applied in the backtest: no point-in-time fundamentals or market caps are available. The backtest tests the price rules only.|A|

## Code and tests

- Rules: `services/research/strategies/alert_templates.py` (`under_the_radar_breakouts`, `under_radar_price`, `UNDER_RADAR_FUNDAMENTALS`).
- Unit tests on hand-made fixtures with known trigger sessions: `services/research/tests/test_alert_templates.py`.
- Library entry: migration `packages/db/migrations/0031_strategy_catalog.sql` (portal page `/library`).

## Data

Prices: tested. Fundamentals and market cap: not tested. The test universe is mostly large caps, so it does not match the mid-cap universe.

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
|Price rules|5086|-0.07% / -0.31% (t -6.42)|+0.66% / -0.18% (t -1.87)|+2.58% / -0.13% (t -0.74)|-0.11% (2543)|-0.25% (2528)|fail|

Verdict: Fail. After costs the alerts trailed the universe at 5 and 20 sessions and in both halves at 20 sessions.

Raw output: `research/backtests/freestockalerts/results.json`.

### Real-data spot checks

|Symbol|Trigger date|Kind|Independent check|Chart|
|---|---|---|---|---|
|DOCU|2026-10-14|new-52-week-high|pass: level 75.00, prev close 72.31, high 75.31, low 72.03|`under-the-radar-breakouts_DOCU_2026-10-14.png`|
|XOM|2026-10-14|new-52-week-high|pass: level 176.41, prev close 174.08, high 177.43, low 174.53|`under-the-radar-breakouts_XOM_2026-10-14.png`|
|GILD|2026-10-15|new-52-week-high|pass: level 157.29, prev close 153.54, high 160.51, low 156.02|`under-the-radar-breakouts_GILD_2026-10-15.png`|

## Limits

- A completed backtest does not authorize a trade. Any live use needs its own options spec and the per-name premium caps (no new share positions).
- Survivorship bias: the test universe uses today's companies.
- Daily bars only; intraday alert timing is approximated as described in the rules.
