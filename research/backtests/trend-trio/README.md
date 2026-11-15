# Trend Trio study (Vertex reconstruction, rules guessed)

Tests a reconstruction of the "16 of 16 years" claim of an Instagram reel
(<https://www.instagram.com/reel/DfuMtdWKDB7/>): SuperTrend, Ultimate MA and AlphaTrend agree, Slingshot filters,
Chandelier Exit exits, 1 NQ contract. The paid rules are not used; the rules are guessed and frozen in
`docs/specs/strategies/trend-trio.md` before the first full run. Design: `docs/specs/strategies/trend-trio-design.md`.

Research only: nothing here places, arms or sizes an order, and nothing writes to Postgres.

## Code

| File | Role |
| --- | --- |
| `services/research/strategies/trend_trio/rules.py` | frozen rules: buckets, signals, trades |
| `services/research/strategies/trend_trio/study.py` | datasets, the 33 rows and diagnostics as jobs, ledger, tests T1-T7, `assemble` |
| `services/research/strategies/trend_trio/document.py` | `study.json` (StrategyBacktestStudySchema) |
| `services/research/strategies/trend_trio/report.py` | `index.html` (dark, self-contained) |
| `research/backtests/trend-trio/run.py` | CLI on the rig |

## Data (on the rig; never copied into the repository)

| Dataset | Default path | Option |
| --- | --- | --- |
| (a) NAS100 CFD 1-minute bid/ask (imom files) | `~/Documents/reports/vertex-reel-dffkn31-data/m1/usatechidxusd-{bid,ask}.csv.gz` | `--m1` (directory) |
| V8 full-session CFD 1-minute, monthly | `~/Documents/reports/vertex-trend-trio-data/m1-full/usatechidxusd-{bid,ask}-YYYY-MM.csv` | `--m1-full` |
| (b) IBKR QQQ 5-minute | `~/Documents/reports/vertex-reel-dffkn31-data/ibkr5m/QQQ.csv.gz` | `--qqq` |
| (b) scale NDX / QQQ, Yahoo daily | `~/Documents/reports/vertex-session-open-momentum/data/yahoo-{NDX,QQQ}.json` | `--yahoo-ndx`, `--yahoo-qqq` |
| (c) NQ 5-minute front month | `~/Documents/reports/vertex-emt/futures/NQ_*.csv` | `--nq` (directory) |

`data.json` and `results.json` list every input file with its size and SHA-256. A missing or empty full-session
month (Q-ETH) leaves V8 "not run"; it still counts in N = 33.

## Venv

The NautilusTrader venv of the rig (`nautilus-trader==1.227.0`, `services/research/requirements-nautilus-linux-py312.lock`):
`~/.cache/vertex-academy-nautilus-venv/bin/python`.

## Commands

```sh
PY=~/.cache/vertex-academy-nautilus-venv/bin/python
# Load the data, list the 33 graded jobs and the diagnostics, print the data manifest; runs no job.
$PY research/backtests/trend-trio/run.py --pilot --dry-run
$PY research/backtests/trend-trio/run.py --dry-run
# Pilot (2024 only) into <out>/pilot.
$PY research/backtests/trend-trio/run.py --out ~/Documents/reports/web/vertex-trend-trio/run --workers 8 --pilot
# Full study: pilot first, then tiers 1-4; stops before a tier projected above 8 core-hours (a blocked job).
$PY research/backtests/trend-trio/run.py --out ~/Documents/reports/web/vertex-trend-trio/run --workers 8
# Rebuild study.json and index.html from <out>/results.json.
$PY research/backtests/trend-trio/run.py --out ~/Documents/reports/web/vertex-trend-trio/run --render-only
```

The run refuses to start when the spec above "## Results" differs from `rules.SPEC_SHA256`, and when the study
code has uncommitted changes (`--allow-dirty` runs anyway as a diagnostic; `study.json` is then not written).
Each job writes `<out>/<job>.json`; a restarted run skips jobs whose file has the same parameters, spec hash, code commit and data manifest hash
(`assemble` treats any other job file as missing). A tier projected above the budget makes the outcome "blocked":
only `results.json` and `index.html` are written.

Outputs in `--out`: `data.json`, one JSON per job, `results.json`, `study.json`, `index.html`.

## Import of the study document

After review:

```sh
DATABASE_URL=postgres://... bun run vertex:research-studies:import < <out>/study.json
```

## Tests (synthetic data only)

```sh
cd services/research
~/.cache/vertex-academy-nautilus-venv/bin/python -m pytest tests/test_trend_trio_study.py tests/test_trend_trio_nautilus.py -q
```
