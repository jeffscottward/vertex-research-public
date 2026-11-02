# Market Stress Alerts (research definition and backtest)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- FreeStockAlerts.ai alert template: <https://freestockalerts.ai/templates/market-stress-alerts> (category: Monitoring; page as of Sep 5, 2026; read 2026-10-26).
- The rules below are restated in Vertex's own words. No site text or code was copied.
- Owner request 2026-10-26 (card vertex-strategies-buildout): add the 12 FreeStockAlerts strategies to Vertex and backtest each trigger.

Summary: Plain alerts on volatility, large index moves, 200-day breaks, Treasuries and credit.

## Classification

Basis codes: S = stated on the template page; I = implied; A = Vertex default, fixed before the first backtest run. The site alerts research candidates; it states no exit, so the backtest measures forward returns after each alert instead of trades.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|VIX: above 25, above 35 (session high), below 13 (session low).|S / A|
|2|SPY session move ≥ 2%, QQQ ≥ 3%, TLT ≥ 2%, HYG ≥ 1.5%, either direction, from the previous close (session high or low).|S / A|
|3|SPY crosses below and back above its 200-day average; IWM crosses below its 200-day average.|S|
|4|Move alerts: at most one per session. Threshold alerts re-arm after the close is back on the other side.|S / A|
|5|Test: SPY's forward return after each alert type against SPY's average forward return over all sessions. These are context alerts, not trade signals; a long-SPY cost is charged for consistency.|A|
|6|Bars: daily OHLCV from Yahoo Finance, split-adjusted; forward returns use the dividend-adjusted close. The site uses Twelve Data prices and SEC fundamentals.|A|
|7|An intraday cross above an average uses the previous session's average as the level: previous close below it, session high above it.|A|

## Code and tests

- Rules: `services/research/strategies/alert_templates.py` (`market_stress`, `vix_thresholds`, `session_moves`, `trend_crosses`).
- Unit tests on hand-made fixtures with known trigger sessions: `services/research/tests/test_alert_templates.py`.
- Library entry: migration `packages/db/migrations/0031_strategy_catalog.sql` (portal page `/library`).

## Data

Prices: tested.

## Backtest

Method (fixed before the first run; `services/research/strategies/alert_templates_run.py`):

- Event = one alert. Forward return from the alert-day close to the close 5, 20 and 60 sessions later (dividend-adjusted). The alert is known by the alert-day close, so there is no look-ahead.
- Benchmark = equal-weight mean forward return, same date and horizon, of every symbol in the universe. Excess = event return − benchmark.
- Cost: 10 bp per side (0.20% round trip), charged to the event return.
- Halves: events split at the median event date.
- Pass rule at 20 sessions: at least 30 events, mean net excess > 0 with t ≥ 2, and mean net excess > 0 in both halves. Fewer than 30 events = inconclusive. Overlapping events make t too high; treat it as an upper bound.
- Universe: `research/backtests/freestockalerts/universe.py` — 145 large US stocks with data (S&P 100 names as of 2026 plus the tickers the template pages listed on 2026-10-24). Today's names over 2005–2026 add survivorship bias. BK had no data.
- For this strategy the generic universe and benchmark above do not apply: the events are the fixed-list alerts, the measured asset is SPY, and the benchmark is SPY's average forward return over all sessions (rule 5).
- Data: Yahoo Finance via yfinance, 2005-01-03 to 2026-10-23, fetched 2026-10-26 (`fetch_yahoo.py`; CSV copies and `manifest.json` with SHA-256 per file: `~/Documents/reports/vertex-strategies-buildout/data/` on the rig).
- Spot checks: `spot_check.py` recomputes the latest real-data trigger of three alert types (VIX above 25, SPY 2% move, SPY 200-day cross) from the raw CSV with separate code and draws one chart each (charts: `~/Documents/reports/vertex-strategies-buildout/charts/` on the rig). All three charts were reviewed by eye: the trigger marker sits on the stated threshold, move or cross.

Results (net of costs; excess = net − benchmark):

|Test|Events|5 sessions: net / excess|20 sessions: net / excess|60 sessions: net / excess|20-session excess, 1st half (n)|2nd half (n)|Verdict|
|---|---|---|---|---|---|---|---|
|^VIX vix-above-25|169|+0.05% / -0.19% (t -0.84)|+1.15% / +0.21% (t 0.47)|+4.00% / +1.20% (t 2.11)|+0.31% (84)|+0.11% (85)|fail|
|^VIX vix-above-35|62|+0.71% / +0.48% (t 0.91)|+1.45% / +0.51% (t 0.5)|+5.66% / +2.85% (t 2.24)|-1.14% (31)|+2.16% (31)|fail|
|^VIX vix-below-13|206|-0.18% / -0.42% (t -4.29)|+0.34% / -0.60% (t -3.37)|+1.63% / -1.17% (t -3.29)|-0.38% (103)|-0.82% (103)|fail|
|SPY crosses-above-200-day|122|-0.17% / -0.40% (t -1.49)|+0.51% / -0.43% (t -0.8)|+2.97% / +0.17% (t 0.23)|+0.74% (61)|-1.60% (61)|fail|
|SPY crosses-below-200-day|129|-0.24% / -0.48% (t -1.69)|-0.01% / -0.95% (t -1.97)|+2.78% / -0.02% (t -0.03)|-0.37% (64)|-1.52% (65)|fail|
|SPY move-down|372|+0.40% / +0.17% (t 0.75)|+1.34% / +0.41% (t 1.03)|+4.36% / +1.55% (t 2.75)|-0.62% (186)|+1.44% (186)|fail|
|SPY move-up|273|-0.24% / -0.47% (t -1.85)|+1.27% / +0.33% (t 0.81)|+3.85% / +1.04% (t 1.55)|-0.87% (136)|+1.52% (137)|fail|
|QQQ move-down|201|+0.42% / +0.18% (t 0.53)|+0.78% / -0.16% (t -0.26)|+4.31% / +1.51% (t 1.86)|-1.01% (100)|+0.70% (100)|fail|
|QQQ move-up|148|-0.69% / -0.93% (t -2.32)|+0.57% / -0.36% (t -0.57)|+2.73% / -0.07% (t -0.07)|-2.06% (74)|+1.33% (74)|fail|
|TLT move-down|184|-0.27% / -0.50% (t -1.84)|+0.60% / -0.34% (t -0.76)|+4.52% / +1.71% (t 2.56)|-1.10% (92)|+0.43% (92)|fail|
|TLT move-up|163|+0.44% / +0.20% (t 0.55)|+1.88% / +0.95% (t 1.54)|+4.72% / +1.92% (t 2.16)|-0.43% (81)|+2.33% (80)|fail|
|HYG move-down|163|+0.62% / +0.38% (t 0.92)|+1.85% / +0.91% (t 1.34)|+4.95% / +2.14% (t 2.12)|-1.45% (81)|+3.25% (82)|fail|
|HYG move-up|137|-0.15% / -0.38% (t -0.97)|+1.03% / +0.09% (t 0.13)|+3.55% / +0.75% (t 0.67)|-2.01% (68)|+2.16% (69)|fail|
|IWM crosses-below-200-day|184|+0.22% / -0.02% (t -0.1)|+0.21% / -0.73% (t -1.62)|+2.02% / -0.78% (t -1.08)|-1.11% (92)|-0.33% (89)|fail|

Verdict: No alert type passes the frozen rule. VIX below 13 was followed by below-average SPY returns at every horizon (t about −3 to −4). VIX above 25/35 and large SPY drops were followed by above-average 60-session returns, but the first half is weaker or negative. Use these as context, as the site intends.

Raw output: `research/backtests/freestockalerts/results.json`.

### Real-data spot checks

|Symbol|Trigger date|Kind|Independent check|Chart|
|---|---|---|---|---|
|^VIX|2026-04-07|vix-above-25|pass: session high 28.00 > 25; previous close 24.17 (re-armed)|`market-stress-alerts_VIX_2026-04-07.png`|
|SPY|2026-06-26|move-down|pass: low vs previous close -2.41% (limit 2%)|`market-stress-alerts_SPY_2026-06-26.png`|
|SPY|2026-04-08|crosses-above-200-day|pass: previous close 659.22 < 200-day level 663.19 < session high 677.08|`market-stress-alerts_SPY_2026-04-08.png`|

## Limits

- A completed backtest does not authorize a trade. Any live use needs its own options spec and the per-name premium caps (no new share positions).
- Survivorship bias: the test universe uses today's companies.
- Daily bars only; intraday alert timing is approximated as described in the rules.
