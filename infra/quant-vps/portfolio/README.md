# vertex-portfolio (QuantVPS)

Read-only IBKR portfolio monitor for the Vertex dashboard Monitor view. It holds one IB API connection
(client id **78**) to the ib-gateway container (port 4003) and serves one sanitized JSON snapshot on
`127.0.0.1:8792`. The tailnet Caddy site (`../status/Caddyfile.tailnet`) proxies `/vertex-portfolio/v1/*`
to it, only for the rig with the bearer token.

## IB calls

Only these (a test enforces the list): `connect`, `disconnect`, `isConnected`, `run`, `reqPositions`,
`reqAccountSummary("All", tags)`, `reqAccountUpdates(True, main)`, `reqPnL`, `reqPnLSingle` (per held conId),
`reqAllOpenOrders` (15 s), `reqCompletedOrders(False)` (60 s), `reqExecutions` (30 s).
No order placement, change or cancel. No `reqOpenOrders` (client 0 semantics). The main account is the account
with the most positions, else the first managed account.

On disconnect or a fatal error (326, 502, 504, 1100, 1300) the service clears all account data, sets
`state=disconnected`, and reconnects after 10 s, doubling to 120 s. After 6 failed sessions in a row it exits
(code 75) so systemd runs the gateway resolver again.

Account codes never leave the process: allow-listed fields, and every output string is scrubbed.

## Account mode

The snapshot always has a definite account mode, also while the gateway is down:

- `accountMode` is `live` or `paper`. `modeSource` says where it comes from: `configured` (the trading mode
  of the gateway container, which `resolve-gateway.sh` writes to `/run/vertex-portfolio/mode` at each start) or
  `confirmed` (the managed account list of the current session agrees; without a configured mode it can be
  the list of the last session, see `modeConfirmedAt`). `modeConfirmedAt` is the last time an
  account list confirmed that mode.
- `stateSince` is the start of the current connection state (live since, or not live since).
- `modeError` names the two cases without a mode. `mismatch`: the configured mode and the account list
  disagree. The session ends before any account request and no account data is shown. With a configured
  mode the service waits for the account list first and requests nothing without it. The mismatch is stored
  too, so a restart keeps it until the configuration or the account list changes. `not-configured`: no
  configured mode and no confirmed mode yet. Fix: set `TRADING_MODE` on the ib-gateway container.

The last confirmed mode, its time and the outage start are kept in SQLite in the unit's `StateDirectory`
(`/var/lib/vertex-portfolio/account-mode.sqlite`), so a disconnect or a restart does not lose them. The file
holds mode words and times only, no account codes.

## Endpoints (bearer `VERTEX_STATUS_TOKEN`)

- `GET /vertex-portfolio/v1/snapshot` -> `vertex-portfolio-snapshot-v1`
- `GET /vertex-portfolio/v1/health` -> `vertex-portfolio-health-v1` (`state`, `connected`, `dataAsOf`)
- other paths 404, other methods 405, bad token 401.

## Test

    python3 infra/quant-vps/portfolio/test_vertex_portfolio.py

`fixtures/sample-snapshot.json` is the cross-language contract fixture. After a snapshot change, regenerate it with `json.dumps(populated_state(FakeClock()).snapshot(), indent=2) + "\n"` from the test module.

## Deploy

From the rig: `node ~/.local/state/vertex-vps-status/deploy-portfolio.mjs`
(set `VERTEX_INFRA_DIR` to another `infra/quant-vps` checkout if needed). It runs `install-portfolio.sh` as
root over SSH. The installer checks the protected containers and compose hashes before and after, installs
`/opt/vertex-portfolio`, the unit, writes `Caddyfile.tailnet` in place and reloads `vertex-status-tailnet`
through its admin socket.

## Rollback

The installer prints `rollback=/opt/vertex-portfolio/rollback-<ts>`. On the VPS:

    systemctl disable --now vertex-portfolio
    cat <rollback>/Caddyfile.tailnet.before > /opt/vertex-status/Caddyfile.tailnet
    docker exec vertex-status-tailnet caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock
