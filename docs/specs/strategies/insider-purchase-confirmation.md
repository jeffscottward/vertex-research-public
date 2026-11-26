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

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Data filter: SEC Form 4 non-derivative open-market purchases (`DOCUMENT_TYPE = '4'`, `TRANS_CODE = 'P'`, `TRANS_SHARES > 0`, `TRANS_PRICEPERSHARE > 0`) on common or ordinary equity shares only; exercises, awards, gifts, conversions, sales, and preferred/unit/option titles are excluded.|S / A|
|2|Filing-date alignment (zero look-ahead): Form 4 is due within 2 business days; every signal uses `FILING_DATE` as public-at time and enters at the next trading day open (`d > FILING_DATE`).|A|
|3|Decimal typo / ticker reuse guard: drop any Form 4 row whose reported price falls outside `[0.25x, 4.0x]` of the as-printed close on `FILING_DATE` (the close before any later split is applied).|A|
|4|Liquidity filter: entry requires an as-printed close `>= $5.00` on the trigger day and a trailing 20-day median dollar volume `>= $10,000,000`.|A|
|5|Primary variant (`cluster-3p-10d`): at least 3 distinct reporting-owner groups (joint filers sharing an accession count once) purchase the same issuer within 10 calendar days by `FILING_DATE`.|A|
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
- Library entry: migrations `packages/db/migrations/0031_strategy_catalog.sql` and `0095_strategy_catalog_smart_money_backtests.sql` (portal `/library` and Postgres `research_studies` id `insider-purchase-confirmation`).

## Data

- SEC Form 3/4/5 quarterly ZIP archives (`2016q1`–`2026q1`): `284,580` code-P common/ordinary buys. `189,879` rows are in tickers without bars, `1,083` were filed before the first bar of their ticker, and `618` rows failed the `[0.25x, 4.0x]` price guard, which leaves `93,000` rows (`3,026` of them flagged `AFF10B5ONE` after 2023).
- Daily OHLCV bars: Yahoo Finance daily series for `468` of the `600` pre-registered tickers (`SPY`, the 146-stock core universe, and the event tickers with the most events in the whole sample). Yahoo has no history for the other `132` (delisted, acquired or renamed issuers). Returns use split- and dividend-adjusted prices; price filters use the as-printed close (`raw_close`), which the collector derives from Yahoo's split events.

## Backtest (2026-11-25, real data)

Verdict: **`no-edge`**. Over `502` OOS sessions (`2024-04-01` to `2026-03-31`), the pre-registered primary trial `cluster-3p-10d (H=20)` generated `79` OOS events (below the `100`-event bar) and a Deflated Sharpe Ratio of `0.351` at `N = 12` (below the `0.95` bar).

|Variant (`H = 20`, excess vs SPY)|Trades (Full)|Full CAGR|Full Sharpe|Max DD|Win Rate|OOS Events|OOS CAGR|OOS Sharpe|
|---|---|---|---|---|---|---|---|---|
|Cluster 3p/10d (Primary, 10 bps/side)|468|+0.31%|+0.083|-40.78%|49.1%|79|+7.33%|+0.977|
|Confirmation Baseline (10 bps/side)|680|-1.27%|-0.105|-33.48%|48.7%|139|-7.62%|-0.823|
|Cluster 3p/10d `$100k+` (10 bps/side)|318|-0.35%|+0.028|-44.33%|52.8%|73|+7.05%|+0.971|
|Cluster + Confirm (10 bps/side)|280|-1.19%|-0.196|-20.71%|44.6%|51|-3.74%|-0.690|
|Cluster 3p/10d (Stress 20 bps/side)|468|-0.60%|-0.005|-42.71%|47.6%|79|+6.45%|+0.868|

Robustness checks on the primary trial (`cluster-3p-10d`, `H = 20`):

- **Deflated Sharpe Ratio (`N = 12`, bar `>= 0.95`):** **FAIL** — `DSR = 0.3509`, `z = -0.383`, per-observation benchmark `0.0788`.
- **OOS event count (bar `>= 100`):** **FAIL** — `79` OOS entries over `502` sessions (`2024-04-01`..`2026-03-31`).
- **Cost stress (`0 / 10 / 20 bps` per side):** **PASS** — OOS Sharpe `1.086` (`0 bps`), `0.977` (`10 bps`), `0.868` (`20 bps`).
- **Post-2023 Rule 10b5-1 exclusion sensitivity (diagnostic):** excluding `3,026` flagged `10b5-1` rows yields OOS Sharpe `0.823` across `75` OOS events.
- **Skips:** `56` overlap, `32` capacity, `2,354` illiquid, `6` truncated exits at window end.
- **Benchmark:** SPY buy-and-hold over the full window had `+14.01%` CAGR, Sharpe `+0.823`, max drawdown `-33.72%`.

## Limits

- Research only. A backtest never authorizes a trade; any future live strategy requires an explicit defined-risk options specification and human approval (no new share positions; hard 2% NLV max-loss cap).
- **Universe cap and survivorship bias:** the study covers `468` tickers. `189,879` of the `284,580` Form 4 rows are in tickers without bars: tickers outside the 600-ticker cap, and `132` capped tickers for which Yahoo Finance has no history (delisted, acquired or renamed issuers). Insider cluster buys are frequent in small issuers, so a wider universe can give a different result.
- **SEC filing anomalies:** `618` rows failed the `[0.25x, 4.0x]` price guard against the as-printed close (decimal typos or reused tickers).
- **Rule 10b5-1 regime break:** the `AFF10B5ONE` checkbox did not exist before Q2 2023.
- **Reporting delay:** Form 4 filings are due within 2 business days of execution; backtest entries strictly follow `FILING_DATE`.
