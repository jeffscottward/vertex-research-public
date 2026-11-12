# Triple RSI study

Research only. Rebuilds the QuantifiedStrategies "Triple RSI" rule (card vertex-triple-rsi) from the stated rules and tests
it on SPY and the Core 7 ETF twins as shares and in the Vertex options form. It creates no order, no deployment request
and no preset. Design, pass/fail rule and results: `docs/specs/strategies/triple-rsi.md`.

## Files

| File | What it does |
| --- | --- |
| `services/research/strategies/triple_rsi/rules.py` | RSI (Wilder, Cutler), the entry and exit bars, one position at a time |
| `services/research/strategies/triple_rsi/shares.py` | Share ledger (100% of equity, cost per side, cents) and its NautilusTrader booking |
| `services/research/strategies/triple_rsi/dsl.py` | The rule as a Vertex strategy DSL definition (version 1) |
| `services/research/strategies/triple_rsi/options_form.py` | Call debit verticals on the qc-ports option book, 2% of equity at risk |
| `services/research/strategies/triple_rsi/metrics.py` | Trade and equity measures, walk-forward, Monte Carlo, gate and lower bar |
| `services/research/strategies/triple_rsi/study.py` | Jobs and the results document |
| `services/research/strategies/triple_rsi/document.py` | The `research_studies` document (kind `strategy-backtest`) |
| `services/research/strategies/triple_rsi/report.py` | The dark HTML report |
| `research/backtests/triple-rsi/run.py` | Runs every job in a process pool and writes the outputs |

## Run it (rig, never QuantVPS)

Data: the flat directory of `research/backtests/options-forms/fetch_data.py` (Core 7 ETFs, their IV indices, IRX).

```sh
~/.cache/vertex-academy-nautilus-venv/bin/python research/backtests/triple-rsi/run.py \
  --data ~/Documents/reports/vertex-options-forms/data --out ~/Documents/reports/web/vertex-triple-rsi --workers 8
```

Any venv with `services/research/requirements-nautilus-linux-py312.lock` works. The run takes about a minute with 8
workers. It writes `results.json`, `study.json` and `index.html` to `--out` (outside the repository; the data terms do not
allow redistribution). `--render-only` rebuilds `study.json` and `index.html` from an existing `results.json`.

Store the study in Postgres (the library detail of `triple-rsi` shows it on its Backtests tab):

```sh
DATABASE_URL=postgres://... bun run vertex:research-studies:import < ~/Documents/reports/web/vertex-triple-rsi/study.json
```

## Tests

`services/research/tests/test_triple_rsi.py` (base lane) and `test_triple_rsi_nautilus.py` (Nautilus lane: share booking
parity, DSL signal parity, DSL engine trades, options booking parity).
