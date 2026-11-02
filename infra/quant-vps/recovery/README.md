# vertex-ibkr-recovery (QuantVPS)

The VPS side of the Vertex "Send IBKR 2FA request" button. A human operator presses the button in Vertex; the
Vertex server calls this service; the service may start exactly ONE fixed program:

    /opt/vertex-exec-node/scripts/request-ibkr-2fa-until-ready.sh   (no arguments, cwd /opt/vertex-exec-node, no shell)

It also reports the ib-gateway login state and the progress of the request. It never starts the script on its
own, never retries it, never logs in, never stops the script, and has no trading authority. No credentials pass
through it. Interface contract: `SCHEMA.md` (card vertex-2fa-button).

Listener `127.0.0.1:8793`. The tailnet Caddy site (`../status/Caddyfile.tailnet`) proxies
`/vertex-ibkr-recovery/v1/*` only for the rig and the VPS's own tailnet addresses. The service checks its own
bearer token `VERTEX_RECOVERY_TOKEN` (constant time). That is not the shared status token:
`VERTEX_STATUS_TOKEN` is only used to call the local vertex-portfolio health endpoint, and the service refuses
to start when both tokens are equal.

## Script environment (fixed)

`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, `HOME=/root`, `LANG=C.UTF-8`,
`IBKR_2FA_NOTIFY_ENABLED=0`, `IBKR_2FA_MAX_ATTEMPTS=1`, `IBKR_2FA_APPROVAL_TIMEOUT_SECONDS=180`,
`IBKR_2FA_VERIFY_ACCOUNT_SNAPSHOT=0`, `IBKR_2FA_VERIFY_API_HANDSHAKE=0`. Nothing else from the service
environment passes.
No extra IB client id is used: with both `VERIFY_*` at 0 the script opens no IB API session, so it needs no
client id (`IBKR_2FA_VERIFY_CLIENT_ID` would have no effect, and the service does not set it). The account
snapshot check runs here, through vertex-portfolio and its existing client id 78.
The two `VERIFY_*=0` values are mandatory: with the script defaults its readiness check runs
`docker compose up -d nautilus-trader`. With both at 0 the readiness check is `/opt/vertex-exec-node/scripts/healthcheck.sh` only.

The script sources `/opt/vertex-exec-node/.env.example` and `.env` (`set -a`), which could undo that environment.
So the service refuses to start the script when those files assign any `IBKR_2FA_*` key outside a short
harmless list (`SAFE_ENV_FILE_KEYS`: notify email, retry interval, restart cooldown/state paths, verify client
id/host/port/timeout, snapshot dirs, `IBKR_2FA_UI_*`). A real request then ends `failed` with the key names;
a dry run answers `wouldStart:false`. The installer prints the blocking key names (never values).

The script's `source` of those files must also succeed: it runs with `set -Eeuo pipefail`, so a value with an
unquoted space (for example `AUTO_RESTART_TIME=11:45 PM`) runs `PM` as a command and the script exits before
it does anything. On 2026-10-28 the VPS `.env` had exactly that, and the script exited with code 127. Such a
request ends `failed` with the script's last output line. The installer prints
`script env-file bash-source: ok|FAILED` (same shell options, no values printed; it does not stop the install).
Fix a FAILED by quoting the value in `/opt/vertex-exec-node/.env`.

Output (stdout+stderr) goes to `$STATE_DIRECTORY/runs/<requestId>.log` (0600); the last 20 run logs stay.

## Docker access (read-only)

Fixed argv only: `docker ps -a --filter label=com.docker.compose.service=ib-gateway --format '{{.ID}} {{.State}}'`,
`docker inspect --format '{{json .State}}' <id>`, `docker logs --timestamps --since <timestamp> <id>`.

Logs are read with a cursor per container (id + StartedAt), never with `--tail`: IBC lines are rare among the
Java output and IBC restarts daily inside the same container, so after 42 h a container had 19,872 lines and
the last `Login has completed` was 6,000 lines from the end (a `--tail 4000` read gave `unknown`).

- First read (new container id or new StartedAt): `--since <StartedAt>`, 20 s timeout, 64 MiB cap. If it is
  larger or slower, the read falls back to the last 48 h (`--since <now - 48 h>`, never before StartedAt);
  without an IBC event in that window the state is `unknown` with reason `log-window`.
- Later reads: `--since <timestamp of the last line read>`, 10 s timeout. `--since` is inclusive, so lines at
  that timestamp that were already read are skipped.
- Only the parsed IBC events stay in memory (last 500), not raw lines. Docker output goes to a temp file first.
- The monitor thread refreshes the state every 10 s, so the cursor stays current and each read is small.

A test fails on any other docker verb, any other subprocess/`os.system`/exec call, or strings such as
`nautilus`, `placeOrder`, `compose up` outside docstrings and comments. The one exception is the Nautilus arm
switch (owner decision 2026-10-30, see SCHEMA.md): `docker exec <node container id> python -m nautilus.arm_cli`
in exactly three forms (status, arm, disarm), built only by `nautilus_exec_argv` and checked again by
`is_nautilus_exec` before `nautilus_cli_run` runs it. The scan allows only that list and a fixed set of string
constants; the tests prove that every other exec argv is refused before any process starts.

## Gateway login state

IBC lines (`IBC: ...`) in time order; the last event wins.

| Log text contains | Event |
| --- | --- |
| `Login dialog WINDOW_OPENED: LoginState is LOGGED_OUT`, `Starting session: will exit if login dialog`, `IBC will restart shortly`, `detected dialog entitled: Restart in progress` | login-started |
| `Second Factor Authentication initiated`, `detected dialog entitled: Second Factor Authentication; event=Opened` | 2fa-started |
| `Login has completed`, `Login has already completed` | logged-in |
| `Re-login after second factor authentication timeout not required`, `IBC closing because login has not completed after Second Factor Authentication` | 2fa-timeout |
| `End this session and let the other session proceed`, `Other session must be primary`, `Other session may be primary, so end this session` | session-ended |

| loginState | When | needsLogin |
| --- | --- | --- |
| `stopped` | no container, or container not running | true |
| `logged-in` | last event logged-in | false |
| `awaiting-2fa` | last event 2fa-started, < 240 s old | false |
| `starting` | last event login-started < 300 s old, or container < 120 s old with no event | false |
| `logged-out` | last event 2fa-timeout or session-ended; 2fa-started >= 240 s; login-started >= 300 s | true |
| `unknown` | docker unreadable, more than one running gateway container, or running > 120 s with no event (reason `no-login-event`, or `log-window` after the 48 h fallback) | false |

The state is cached for 10 s. Each POST reads it fresh before it takes the request lock (the lock section never
waits on docker); the monitor also reads it fresh once the script has ended.

## Request lifecycle

`requested` -> `waiting-for-approval` -> `verifying` -> `logged-in`; terminal failures `timed-out`, `failed`.
A monitor thread checks the active request every 5 s. Only gateway events after the request start count.

- `waiting-for-approval`: a 2fa-started event, or the script printed `IBKR 2FA login request attempt`.
- `verifying`: a logged-in event; then the account snapshot check runs:
  `GET http://127.0.0.1:8792/vertex-portfolio/v1/health` is OK when `state == "live"`, `connected == true` and
  `dataAsOf >= logged-in event time - 5 s`.
- `logged-in`: snapshot OK (`account snapshot OK`).
- `timed-out`: a 2fa-timeout event, or no logged-in event within 300 s.
- `failed`: the script exited before its `IBKR 2FA login request attempt` line and before any
  2fa-started/logged-in event (detail = last output line, max 200 chars); the script printed
  `no 2FA request needed` (detail `The script reported the gateway ready and sent no 2FA request.`); the
  script printed `restart cooldown active`; session-ended; verifying > 180 s without snapshot OK; the service
  restarted during the request; the script could not be started.

After the attempt line (the gateway restart has happened) the script's exit no longer decides anything: the
gateway events decide, up to the 300 s limit.

A terminal state does not stop the script; it ends on its own (approval timeout 180 s). `scriptRunning` stays
true until it exits, and no new request starts while it runs. A service stop or restart ends a running script
(systemd default KillMode=control-group), so two scripts never run at once.

## API (prefix `/vertex-ibkr-recovery/v1`, bearer `VERTEX_RECOVERY_TOKEN`)

Every response is JSON with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
Missing/wrong token 401, unknown path 404, wrong method 405, body over 4096 bytes 413.

- `GET /status` -> `vertex-ibkr-recovery-status-v1`: `gateway` (`loginState`, `needsLogin`, `since`, `reason`),
  `request` (active or most recent, or null), `cooldown` (`seconds: 900`, `until`), `history` (newest 10).
- `GET /health` -> `vertex-ibkr-recovery-health-v1`: `version`, `loginState`.
- `POST /request` body exactly `{"requestId","actorId","statement","dryRun"}`:
  - invalid (pattern, statement, extra or missing keys, non-boolean dryRun) -> 400 `bad_request`
  - known `requestId` -> 200 `outcome: existing` (nothing started)
  - script running or active request not terminal -> 409 `in_flight`
  - cooldown (900 s after the last start, persisted) -> 429 `cooldown` + `Retry-After`
  - gateway `needsLogin` false -> 409 `not_needed`
  - `dryRun: true` -> 200 `outcome: dry-run`, `wouldStart` (nothing started, nothing stored)
  - else start -> 202 `outcome: started` (a start failure gives a `failed` request; the cooldown still counts)

Single-flight: the forced gateway read runs first, without the lock; the `requestId`, in-flight, cooldown and
not-needed checks and the start then run under one lock with that fresh state.

State: `$STATE_DIRECTORY/state.json` (0600, temp file + rename): `lastStartedAt`, `active`, `history` (20).
Logs: JSON lines on stdout (`listening`, `request_started`, `request_state`, `request_refused`, ...), never
the token and never script output beyond the 200-char detail.

## Test

    python3 infra/quant-vps/recovery/test_vertex_ibkr_recovery.py

No docker, no real script, no network beyond a loopback test server.

## Deploy

The rig-side deployer substitutes `__TS__` and the base64 payloads `__SERVICE_PY__`
(`vertex_ibkr_recovery.py`), `__TEST_PY__` (`test_vertex_ibkr_recovery.py`), `__UNIT__`
(`vertex-ibkr-recovery.service`) and `__TAILCADDY__` (`../status/Caddyfile.tailnet`) into
`install-recovery.sh` and runs it as root over SSH. The installer runs the tests with the VPS python3, prints
`script env-file overrides: none|<keys>` and `script env-file bash-source: ok|FAILED`,
validates the Caddy config, and stops with exit code 4 (nothing installed) when the deployed
`Caddyfile.tailnet` differs from the staged one outside the recovery block, so routes added by other sessions are
never dropped. It creates `/opt/vertex-ibkr-recovery/token.env` once (never printed), installs and
starts the unit, checks health (200, no token 401, wrong token 401), sends one `dryRun:true` request, writes
`Caddyfile.tailnet` in place, reloads `vertex-status-tailnet` through its admin socket, checks the tailnet route
from the VPS itself, and checks that the protected containers and compose files did not change.
It never runs the 2FA script.

## Rollback

The installer prints `rollback=/opt/vertex-ibkr-recovery/rollback-<ts>`. On the VPS:

    systemctl disable --now vertex-ibkr-recovery
    rm -f /etc/systemd/system/vertex-ibkr-recovery.service   # or restore <rollback>/vertex-ibkr-recovery.service
    systemctl daemon-reload
    cat <rollback>/Caddyfile.tailnet.before > /opt/vertex-status/Caddyfile.tailnet
    docker exec vertex-status-tailnet caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock

`/opt/vertex-ibkr-recovery/token.env` and `/var/lib/vertex-ibkr-recovery` (state, run logs) stay; remove them
by hand if the service is retired.
