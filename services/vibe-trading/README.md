# Vibe-Trading driver

This folder holds the Vertex driver for [Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) (MIT, Copyright (c) 2026 Vibe-Trading Contributors), the third agent framework of the framework benchmark ([docs/agent-benchmark.md](../../docs/agent-benchmark.md)). Research only: a Vibe-Trading run gives a research rating; nothing here places, sizes or sends an order.

No Vibe-Trading code is in this repository. `scripts/vibe-trading-setup.sh` clones the pinned release outside the repository and gives it its own virtual environment.

## Files

| File | Purpose |
| --- | --- |
| `services/vibe-trading/driver/vt_driver.py` | Runs one analysis inside Vibe-Trading's virtual environment and prints JSON-line events. Adapted from Glassbench (Apache-2.0, see the root `NOTICE`). |
| `services/vibe-trading/tests/test_vt_driver.py` | Driver logic without Vibe-Trading: tool guard, event shape, environment, committee settings, `--describe`. One smoke test runs the real driver and is skipped unless `VERTEX_VT_DIR` is set. |
| `services/vibe-trading/pyproject.toml` | Metadata and pytest settings for the driver. The driver is run by path; it is not installed. |

The adapter that starts the driver is `services/research/adapters/vibe_trading_framework.py` (`AgentFrameworkPort`, bench name `vibe_trading`).

## Setup

```bash
scripts/vibe-trading-setup.sh                 # clones v0.1.18 into ~/Github/tools/vibe-trading
export VERTEX_VT_DIR=~/Github/tools/vibe-trading
```

The script checks that tag `v0.1.18` is commit `66eb57634f16344b326d85fd1fe10029c7f348bb`, refuses a clone with local changes or untracked files, installs upstream's hash-locked `requirements-lock.txt` with `--require-hashes` (as upstream's Dockerfile does), then the package without dependencies and without build isolation, using a hash-pinned setuptools as its build backend. It rebuilds the venv when the pinned commit changes (`.venv/.vertex-commit`). It needs Python 3.11 or newer (`VT_PYTHON` picks the interpreter). It refuses a clone with `agent/.env`, because Vibe-Trading fills missing settings from that file.

## What a run may do

- Tools: read-only data tools plus `quantlib_call` and `options_payoff` (pure computation). The allowlist and the denylist are `TOOL_ALLOWLIST`, `TOOL_DENYLIST` and `DENIED_PREFIXES` in `vt_driver.py`. Shell, file, backtest, factor analysis, memory, swarm, scheduler, `trading_*` and `etoro_*` tools never enter a registry, and every tool call is checked again before it runs.
- Environment: the adapter passes only basic variables and the API key the endpoint names. The driver removes LangSmith and LangChain tracing settings, keeps only the key of the chosen provider and sets `HOME` and `VIBE_TRADING_HOME` to a temporary folder for the run.
- Dates: Vibe-Trading has no date input. Its tools return current data, so a run with a past decision date is flagged `not_point_in_time`.

## Commands

```bash
# Tool lists of the installed clone (no model call)
"$VERTEX_VT_DIR/.venv/bin/python" services/vibe-trading/driver/vt_driver.py \
  --describe --vt-dir "$VERTEX_VT_DIR" --run-dir "$(mktemp -d)"

# Driver tests (from services/vibe-trading; Python 3.11+ with pytest)
python -m pytest
```

Runs go through the bench command in `services/research` (`--arm vibe_trading:provider:model[:base_url]`); `VERTEX_VT_MODE=single` runs one research agent instead of the investment committee.
