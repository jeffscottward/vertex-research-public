# Earnings Calendar Alerts (research definition and backtest)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- FreeStockAlerts.ai alert template: <https://freestockalerts.ai/templates/earnings-calendar-alerts> (category: Monitoring; page as of Sep 5, 2026; read 2026-10-26).
- The rules below are restated in Vertex's own words. No site text or code was copied.
- Owner request 2026-10-26 (card vertex-strategies-buildout): add the 12 FreeStockAlerts strategies to Vertex and backtest each trigger.

Summary: Reminders before seven widely held companies report, plus alerts on unusually large single-session moves.

## Classification

Basis codes: S = stated on the template page; I = implied; A = Vertex default, fixed before the first backtest run. The site alerts research candidates; it states no exit, so the backtest measures forward returns after each alert instead of trades.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Universe: AAPL, NVDA, TSLA, META, AMZN, MSFT, GOOGL.|S|
|2|Reminder: once per report, on the first session within 3 calendar days before the scheduled date.|S / A|
|3|Large move: AAPL ≥ 5%, NVDA or TSLA ≥ 7% from the previous close, either direction, any day; at most one per session.|S|
|4|Move test benchmarks: (a) equal-weight mean of the 7 stocks; (b) the same stock's average forward return over all sessions, which removes the selection effect of testing the best performers.|A|
|5|Bars: daily OHLCV from Yahoo Finance, split-adjusted; forward returns use the dividend-adjusted close. The site uses Twelve Data prices and SEC fundamentals.|A|

## Code and tests

- Rules: `services/research/strategies/alert_templates.py` (`earnings_reminders`, `large_moves`).
- Unit tests on hand-made fixtures with known trigger sessions: `services/research/tests/test_alert_templates.py`.
- Library entry: migration `packages/db/migrations/0031_strategy_catalog.sql` (portal page `/library`).

## Data

Large moves: tested. Reminders need a data source for historical report dates (FinancialDatasets `/earnings` adapter exists; no API key is configured).

## Backtest

Method (fixed before the first run; `services/research/strategies/alert_templates_run.py`):

- Event = one alert. Forward return from the alert-day close to the close 5, 20 and 60 sessions later (dividend-adjusted). The alert is known by the alert-day close, so there is no look-ahead.
- Benchmark = equal-weight mean forward return, same date and horizon, of every symbol in the universe. Excess = event return − benchmark.
- Cost: 10 bp per side (0.20% round trip), charged to the event return.
- Halves: events split at the median event date.
- Pass rule at 20 sessions: at least 30 events, mean net excess > 0 with t ≥ 2, and mean net excess > 0 in both halves. Fewer than 30 events = inconclusive. Overlapping events make t too high; treat it as an upper bound.
- Universe: `research/backtests/freestockalerts/universe.py` — 145 large US stocks with data (S&P 100 names as of 2026 plus the tickers the template pages listed on 2026-10-24). Today's names over 2005–2026 add survivorship bias. BK had no data.
- For this strategy the universe is the 7 listed stocks; the benchmarks are the 7-stock equal-weight mean and each stock's own average forward return (rule 4), not the stock universe above.
- Data: Yahoo Finance via yfinance, 2005-01-03 to 2026-10-23, fetched 2026-10-26 (`fetch_yahoo.py`; CSV copies and `manifest.json` with SHA-256 per file: `~/Documents/reports/vertex-strategies-buildout/data/` on the rig).
- Spot checks: `spot_check.py` recomputes the three most recent real-data triggers from the raw CSV with separate code and draws one chart each (charts: `~/Documents/reports/vertex-strategies-buildout/charts/` on the rig). One chart per strategy was reviewed by eye: the trigger marker sits on the stated cross, breakout or move.

Results (net of costs; excess = net − benchmark):

|Test|Events|5 sessions: net / excess|20 sessions: net / excess|60 sessions: net / excess|20-session excess, 1st half (n)|2nd half (n)|Verdict|
|---|---|---|---|---|---|---|---|
|Moves vs 7-stock average (all)|1006|+1.16% / +0.55% (t 2.7)|+4.34% / +1.77% (t 4.67)|+14.52% / +4.95% (t 7.08)|+1.77% (503)|+1.77% (503)|pass|
|Moves up vs 7-stock average|520|+1.16% / +0.73% (t 2.57)|+4.72% / +2.23% (t 4.16)|+14.54% / +5.17% (t 5.35)|+2.14% (260)|+2.32% (260)|pass|
|Moves down vs 7-stock average|486|+1.16% / +0.36% (t 1.21)|+3.93% / +1.28% (t 2.4)|+14.49% / +4.70% (t 4.65)|+1.18% (243)|+1.38% (243)|pass|
|Moves (all) vs own average|1006|+1.16% / +0.30% (t 1.01)|+4.34% / +0.80% (t 1.42)|+14.52% / +3.45% (t 3.41)|-0.11% (503)|+1.70% (503)|fail|

Verdict: Against the 7-stock average the move alerts pass, but that comes from selection: NVDA and TSLA, which produce most alerts, outperformed the other five. Against each stock's own average return they fail (20-session excess +0.8%, t 1.4, first half negative). Verdict: fail; no evidence that a large move predicts the next 20 sessions.

Raw output: `research/backtests/freestockalerts/results.json`.

### Real-data spot checks

|Symbol|Trigger date|Kind|Independent check|Chart|
|---|---|---|---|---|
|AAPL|2026-07-31|move-down|pass: high vs prev close -6.8%, low vs prev close -10.0%|`earnings-calendar-alerts_AAPL_2026-07-31.png`|
|NVDA|2026-08-27|move-up|pass: high vs prev close +9.9%, low vs prev close +5.4%|`earnings-calendar-alerts_NVDA_2026-08-27.png`|
|TSLA|2026-09-03|move-up|pass: high vs prev close +7.6%, low vs prev close +2.5%|`earnings-calendar-alerts_TSLA_2026-09-03.png`|

## Limits

- A completed backtest does not authorize a trade. Any live use needs its own options spec and the per-name premium caps (no new share positions).
- Survivorship bias: the test universe uses today's companies.
- Daily bars only; intraday alert timing is approximated as described in the rules.
