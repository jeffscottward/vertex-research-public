# Insider Purchase Confirmation (research definition and backtest)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- FreeStockAlerts.ai alert template: <https://freestockalerts.ai/templates/insider-purchase-confirmation> (category: Idea discovery; page as of last scan Oct 26, 2026; read 2026-10-26).
- The rules below are restated in Vertex's own words. No site text or code was copied.
- Owner request 2026-10-26 (card vertex-strategies-buildout): add the 12 FreeStockAlerts strategies to Vertex and backtest each trigger.

Summary: Open-market purchases by directors and senior officers, alerted only after the price confirms them.

## Classification

Basis codes: S = stated on the template page; I = implied; A = Vertex default, fixed before the first backtest run. The site alerts research candidates; it states no exit, so the backtest measures forward returns after each alert instead of trades.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Universe: Form 4 transactions with code P in the last 30 days; market cap over $2B, average volume over 1M shares.|S|
|2|Only code P on common or ordinary shares. Exercises, awards, gifts, conversions, sales, zero-price or incomplete records do not count.|S|
|3|Buyer is a director or senior officer (CEO, CFO, COO, president, chair, founder, other chief officer). A 10% owner with no role does not count.|S|
|4|Purchase value (shares × price) ≥ $100,000.|S|
|5|Close above the 50-day average; at least one completed session since the purchase.|S|
|6|Trigger, after the close: close above the highest close since the purchase, or close within 3% of it on volume ≥ 1.5 × the 20-day average.|S|
|7|Ranking score 0–8: several insiders within 30 days, a top role, $500k+, ≥ 10% of the prior holding. Point weights are not stated; Vertex uses 2 points each.|S / A|
|8|Cooldown: one alert per company per 14 days; one alert per filing.|S|
|9|Bars: daily OHLCV from Yahoo Finance, split-adjusted; forward returns use the dividend-adjusted close. The site uses Twelve Data prices and SEC fundamentals.|A|
|10|Fundamentals and events are explicit inputs; a missing input fails the screen and is reported, never guessed.|A|

## Code and tests

- Rules: `services/research/strategies/alert_templates.py` (`insider_purchase_confirmation`, `insider_purchase_counts`, `insider_score`).
- Unit tests on hand-made fixtures with known trigger sessions: `services/research/tests/test_alert_templates.py`.
- Library entry: migration `packages/db/migrations/0031_strategy_catalog.sql` (portal page `/library`).

## Data

Needs data source: Form 4 transaction history. The repository has a FinancialDatasets `/insider-trades` adapter, but no API key is configured. SEC EDGAR Form 4 files are a free alternative that needs a new parser. Rules are coded and tested on fixtures; the backtest was not run.

## Backtest

Not run: needs a data source (see Data). Trigger dates cannot be spot-checked until the data exists.

## Limits

- A completed backtest does not authorize a trade. Any live use needs its own options spec and the per-name premium caps (no new share positions).
- Survivorship bias: the test universe uses today's companies.
- Daily bars only; intraday alert timing is approximated as described in the rules.
