# Analyst Upgrade Clusters (research definition and backtest)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- FreeStockAlerts.ai alert template: <https://freestockalerts.ai/templates/analyst-upgrade-clusters> (category: Idea discovery; page as of last scan Sep 17, 2026; read 2026-10-26).
- The rules below are restated in Vertex's own words. No site text or code was copied.
- Owner request 2026-10-26 (card vertex-strategies-buildout): add the 12 FreeStockAlerts strategies to Vertex and backtest each trigger.

Summary: Two or more independent upgrades or positive initiations within two weeks, alerted once price or volume confirms.

## Classification

Basis codes: S = stated on the template page; I = implied; A = Vertex default, fixed before the first backtest run. The site alerts research candidates; it states no exit, so the backtest measures forward returns after each alert instead of trades.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Universe: rating changes from the last 14 days; market cap over $2B, average volume over 1M shares.|S|
|2|Positive action = an upgrade, or an initiation at Buy or better. Duplicate records from one firm count once. Reiterations and target-only changes do not count.|S|
|3|At least 2 firms with positive actions in 14 days; no firm cut the stock out of buy territory or by two levels in the window.|S|
|4|Ratings map to five levels (Strong Buy 5 … Strong Sell 1); direction comes from the levels. The grade-name table is a Vertex default.|S / A|
|5|Close above the 50-day average.|S|
|6|Trigger, after the close: close above the high of the prior 20 sessions, or volume ≥ 1.5 × the 20-day average on an up day.|S / A|
|7|Cooldown: one alert per company per 14 days; one alert per set of actions.|S|
|8|Bars: daily OHLCV from Yahoo Finance, split-adjusted; forward returns use the dividend-adjusted close. The site uses Twelve Data prices and SEC fundamentals.|A|
|9|Fundamentals and events are explicit inputs; a missing input fails the screen and is reported, never guessed.|A|

## Code and tests

- Rules: `services/research/strategies/alert_templates.py` (`analyst_upgrade_clusters`, `analyst_cluster`, `analyst_action_direction`, `RATING_LEVELS`).
- Unit tests on hand-made fixtures with known trigger sessions: `services/research/tests/test_alert_templates.py`.
- Library entry: migration `packages/db/migrations/0031_strategy_catalog.sql` (portal page `/library`).

## Data

Needs data source: analyst rating history (the site uses Financial Modeling Prep). The repository has no analyst-rating adapter. Rules are coded and tested on fixtures; the backtest was not run.

## Backtest

Not run: needs a data source (see Data). Trigger dates cannot be spot-checked until the data exists.

## Limits

- A completed backtest does not authorize a trade. Any live use needs its own options spec and the per-name premium caps (no new share positions).
- Survivorship bias: the test universe uses today's companies.
- Daily bars only; intraday alert timing is approximated as described in the rules.
