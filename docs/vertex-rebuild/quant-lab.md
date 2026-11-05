# Quant Lab: SSRN paper → strategy spec → backtest

Status: research only. Nothing in this pipeline places orders, reads broker accounts, or uses broker credentials. A backtest verdict does not authorize a trade (see the implementation plan, section "SSRN -> deterministic spec -> empirical evaluation").

## Parts

| Step | Code | Output |
| --- | --- | --- |
| 1. Topic search and capture | `services/research/quantlab/ssrn.py`, topics in `quantlab/topics.json` | `private/quantlab/captures/*.json`, retained PDFs in `private/quantlab/papers/` |
| 2. Strategy spec | `quantlab/spec.py`; agent drafts in `quantlab/drafts/` | `private/quantlab/specs/<id>-<sha12>.json` |
| 3. Frozen data | `quantlab/data.py` | `private/quantlab/data/*.csv` + `.manifest.json` (SHA-256) |
| 4. Backtest | `quantlab/engine.py`, `quantlab/backtest.py` | `private/quantlab/results/<id>-<sha12>.json` |
| 5. Record | `scripts/quant-lab/record.ts` (row mapping in `scripts/quant-lab/record-rows.ts`) → Drizzle store `packages/db/src/server/quant-lab-store.ts` | `research_papers`, `paper_captures`, `strategies`, `strategy_specs`, `agent_tasks`, `backtest_results` |

`private/` is git-ignored. Vendor price data is not committed.

## Source rules

- Optional: set `QUANTLAB_CONTACT_EMAIL` in the local environment to send a contact address to Crossref and OpenAlex (their polite pool). Do not put it in source.
- Metadata comes from the public Crossref API (SSRN DOIs, prefix `10.2139`). Abstracts come from the Crossref record when SSRN deposited one.
- SSRN's site returns a bot challenge (HTTP 403) to automated clients. The downloader never requests `papers.ssrn.com` and never bypasses a challenge or login.
- A PDF is kept only when OpenAlex lists an open-access PDF location and that location returns a real PDF (`%PDF` header, at most 25 MB). The capture stores the SHA-256 and size. Otherwise the capture is `metadata_only:<reason>`.
- A capture is unique by DOI and Crossref deposit time (`version`). SSRN revisions re-deposit the same DOI, so a revision becomes a new capture row.

## Spec rules

- The spec separates `paper_claims` (verbatim quotes with a locator) from `our_reading` (interpretation, gaps, assumptions, deviations).
- A claim that cites full text (page, section, table, figure) is rejected when no full-text copy is retained.
- Entry, exit, universe, sizing, rebalance timing, costs, the in-sample end date, the walk-forward plan and the rejection criteria must be set before a backtest runs. The builder freezes the spec with a canonical SHA-256.
- Supported signals: `price_above_sma`, `momentum`; one instrument; long or cash; no leverage or shorting. Anything else is a validation error.
- `python -m quantlab prompt --capture <file>` prints drafting instructions for a model agent. The paper text is treated as untrusted data.

## Engine

Quant Lab has two engines with the same input (a frozen spec and frozen CSV bars) and the same result record. The result has an `engine` field: `stdlib-daily-v1` (default) or `nautilus-trader-1.227.0`. The existing `backtesting/` package plans and verifies runs but does not simulate fills.

`quantlab/engine.py` (default) is a deterministic, standard-library daily simulator:

- Signals use adjusted closes up to the decision day. The trade fills at the next session's open. Month-end detection uses the next trading date, which is known from the exchange calendar in advance.
- Costs per side: commission + half-spread + slippage on traded notional. A 5x cost stress run is included.
- Cash earns the 13-week T-bill yield (`^IRX`), forward-filled.
- Validation: fixed-parameter in-sample/out-of-sample split at the preregistered date, and a rolling walk-forward (train window selects the lookback by Sharpe; next test window uses it). The Backtests page shows the stitched walk-forward curve and a buy-and-hold benchmark on the same days.
- Limits: bar-level fills; no queue position, partial fills, borrow, taxes or intraday gaps beyond the open.

### NautilusTrader engine (optional)

`quantlab/nautilus_engine.py` runs the same spec in a NautilusTrader `BacktestEngine`. Select it with `--engine nautilus`. The pin is `nautilus-trader==1.227.0`, the version of the Vertex Quant node. It is a lazy import: the package imports without it, and `--engine nautilus` without the pinned version stops with exit code 2 and an install hint. Install from the hash lock `services/research/requirements-nautilus-linux-py312.lock` (CPython 3.12, Linux x86_64, glibc 2.35 or later; NautilusTrader is LGPL-3.0 and is a pinned dependency only, never vendored). Research only: one simulated venue, no live client, broker, order route or network.

How it maps the spec:

- Each session is three one-minute bars with open = high = low = close: the opening print (adjusted open), the closing print (adjusted close), and an end-of-day mark at the close price. Bar-based execution fills a market order at the price of the print where the strategy submits it.
- Decisions: the same `engine.signals` function as the default engine, read at the end-of-day mark. The order goes in at the next session's opening print (`next_open`) or closing print (`next_close`). So fill dates and fill prices are the same as in the default engine.
- Costs: commission + half-spread + slippage per side are the instrument fee on traded notional. The fill price is the print price; spread and slippage are a fee, not a worse price.
- Cash interest: a simulation module credits the daily T-bill rate on the cash balance before the first print of each session.
- Account: CASH account, 100,000,000 USD start, whole shares. An entry buys `floor(weight × equity / (1 + weight × fee) / price)` shares; an exit sells all.
- The buy-and-hold benchmark stays closed-form for both engines.

Differences from the default engine:

- Whole shares, cent-rounded fees and interest, and the fee charged on notional instead of on equity. With weight 1 the close equity agrees within 1e-5 (relative); the parity tests (`tests/test_quantlab_nautilus.py`) check this tolerance and equal trade dates, sides and fill prices.
- The share count is fixed between rebalances. With a weight below 1 the exposure drifts with the price; the default engine keeps the weight constant every day.
- About 15 times slower (a full SPY 1993–2026 spec with an 11-value walk-forward grid and the cost stress: about 35 seconds on this host).
- The result `strategy` label ends in `(walk-forward, nautilus-trader-1.227.0)`. The recorder drops the top-level `engine` key and the stored `runConfig` is a closed contract, so the label is how a recorded row shows the engine.

## Commands

From `services/research` with Python 3.12 (the package uses only the standard library; tests need pytest, for example `uv run --python 3.12 --with pytest python -m pytest tests/test_quantlab.py`). The `--engine nautilus` line needs a separate virtual environment from `requirements-nautilus-linux-py312.lock` (`python -m pip install --no-deps --require-hashes --only-binary=:all: -r requirements-nautilus-linux-py312.lock`):

```sh
python -m quantlab paper --doi 10.2139/ssrn.2242795 --topic "moving average market timing"
python -m quantlab spec --capture ../../private/quantlab/captures/ssrn-2242795.json --draft quantlab/drafts/zakamulin-2013-sma-timing.json
python -m quantlab freeze --symbol SPY --start 1993-01-01 --end 2026-10-17
python -m quantlab freeze --symbol ^IRX --start 1993-01-01 --end 2026-10-17
python -m quantlab backtest --spec <spec.json> --bars <spy manifest> --rates <irx manifest>
python -m quantlab backtest --spec <spec.json> --bars <spy manifest> --rates <irx manifest> --engine nautilus
```

From the repository root. `DATABASE_URL` selects the target database; for the QuantVPS database use an SSH tunnel to its `127.0.0.1:5433`:

```sh
bun run vertex:quantlab:record -- --capture <capture.json> --spec <spec.json> --result <result.json>
bun run vertex:quantlab:record -- --search <search-<stamp>.json>
bun run vertex:quantlab:record -- --capture <capture.json> --spec <spec.json> --result <result.json> --dry-run
```

`--dry-run` prints the paper, capture, strategy, spec and backtest rows and needs no database. The recorder checks each input file with a Zod schema. Exit codes: 0 success, 2 usage error, a file that fails its schema, or an input mismatch (for example a result that does not belong to the spec, or a spec whose paper is not recorded), 1 any other failure (unreadable file, database error).

## Read view

The recorded studies show in the Quant Lab section of the Backtests page (`/backtests`). The page reads them through the oRPC procedure `quantLab.list`. The view is operator-only and read-only: it cannot record, change or delete anything. A study is one frozen spec. It shows the newest backtest recorded for that exact spec, matched by the spec hash in the backtest id (`bt-quantlab-<spec_sha256[0:12]>-…`).

## Scheduled search

`infra/quant-lab/ssrn-search.sh` searches every topic for DOIs created in the last 30 days, then records the captures. `infra/quant-lab/vertex-quantlab-ssrn.{service,timer}` run it weekly (Monday 06:15). The timer is not installed or enabled. To enable it after merge, copy both units to `~/.config/systemd/user/`, then run `systemctl --user daemon-reload && systemctl --user enable --now vertex-quantlab-ssrn.timer`.

## Database

Migration `0043_quant_lab` adds `paper_captures` and `strategy_specs` and gives the app role `vertex_research` `SELECT, INSERT` on both. Rollback: `packages/db/rollback/0043_quant_lab.down.sql` (refuses while either table has rows, then drops only those two tables). Papers, strategies and backtests use the existing tables.

All writes go through `createQuantLabStore` / `recordQuantLab` in `@darkfactory/db/server` (Drizzle, one transaction per recording). Each insert is idempotent on its natural key: paper by DOI, capture by DOI and version, strategy by slug, spec by SHA-256, task and backtest by content-hash id. Later states are never moved back:

- Strategy: a rerun refreshes the description and parameters. It takes the new status only while the stored status is `idea` or `researching`.
- Paper stage after a spec: moves to `spec_extracted` only from `queued` or `ingested`.
- Paper after a backtest: the stage moves to `backtested` only from `queued`, `ingested`, `spec_extracted` or `implemented`. The verdict is set only when it is still `pending` or the paper was at one of those earlier stages, so an operator's later verdict is kept. Reproduced metrics are always refreshed.

The recorder rejects a `--spec` whose paper (by DOI) is neither in the same run's captures nor already in the database (exit 2), so a spec is never stored unlinked. It checks `our_reading` and `paper_claims` (1 to 50 objects) with the same bounds as the API contract.

Tests:

- Unit: `packages/db/src/server/quant-lab-store.test.ts`, `packages/db/src/server/quant-lab-migration.test.ts`, `packages/db/src/server/quant-lab-read.test.ts`, `packages/api/src/quant-lab.test.ts`, `apps/web/src/components/portal/quant-lab-panel.test.tsx`.
- Recorder: `scripts/quant-lab/record.test.ts`, `scripts/quant-lab/record-rows.test.ts`.
- Real Postgres (CI): `tests/integration/database/quant-lab-store.test.ts`, `tests/integration/database/quant-lab-read.test.ts`.
- Python: `services/research/tests/test_quantlab.py`; `services/research/tests/test_quantlab_nautilus.py` (engine parity; its Nautilus tests skip without the pinned engine, except in the CI Nautilus run, which sets `VERTEX_REQUIRE_NAUTILUS=1`).
