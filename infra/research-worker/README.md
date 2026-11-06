# Nautilus backtest worker

The worker runs backtest runs on NautilusTrader for the Vertex API. It runs on the research host (the rig or a research container) as a user systemd service. Never install it on the live trading node: it is research only and has no order, broker or deployment path.

How it works: the API stores a new backtest run with the engine `nautilus-trader-1.227.0` when `VERTEX_BACKTEST_RUNS_ENGINE=nautilus`, and Nautilus repeats of instant backtests, sweep cells and Autopilot gate runs when `VERTEX_ENGINE_COMPARISON=on` ([dual run](../../docs/vertex-rebuild/nautilus-backtest-engine.md#dual-run-engine-comparison)). The worker claims a batch (`backtestRuns.engine.claim` with `max` 50: the oldest run and more runs of its comparison group), runs it in `VERTEX_WORKER_PROCESSES` processes of `python -m nautilus_backtest batch - -`, and posts every result or error with `backtestRuns.engine.completeMany` (in requests under 900 KB each), with where and how long each run took (`engineRun`: host, engine time, process wall and CPU time, processes; no GPU). The API checks every result against the stored bars and builds the report. The worker calls the API over HTTPS with an operator agent write key in `x-api-key`. Details: [docs/vertex-rebuild/nautilus-backtest-engine.md](../../docs/vertex-rebuild/nautilus-backtest-engine.md).

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
| `VERTEX_WORKER_IDLE_MAX_MS` | Longest wait between empty claims. Default 45000 (not below `VERTEX_WORKER_IDLE_MS`). The web restart pauses the worker with the pause file, so a short cap (3000 with its own key) does not block restarts: see [Web restarts](#web-restarts). |
| `VERTEX_WORKER_REQUEST_BUDGET` | Requests before a quiet pause. Default 150 (shared key); 1 to 580. With its own key: 550. See [Request budget](#request-budget). |
| `VERTEX_WORKER_QUIET_PAUSE_MS` | Length of the quiet pause and of the wait after a 429. Default 125000 (shared key); at least 61000, refused below. With its own key use at least 65000. |
| `VERTEX_WORKER_PAUSE_FILE` | Pause file. Default `${XDG_STATE_HOME:-$HOME/.local/state}/vertex-nautilus-worker.pause`. While it exists and is younger than 90 min the worker claims nothing. |
| `VERTEX_WORKER_PROCESSES` | Engine processes per claimed batch. Default 8, at most 16. A batch (up to 50 runs of one comparison group on one bar series) is split over them; on the rig 184 sweep cells took 73.9 s in 1 process, 11.8 s in 8 and 7.7 s in 24. |
| `VERTEX_ALERT_POST_URL` | Optional. Loopback chat endpoint that takes `{channel, text}` (the same route as the sector rotation alerts, for example `http://127.0.0.1:47821/post`). |
| `VERTEX_ALERT_CHANNEL` | Optional. Channel for the alert lines, for example `trading-alerts`. Without both settings the worker posts no alerts. |

Alerts: a failed cycle is a claim or fail call that got an error (HTTP 401, 429, 5xx, network), a result that could not be delivered or was rejected, or an engine crash, timeout or version mismatch. An input error of a run (the run fails with its message) and an empty claim are normal cycles. After 3 failed cycles in a row the worker posts one alert line with the count and the last error class; it posts no more lines for that incident. On the next normal cycle it posts one recovery line. The lines never contain the key or a payload. A failed alert post is logged and the worker goes on.

One engine process (one part of a batch) may take at most 9 minutes; the worker then kills it and fails its runs. The API fails a queued run after 10 minutes only when no worker claimed any Nautilus run in that time ("Nautilus backtest worker did not pick up the run"); a busy worker never fails its backlog.

A claim moves the run to `running` before the response reaches the worker. When that response is lost (network drop, worker restart during the request), no worker knows the run: it stays `running` until the API's stale check fails it 10 minutes after the claim ("Backtest stopped before it finished", on the next read of the run). Submit it again after that.

When `completeMany` fails with a network error or a 5xx answer, the worker tries again 3 times (waits of 1, 2 and 4 seconds) and then fails the run with "Could not deliver the Nautilus result". A 429 answer is tried again once, after the limiter wait (see below). On SIGTERM during a retry wait, the remaining tries run at once (without waits) before the run fails.

## Request budget

The agent key limiter (better-auth api-key plugin, `rate_limit_max` 600 and `rate_limit_time_window` 60000 on the key row) counts accepted requests per key. It resets the count only when more than 60 s passed since the last accepted request on that key; a gap of exactly 60 s does not reset it. It is not 600 per minute: clients that call the key at least once every 60 s never reset it, so the key refuses every request after 600 accepted ones until more than 60 s pass without an accepted request. On 2026-11-05 the worker (3 s polling) and the QuantVPS Autopilot tick (1/min) shared one key: after 600 requests (30 min) the next 19 requests of the worker and the tick got HTTP 429. A unit test of the plugin with these settings shows the same numbers (`packages/auth/src/agent-key-rate-limit.test.ts`).

The worker therefore:

- Backs off when idle: 3 s after an empty claim, then 6, 12 and 24 s up to `VERTEX_WORKER_IDLE_MAX_MS` (45 s). A claim that returns work resets the wait to 3 s.
- Sends at most 150 requests (a quarter of the limit; `VERTEX_WORKER_REQUEST_BUDGET`) and then nothing for 125 s (two limiter windows plus 5 s; `VERTEX_WORKER_QUIET_PAUSE_MS`). A worker restart starts a new budget. With its own key see [Own key](#own-key-fast-polling).
- On a 429 answer to a claim, waits the quiet pause (125 s by default), or the `Retry-After` time when the answer has a longer one, and then starts again with the 3 s idle wait.
- On a 429 answer while it delivers a result, waits once (125 s, or less when the run would pass the API's 10-minute stale limit; it stops 30 s before it) and tries once more. With less than 1 s left it does not try again. A second 429 fails the run with "Could not deliver the Nautilus result". Without this cut a 9-minute run plus the wait would pass the stale limit, and the API would refuse the finished result with 409.

What the quiet pause depends on: the count resets only after a gap of more than 60 s with no accepted request on the key. The worker is silent for 125 s; the other client of the shared key is the QuantVPS Autopilot tick (`vertex-autopilot.timer`, `OnUnitActiveSec=1min` plus the run time, one request per tick). With one tick inside the pause, the two gaps add up to 125 s, so one is over 60 s; with two ticks, the gap between them is over 60 s. It depends on ticks being more than 60 s apart with one request each; if Autopilot ever ticks 60 s apart or closer, or spreads several requests over a tick, the shared key may never reset and the worker and the tick reach 429 again. A separate worker key is the robust fix; the owner chose to reuse the Autopilot key (2026-11-05).

### Own key (fast polling)

With a write key that no other client uses, one quiet gap of more than 60 s resets the count. The intended settings (commented in the start script template) are `VERTEX_WORKER_IDLE_MS=3000`, `VERTEX_WORKER_IDLE_MAX_MS=3000`, `VERTEX_WORKER_REQUEST_BUDGET=550` and `VERTEX_WORKER_QUIET_PAUSE_MS=65000`. The worker then claims every 3 s (a run waits about 1.5 s in the queue on average, at most about 3 s plus the claim), sends 20 requests a minute, and takes one 65 s pause about every 27 minutes (550 requests). During that pause a new run waits up to 65 s.

Trade-off: a larger budget means fewer pauses but less room under the 600 limit for hand-made requests with the same key and for deliveries (each delivery chunk is one request); 580 is the largest accepted value (the budget is checked after each cycle, so one cycle may add a claim and several delivery requests). A shorter pause means less waiting, but it must stay above 60 s with a margin: below 61000 the worker refuses to start, and 65000 leaves 5 s for clock and request timing. Never use these settings on a shared key: the other client's requests can fill the 65 s gap, and the key then refuses everyone after 600 requests. A shared key keeps the defaults (150, 125000).

## Web restarts

`infra/quantvps/restart-when-idle.sh` waits for 30 s without a `vertex-web` journal line or TCP traffic, seen on two polls 5 s apart, and a polling worker would never let that happen. The script runs on the rig as the same user, so right before its idle wait it writes its PID and the time to the pause file (`VERTEX_WORKER_PAUSE_FILE`, same default path) and removes it on every exit. While the file exists the worker claims nothing; it looks every second and logs one line when it pauses and one when it goes on. A run in progress finishes and delivers first; that only delays the idle decision. A pause file older than 90 min is ignored with one log line, so a script killed with SIGKILL cannot stop the worker for good (the restart script gives up after 60 min). A pause of 65 s or more also starts a new request budget. `--dry-run` of the script never touches the file.
