# Insider Purchase Confirmation & SEC Form 4 Cluster Buys (research definition and backtest)

Status: research only. Verdict: `no-edge` (failed pre-registered out-of-sample event count and deflated Sharpe ratio bars). No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- FreeStockAlerts.ai alert template: <https://freestockalerts.ai/templates/insider-purchase-confirmation> (category: Idea discovery; page as of last scan 2026-10-26). The template rules below are restated in Vertex's own words; no site text or code was copied.
- SEC quarterly Form 3/4/5 insider transaction datasets (`2016q1`–`2026q1`, 41 quarterly ZIP archives, `284,580` code-P common/ordinary purchases): <https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets>.
- Owner decisions: 2026-10-26 (card `vertex-strategies-buildout`, add FreeStockAlerts templates); 2026-11-11 and 2026-11-16 (cards `vertex-smart-money-gaps` and `vertex-smart-money-pr7-backtests`, owner Discord message (private), free and already-paid data only).
- Design and plan: [docs/vertex-rebuild/designs/smart-money/design.md](../../vertex-rebuild/designs/smart-money/design.md) and [docs/vertex-rebuild/designs/smart-money/plan-pr7.md](../../vertex-rebuild/designs/smart-money/plan-pr7.md).

Summary: Open-market SEC Form 4 purchases (code `P`) evaluated both under the FreeStockAlerts confirmation rule (`confirmation-baseline`) and under pre-registered multi-insider cluster buy variants (`cluster-3p-10d` primary).

## Classification

Basis codes: S = stated on the FreeStockAlerts template page; I = implied; A = Vertex pre-registered backtest rule from `plan-pr7.md` (method gates decided from the trading knowledge bases before running the data).

## Template rules (`confirmation-baseline`)

The FreeStockAlerts template, restated in Vertex's own words. `services/research/strategies/alert_templates.py` implements rules 2 to 8; the backtest feeds it with the Form 4 filing date as the purchase day.

|#|Rule|Basis|
|---|---|---|
|1|Universe: Form 4 transactions with code P in the last 30 days; market cap over $2B, average volume over 1M shares. The backtest does not have point-in-time market cap, so it uses the pre-registered universe and the liquidity filter of the backtest rules below instead.|S / A|
|2|Only code P on common or ordinary shares. Exercises, awards, gifts, conversions, sales, zero-price or incomplete records do not count.|S|
|3|Buyer is a director or senior officer (CEO, CFO, COO, president, chair, founder, other chief officer). A 10% owner with no role does not count.|S|
|4|Purchase value (shares × price) ≥ $100,000.|S|
|5|Close above the 50-day average; at least one completed session since the purchase.|S|
|6|Trigger, after the close: close above the highest close since the purchase, or close within 3% of it on volume ≥ 1.5 × the 20-day average.|S|
|7|Ranking score 0–8: several insiders within 30 days, a top role, $500k+, ≥ 10% of the prior holding. Point weights are not stated; Vertex uses 2 points each. The backtest does not use the score.|S / A|
|8|Cooldown: one alert per company per 14 days; one alert per filing.|S|

## Backtest rules (`plan-pr7.md`)

|#|Rule|Basis|
|---|---|---|
|1|Data filter: SEC Form 4 non-derivative open-market purchases (`DOCUMENT_TYPE = '4'`, `TRANS_CODE = 'P'`, `TRANS_SHARES > 0`, `TRANS_PRICEPERSHARE > 0`) on common or ordinary equity shares only; exercises, awards, gifts, conversions, sales, and preferred/unit/option titles are excluded.|S / A|
|2|Filing-date alignment (zero look-ahead): Form 4 is due within 2 business days; every signal uses `FILING_DATE` as public-at time and enters at the next trading day open (`d > FILING_DATE`).|A|
|3|Decimal typo / ticker reuse guard: drop any Form 4 row whose reported price falls outside `[0.25x, 4.0x]` of the as-printed close on `FILING_DATE` (the close before any later split is applied).|A|
|4|Liquidity filter: entry requires an as-printed close `>= $5.00` on the trigger day and a trailing 20-day median dollar volume `>= $10,000,000`.|A|
|5|Primary variant (`cluster-3p-10d`): at least 3 distinct reporting-owner groups purchase the same issuer within 10 calendar days by `FILING_DATE`; 14-day per-issuer cooldown after a trigger. Owners that file together are one group, and an owner who also files alone or with others joins those filings into the same group (the rule of the live cluster list, `packages/api/src/insider-clusters.ts`). Unlike the template rule, a 10% owner without a role counts, and there is no value floor.|A|
|6|Counted variants (`N = 12` total trials across 4 variants x 3 horizons `H in {5, 20, 60}`): `confirmation-baseline` (existing `alert_templates.insider_purchase_confirmation` rule), `cluster-3p-10d` (primary), `cluster-3p-10d-100k` (cluster total `>= $100,000`), `cluster-3p-10d-confirm` (cluster plus confirmation close).|S / A|
|7|Portfolio accounting: equal-weight 10-slot event portfolio (`w = 0.10` per slot, idle slots earn `0` excess return), no overlapping position in the same ticker, exit at the close of the `H`-th trading day held, measured in excess of SPY (split/dividend adjusted).|A|
|8|Costs: `10 bps` per side base cost (`20 bps` round trip), plus `0 bps` and `20 bps` per side stress tests on the primary trial.|A|
|9|Sample split: in-sample `2016-01-01` to `2024-03-31`; strictly held-out 24-month out-of-sample (OOS) window `2024-04-01` to `2026-03-31` (`502` trading sessions).|A|
|10|Pass gate: OOS span `>= 24` months (`>= 490` sessions), `>= 100` OOS events, OOS excess Sharpe `> 0` at both `10 bps` and `20 bps` per side, and Deflated Sharpe Ratio (DSR) `>= 0.95` at full trial count `N = 12`.|A|

## Code and tests

- Alert template rule: `services/research/strategies/alert_templates.py` (`insider_purchase_confirmation`, `insider_purchase_counts`, `insider_score`) and `services/research/tests/test_alert_templates.py`.
- Event-study engine and CLI: `services/research/strategies/smart_money/` (`engine.py`, `signals.py`, `document.py`, `__main__.py`) reusing `services/research/backtesting/optimizer.py` (`deflated_sharpe_ratio`) and `services/research/strategies/trend_trio/study.py` (`moments`).
- Unit tests: `services/research/tests/test_smart_money_backtests.py`.
- Offline rig collector: `scripts/smart-money-pr7/fetch_data.py`.
- Library entry: migrations `packages/db/migrations/0031_strategy_catalog.sql` and `0096_strategy_catalog_smart_money_backtests.sql` (portal `/library` and Postgres `research_studies` id `insider-purchase-confirmation`).

## Data

- SEC Form 3/4/5 quarterly ZIP archives (`2016q1`–`2026q1`): `284,580` code-P common/ordinary buys. `189,879` rows are in tickers without bars, `1,083` were filed before the first bar of their ticker, and `618` rows failed the `[0.25x, 4.0x]` price guard, which leaves `93,000` rows (`3,026` of them flagged `AFF10B5ONE` after 2023).
- Daily OHLCV bars: Yahoo Finance daily series for `468` of the `600` pre-registered tickers (`SPY`, the 146-stock core universe, and the event tickers with the most events in the whole sample). Yahoo has no history for the other `132` (delisted, acquired or renamed issuers). Returns use split- and dividend-adjusted prices; price filters use the as-printed close (`raw_close`), which the collector derives from Yahoo's split events.

## Backtest (2026-11-25, real data)

Verdict: **`no-edge`**. Over `502` OOS sessions (`2024-04-01` to `2026-03-31`), the pre-registered primary trial `cluster-3p-10d (H=20)` generated `78` OOS events (below the `100`-event bar) and a Deflated Sharpe Ratio of `0.334` at `N = 12` (below the `0.95` bar).

|Variant (`H = 20`, excess vs SPY)|Trades (Full)|Full CAGR|Full Sharpe|Max DD|Win Rate|OOS Events|OOS CAGR|OOS Sharpe|
|---|---|---|---|---|---|---|---|---|
|Cluster 3p/10d (Primary, 10 bps/side)|465|-0.34%|+0.020|-40.78%|48.6%|78|+7.07%|+0.956|
|Confirmation Baseline (10 bps/side)|680|-1.27%|-0.105|-33.48%|48.7%|139|-7.62%|-0.823|
|Cluster 3p/10d `$100k+` (10 bps/side)|315|-0.99%|-0.029|-44.33%|52.1%|72|+6.80%|+0.950|
|Cluster + Confirm (10 bps/side)|276|-1.49%|-0.258|-23.15%|43.8%|50|-3.87%|-0.720|
|Cluster 3p/10d (Stress 20 bps/side)|465|-1.24%|-0.067|-42.71%|47.1%|78|+6.21%|+0.846|

Robustness checks on the primary trial (`cluster-3p-10d`, `H = 20`):

- **Deflated Sharpe Ratio (`N = 12`, bar `>= 0.95`):** **FAIL** — `DSR = 0.3335`, `z = -0.430`, per-observation benchmark `0.0795`.
- **OOS event count (bar `>= 100`):** **FAIL** — `78` OOS entries over `502` sessions (`2024-04-01`..`2026-03-31`).
- **Cost stress (`0 / 10 / 20 bps` per side):** **PASS** — OOS Sharpe `1.065` (`0 bps`), `0.956` (`10 bps`), `0.846` (`20 bps`).
- **Post-2023 Rule 10b5-1 exclusion sensitivity (diagnostic):** excluding `3,026` flagged `10b5-1` rows yields OOS Sharpe `0.823` across `75` OOS events.
- **Skips:** `56` overlap, `32` capacity, `2,350` illiquid, `6` truncated exits at window end.
- **Post-hoc full-universe check (not in the verdict):** after the first look at the out-of-sample window, the primary trial was also run without the 600-ticker cap, on bars for `3,153` tickers (every ticker with a cluster event or a Congress purchase that Yahoo Finance has history for; `1,279` of the `3,964` further tickers have none). Result: `164` OOS events, OOS excess Sharpe `-0.354`, `DSR = 0.011` at `N = 13`; whole-sample `830` trades, Sharpe `+0.110`. The wider universe passes the event-count bar and fails the Sharpe and deflated Sharpe bars (it has no 20 bps stress run), so the cap does not hide an edge. This run counts as one more trial; a pass would have needed a new holdout.
- **Benchmark:** SPY buy-and-hold over the full window had `+14.01%` CAGR, Sharpe `+0.823`, max drawdown `-33.72%`.

## Limits

- Research only. A backtest never authorizes a trade; any future live strategy requires an explicit defined-risk options specification and human approval (no new share positions; hard 2% NLV max-loss cap).
- **Universe cap and survivorship bias:** the study covers `468` tickers. `189,879` of the `284,580` Form 4 rows are in tickers without bars: tickers outside the 600-ticker cap, and `132` capped tickers for which Yahoo Finance has no history (delisted, acquired or renamed issuers). Insider cluster buys are frequent in small issuers: `2,903` of `9,196` cluster events in the window (`295` of `3,296` tickers; out of sample `461` of `1,303`) remain after the bar universe and the price guard. The failed event-count bar therefore also reflects the 600-ticker cap, and a wider universe can give a different result. The deflated Sharpe bar fails on the tested universe in any case.
- **SEC filing anomalies:** `618` rows failed the `[0.25x, 4.0x]` price guard against the as-printed close (decimal typos or reused tickers).
- **Share-volume floor of the confirmation baseline:** the template's floor of 1,000,000 shares of average volume reads Yahoo volumes that are restated for later splits. A point-in-time evaluation (measured 2026-11-25) changes `32` of `966` baseline events (`6` exist only because of a later split, `26` are missing); the out-of-sample numbers of the baseline do not change. The cluster variants do not use this floor.
- **Rule 10b5-1 regime break:** the `AFF10B5ONE` checkbox did not exist before Q2 2023.
- **Reporting delay:** Form 4 filings are due within 2 business days of execution; backtest entries strictly follow `FILING_DATE`.
