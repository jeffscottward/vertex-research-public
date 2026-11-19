# Options-side continuation study (modelled fills)

Tests the options side of the flow control signals: the QuantData net drift state of a ticker group (SPX with SPY,
QQQ with NDX) with the trend on the same side, entered between 09:45 and 11:30 New York. Futures results (ES, NQ) are
modelled from index prices; the option form (debit verticals on SPY and QQQ) is priced with Black-Scholes. The
futures and options agreement is not tested.

Research only: the study places no order, writes nothing to Postgres and its verdict gives no trading authority.
NautilusTrader stays disarmed. Spec: [flow-control-continuation.md](../../../docs/specs/strategies/flow-control-continuation.md).

## Code

| File | Role |
| --- | --- |
| `services/research/strategies/flow_control/control.py` | Python port of the options side of the flow control rules |
| `services/research/strategies/flow_control/rules.py` | Frozen rule: trend, entry, exit, signal arrays, spec hash |
| `services/research/strategies/flow_control/fomc.py` | Scheduled FOMC decision days of 2025 and 2026 |
| `services/research/strategies/flow_control/data.py` | Loader of the downloaded net drift history |
| `services/research/strategies/flow_control/download.py` | Pure core of the resumable download |
| `services/research/strategies/flow_control/options.py` | Debit vertical form on the intraday option model |
| `services/research/strategies/flow_control/study.py` | Ledger, split, trials, statistics, verdict, engine check |
| `services/research/strategies/flow_control/document.py` | Study document for the importer |
| `services/research/strategies/flow_control/report.py` | HTML report |
| `fetch_net_drift.py` | Resumable download script |
| `run.py` | Study runner |

## Data (on the research machine; never copied into the repository)

- Net drift: `<data dir>/net-drift/<TICKER>/<total|zero_dte>/<YYYY-MM-DD>.json` (the loader also reads the layout
  `zero_dte` plus `longer` and derives the total). Default `~/.local/share/vertex-research-data/flow-control`, or
  `VERTEX_FLOW_CONTROL_DATA`, or `--data`.
- Daily SPY, QQQ, VIX, VXN and T-bill rows of the option model: `~/Documents/reports/vertex-qc-ports/data`
  (`VERTEX_QC_PORTS_DATA` or `--market-data`).
- Vendor data is for personal use and is not redistributed. The data and the report stay outside the repository; the
  scripts refuse a folder inside it.

## Venv

`~/.cache/vertex-academy-nautilus-venv/bin/python` (nautilus-trader 1.227.0 for the fill check). Never run the
download or the study on the trading server.

## Commands

```sh
PY=~/.cache/vertex-academy-nautilus-venv/bin/python
DATA=~/.local/share/vertex-research-data/flow-control
OUT=~/Documents/reports/web/vertex-flow-control-continuation/run
# 1. Plan of the download: pending files and time. Sends nothing.
$PY research/backtests/flow-control-continuation/fetch_net_drift.py --data $DATA --dry-run
# 2. Download (key from the secret manager for this one process). Exit code 1: run again to resume.
op run --env-file=<env file> -- $PY research/backtests/flow-control-continuation/fetch_net_drift.py --data $DATA
# 3. Daily rows for the option model.
uv run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 \
    python research/backtests/qc-ports/fetch_data.py --out ~/Documents/reports/vertex-qc-ports/data
# 4. Sessions, split, skipped days and data hash. Runs nothing.
$PY research/backtests/flow-control-continuation/run.py --data $DATA --dry-run
# 5. Study: data.json, results.json, study.json and index.html in $OUT. Optional: --deep-trades <csv> --live-rows <csv>.
$PY research/backtests/flow-control-continuation/run.py --data $DATA --out $OUT
# 6. Check the document without a database.
bun run vertex:research-studies:import --dry-run < $OUT/study.json
# 7. Store it after review.
DATABASE_URL=postgres://... bun run vertex:research-studies:import < $OUT/study.json
```

## Exports for the optional checks

Run with psql in the `vertex-postgres` container on the trading server (user `postgres`); both write CSV to stdout.

```sql
\copy (select symbol, extract(epoch from second)::bigint as second_s, side, size, price from flow_large_trades where symbol = 'ES' order by second, seq) to stdout csv header
\copy (select ticker, part, (extract(epoch from minute) * 1000)::bigint as minute_ms, net_call_premium, net_put_premium, net_call_volume, net_put_volume, underlying_price from flow_net_drift where minute >= '<YYYY-MM-DD> 09:30 America/New_York' and minute < '<YYYY-MM-DD> 16:00 America/New_York' order by ticker, part, minute) to stdout csv header
```

## Tests (synthetic data only)

```sh
cd services/research && ~/.cache/vertex-academy-nautilus-venv/bin/python -m pytest tests/test_flow_control_*.py -q
```
