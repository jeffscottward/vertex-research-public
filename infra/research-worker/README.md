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
| `VERTEX_WORKER_IDLE_MS` | First wait after an empty claim. Default 3000. Each further empty claim doubles the wait; a claim that returns work resets it. |
| `VERTEX_WORKER_IDLE_MAX_MS` | Longest wait between empty claims. Default 45000 (not below `VERTEX_WORKER_IDLE_MS`). Keep it above 35000: see [Request budget](#request-budget). |
| `VERTEX_ALERT_POST_URL` | Optional. Loopback chat endpoint that takes `{channel, text}` (the same route as the sector rotation alerts, for example `http://127.0.0.1:47821/post`). |
| `VERTEX_ALERT_CHANNEL` | Optional. Channel for the alert lines, for example `trading-alerts`. Without both settings the worker posts no alerts. |

Alerts: a failed cycle is a claim or fail call that got an error (HTTP 401, 429, 5xx, network), a result that could not be delivered or was rejected, or an engine crash, timeout or version mismatch. An input error of a run (the run fails with its message) and an empty claim are normal cycles. After 3 failed cycles in a row the worker posts one alert line with the count and the last error class; it posts no more lines for that incident. On the next normal cycle it posts one recovery line. The lines never contain the key or a payload. A failed alert post is logged and the worker goes on.

One run may take at most 9 minutes; the worker then kills the engine and fails the run. The API fails a queued run after 10 minutes only when no worker claimed any Nautilus run in that time ("Nautilus backtest worker did not pick up the run"); a busy worker never fails its backlog.

A claim moves the run to `running` before the response reaches the worker. When that response is lost (network drop, worker restart during the request), no worker knows the run: it stays `running` until the API's stale check fails it 10 minutes after the claim ("Backtest stopped before it finished", on the next read of the run). Submit it again after that.

When `complete` fails with a network error or a 5xx answer, the worker tries again 3 times (waits of 1, 2 and 4 seconds) and then fails the run with "Could not deliver the Nautilus result". A 429 answer is tried again once, after the limiter wait (see below). On SIGTERM during a retry wait, the remaining tries run at once (without waits) before the run fails.

## Request budget

The agent key limiter (better-auth api-key plugin, `rate_limit_max` 600 and `rate_limit_time_window` 60000 on the key row) counts accepted requests per key. It resets the count only when more than 60 s passed since the last accepted request on that key; a gap of exactly 60 s does not reset it. It is not 600 per minute: clients that call the key at least once every 60 s never reset it, so the key refuses every request after 600 accepted ones until more than 60 s pass without an accepted request. On 2026-11-05 the worker (3 s polling) and the QuantVPS Autopilot tick (1/min) shared one key: after 600 requests (30 min) the next 19 requests of the worker and the tick got HTTP 429. A unit test of the plugin with these settings shows the same numbers (`packages/auth/src/agent-key-rate-limit.test.ts`).

The worker therefore:

- Backs off when idle: 3 s after an empty claim, then 6, 12 and 24 s up to `VERTEX_WORKER_IDLE_MAX_MS` (45 s). A claim that returns work resets the wait to 3 s.
- Sends at most 150 requests (a quarter of the limit) and then nothing for 65 s (one limiter window plus 5 s). A worker restart starts a new budget of 150 requests.
- On a 429 answer to a claim, waits 65 s, or the `Retry-After` time when the answer has a longer one, and then starts again with the 3 s idle wait.
- On a 429 answer while it delivers a result, waits once (65 s, or less when the run would pass the API's 10-minute stale limit; it stops 30 s before it) and tries once more. A second 429 fails the run with "Could not deliver the Nautilus result". Without this cut a 9-minute run plus the wait would pass the stale limit, and the API would refuse the finished result with 409.

What the quiet pause depends on: the count resets only when every client of the key leaves a gap of more than 60 s. The worker is silent for 65 s; the other client of the shared key is the QuantVPS Autopilot tick (`vertex-autopilot.timer`, `OnUnitActiveSec=1min`, one request per tick). The ticks are more than 60 s apart (one minute after the previous start, plus the run time), so a gap between two ticks inside the pause resets the count. This holds only as long as the ticks stay more than 60 s apart and send one request each. If Autopilot ever ticks 60 s apart or closer, or spreads several requests over a tick, the shared key never resets and the worker and the tick reach 429 again. The robust fix is a separate agent key for the worker; the owner chose to reuse the Autopilot key (2026-11-05).

Coupling with `infra/quantvps/restart-when-idle.sh`: the restart waits for 30 s without a `vertex-web` journal line or TCP traffic, seen on two polls 5 s apart. Every worker request logs a line, and so does every Autopilot tick, which can split a gap between two worker requests. The idle wait must therefore stay longer than 35 s; the 45 s default leaves 10 s. Do not set `VERTEX_WORKER_IDLE_MAX_MS` below 35000 while the restart script uses these defaults.
