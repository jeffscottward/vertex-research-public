# QuantVPS read-only status endpoints

These endpoints let Vertex show the trading-stack state and a read-only session snapshot, with no write or trade path.

## Endpoints

| Endpoint | Audience | Document |
| --- | --- | --- |
| `https://vertex.xyz/vertex-status/v1` | public internet, bearer token | `vertex-deploy-status-v1` only, also for `?schema=v2` and the v2 Accept header |
| `https://quant-vps-host.example-tailnet.ts.net:8443/vertex-status/v2` | tailnet only, **rig only** (remote_ip allow-list), bearer token | `vertex-deploy-status-v2`: v1 fields plus session, positions, orders, fills, equity, risk, logs |
| `https://quant-vps-host.example-tailnet.ts.net:8443/vertex-history/v1/bars` | tailnet only, **rig only**, bearer token (checked by Caddy and again by the service) | `vertex-history-bars-v1`: IBKR historical bars (read-only service, IB client id 77) |
| `https://quant-vps-host.example-tailnet.ts.net:8443/vertex-ibkr-recovery/v1/*` | tailnet only, rig and the VPS's own tailnet addresses, **own** bearer token `VERTEX_RECOVERY_TOKEN` (checked by the service) | `vertex-ibkr-recovery-status-v1` / `-request-v1`: gateway login state and one human 2FA request (see below) |

The status, history and portfolio endpoints use the same token. The rig copy is `private/basic-app/.dev.vars` `VERTEX_DEPLOY_STATUS_TOKEN`. The recovery endpoint has its own token, because the shared token also opens the public v1 route.

The tailnet URL is not secret. It is reachable only by tailnet members that use MagicDNS (the rig does), and not by Cloudflare-hosted runtimes.

## Timeline

| When | Event |
| --- | --- |
| 2026-09-30T00:20Z | v1 deployed. |
| 2026-10-03T11:30Z | Collector v2 deployed. v2 was briefly public through `?schema=v2` from 11:30:33Z to 11:35:39Z. |
| 2026-10-03T11:35:39Z | v2 public serving disabled. The user's condition for account data is token **plus** IP allow-list. |
| 2026-10-03T11:42Z | VPS joined the tailnet; the user approved the device. |
| 2026-10-03T11:49:55Z | v2 served on the tailnet interface, to the rig only. |

## Tracked sources (`infra/quant-vps/status/`)

| File | Purpose |
| --- | --- |
| `collect.py` (2.1.0) | Collector, stdlib Python. Tests: `python3 infra/quant-vps/status/test_collect.py` (14 tests). |
| `vertex-status-collect.service.tailnet` | Deployed unit: `VERTEX_STATUS_V2=1`, `VERTEX_STATUS_V2_DIR=/opt/vertex-status/private-v2`. |
| `vertex-status-collect.service` | v1-only unit (`VERTEX_STATUS_V2=0`). |
| `vertex-status-collect.timer` | Runs the collector every 30 s. |
| `Caddyfile.status` | Public status container config (v1 only, deployed). |
| `Caddyfile.status.v2` | Public v2 routing. **Not deployed; do not use.** |
| `Caddyfile.tailnet` | Tailnet-only site template (deployed). |
| `install-tailnet.sh` | Phase 2 installer (used). |
| `install-remote.sh` | Public-v2 installer. Refuses to run unless `VERTEX_STATUS_ENABLE_V2=1`. **Do not use.** |
| `Caddyfile.route.snippet` | Main Caddy route (unchanged). |
| `SCHEMA.md` | v2 contract. |

Rig-side deployers live in `~/.local/state/vertex-vps-status/`: `deploy-tailnet.mjs`, `deploy-v2.mjs`, and `vps.mjs` (read-only shell). The SSH password is read in-process from `vertex-quant/.env` and never printed.

## What runs on QuantVPS

| Item | Location | Notes |
| --- | --- | --- |
| Collector | `/opt/vertex-status/collect.py` + `vertex-status-collect.{service,timer}` (30 s, oneshot, `Nice=10`, `TimeoutStartSec=25`) | Writes the public `public/status.json` (v1). Writes v2 **only** to `/opt/vertex-status/private-v2/status-v2.json` (0700); it refuses the public dir and deletes any v2 file found there. Read-only inputs (see below). Never starts or stops containers, never calls portfolio-ui, never opens an IBKR client, never touches kill-switch files. |
| Public status server | container `vertex-status` (caddy:2-alpine; network `ibkr-nautilus-exec-node_prototype`; read-only; caps dropped except NET_BIND_SERVICE; 64 MB) | Mounts only `/opt/vertex-status/public`. Bearer token required, otherwise 401. |
| Public route | `/opt/vertex-quant/deploy/Caddyfile`, `vertex.xyz` block: `handle /vertex-status/v1 { reverse_proxy vertex-status:8080 }` | Unchanged since 2026-09-30. |
| Tailnet status server | container `vertex-status-tailnet` (caddy:2-alpine; `--network host`; read-only; caps dropped except NET_BIND_SERVICE; 64 MB; restart unless-stopped) | Binds **only** 100.64.0.10:8443 and [fd7a:115c:a1e0::10]:8443. TLS certificate for `quant-vps-host.example-tailnet.ts.net` comes from tailscaled through the mounted socket. Allow-list `remote_ip 100.64.0.20 fd7a:115c:a1e0::20` (the rig's tailnet IPv4/IPv6). Responses: other sources 403; rig without or with a wrong token 401; rig with a valid token on `/vertex-status/v2` 200; any other path 404. Mounts `private-v2` read-only. |
| Tailscale | `tailscale 1.102.4` from the official apt repo (key `2596A99EAAB33821893C0A79458CA832957F5868`), node `quant-vps-host` | Prefs: `--accept-dns=false --accept-routes=false --ssh=false --netfilter-mode=off`; no exit node. Main routes, DNS and iptables are unchanged against `/opt/vertex-status/net-baseline-20261003T1140Z/`. tailscaled adds ip rules 5210–5270, and table 52 holds only tailnet routes. |
| Token | `/opt/vertex-status/token.env` (0600) | Used by both status containers. |
| Web app | `vertex-web.service` (`vite preview` of the prebuilt `dist/` folder of `apps/web` on 127.0.0.1:3450; tailnet proxy container `vertex-web-tailnet` on :3451) | Deploy and restart only through `infra/quantvps/restart-when-idle.sh` (idle wait, health check, rollback; see [infra/quantvps/README.md](../../infra/quantvps/README.md)). |

Collector inputs (all read-only):

- `docker inspect` and `docker logs --tail`.
- Files under `/opt/vertex-quant/data`: health.json, the newest account snapshot, `ibkr-open-orders.json`, `ibkr-fills.json`, and the tails of watchdog.log and prototype-runner.log.
- Redis `HGETALL` of the heartbeat hash.
- Postgres inside `BEGIN READ ONLY` with a 4 s statement timeout, cached 300 s in `/opt/vertex-status/state/`.
- Allow-listed non-secret nautilus-trader env keys.

## Schema v2 (summary; contract in `infra/quant-vps/status/SCHEMA.md`)

v2 keeps all v1 fields with identical values. Every block has `available`, `source` and `as_of` (report files add `age_seconds` and `stale`), or `{available:false, reason}`.

| Block | Contents |
| --- | --- |
| `session` | `state` (starting, running, paused, degraded, halted, stopping, stopped, error, unknown) plus `raw_state`, strategies, symbols, `account_masked` (`****NNNN`), start/stop/heartbeat times |
| `positions`, `equity` | newest IBKR account-snapshot report |
| `orders` | `ibkr-open-orders.json`, read from disk without a refresh |
| `fills` | last 50 |
| `risk` | kill switch (engaged, clear or unknown) with indicators; risk limits; last risk check; watchdog summary |
| `logs` | at most 50 scrubbed WARNING/ERROR entries |

Size stays under 60 KiB (the app reads at most 64 KiB); the hard cap is 256 KiB. A final secret-pattern and token guard withholds the v2 blocks if anything suspicious remains.

The app's current parser is strict v1. To adopt v2 it needs a separate tailnet URL setting and a v2 parser. Its `https:` requirement is already satisfied.

State on 2026-10-03:

- `session.state = stopped`: nautilus-trader container is in state `created` since 2026-09-25.
- IB Gateway API is not logged in.
- Kill switch `clear`.
- Report files are stale.

## Receipts (2026-10-03)

### Backups

| Directory | Contents |
| --- | --- |
| `/opt/vertex-status/rollback-20260930T002044Z/` | original v1 deploy |
| `/opt/vertex-status/rollback-20261003T113025Z/` | before collector v2: main Caddyfile, v1 collect.py, status Caddyfile, both units |
| `/opt/vertex-status/rollback-20261003T114820Z/` | before the tailnet site: collect.py 2.0.1, V2=0 unit, main Caddyfile, table 52 after login |
| `/opt/vertex-status/net-baseline-20261003T1140Z/` | network state before Tailscale |

### Tailnet verification from the rig, 11:51:07Z

| Request | Result |
| --- | --- |
| valid token | 200 v2 (9,656 bytes); token not in body; leak scan clean |
| no token | 401 |
| wrong token | 401 |
| other path | 404 |

**Non-allowed source:** from the VPS itself (its own tailnet IP) with a valid token, 403 over IPv4 and IPv6. The public IP:8443 has no listener.

**Public endpoint:** default, `?schema=v2` and Accept header all return 200 v1 with no v2 blocks; no token returns 401.

**No restarts:** ib-gateway, nautilus-trader, watchdog, portfolio-ui, postgres, redis and main caddy were not restarted, stopped or recreated. The compose file and main Caddyfile are untouched (hash `294d672e…` throughout), and main Caddy was not reloaded. The public `vertex-status` was restarted only at 11:30:33Z and 11:35:39Z (deploy, then disable).

## Read-only IBKR history service (2026-10-04)

Sources: `infra/quant-vps/history/` (`vertex_history.py` 1.0.0, `test_vertex_history.py` 22 tests incl. a static scan that fails on any order, account or position API name and an AST allow-list of IB client calls, `vertex-history.service`, `resolve-gateway.sh`, `install-history.sh`). Rig deployer: `~/.local/state/vertex-vps-status/deploy-history.mjs`.

| Item | Value |
| --- | --- |
| Unit | `vertex-history.service` (systemd, `DynamicUser`, `ProtectSystem=strict`, no capabilities, `IPAddressAllow=127.0.0.0/8 172.16.0.0/12`, 256 MB, `Restart=on-failure`) |
| Runtime | `/opt/vertex-history/venv` (`python3 -m venv --without-pip`, Python 3.10.12) with `ibapi 9.81.1.post1` from the PyPI sdist (sha256 `49f6678b…`); the installed tree hashes identically to the watchdog's ibapi (`e5fb55e3…`) |
| Listener | `127.0.0.1:8791` only; Caddy route `/vertex-history/v1/*` in `Caddyfile.tailnet` |
| IB session | client id 77 to the ib-gateway bridge IP, port 4003 (resolved at start by `resolve-gateway.sh` via `docker inspect`). Calls: connect, disconnect, reqContractDetails, reqHistoricalData, cancelHistoricalData |
| Requests | `GET /vertex-history/v1/bars?symbol=&secType=STK\|FUT\|CONTFUT\|CASH&exchange=&currency=&barSize=&duration=&whatToShow=TRADES\|MIDPOINT&useRTH=1&contractMonth=`; `GET /vertex-history/v1/health` |
| Bounds | bar sizes 1 min, 5/15/30 mins, 1 hour, 1 day; duration ≤ 1 Y daily, ≤ 1 M intraday, ≤ 2 D for 1 min |
| Pacing | historical requests ≥ 10 s apart, ≤ 6 per 120 s, identical ≤ 1 per 15 s, 10 min back-off after an IBKR pacing violation; a request waits at most 20 s, otherwise 429 with `retry_after_seconds` |
| Cache | `/var/cache/private/vertex-history`, TTL 3600 s daily, 300 s intraday, 120 s for 1 min; stale copies up to 24 h served (`cache.stale=true`) while paced or the gateway is down |
| Volume | as reported by IBKR to this API version (US stocks in lots of 100 shares) |

Note: `secType=CASH` (forex on IDEALPRO, MIDPOINT only) is staged in `infra/quant-vps/history` only; it is not yet deployed to the live service, and the web/API side (`MARKET_SEC_TYPES`, the charts picker, MCP `market_bars`) does not expose it.

The tailnet Caddy config had `admin off`, so adding the route required one restart of `vertex-status-tailnet` (2026-10-04T02:16:41Z). The admin API now listens only on `unix//tmp/caddy-admin.sock` inside the container; reload with `docker exec vertex-status-tailnet caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock`.

Verification from the rig, 2026-10-04T02:17Z: no token 401, wrong token 401, health 200, other path 404, `/vertex-status/v2` still 200; SPY STK SMART 1 day 1 Y 200 (251 bars, conId 756733); ES CONTFUT CME 1 day 1 Y 200 (250 bars, front contract ESZ6). Pacing: requests logged 10 s apart; the 7th distinct request within 120 s got 429 `paced` (retry 61 s). From the VPS itself (non-allowed source) 403 over IPv4 and IPv6. The public IP has no listener on 8791 or 8443. Protected containers kept their start times; compose file and main Caddyfile hashes unchanged. Backup: `/opt/vertex-history/rollback-20261004T021635Z/`.

Roll back: `systemctl disable --now vertex-history; rm /etc/systemd/system/vertex-history.service; systemctl daemon-reload; cat /opt/vertex-history/rollback-20261004T021635Z/Caddyfile.tailnet.before > /opt/vertex-status/Caddyfile.tailnet; docker restart vertex-status-tailnet; rm -rf /opt/vertex-history`.

## Read-only IBKR portfolio service (2026-10-10)

Sources: `infra/quant-vps/portfolio/` (`vertex_portfolio.py` 1.0.0, 23 tests incl. the AST allow-list of IB calls and a cross-language snapshot fixture, `vertex-portfolio.service`, `resolve-gateway.sh`, `install-portfolio.sh`, `README.md`). Rig deployer: `~/.local/state/vertex-vps-status/deploy-portfolio.mjs` (uses the `quantvps` SSH key alias only; it reads no `.env` file). Consumer: `portfolioMonitor.snapshot` (operator-only; not reachable with agent API keys or MCP tools). Since the Mission control account card (audit P1-2, phase 2) no page reads it: `/dashboard` and `/portfolio` both read `ibkrMonitor.snapshot`. The procedure and service remain until their retirement is approved.

| Item | Value |
| --- | --- |
| Unit | `vertex-portfolio.service` (same hardening as `vertex-history.service`) |
| Listener | `127.0.0.1:8792` only; Caddy route `/vertex-portfolio/v1/*` in `Caddyfile.tailnet` (rig IP allow-list plus bearer token) |
| IB session | client id 78, read-only subscriptions: reqPositions, reqAccountSummary, reqAccountUpdates, reqPnL, reqPnLSingle, reqAllOpenOrders (15 s), reqCompletedOrders (60 s), reqExecutions (30 s). Reconnects with back-off 10 s to 120 s; clears all account data while disconnected |
| Requests | `GET /vertex-portfolio/v1/snapshot` (`vertex-portfolio-snapshot-v1`), `GET /vertex-portfolio/v1/health` |
| Privacy | Account codes never leave the service; the Vertex server removes them again. `accountMode` reports live or paper only |
| Rig setting | `VERTEX_PORTFOLIO_URL` in `private/basic-app-named/.dev.vars` (backup `~/.local/state/vertex-vps-status/dev.vars.before-portfolio-20261010`) |

Deployment 2026-10-10T11:15:34Z: tests 23 run, 1 skipped (fixture not shipped), ibapi hash matches the watchdog, Caddy config valid, graceful reload through the admin socket (no container restart), protected containers kept their start times, compose file and main Caddyfile unchanged, `vertex-history` still active. First snapshot: state live, live account. Browser E2E from the rig (headless, operator test account): values matched a fresh ibkr-monitor snapshot (net liquidation, 12 positions, 94 open orders, three position sizes). Backup: `/opt/vertex-portfolio/rollback-20261010T111534Z/`.

Readiness fix, redeployed 2026-10-10T11:33:04Z from commit `95edf0d` (deployed `vertex_portfolio.py` sha256 `ef0f9394…` equals the commit): the service reports `live` only after positionEnd, accountSummaryEnd, openOrderEnd, completedOrdersEnd and execDetailsEnd (completedOrdersEnd: superseded by the 2026-10-28 change below); until then the snapshot withholds all account data (state `starting`, empty lists, no data time). The gateway did not send accountDownloadEnd to client 78 within 30 s, so that wait is bounded to 10 s and logged as `account_updates_pending`; missing per-position account prices stay null. Live reached 10 s after start. Backups: `/opt/vertex-portfolio/rollback-20261010T113015Z/`, `…T113102Z/`, `…T113304Z/`.

Access checks from the rig after redeploy: no token 401, wrong token 401, valid health 200, unknown path 404, POST 405; from the VPS itself (non-rig source) 403 over IPv4 and IPv6. Browser E2E after redeploy: Live badge; Today tab shows "Executions today (0)" and "Completed / cancelled today (0)" (ibkr-monitor also reported 0 and 0); Charts tab shows the allocation donut (12 slices), P&L by position and 12 stop ladders.

Source change 2026-10-28 (commit `6d05809`, ported to this branch 2026-10-30, card civet-20-port): `live` no longer waits for completedOrdersEnd. On 2026-10-28 the gateway answered every other initial request in about 3 s but did not send completedOrdersEnd, so the service never went live. The service now waits 10 s more for completed orders, then goes live with an empty completed list and logs `completed_orders_pending`. Each completed-orders request starts a new row buffer, so rows without an end do not accumulate or repeat. A timeout of the core feeds logs `initial_feeds_missing` with the missing feed names. Known limit: while completed orders are pending, the dashboard shows "Completed / cancelled today (0)", which looks like a real zero; a pending flag needs a coordinated change of the strict snapshot schema and is not part of this change. Deployment state (read-only check 2026-10-30): `/opt/vertex-portfolio/vertex_portfolio.py` on QuantVPS has the same SHA-256 as `6d05809` (`3e8929a0…`); the deploy of 2026-10-28 left the backup folder `/opt/vertex-portfolio/rollback-20261028T133615Z/`. The per-request buffer reset above is not deployed yet.

Roll back: `systemctl disable --now vertex-portfolio; rm /etc/systemd/system/vertex-portfolio.service; systemctl daemon-reload; cat /opt/vertex-portfolio/rollback-20261010T111534Z/Caddyfile.tailnet.before > /opt/vertex-status/Caddyfile.tailnet; docker exec vertex-status-tailnet caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock; rm -rf /opt/vertex-portfolio`. On the rig, remove `VERTEX_PORTFOLIO_URL` from `.dev.vars` and restart `vertex-web`.

## Human IBKR 2FA recovery service (2026-10-28)

Card vertex-2fa-button. Sources: `infra/quant-vps/recovery/` (`vertex_ibkr_recovery.py` 1.0.0, tests, `vertex-ibkr-recovery.service`, `install-recovery.sh`, `README.md`, interface contract `SCHEMA.md`). Rig deployer: `~/.local/state/vertex-vps-status/deploy-recovery.mjs` (uses the `quantvps` SSH key alias only). Consumer: `ibkrRecovery.status` and `ibkrRecovery.request` (operator-only; not reachable with agent API keys or MCP tools), shown as the "Send IBKR 2FA request" button on the Mission control account card (`/dashboard`).

| Item | Value |
| --- | --- |
| What it may start | Only `/opt/vertex-quant/scripts/request-ibkr-2fa-until-ready.sh`, no arguments, no shell, after an operator presses the button and confirms "I request IBKR recovery only; this does not authorize trading." Never automatic, never retried. |
| Script environment | `IBKR_2FA_NOTIFY_ENABLED=0`, `IBKR_2FA_MAX_ATTEMPTS=1`, `IBKR_2FA_APPROVAL_TIMEOUT_SECONDS=180`, `IBKR_2FA_VERIFY_ACCOUNT_SNAPSHOT=0`, `IBKR_2FA_VERIFY_API_HANDSHAKE=0` (with the script defaults its readiness check runs `docker compose up -d nautilus-trader`). No extra IB client id is used: with both checks off the script opens no IB session, and the account check reads vertex-portfolio (client id 78). `IBKR_RECOVERY_SNAPSHOT_CLIENT_ID` is therefore not needed. A start is refused when `/opt/vertex-quant/.env(.example)` would override these keys. |
| Gates (VPS, persisted) | gateway login state `logged-out` or `stopped`; no request in flight and the script not running; 15 min cooldown after each start (`state.json`, temp file + rename). The Vertex server checks the same gates and writes an audit record (`vertex.ibkrRecovery.requestIntent`) before it calls the VPS. |
| Login state | Derived from the IBC lines of the ib-gateway container logs since its start (`Login has completed`, `Second Factor Authentication initiated`, `Re-login after second factor authentication timeout not required`, existing-session messages) plus the container state. States: logged-in, awaiting-2fa, starting, logged-out, stopped, unknown. |
| Progress | requested → waiting-for-approval → verifying → logged-in (vertex-portfolio health live with data newer than the login) / timed-out / failed |
| Listener | `127.0.0.1:8793` only; Caddy route `/vertex-ibkr-recovery/v1/*` in `Caddyfile.tailnet` before the rig-only block |
| Token | `/opt/vertex-ibkr-recovery/token.env` (0600, created by the installer, never printed). Vertex reads it as `VERTEX_IBKR_RECOVERY_TOKEN` with `VERTEX_IBKR_RECOVERY_URL`. |

Deployment 2026-10-28T14:38:27Z (redeploy with the log cursor fix; first install 14:32:22Z reported `unknown` because `--tail 4000` dropped the login event): 68 tests on the VPS python3, env-file overrides none, Caddy config valid, graceful reload, protected containers kept their start times, compose file and main Caddyfile unchanged. Checks: local health 200 `logged-in`; no token, wrong token and the status token 401; dry-run POST 409 `not_needed`; from the rig through the tailnet: status 200 (`logged-in` since the 23:45 auto-restart), no token 401, dry-run 409 `not_needed`, GET on `/request` 405, unknown path 404; VPS-self 200 with token, 401 without, portfolio 403. No real request was sent (`runs/` empty, no `request_started` log line). Backups: `/opt/vertex-ibkr-recovery/rollback-20261028T143222Z/`, `…T143827Z/`.

Prerequisite fixed the same day: `/opt/vertex-quant/.env` line 104 had `AUTO_RESTART_TIME=11:45 PM` unquoted (added 2026-10-26 for the daily auto-restart). Docker Compose reads it, but bash `source` stops with exit 127 (`PM: command not found`), so every vertex-quant script that loads `.env` (the 2FA script, `healthcheck.sh`, and the ibkr-monitor 2FA button) failed before doing anything. The value is now quoted (`"11:45 PM"`). `docker compose --profile ibkr config` is byte-identical before and after (hash `432908369200e4c2`); backup `/opt/vertex-quant/.env.bak-quote-20261028T143216Z`.

Roll back: see `infra/quant-vps/recovery/README.md` (disable the unit, restore `Caddyfile.tailnet.before` from the printed rollback folder in place, reload through the admin socket).

### Nautilus arm switch on the same service (2026-10-30, not yet deployed)

Owner decision 2026-10-30: the Nautilus node runs 24/7 and is disarmed by default. The recovery service adds `GET /nautilus/status`, `POST /nautilus/arm` and `POST /nautilus/disarm` (same token, same Caddy route). They run only `docker exec <node container id> python -m nautilus.arm_cli status|arm|disarm ... --json` in three fixed forms (contract: `infra/quant-vps/recovery/SCHEMA.md`, section "Nautilus arm switch"). Consumer: `nautilusArm.status`, `nautilusArm.arm` and `nautilusArm.disarm` (operator session only; agent API keys refused). Arm needs the owner's password, a 10..280 character reason and the statement "I arm the Nautilus node; it may submit live orders."; the server writes an `audit_records` intent row before the call and a result row after it. Disarm is one click. Mission control shows the badge "Running · Disarmed", "Running · Armed" or "Down" (plus "Unknown" and "Unreachable").

## Roll back

On QuantVPS as root.

### Remove the tailnet v2 site (keep the public v1 endpoint)

```sh
docker rm -f vertex-status-tailnet
R=/opt/vertex-status/rollback-20261003T114820Z
install -m 700 "$R/collect.py.before" /opt/vertex-status/collect.py              # 2.0.1, v1-only
install -m 644 "$R/vertex-status-collect.service.before" /etc/systemd/system/vertex-status-collect.service
systemctl daemon-reload
rm -rf /opt/vertex-status/private-v2 /opt/vertex-status/Caddyfile.tailnet /opt/vertex-status/state
```

### Leave the tailnet

```sh
tailscale logout
apt-get remove -y tailscale
rm -f /etc/apt/sources.list.d/tailscale.list /usr/share/keyrings/tailscale-archive-keyring.gpg
```

Also remove the device in the Tailscale admin console. Afterwards, compare with `/opt/vertex-status/net-baseline-20261003T1140Z/`.

### Back to the pre-v2 collector

```sh
R=/opt/vertex-status/rollback-20261003T113025Z
install -m 700 "$R/collect.py.before" /opt/vertex-status/collect.py
install -m 644 "$R/vertex-status-collect.service.before" /etc/systemd/system/vertex-status-collect.service
install -m 644 "$R/vertex-status-collect.timer.before" /etc/systemd/system/vertex-status-collect.timer
systemctl daemon-reload
```

### Remove the public endpoint entirely

```sh
R=/opt/vertex-status/rollback-20260930T002044Z
cat "$R/Caddyfile.before" > /opt/vertex-quant/deploy/Caddyfile   # keep inode (bind mount)
docker exec ibkr-nautilus-exec-node-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
docker rm -f vertex-status
systemctl disable --now vertex-status-collect.timer
rm -f /etc/systemd/system/vertex-status-collect.{timer,service}; systemctl daemon-reload
rm -rf /opt/vertex-status
```

Then remove `VERTEX_DEPLOY_STATUS_URL` and `VERTEX_DEPLOY_STATUS_TOKEN` from the rig's `private/basic-app/.dev.vars`. The pre-change copy is `~/.local/state/vertex-vps-status/dev.vars.before`.

## Rotate the token

1. Write the new value to `/opt/vertex-status/token.env` and to the rig `.dev.vars`.
2. Run `docker restart vertex-status vertex-status-tailnet`. This restarts the status containers only.
