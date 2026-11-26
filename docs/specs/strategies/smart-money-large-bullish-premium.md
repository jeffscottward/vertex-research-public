# Large Bullish Options Premium (QuantData, Frozen Baseline)

Status: research only. Verdict: `needs-more-data` (insufficient history: `284` complete sessions / `~13.1` months vs required `24`-month out-of-sample holdout; unlocks `2027-10-16`). No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- QuantData market-wide options premium flow (`gainers-losers`, stored in Postgres `flow_market_premium` via PR 2; trades `>= $100,000`): <https://quantdata.us/llms-full.txt>.
- Naming constraint (`design.md` PR 2 and PR 7): QuantData's bullish premium class aggregates calls bought at the ask and puts sold at the bid. This signal is therefore named **large bullish premium** and never "call flow".
- Owner decisions: 2026-11-11 and 2026-11-16 (cards `vertex-smart-money-gaps` and `vertex-smart-money-pr7-backtests`, owner Discord message (private), free and already-paid data only).
- Design and plan: [docs/vertex-rebuild/designs/smart-money/design.md](../../vertex-rebuild/designs/smart-money/design.md) and [docs/vertex-rebuild/designs/smart-money/plan-pr7.md](../../vertex-rebuild/designs/smart-money/plan-pr7.md).

Summary: Frozen single-rule (`N = 1`) baseline for large bullish options premium flow. Because QuantData exposes only `~13.1` months of complete sessions (`2025-10-16` to `2026-11-20`), no parameter sweep is performed so that future out-of-sample testing after `2027-10-16` stays uncontaminated.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Source data: complete daily sessions from `flow_market_premium` joined with `flow_market_premium_sessions` where `status = 'complete'` ( `177,519` rows across `284` complete sessions from `2025-10-16` to `2026-11-20`).|Pre-registered (`plan-pr7.md`)|
|2|Frozen signal (`top10-500k`, `N = 1`): on each complete session, tickers with `bullish_premium >= $500,000`, bullish share `>= 70%` and `trade_count >= 3` qualify; a ticker with daily bars must also pass the liquidity filter (as-printed close `>= $5`, 20-day median dollar volume `>= $10M`), and a ticker without bars keeps its rank but cannot be traded. The top 10 by net bullish premium (`bullish_premium - bearish_premium`) are the events (`18,221` qualifying ticker-sessions; `2,770` top-10 events; `140` entries, because the 10 slots stay full for 20 sessions).|Pre-registered (`plan-pr7.md`)|
|3|Entry alignment (zero look-ahead): complete sessions settle after midnight; entry occurs at the next trading day open (`d > session_date`).|Pre-registered (`plan-pr7.md`)|
|4|Portfolio accounting: equal-weight 10-slot event portfolio (`w = 0.10` per slot, no same-ticker overlap), holding period `H = 20` trading days, exit at close of the `20`-th trading day held, measured in excess of SPY at `10 bps` per side.|Pre-registered (`plan-pr7.md`)|
|5|History gate: verdict stays `needs-more-data` with `oosCagr = null` and `oosSharpe = null` until at least `24` calendar months (`>= 490` complete sessions) exist. Full evaluation unlocks on `2027-10-16`.|Pre-registered (`plan-pr7.md`)|

## Code and tests

- Event-study engine and CLI: `services/research/strategies/smart_money/` (`engine.py`, `signals.py`, `document.py`, `__main__.py`).
- Unit tests: `services/research/tests/test_smart_money_backtests.py`.
- Offline rig collector: `scripts/smart-money-pr7/fetch_data.py`.
- Library entry: migration `packages/db/migrations/0095_strategy_catalog_smart_money_backtests.sql` (portal `/library` and Postgres `research_studies` id `smart-money-large-bullish-premium`).

## Descriptive Baseline (2026-11-25, real data — `< 2` years)

Verdict: **`needs-more-data`**. The numbers below describe the observed `13.1`-month window only and are not an out-of-sample verdict.

|Rule (`H = 20`, excess vs SPY, `10 bps/side`)|Complete Sessions|Entries|Observed Excess CAGR|Observed Excess Sharpe|Max DD|Exposure|Win Rate|Profit Factor|
|---|---|---|---|---|---|---|---|---|
|Top 10 `>= $500k` (Frozen, `N = 1`)|284|140|-33.31%|-1.553|-37.30%|99.6%|47.9%|0.588|

Robustness and collection checks:

- **24-month OOS history requirement (`>= 490` sessions):** **FAIL (pending)** — `284` complete sessions (`2025-10-16`..`2026-11-20`); unlocks `2027-10-16`.
- **Zero OOS parameter sweep (frozen rule `N = 1`):** **PASS** — single pre-registered rule `top10-500k (H=20)` recorded without threshold tuning.
- **Forward collection baseline:** `18,221` qualifying ticker-sessions, `2,770` top-10 events, `140` portfolio entries.
- **Skips:** of the `2,770` top-10 events, `2,400` were skipped because all 10 slots were full, `153` because the ticker was already held, `67` because the ticker has no daily bars, and `10` because the entry day is after the last session of the window. Before ranking, `222` ticker-sessions that passed the premium tests had no daily bars (they stay in the ranking) and `268` failed the liquidity check (they leave it).
- **Benchmark:** SPY buy-and-hold over the same window (`2025-10-16`..`2026-11-20`) had `+5.05%` CAGR, Sharpe `+0.418`, max drawdown `-11.46%`.

## Limits

- **Insufficient history:** QuantData exposes ~1 year of history (`2025-10-16`..`2026-11-20`). Do not tune thresholds before `2027-10-16`.
- **Trade-side taxonomy:** QuantData bullish premium aggregates calls bought at the ask and puts sold at the bid; option-side decomposition is absent in `gainers-losers`.
- **Bars for premium tickers:** the collector fetches daily bars for every ticker that passes the premium tests on a complete session, also outside the 600-ticker cap of the other two studies. `67` of the `2,770` top-10 events are in tickers without bars (index options and tickers Yahoo Finance has no history for); they keep their rank and are not traded.
- **Slot capacity:** the 10 slots stay full for 20 sessions, so the baseline holds about 10 new entries per 20 sessions.
- **EOD capture delay:** complete sessions settle after midnight; entries occur at the next session open.
- **Research only:** underlying equity study only; live Vertex rules require defined-risk options and explicit owner approval.
