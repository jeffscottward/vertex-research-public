# `vertex-deploy-status-v2`

> **Status (2026-10-03T11:49:55Z): served ONLY over the tailnet, ONLY to the rig.** v2 contains account blocks. The user's condition is bearer token **plus** a source-IP allow-list. That condition is now met on the VPS tailnet interface.
>
> - The v1 endpoint (tailnet `/vertex-status/v1`; the public `vertex.xyz` route is retired since 2026-11-05) serves v1 only, including for `?schema=v2` and the v2 Accept header.
> - v2 was briefly public from 11:30:33Z to 11:35:39Z, before the tailnet path existed.

Read-only QuantVPS session snapshot. `collect.py` writes it every 30 s to the **non-public** `/opt/vertex-status/private-v2/status-v2.json`. This requires the unit to set `VERTEX_STATUS_V2=1` and `VERTEX_STATUS_V2_DIR=/opt/vertex-status/private-v2`. The collector refuses to write v2 into `/opt/vertex-status/public`, and deletes any `status-v2.json` it finds there.

## How to fetch

`GET https://quant-vps-host.example-tailnet.ts.net:8443/vertex-status/v2` with `Authorization: Bearer <VERTEX_DEPLOY_STATUS_TOKEN>` (the same token as v1).

| Caller | Result |
| --- | --- |
| rig (100.64.0.20 / fd7a:115c:a1e0::20), valid token | `200` v2 |
| rig, no token or wrong token | `401` |
| rig, valid token, any other path | `404` |
| any other source (other tailnet nodes, the VPS itself) | `403` |
| public internet | no listener (port 8443 is bound to tailnet addresses only) |

- The listener is container `vertex-status-tailnet` (`Caddyfile.tailnet`), bound to 100.64.0.10 and fd7a:115c:a1e0::10 on port 8443.
- TLS uses the Let's Encrypt certificate for the MagicDNS name, obtained through tailscaled.
- Callers must be tailnet members using MagicDNS. Cloudflare-hosted runtimes cannot reach this endpoint.
- The v1 URL `https://quant-vps-host.example-tailnet.ts.net:8443/vertex-status/v1` serves the unchanged v1 document, for every selector. The public `vertex.xyz` route is retired (2026-11-05).
- Responses send `Cache-Control: no-store`.

## Size and safety guarantees

- Normally about 10 KiB. The collector trims lists until the document fits in 60 KiB (`collector.soft_max_bytes`), so it stays under the app's 64 KiB read cap. Over 256 KiB (`hard_max_bytes`), it drops whole blocks and marks them unavailable.
- Account identifiers appear only as `****` plus the last 4 characters. Order and execution IDs use the same mask when they have more than 4 characters.
- Log text is limited to WARNING/ERROR, deduplicated and capped at 50 entries. Each message is at most 240 characters. Scrubbing removes token, key, password, Bearer/Basic, URL-credential, email, account-number and opaque-token patterns.
- Final guard: if the serialized document matches any account, Bearer or password pattern, or contains the endpoint token, every v2 block is replaced with `{available:false, reason:"withheld: …"}`.
- Container environment is read only for an allow-list of non-secret risk/config keys (`RISK_ENV_KEYS` in `collect.py`).

## Top level

| Field | Type | Notes |
| --- | --- | --- |
| `schema` | `"vertex-deploy-status-v2"` | |
| `host`, `generatedAt`, `readOnly`, `services` | | Identical to v1, value for value. |
| `session`, `positions`, `orders`, `fills`, `equity`, `risk`, `logs` | block | See below. |
| `collector` | `{version, duration_ms, soft_max_bytes, hard_max_bytes}` | |

## Block contract

Every block has one of two shapes:

- available: `{available: true, source: string, as_of: ISO-8601 Z | null, ...}`
- unavailable: `{available: false, source: string, reason: string}`

Blocks sourced from report files also carry `age_seconds` (int) and `stale` (bool; true when older than 300 s or when `as_of` is unknown). `as_of` is the producer's own timestamp (`generated_at`), not the collector time. List blocks have `count`, `items`, and `truncated`.

### `session`

| Field | Notes |
| --- | --- |
| `state` | `starting \| running \| paused \| degraded \| halted \| stopping \| stopped \| error \| unknown` |
| `raw_state` | `{container_status, container_health, container_exit_code, health_file_status, last_runner_event, last_runner_event_at, heartbeat_age_seconds}` |
| `trading_mode`, `safe_mode` | from `data/nautilus/health.json` (last written by the runner) |
| `strategies[]` | `{id, name, started_at, symbols[], observation_only, trading_mode}`: latest `strategy_started` per strategy since the runner start (Postgres `strategy_events`; falls back to the runner log) |
| `symbols[]` | union of strategy watchlists |
| `account_masked` | `****NNNN` |
| `started_at`, `stopped_at`, `last_heartbeat_at` | ISO Z. `stopped_at` is set only when the state is stopped, error or stopping. The heartbeat is the latest of health.json, the Redis `vertex_quant:nautilus:heartbeat:state` hash and runner-log `strategy_heartbeat` events. |
| `ibkr_adapter` | `{ok, detail, checked_at}` from health.json |

State mapping (nautilus-trader container plus runner signals):

| Container | Condition | `state` |
| --- | --- | --- |
| missing | | `unknown` |
| running | kill switch engaged | `halted` |
| running | container health `starting` | `starting` |
| running | last runner event `runner_stopping`/`runner_stopped` | `stopping` |
| running | health.json `status=ok` and heartbeat ≤ 120 s old | `running` |
| running | otherwise | `degraded` |
| restarting | | `starting` |
| paused | | `paused` |
| removing | | `stopping` |
| dead, or OOM-killed | | `error` |
| exited | exit code ≠ 0 | `error` |
| exited (code 0) or created | | `stopped` |

### `positions`

Items: `{symbol, sec_type, qty, avg_px, avg_cost, multiplier|null, market_price, market_value, unrealized_pnl, realized_pnl, currency}`. Options also carry `right`, `strike` and `expiry`. `avg_px` = `avg_cost / multiplier`. Source: the newest `data/nautilus/reports/ibkr-account-snapshot-*.json`, written by the portfolio-ui snapshot refresh. The collector reads the file and never calls IBKR.

### `orders`

Items: `{order_id_masked, client_id, symbol, sec_type, side (buy|sell), type, qty, filled, remaining, price (limit), stop, aux_price, tif, status, currency, warning?}`. `stop` holds the IB aux price for `STP`, `STP LMT`, `TRAIL`, `TRAIL LIMIT` and `STP PRT`; for every other type the value goes in `aux_price`. Source: `data/nautilus/reports/ibkr-open-orders.json`, read from disk without a portfolio-ui call or refresh.

### `fills`

Last 50, newest first: `{time, symbol, side (buy|sell), qty, price, order_id_masked, exec_id_masked}`. Source: `data/nautilus/reports/ibkr-fills.json` (written by `/opt/vertex-exec-node/scripts/ibkr_fill_check.py`, a QuantVPS host script outside this repository). Postgres `execution_events` is empty on this host.

### `equity`

`{currency: "USD", net_liq, cash, available_funds, buying_power, unrealized, realized}`. `unrealized` and `realized` are sums over the snapshot positions. Source: the summary in the same account-snapshot file.

### `risk`

| Field | Notes |
| --- | --- |
| `kill_switch` | `engaged` if any kill-switch file exists or watchdog `live_flags.kill_switch_active` is true. `clear` if every file is confirmed absent. `unknown` otherwise. |
| `kill_switch_indicators[]` | `{source, engaged (bool\|null), as_of}`: files `data/KILL_SWITCH` and `portfolio-ui/data/KILL_SWITCH` (stat only), the watchdog flag, and the health.json flag. |
| `limits` | block: allow-listed nautilus-trader env as lower-case keys, typed. Examples: `nautilus_risk_max_order_quantity`, `nautilus_risk_max_position_notional_usd`, `nautilus_risk_max_daily_loss_usd`, `nautilus_risk_allowed_instruments[]`, `risk_denied_instruments[]`, `nautilus_risk_orders_enabled`, `nautilus_risk_dry_run`, `trading_mode`, `enable_live_trading`, `synthetic_*`. |
| `last_risk_check` | most recent Postgres `risk_events` row: `{time, event, allowed, dry_run, reason, strategy, requested_symbol, max_*}` or `null`. |
| `watchdog` | `{as_of, status, safe_mode, orders_enabled, nautilus_orders_enabled, required_failures[], kill_switch_created_at, kill_switch_reason, live_flags{}, checks{name: {ok, required, consecutive_failures, detail, checked_at}}}`, from the last `watchdog_status` line of `watchdog.log`. `live_flags` carries only `trading_mode`, `enable_live_trading`, `live_risk_acknowledged`, `nautilus_risk_orders_enabled`, `nautilus_risk_dry_run` and `kill_switch_active`; other flags are dropped. |

### `logs`

Up to 50 items, newest first: `{time, level: WARNING|ERROR, source, message, count}`. `count` is the number of occurrences in the scanned window; messages that differ only in numbers or PIDs are merged.

| Source | Inclusion rule |
| --- | --- |
| watchdog | every failing check in `watchdog.log` (ERROR if required, otherwise WARNING) |
| nautilus-trader | `prototype-runner.log` events whose level, or whose event name if no level is present, signals an error or warning |
| ib-gateway, portfolio-ui, nautilus-trader (when running) | `docker logs --tail 300` lines matching error or warning patterns |

## Compatibility

v1 is unchanged and remains the only public document. To adopt v2, the app adds a separate setting for the tailnet URL and parses v2 as a superset of v1. The app's fetcher already requires `https:`, which the tailnet URL satisfies.
