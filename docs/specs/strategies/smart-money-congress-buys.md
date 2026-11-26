# Congress Electronic PTR Purchases by Filing Date (research definition and backtest)

Status: research only. Verdict: `no-edge` (failed pre-registered deflated Sharpe ratio bar). No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- U.S. House Clerk Periodic Transaction Report (PTR) PDFs (`house.v1` parser): <https://disclosures-clerk.house.gov/FinancialDisclosure>.
- U.S. Senate eFD electronic PTR HTML disclosures (`senate.v1` parser): <https://efdsearch.senate.gov/search/>.
- Live 2026 rows exported from QuantVPS Postgres (`openbb_congress_trades` joined with `openbb_congress_filings`, PR 1); 2022–2025 history parsed via `services/openbb/vertex_openbb/jobs/congress.py`.
- Owner decisions: 2026-11-11 and 2026-11-16 (cards `vertex-smart-money-gaps` and `vertex-smart-money-pr7-backtests`, owner Discord message (private), free and already-paid data only).
- Design and plan: [docs/vertex-rebuild/designs/smart-money/design.md](../../vertex-rebuild/designs/smart-money/design.md) and [docs/vertex-rebuild/designs/smart-money/plan-pr7.md](../../vertex-rebuild/designs/smart-money/plan-pr7.md).

Summary: Event-study backtest of U.S. House and Senate electronic PTR stock purchases entered strictly at the next trading day open after the first `filed_on` date (zero look-ahead).

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Sample window: `2022-01-01` to `2026-11-23` (in-sample through `2024-11-22`; strictly held-out 24-month OOS `2024-11-23` to `2026-11-23`, `500` trading sessions). Pre-2022 House PTR PDFs use legacy Wingdings/small-caps fonts (`layout_unknown` in `house.v1`) and are excluded so House and Senate share a balanced window.|Pre-registered (`plan-pr7.md`)|
|2|One event per trade: the trade key is `(chamber, normalized_member, holder, ticker, tx_date_or_doc_id, purchase)`. Rows with the same key inside one filing are lots of the same purchase day and their amounts are summed (`386` rows). Of several filings with the same key the earliest `filed_on` is kept, so an amended filing never moves the public-at date (`114` trades of later filings dropped). Rows that report an option (House `OP`, Senate `Stock Option`; `209` rows, puts included) are dropped first. Result: `9,284` trades from `9,993` purchase rows.|Pre-registered (`design.md` PR 1); lot rule corrected 2026-11-25 (`plan-pr7.md`)|
|3|Entry alignment (zero look-ahead): STOCK Act allows up to 45 calendar days between trade execution and public disclosure; entry is strictly the next trading day open after `filed_on`.|Pre-registered (`plan-pr7.md`)|
|4|Liquidity filter: entry requires prior-session close `>= $5.00` and trailing 20-day median dollar volume `>= $10,000,000`.|Pre-registered (`plan-pr7.md`)|
|5|Counted variants (`N = 12` total trials across 4 variants x 3 horizons `H in {5, 20, 60}`): `all-buys` (primary, `amount_low >= $1,001`), `large-50k` (`amount_low >= $50,001`), `fast-filed-15d` (`filed_on - tx_date <= 15` days), and `multi-member-30d` (`>= 2` distinct members buying within 30 calendar days; 14-day per-ticker cooldown after a trigger).|Pre-registered (`plan-pr7.md`)|
|6|Portfolio accounting: equal-weight 10-slot event portfolio (`w = 0.10` per slot, no same-ticker overlap), exit at close of the `H`-th trading day held, measured in excess of SPY (split/dividend adjusted).|Pre-registered (`plan-pr7.md`)|
|7|Costs: `10 bps` per side base cost (`0` and `20 bps` per side stress tests on the primary trial).|Pre-registered (`plan-pr7.md`)|
|8|Pass gate: OOS span `>= 24` months (`>= 490` sessions), `>= 100` OOS events, OOS excess Sharpe `> 0` at both `10 bps` and `20 bps` per side, and DSR `>= 0.95` at full `N = 12`.|Pre-registered (`plan-pr7.md`)|

## Code and tests

- Event-study engine and CLI: `services/research/strategies/smart_money/` (`engine.py`, `signals.py`, `document.py`, `__main__.py`).
- Unit tests: `services/research/tests/test_smart_money_backtests.py`.
- Offline rig collector: `scripts/smart-money-pr7/fetch_data.py`.
- Library entry: migration `packages/db/migrations/0096_strategy_catalog_smart_money_backtests.sql` (portal `/library` and Postgres `research_studies` id `smart-money-congress-buys`).

## Backtest (2026-11-25, real data)

Verdict: **`no-edge`**. Over `500` OOS sessions (`2024-11-23` to `2026-11-23`), the pre-registered primary trial `all-buys (H=20)` passed the event-count bar (`238 >= 100`), but failed the Deflated Sharpe Ratio bar (`DSR = 0.095 < 0.95` at `N = 12`) and the 20 bps cost-stress bar (OOS Sharpe `-0.167`).

|Variant (`H = 20`, excess vs SPY)|Trades (Full)|Full CAGR|Full Sharpe|Max DD|Win Rate|OOS Events|OOS CAGR|OOS Sharpe|
|---|---|---|---|---|---|---|---|---|
|All PTR Buys (Primary, 10 bps/side)|567|-2.65%|-0.209|-21.42%|46.4%|238|-0.29%|+0.036|
|Large Buys `>= $50k` (10 bps/side)|183|+0.98%|+0.198|-10.31%|50.3%|99|+0.71%|+0.140|
|Fast-Filed `<= 15d` (10 bps/side)|407|-1.44%|-0.125|-24.66%|46.2%|199|+3.36%|+0.380|
|Multi-Member 30d (10 bps/side)|427|+4.87%|+0.608|-7.68%|49.9%|205|+7.50%|+0.734|
|All PTR Buys (Stress 20 bps/side)|567|-4.89%|-0.433|-27.73%|45.1%|238|-2.70%|-0.167|

Robustness checks on the primary trial (`all-buys`, `H = 20`):

- **Deflated Sharpe Ratio (`N = 12`, bar `>= 0.95`):** **FAIL** — `DSR = 0.0947`, `z = -1.312`, per-observation benchmark `0.0610`.
- **OOS event count (bar `>= 100`):** **PASS** — `238` OOS entries over `500` sessions (`2024-11-23`..`2026-11-23`).
- **Cost stress (`0 / 10 / 20 bps` per side):** **FAIL** — OOS Sharpe `0.239` (`0 bps`), `0.036` (`10 bps`), `-0.167` (`20 bps`).
- **One event per trade, and skips:** `9,284` trades from `9,993` purchase rows (`209` option rows were dropped; `386` rows are further lots of a trade inside the same filing and were summed into it; `114` trades of later filings were dropped); `568` overlap, `3,608` capacity, `74` illiquid, `4,390` missing Yahoo Finance bars, `9` exits truncated at window end.
- **Post-hoc full-universe check (not in the verdict):** after the first look at the out-of-sample window, the primary trial was also run without the 600-ticker cap, on bars for `3,153` tickers. Result: `240` OOS events, OOS excess Sharpe `-0.403`, `DSR = 0.022` at `N = 13`; whole-sample `575` trades, Sharpe `-0.310` (no 20 bps stress run). This run counts as one more trial; a pass would have needed a new holdout.
- **Benchmark:** SPY buy-and-hold over `2022-01-01`..`2026-11-23` had `+10.25%` CAGR, Sharpe `+0.645`, max drawdown `-24.50%`.

## Limits

- Research only. No live or paper orders; no new share positions.
- **STOCK Act delay:** members may disclose up to 45 days after execution; public filing-date entries capture only post-disclosure drift.
- **Scanned paper PTRs excluded:** across `2022`–`2026`, House scanned paper PTRs were `344 / 2,505` (`13.7%`) unparsed and Senate paper PTRs were `78 / 678` (`11.5%`) unparsed.
- **House PTRs with an unknown PDF layout excluded:** `171 / 2,505` (`6.8%`) electronic House PTRs have a PDF layout that `house.v1` does not read; `151` of them were filed in `2022` (`24.6%` of that year's House PTRs), so the first in-sample year is thinner than the others.
- **Universe cap and survivorship bias:** daily bars cover `468` of the `600` pre-registered tickers; Yahoo Finance has no history for the other `132` (delisted, acquired or renamed issuers). `4,390` primary events had no bar on the entry day (tickers outside the bar universe, funds, or non-standard tickers).
- **Slot capacity:** the portfolio holds 10 positions, so `3,608` primary events were skipped because every slot was full. On a day with more events than free slots, the events with the largest reported amount enter first.
- **House amendment metadata:** the House Clerk yearly index does not flag amendments; earliest `filed_on` deduplication mitigates re-disclosures.
