# vertex-ibkr-recovery (QuantVPS) interface contract — v1

Card vertex-2fa-button. Shared by the VPS service (`vertex_ibkr_recovery.py`) and the Vertex server
(`packages/api/src/server/ibkr-recovery.ts`). Change this file first if the interface changes.

## Purpose and limits

- A human operator presses "Send IBKR 2FA request" in Vertex. The Vertex server calls this service. The service
  may start exactly ONE fixed program: `/opt/vertex-exec-node/scripts/request-ibkr-2fa-until-ready.sh` (argv has no
  extra arguments, cwd `/opt/vertex-exec-node`, no shell). Nothing else is executable through HTTP.
- It never auto-starts the script, never retries it, never logs in, never touches orders, kill switch or
  nautilus-trader. No credentials pass through it.
- Own bearer token `VERTEX_RECOVERY_TOKEN` (env file `/opt/vertex-ibkr-recovery/token.env`, 0600, created by the
  installer if absent, 43+ URL-safe chars). It is NOT the shared status token, because that token also opens the
  public v1 route. The service also reads `VERTEX_STATUS_TOKEN` (from `/opt/vertex-status/token.env`) only to call
  the local vertex-portfolio health endpoint; that token never authenticates a recovery request.
- Listener `127.0.0.1:8793` only. Tailnet Caddy route `/vertex-ibkr-recovery/v1/*`: Caddy allows only the rig and the
  VPS's own tailnet addresses (remote_ip) and proxies; the service checks `VERTEX_RECOVERY_TOKEN` (constant time).

## Script environment (fixed)

`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, `HOME=/root`, `LANG=C.UTF-8`,
`IBKR_2FA_NOTIFY_ENABLED=0`, `IBKR_2FA_MAX_ATTEMPTS=1`, `IBKR_2FA_APPROVAL_TIMEOUT_SECONDS=180`,
`IBKR_2FA_VERIFY_ACCOUNT_SNAPSHOT=0`, `IBKR_2FA_VERIFY_API_HANDSHAKE=0`. The last two are mandatory: with the
script defaults, its readiness check runs `docker compose up -d nautilus-trader` (the live trading engine). With
both at 0 the script's readiness check is `/opt/vertex-exec-node/scripts/healthcheck.sh` only (read-only). The account snapshot check is
done by this service through vertex-portfolio instead. A test must assert the complete fixed environment and argv.
No extra IB client id is used: with both `VERIFY_*` at 0 the script opens no IB API session, so the service does
not pass `IBKR_2FA_VERIFY_CLIENT_ID` (it would have no effect). The account snapshot check goes through
vertex-portfolio and its existing client id 78. Output (stdout+stderr) goes to
`$STATE_DIRECTORY/runs/<requestId>.log` (0600). Keep at most the last 20 run logs.

The script sources `/opt/vertex-exec-node/.env.example` and `.env` under `set -Eeuo pipefail`; that `source` must
succeed. A value with an unquoted space (on 2026-10-28 the VPS `.env` had `AUTO_RESTART_TIME=11:45 PM`) runs a
command and the script exits (127) before it does anything; the request then ends `failed` with its last output
line. The installer prints `script env-file bash-source: ok|FAILED` (no values).

## Gateway login state (derived on the VPS)

Source: the ib-gateway container (resolve with `docker ps -a --filter label=com.docker.compose.service=ib-gateway`),
`docker inspect` State (Running, StartedAt) and `docker logs --timestamps --since <timestamp>` (stdout+stderr), no
`--tail` (IBC lines are rare and IBC restarts daily inside the same container, so a tail loses the login event).
Incremental cursor per container id + StartedAt: the first read is `--since <StartedAt>` (20 s timeout, 64 MiB cap;
above either it reads `--since <now - 48 h>`, never before StartedAt, and marks reason `log-window` when that
window has no event); later reads are `--since <timestamp of the last line read>`, skipping the already-read lines
at that timestamp (`--since` is inclusive). Only parsed IBC events are kept (last 500).
Parse IBC lines (`IBC: ...`) in order; the last matching event wins:

| Log text contains | Event |
| --- | --- |
| `Login dialog WINDOW_OPENED: LoginState is LOGGED_OUT`, `Starting session: will exit if login dialog`, `IBC will restart shortly`, `detected dialog entitled: Restart in progress` | login-started |
| `Second Factor Authentication initiated`, `detected dialog entitled: Second Factor Authentication; event=Opened` | 2fa-started |
| `Login has completed`, `Login has already completed` | logged-in |
| `Re-login after second factor authentication timeout not required`, `IBC closing because login has not completed after Second Factor Authentication` | 2fa-timeout |
| `End this session and let the other session proceed`, `Other session must be primary`, `Other session may be primary, so end this session` | session-ended |

`loginState` (exactly one):

- `stopped`: container exists but not running, or no container. needsLogin=true.
- `logged-in`: last event logged-in. needsLogin=false.
- `awaiting-2fa`: last event 2fa-started and less than 240 s old (IBC SecondFactorAuthenticationTimeout 180 s + 60 s). needsLogin=false.
- `starting`: last event login-started and less than 300 s old, or container started less than 120 s ago with no event yet. needsLogin=false.
- `logged-out`: last event 2fa-timeout or session-ended; or 2fa-started older than 240 s; or login-started older than 300 s. needsLogin=true.
- `unknown`: docker unreadable, or container running longer than 120 s with no event. needsLogin=false.

`feedsMissing` (1.1.0): vertex-portfolio health answered and its account feeds are not live (`state` is not
`live` or `connected` is not true). No answer counts as false (unknown). A request is also allowed when
`loginState` is `logged-in` and `feedsMissing` is true: the script then restarts the gateway login.

Line timestamps: use `docker logs --timestamps` (RFC3339 prefix). `since` = time of the deciding event (ISO, UTC, `Z`), or StartedAt for stopped/starting-without-event, else null. `reason` = the event name or a short code (`container-not-running`, `docker-error`, `no-login-event`, `log-window`).
Cache the state; refresh at most every 10 s (and on each POST).

## Account snapshot check

`GET http://127.0.0.1:8792/vertex-portfolio/v1/health` with the same bearer token, 5 s timeout. OK when
`state == "live"`, `connected == true` and `dataAsOf` (epoch seconds) >= the logged-in event time minus 5 s.

## Request lifecycle

States: `requested` → `waiting-for-approval` → `verifying` → `logged-in`; terminal failures `timed-out`, `failed`.

- `requested`: accepted, script started.
- `waiting-for-approval`: a 2fa-started event appears after the request start, or the script printed
  `IBKR 2FA login request attempt`.
- `verifying`: a logged-in event appears after the request start; waiting for the account snapshot check.
- `logged-in`: snapshot check OK (detail `account snapshot OK`).
- `timed-out`: a 2fa-timeout event after the start, or no logged-in event within 300 s of the start.
- `failed`: script exited before its `IBKR 2FA login request attempt` line and before any 2fa-started/logged-in
  event (detail: last non-empty output line, max 200 chars, tokens/secrets never included — the script already
  redacts); or the script printed `no 2FA request needed` (detail
  `The script reported the gateway ready and sent no 2FA request.`); or the script printed
  `restart cooldown active` (detail `gateway restart cooldown active on the VPS`); or session-ended after start; or
  `verifying` for more than 180 s without snapshot OK (detail `login completed; account snapshot not confirmed`);
  or the service restarted while a request was not terminal (detail `service restarted during the request`).
- After the attempt line (the gateway restart happened) the script's exit no longer decides anything; the
  gateway events decide until the 300 s limit.

A monitor thread evaluates the active request every 5 s. Reaching a terminal state does NOT kill the script; the
script ends on its own (approval timeout 180 s). `scriptRunning` stays true until it exits. A new request is refused
while the script runs, even if the request state is terminal.

## Persistence

`$STATE_DIRECTORY/state.json` (0600), written temp-file + rename: `lastStartedAt` (epoch), `active` request, `history`
(newest first, max 20). Read at start; a non-terminal active request becomes `failed` (service restarted).

## HTTP API (prefix `/vertex-ibkr-recovery/v1`)

Every response: JSON, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. Missing/wrong bearer → 401
`{"error":"unauthorized"}` (constant-time compare). Unknown path → 404. Wrong method → 405. Body > 4096 bytes → 413.

Request object (`RecoveryRequest`):
`{"requestId": str, "actorId": str, "requestedAt": ISO, "updatedAt": ISO, "finishedAt": ISO|null, "state": <state>, "detail": str (max 200), "scriptRunning": bool, "recheckAt": ISO|null, "recheck": {"at": ISO, "ok": bool, "detail": str}|null}`

Re-check (1.1.0, owner 2026-10-30): at `recheckAt` (request time + 900 s, the IBKR approval window) the monitor
re-reads the real auth state once the request is terminal: gateway `logged-in` AND account feeds live. Good: the
request is removed from `request` (history keeps it with `recheck.ok=true`). Not good: it stays with
`recheck.ok=false` and the reason, and the check repeats every 60 s until auth is good. Read-only.

### `GET /status` → 200

```json
{"schema":"vertex-ibkr-recovery-status-v1","version":"1.0.0","generatedAt":"…Z",
 "gateway":{"loginState":"logged-out","needsLogin":true,"since":"…Z"|null,"reason":"2fa-timeout","feedsMissing":false},
 "request": RecoveryRequest|null,
 "cooldown":{"seconds":900,"until":"…Z"|null},
 "history":[RecoveryRequest, …max 10]}
```

`request` is the active/most recent request (null if none). `cooldown.until` = lastStartedAt + 900 s if in the
future, else null.

### `POST /request` body `{"requestId","actorId","statement","dryRun"}`

- `requestId`: `^[A-Za-z0-9-]{8,64}$`; `actorId`: `^[A-Za-z0-9_-]{1,64}$`; `statement` must equal exactly
  `I request IBKR recovery only; this does not authorize trading.`; `dryRun` boolean. Extra keys → 400.
  Invalid → 400 `{"error":"bad_request","detail":…}`.
- Same `requestId` as the active request or any request in the history → 200 `{"schema":"vertex-ibkr-recovery-request-v1","outcome":"existing","request":…}` (no new start).
- Checks in order (refresh gateway state first, before taking the request lock; no docker call inside the lock):
  1. script running or active request not terminal → 409 `{"error":"in_flight","request":…}`
  2. cooldown active → 429 `{"error":"cooldown","retryAfterSeconds":n,"until":"…Z"}` + `Retry-After` header
  3. gateway needsLogin false (and not logged-in with feedsMissing) → 409 `{"error":"not_needed","loginState":…}`
- `dryRun:true` and all checks pass → 200 `{"schema":"vertex-ibkr-recovery-request-v1","outcome":"dry-run","wouldStart":true}`; nothing started, nothing persisted.
  When the script's env files would override the fixed environment (see the service README), the dry run
  answers `"wouldStart":false` with a `detail` naming the keys, and a real request ends `failed`.
- Otherwise start the script; persist; → 202 `{"schema":"vertex-ibkr-recovery-request-v1","outcome":"started","request":…}`.
  Spawn failure → state `failed`, 202 with that request (cooldown still recorded).
- Single-flight is enforced with a lock around check+start (the `requestId` check repeats inside the lock).

### `GET /health` → 200 `{"schema":"vertex-ibkr-recovery-health-v1","version":"1.0.0","loginState":…}`

## Nautilus arm switch (owner decision 2026-10-30)

The Nautilus node runs 24/7 and is disarmed by default. Arming is an explicit owner action in Vertex (password
step-up, typed reason, audit). The node side is the vertex-quant arm CLI (contract `arm-contract.md` v1); it is the
only writer of the arm record `/opt/vertex-exec-node/data/nautilus/ARMED` (`/app/data/nautilus/ARMED` in the container). This service only runs that CLI:

`docker exec <node container id> python -m nautilus.arm_cli` + one of:

- `status --json`
- `arm --by <actorId> --reason <reason> --confirm-image-version <imageVersion> --json`
- `disarm --by <actorId> --reason <reason> --json`

The node container is the one with labels `com.docker.compose.service=nautilus-trader` and
`com.docker.compose.oneoff=False` (one-off `docker compose run` containers do not count). No match: `missing`. More
than one match: `unknown`, and no exec runs. argv is
fixed, no shell, fixed environment, timeouts 8 s (status) and 12 s (arm, disarm), stdout max 64 KiB. One arm or
disarm at a time (409 `busy`). It never starts, stops or restarts the node.

| Method | Path | Body | Replies |
| --- | --- | --- | --- |
| GET | `/nautilus/status` | none | 200 status (below) |
| POST | `/nautilus/arm` | `{requestId, actorId, reason, statement, imageVersion}` (exact keys) | 200 result; 409 `not_running`, `busy` or a CLI refusal code; 400; 502 `cli_failed`; 504 `cli_timeout` |
| POST | `/nautilus/disarm` | `{requestId, actorId, reason}` (exact keys) | same as arm |

Body rules: `requestId` `^[A-Za-z0-9-]{8,64}$`; `actorId` `^[A-Za-z0-9_.@][A-Za-z0-9_.@-]{0,63}$`; `reason` one
line without control characters or edge spaces, not starting with `-`, 10..280 characters for arm and 1..280
for disarm; `statement` exactly `I arm the Nautilus node; it may submit live orders.`; `imageVersion`
`^[A-Za-z0-9][A-Za-z0-9._+:-]{0,63}$` (the version the owner saw; the CLI refuses a mismatch).
CLI refusal codes (409): `version_mismatch`, `kill_switch_active`, `invalid_reason`, `invalid_actor`, `write_failed`.

Status (`vertex-nautilus-arm-status-v1`):

```json
{"schema":"vertex-nautilus-arm-status-v1","version":"1.0.0","generatedAt":"<ISO>",
 "container":{"state":"running|exited|missing|unknown","health":"healthy|unhealthy|starting|null"},
 "arm":{"armed":false,"state":"disarmed","detail":"no_arm_record","imageVersion":"<v>","killSwitchActive":false,
        "armedAt":null,"armedBy":null,"reason":null},
 "armError":null}
```

`arm` is null when the container is not running (`armError` `not-running`) or the CLI fails (`cli-timeout`,
`cli-error`, `cli-bad-output`). Result (`vertex-nautilus-arm-result-v1`):
`{"schema", "action": "arm|disarm", "requestId", "auditId", "arm": {...same as status...}}`.

## Logging

JSON lines to stdout: `listening`, `request_started` (requestId, actorId), `request_state` (requestId, state),
`request_refused` (reason). Never the token, never script output content beyond the 200-char detail.
