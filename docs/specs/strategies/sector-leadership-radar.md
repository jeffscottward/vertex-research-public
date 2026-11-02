# Sector Leadership Radar (research definition and backtest)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- FreeStockAlerts.ai alert template: <https://freestockalerts.ai/templates/sector-leadership-radar> (category: Monitoring; page as of Sep 5, 2026; read 2026-10-26).
- The rules below are restated in Vertex's own words. No site text or code was copied.
- Owner request 2026-10-26 (card vertex-strategies-buildout): add the 12 FreeStockAlerts strategies to Vertex and backtest each trigger.

Summary: The 11 Select Sector SPDR ETFs, alerted when one crosses above its 50-day average.

## Classification

Basis codes: S = stated on the template page; I = implied; A = Vertex default, fixed before the first backtest run. The site alerts research candidates; it states no exit, so the backtest measures forward returns after each alert instead of trades.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Universe: XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, XLC. No screen.|S|
|2|Trigger: a cross above the 50-day average after a close below it.|S|
|3|Label: "bounce in a downtrend" when the ETF is below its 200-day average and its 21-session return trails SPY; otherwise "leadership".|S|
|4|Re-arm: the site re-arms when the user edits the alert; the backtest counts every new cross.|A|
|5|Benchmark: equal-weight mean of the 11 ETFs on the same date.|A|
|6|Bars: daily OHLCV from Yahoo Finance, split-adjusted; forward returns use the dividend-adjusted close. The site uses Twelve Data prices and SEC fundamentals.|A|
|7|An intraday cross above an average uses the previous session's average as the level: previous close below it, session high above it.|A|

## Code and tests

- Rules: `services/research/strategies/alert_templates.py` (`sector_leadership`).
- Unit tests on hand-made fixtures with known trigger sessions: `services/research/tests/test_alert_templates.py`.
- Library entry: migration `packages/db/migrations/0031_strategy_catalog.sql` (portal page `/library`).

## Data

Prices: tested. XLRE starts 2015 and XLC 2018.

## Backtest

Method (fixed before the first run; `services/research/strategies/alert_templates_run.py`):

- Event = one alert. Forward return from the alert-day close to the close 5, 20 and 60 sessions later (dividend-adjusted). The alert is known by the alert-day close, so there is no look-ahead.
- Benchmark = equal-weight mean forward return, same date and horizon, of every symbol in the universe. Excess = event return − benchmark.
- Cost: 10 bp per side (0.20% round trip), charged to the event return.
- Halves: events split at the median event date.
- Pass rule at 20 sessions: at least 30 events, mean net excess > 0 with t ≥ 2, and mean net excess > 0 in both halves. Fewer than 30 events = inconclusive. Overlapping events make t too high; treat it as an upper bound.
- Universe: `research/backtests/freestockalerts/universe.py` — 145 large US stocks with data (S&P 100 names as of 2026 plus the tickers the template pages listed on 2026-10-24). Today's names over 2005–2026 add survivorship bias. BK had no data.
- For this strategy the universe is the 11 sector ETFs and the benchmark is their equal-weight mean on the same date (rule 5), not the stock universe above.
- Data: Yahoo Finance via yfinance, 2005-01-03 to 2026-10-23, fetched 2026-10-26 (`fetch_yahoo.py`; CSV copies and `manifest.json` with SHA-256 per file: `~/Documents/reports/vertex-strategies-buildout/data/` on the rig).
- Spot checks: `spot_check.py` recomputes the three most recent real-data triggers from the raw CSV with separate code and draws one chart each (charts: `~/Documents/reports/vertex-strategies-buildout/charts/` on the rig). One chart per strategy was reviewed by eye: the trigger marker sits on the stated cross, breakout or move.

Results (net of costs; excess = net − benchmark):

|Test|Events|5 sessions: net / excess|20 sessions: net / excess|60 sessions: net / excess|20-session excess, 1st half (n)|2nd half (n)|Verdict|
|---|---|---|---|---|---|---|---|
|All crosses|3551|-0.03% / -0.22% (t -7.52)|+0.77% / -0.06% (t -0.95)|+2.41% / +0.00% (t 0.02)|-0.02% (1775)|-0.09% (1753)|fail|
|leadership|3015|-0.02% / -0.22% (t -7.15)|+0.75% / -0.06% (t -0.95)|+2.52% / +0.04% (t 0.38)|-0.08% (1506)|-0.03% (1494)|fail|
|bounce-in-downtrend|536|-0.05% / -0.21% (t -2.49)|+0.88% / -0.03% (t -0.2)|+1.80% / -0.21% (t -0.73)|+0.19% (268)|-0.26% (260)|fail|

Verdict: Fail as a trade signal: the crossing ETF did not beat the other sector ETFs. The two labels behaved alike.

Raw output: `research/backtests/freestockalerts/results.json`.

### Real-data spot checks

|Symbol|Trigger date|Kind|Independent check|Chart|
|---|---|---|---|---|
|XLU|2026-10-21|crosses-above-50-day|pass: level 41.95, prev close 41.88, high 42.26, low 41.87|`sector-leadership-radar_XLU_2026-10-21.png`|
|XLF|2026-10-22|crosses-above-50-day|pass: level 56.15, prev close 56.04, high 56.67, low 55.82|`sector-leadership-radar_XLF_2026-10-22.png`|
|XLRE|2026-10-23|crosses-above-50-day|pass: level 42.93, prev close 42.52, high 43.21, low 42.35|`sector-leadership-radar_XLRE_2026-10-23.png`|

## Limits

- A completed backtest does not authorize a trade. Any live use needs its own options spec and the per-name premium caps (no new share positions).
- Survivorship bias: the test universe uses today's companies.
- Daily bars only; intraday alert timing is approximated as described in the rules.
