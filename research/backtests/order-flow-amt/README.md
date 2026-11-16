# Order flow / AMT auction study (failed auction, acceptance)

Tests two Auction Market Theory rules on the prior session's value area with 5-minute SPY and QQQ bars from 2008 to
2026-11-06: rule A (failed auction back to the prior POC) and rule C (acceptance outside value, continuation). The
option form is a same-day-expiry debit vertical (modelled prices). True order flow (delta) is not in the historical
test; it is reported at each signal after 2026-11-06 as a description.

Research only: the study places no order, writes nothing to Postgres and its verdict gives no trading authority.
NautilusTrader stays disarmed. Spec: [order-flow-amt-auction.md](../../../docs/specs/strategies/order-flow-amt-auction.md).

## Code

| File | Role |
| --- | --- |
| `services/research/strategies/order_flow_amt/profile.py` | Prior-session volume profile and value area (port of the live AMT job) |
| `services/research/strategies/order_flow_amt/rules.py` | Frozen rules A and C, fill model, spec hash, NautilusTrader arrays |
| `services/research/strategies/order_flow_amt/data.py` | Bar loaders, ex-dividend dates, `flow_minutes` export reader |
| `services/research/strategies/order_flow_amt/options.py` | 0DTE and weekly debit verticals on the house option model |
| `services/research/strategies/order_flow_amt/study.py` | Ledger, split, statistics, verdicts, NautilusTrader replay, forward check |
| `run.py` | Study runner |

## Data (on the research machine; never copied into the repository)

- SPY 1-minute bars 2008-2021: `~/Documents/reports/vertex-noiseband/data/spy_1min_2008_2021_cleaned.csv`.
- IBKR 5-minute bars: `~/Documents/reports/vertex-noiseband-retest/data/ib/<SYMBOL>/*.csv` (fetched by
  `services/research/strategies/noise_band_ib_fetch.py` on QuantVPS).
- Forward window: Yahoo 5-minute bars, `~/.local/share/vertex-research-data/order-flow-amt/yahoo-5m/<SYMBOL>/`.
- Ex-dividend dates (Yahoo): `~/.local/share/vertex-research-data/order-flow-amt/dividends/<SYMBOL>.csv`.
- `flow_minutes` export: `~/.local/share/vertex-research-data/order-flow-amt/flow-minutes-<date>.csv` (optional, `--flow-minutes`; forward description only).
- Option model rows (SPY, QQQ, VIX, VXN, IRX): `~/Documents/reports/vertex-qc-ports/data` (`--market-data`).
- Vendor data are for personal use and are not redistributed. The scripts refuse an output folder inside the
  repository.

## Commands

```sh
# 1. flow_minutes export (read-only; trading server, vertex-postgres container). Rows older than 14 days are deleted.
ssh quantvps "docker exec vertex-postgres psql -U postgres -d vertex_research_development -c \"\\copy (select symbol, \
  (extract(epoch from minute)*1000)::bigint as minute_ms, delta, buy_volume, sell_volume, volume, covered_seconds, \
  trades, close from flow_minutes where symbol in ('SPY','ES','NQ') order by symbol, minute) to stdout csv header\"" \
  > ~/.local/share/vertex-research-data/order-flow-amt/flow-minutes-<date>.csv

# 2. Dry run: data, sessions and the data hash.
~/.cache/vertex-academy-nautilus-venv/bin/python research/backtests/order-flow-amt/run.py --dry-run \
  --market-data ~/Documents/reports/vertex-qc-ports/data

# 3. Study (needs nautilus-trader 1.227.0; the rig venv above has it).
~/.cache/vertex-academy-nautilus-venv/bin/python research/backtests/order-flow-amt/run.py \
  --market-data ~/Documents/reports/vertex-qc-ports/data --out ~/Documents/reports/web/vertex-orderflow-amt/run \
  --flow-minutes ~/.local/share/vertex-research-data/order-flow-amt/flow-minutes-<date>.csv
```

The runner refuses to run when the spec above "## Results" differs from `rules.SPEC_SHA256` or when the study files
have uncommitted changes. Output: `results.json` and `summary.md`.
