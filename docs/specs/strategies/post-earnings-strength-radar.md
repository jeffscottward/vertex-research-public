# Post-Earnings Strength Radar (research definition and backtest)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- FreeStockAlerts.ai alert template: <https://freestockalerts.ai/templates/post-earnings-strength-radar> (category: Idea discovery; page as of Oct 24, 2026; read 2026-10-26).
- The rules below are restated in Vertex's own words. No site text or code was copied.
- Owner request 2026-10-26 (card vertex-strategies-buildout): add the 12 FreeStockAlerts strategies to Vertex and backtest each trigger.

Summary: A weekly list of companies that beat the EPS estimate, grew revenue and rose on the report, watched for a move through the reaction-day high.

## Classification

Basis codes: S = stated on the template page; I = implied; A = Vertex default, fixed before the first backtest run. The site alerts research candidates; it states no exit, so the backtest measures forward returns after each alert instead of trades.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Universe: NYSE/Nasdaq common stocks, market cap over $2B, average volume over 1M shares.|S|
|2|Report released in the last 45 days.|S|
|3|Reported EPS above the consensus estimate; quarterly revenue above the same quarter a year earlier. A missing EPS or revenue figure disqualifies.|S|
|4|Reaction session = the report session or the next one, whichever traded more shares.|S|
|5|Reaction session close ≥ 3% above the previous close, on volume ≥ 1.5 × the average of the 30 sessions before it.|S|
|6|At the screen: close above the last close before the report, and above the 50- and 200-day averages.|S|
|7|Trigger: while the close is below the reaction-session high, an alert at that high (traded through, no close needed). Once the close is above it, a fresh 52-week high.|S|
|8|Refresh: weekly (site: weekly in earnings season, at least every 2 weeks otherwise).|S / A|
|9|`report_day` is the first session the report can move the price (after-close reports: the next session).|A|
|10|Bars: daily OHLCV from Yahoo Finance, split-adjusted; forward returns use the dividend-adjusted close. The site uses Twelve Data prices and SEC fundamentals.|A|
|11|A 52-week window is 252 sessions. A fresh 52-week high is a session high above the highest high of the 252 sessions before it.|A|
|12|List refresh: screen at the close of the first session of each month (weekly lists: each ISO week). A passing name is armed from the next session to the next refresh day and alerts once per armed window.|S / A|
|13|Average volume = mean volume of the 30 sessions before the screen day; applied with the stated share threshold.|S / A|
|14|The market-cap and fundamental rules are coded (`fundamental_screen`) but NOT applied in the backtest: no point-in-time fundamentals or market caps are available. The backtest tests the price rules only.|A|

## Code and tests

- Rules: `services/research/strategies/alert_templates.py` (`post_earnings_strength`, `post_earnings_qualifies`, `post_earnings_reaction`).
- Unit tests on hand-made fixtures with known trigger sessions: `services/research/tests/test_alert_templates.py`.
- Library entry: migration `packages/db/migrations/0031_strategy_catalog.sql` (portal page `/library`).

## Data

Needs data source: point-in-time earnings dates, EPS actual and estimate, and quarterly revenue. The repository has a FinancialDatasets `/earnings` adapter (`services/research/providers/financialdatasets.py`), but no API key is configured. The rules are coded and tested on fixtures; the backtest was not run.

## Backtest

Not run: needs a data source (see Data). Trigger dates cannot be spot-checked until the data exists.

## Limits

- A completed backtest does not authorize a trade. Any live use needs its own options spec and the per-name premium caps (no new share positions).
- Survivorship bias: the test universe uses today's companies.
- Daily bars only; intraday alert timing is approximated as described in the rules.
