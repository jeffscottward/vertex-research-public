# Nautilus backtest worker

The worker runs backtest runs on NautilusTrader for the Vertex API. It runs on the research host (the rig or a research container) as a user systemd service. Never install it on the live trading node: it is research only and has no order, broker or deployment path.

How it works: the API stores a new backtest run with the engine `nautilus-trader-1.227.0` when `VERTEX_BACKTEST_RUNS_ENGINE=nautilus`. The worker claims the oldest queued run (`backtestRuns.engine.claim`), runs `python -m nautilus_backtest run -` in `services/research`, and posts the result (`backtestRuns.engine.complete`) or the error (`backtestRuns.engine.fail`). The API checks the result against the stored bars and builds the report. The worker calls the API over HTTPS with an operator agent write key in `x-api-key`. Details: [docs/vertex-rebuild/nautilus-backtest-engine.md](../../docs/vertex-rebuild/nautilus-backtest-engine.md).

## Files

| File | Use |
| --- | --- |
| `vertex-nautilus-worker.service` | User unit, `Restart=always`. `SIGTERM` stops the worker; a running engine process is killed and its run fails. |
| `vertex-nautilus-worker-run.sh` | Start script template. It reads the write key from its own `0600` file and starts the worker from a runner checkout. Contains placeholders only. |

## Install

1. Create a Python venv with the Nautilus lock: `python3.12 -m venv <venv> && <venv>/bin/pip install -r services/research/requirements-nautilus-linux-py312.lock`.
2. Create an operator agent key with write access in the portal (Agent keys). Save only the key in a file with mode `0600`, for example `~/.config/vertex/agent-write-key`.
3. Copy `vertex-nautilus-worker-run.sh` to `~/.local/bin/vertex-nautilus-worker-run`, set mode `0700` and replace every `__PLACEHOLDER__`.
4. Check one cycle by hand: `~/.local/bin/vertex-nautilus-worker-run --once` (exit 0; it prints `run <id>: succeeded` when it found a run).
5. Copy `vertex-nautilus-worker.service` to `~/.config/systemd/user/` and run `systemctl --user daemon-reload && systemctl --user enable --now vertex-nautilus-worker.service`. Run `loginctl enable-linger` once so the service runs without a login session.
6. Set `VERTEX_BACKTEST_RUNS_ENGINE=nautilus` in the web app environment and restart the web app only through `infra/quantvps/restart-when-idle.sh` ([infra/quantvps/README.md](../quantvps/README.md)). Without this setting the API runs backtests itself and the worker finds no runs. To switch back, set `typescript` (or remove the line) and restart the same way; queued Nautilus runs still go to the worker.

Logs: `journalctl --user -u vertex-nautilus-worker.service`. The worker never prints the key.

## Settings

| Variable | Use |
| --- | --- |
| `VERTEX_ORIGIN` | Portal origin (https). |
| `VERTEX_AGENT_API_KEY` | Operator agent write key (read from the key file by the start script). |
| `VERTEX_NAUTILUS_PYTHON` | Python of the Nautilus venv. |
| `VERTEX_WORKER_IDLE_MS` | Wait between claims when no run is queued. Default 3000. |

One run may take at most 9 minutes; the worker then kills the engine and fails the run. The API fails a queued run after 10 minutes only when no worker claimed any Nautilus run in that time ("Nautilus backtest worker did not pick up the run"); a busy worker never fails its backlog.

A claim moves the run to `running` before the response reaches the worker. When that response is lost (network drop, worker restart during the request), no worker knows the run: it stays `running` until the API's stale check fails it 10 minutes after the claim ("Backtest stopped before it finished", on the next read of the run). Submit it again after that.

When `complete` fails with a network error, a 429 or a 5xx answer, the worker tries again 3 times (waits of 1, 2 and 4 seconds) and then fails the run with "Could not deliver the Nautilus result". On SIGTERM during a retry wait, the remaining tries run at once (without waits) before the run fails.
