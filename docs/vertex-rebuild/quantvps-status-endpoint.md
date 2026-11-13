# QuantVPS read-only status endpoints

These endpoints let Vertex show the trading-stack state and a read-only session snapshot, with no write or trade path.

## Endpoints

| Endpoint | Audience | Document |
| --- | --- | --- |
| `https://quant-vps-host.example-tailnet.ts.net:8443/vertex-status/v1` | tailnet only, the rig and the VPS's own tailnet addresses, bearer token (checked by `vertex-status`) | `vertex-deploy-status-v1` only, also for `?schema=v2` and the v2 Accept header. The public `https://vertex.xyz/vertex-status/v1` route is retired (2026-11-05, owner decision "No use of vertex.XYZ at all"). |
| `https://quant-vps-host.example-tailnet.ts.net:8443/vertex-status/v2` | tailnet only, **rig only** (remote_ip allow-list), bearer token | `vertex-deploy-status-v2`: v1 fields plus session, positions, orders, fills, equity, risk, logs |
| `https://quant-vps-host.example-tailnet.ts.net:8443/vertex-history/v1/bars` | tailnet only, **rig only**, bearer token (checked by Caddy and again by the service) | `vertex-history-bars-v1`: IBKR historical bars (read-only service, IB client id 77) |
| `https://quant-vps-host.example-tailnet.ts.net:8443/vertex-ibkr-recovery/v1/*` | tailnet only, rig and the VPS's own tailnet addresses, **own** bearer token `VERTEX_RECOVERY_TOKEN` (checked by the service) | `vertex-ibkr-recovery-status-v1` / `-request-v1`: gateway login state and one human 2FA request (see below) |

The status, history and portfolio endpoints use the same token. The rig copy is `private/basic-app/.dev.vars` `VERTEX_DEPLOY_STATUS_TOKEN`. The recovery endpoint has its own token, because the shared token also opens the v1 route.

The tailnet URL is not secret. It is reachable only by tailnet members that use MagicDNS (the rig does), and not by Cloudflare-hosted runtimes.

## Timeline

| When | Event |
| --- | --- |
| 2026-09-30T00:20Z | v1 deployed. |
| 2026-10-03T11:30Z | Collector v2 deployed. v2 was briefly public through `?schema=v2` from 11:30:33Z to 11:35:39Z. |
| 2026-10-03T11:35:39Z | v2 public serving disabled. The user's condition for account data is token **plus** IP allow-list. |
| 2026-10-03T11:42Z | VPS joined the tailnet; the user approved the device. |
| 2026-10-03T11:49:55Z | v2 served on the tailnet interface, to the rig only. |
| 2026-11-05T17:41Z | Public vertex.xyz retired. v1 moved to the tailnet listener; `vertex-status` published on 127.0.0.1:8790; the web app's `VERTEX_DEPLOY_STATUS_URL` points to the tailnet URL. |

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
| `Caddyfile.route.snippet` | Retirement note for the former public main-Caddy route. |
| `SCHEMA.md` | v2 contract. |

Rig-side deployers live in `~/.local/state/vertex-vps-status/`: `deploy-tailnet.mjs`, `deploy-v2.mjs`, and `vps.mjs` (read-only shell). The SSH password is read in-process from `vertex-quant/.env` and never printed.

## What runs on QuantVPS

| Item | Location | Notes |
| --- | --- | --- |
| Collector | `/opt/vertex-status/collect.py` + `vertex-status-collect.{service,timer}` (30 s, oneshot, `Nice=10`, `TimeoutStartSec=25`) | Writes the public `public/status.json` (v1). Writes v2 **only** to `/opt/vertex-status/private-v2/status-v2.json` (0700); it refuses the public dir and deletes any v2 file found there. Read-only inputs (see below). Never starts or stops containers, never calls portfolio-ui, never opens an IBKR client, never touches kill-switch files. |
| v1 status server | container `vertex-status` (caddy:2-alpine; network `ibkr-nautilus-exec-node_prototype`; published on `127.0.0.1:8790` only; read-only; caps dropped except NET_BIND_SERVICE; 64 MB) | Mounts only `/opt/vertex-status/public`. Bearer token required, otherwise 401. |
| Public route | none (retired 2026-11-05) | The main Caddy serves no public site. v1 is served by `vertex-status-tailnet` (`@status_v1_caller`). |
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

Sources: `infra/quant-vps/history/` (`vertex_history.py` 1.4.0, `test_vertex_history.py` 138 tests incl. a static scan that fails on any order, account or position API name and an AST allow-list of IB client calls, `vertex-history.service`, `resolve-gateway.sh`, `install-history.sh`). Rig deployer: `~/.local/state/vertex-vps-status/deploy-history.mjs`.

| Item | Value |
| --- | --- |
| Unit | `vertex-history.service` (systemd, `DynamicUser`, `ProtectSystem=strict`, no capabilities, `IPAddressAllow=127.0.0.0/8 172.16.0.0/12`, 256 MB, `Restart=on-failure`) |
| Runtime | `/opt/vertex-history/venv` (`python3 -m venv --without-pip`, Python 3.10.12) with `ibapi 9.81.1.post1` from the PyPI sdist (sha256 `49f6678b…`); the installed tree hashes identically to the watchdog's ibapi (`e5fb55e3…`) |
| Listener | `127.0.0.1:8791` only; Caddy route `/vertex-history/v1/*` in `Caddyfile.tailnet` |
| IB session | client id 77 to the ib-gateway bridge IP, port 4003 (resolved at start by `resolve-gateway.sh` via `docker inspect`). Calls: connect, disconnect, reqContractDetails, reqHistoricalData, cancelHistoricalData, reqHistoricalTicks, reqMktDepth, cancelMktDepth, reqNewsProviders, reqHistoricalNews (all read-only). Service 1.4.0 adds reqSecDefOptParams, reqMktData (one-shot snapshot only) and cancelMktData for `/option-chain`, also read-only and unused while the switch is off |
| Requests | `GET /vertex-history/v1/bars?symbol=&secType=STK\|FUT\|CONTFUT\|CASH\|IND&exchange=&currency=&barSize=&duration=&whatToShow=TRADES\|MIDPOINT\|BID_ASK\|ADJUSTED_LAST&useRTH=1&contractMonth=&endDateTime=`; `GET /vertex-history/v1/health` |
| `endDateTime` (bars, optional, service 1.2.0+) | `YYYYMMDD-HH:MM:SS` in UTC (IBKR's form), passed to `reqHistoricalData` as the end of the range; `duration` counts back from it. Absent = now (IBKR's empty end), and the request, its cache key and its echo are unchanged. Present: exactly that form (ASCII digits, a real calendar date and time), not before `19900101-00:00:00`, strictly before the service clock, otherwise 400 `bad_request`; refused with 400 for `secType=CONTFUT` (IBKR rejects an end date there; use `FUT` with `contractMonth`). Echoed as `request.endDateTime`; part of the cache key. Not accepted by `/ticks` or `/depth` |
| `whatToShow=BID_ASK` (bars, service 1.2.0+) | `secType=STK` only (400 for FUT, CONTFUT and CASH; CASH stays MIDPOINT). IBKR semantics: open = time-average bid, high = max ask, low = min bid, close = time-average ask, volume n/a (`v: null`). Same bounds, pacing and cache as TRADES |
| `whatToShow=ADJUSTED_LAST` (bars, service 1.3.0+) | `secType=STK`, `barSize=1 day`, no `endDateTime` (IBKR refuses an end date for it); split- and dividend-adjusted daily bars. Replaces Yahoo's adjusted close (card vertex-yahoo-terms-decision) |
| `secType=IND` (bars, service 1.3.0+) | indices, `exchange` required (for example `VIX` on `CBOE`), `whatToShow=TRADES` only; refused for ticks and depth. Needs the account's index data line; IBKR answers an entitlement error otherwise |
| `GET /vertex-history/v1/news` (service 1.3.0+) | `symbol` (STK only), `count` 1 to 50 (default 20): newest headlines from every API news provider the account has (`reqNewsProviders`, cached 24 h; `reqHistoricalNews`), metadata prefix `{...}` stripped, account numbers masked. One request at a time, ≥ 3 s apart, cached 300 s, stale copy up to 1 h when IBKR is unavailable. Schema `vertex-history-news-v1` (camelCase like ticks/depth). `t`/`time` read IBKR's zone-less news time as UTC (IBKR: "UTC assumed"); to be confirmed against one live headline after deploy. Code 10276 (news feed not allowed) = `entitlement` |
| `GET /vertex-history/v1/option-chain` (service 1.4.0+, off by default, not deployed) | `symbol` (stock underlying; always STK on SMART in USD, no `secType`), `expiry` optional `YYYYMMDD` (omitted = first listed expiration whose 16:00 America/New_York close is still ahead), `strikes` 1 to 12 (default 8): bid, ask and last of the call and the put at the listed strikes nearest the underlying price. Works only with `VERTEX_HISTORY_OPTION_QUOTES=1`, otherwise 403 `disabled` and no IB call. One request at a time, starts ≥ 5 s apart, 14 s budget, cached 30 s, stale copy up to 300 s when IBKR is unavailable. Schema `vertex-history-option-chain-v1` (camelCase like news). Details in "Option chain quotes" below |
| Bounds | bar sizes 1 min, 5/15/30 mins, 1 hour, 1 day; duration ≤ 30 Y daily (service 1.3.0+; above 365 days in `Y` units only, IBKR's rule), ≤ 1 M intraday, ≤ 2 D for 1 min |
| Pacing | historical requests ≥ 10 s apart, ≤ 6 per 120 s, identical ≤ 1 per 15 s, 10 min back-off after an IBKR pacing violation; a request waits at most 20 s, otherwise 429 with `retry_after_seconds` |
| Cache | `/var/cache/private/vertex-history`, TTL 3600 s daily, 300 s intraday, 120 s for 1 min; with `endDateTime`, a copy fetched at least 24 h after that end is served for up to 24 h (`cache.ttl_seconds` = min(86400, now − end − 86400), never below the normal TTL); stale copies up to 24 h served (`cache.stale=true`) while paced or the gateway is down |
| Volume | as reported by IBKR to this API version (ibapi 9.81: US stocks in lots of 100 shares). `marketData.bars` (/charts) passes it through unchanged; the server-side client `packages/api/src/server/ibkr-history.ts` (Yahoo-merge call sites) multiplies STK/USD volume by 100 (`STK_VOLUME_LOT`). `test_vertex_history.py` pins ibapi 9.81 so an upgrade (10.x reports shares) changes both |

Note: `secType=CASH` (forex on IDEALPRO, MIDPOINT only) is staged in `infra/quant-vps/history` only; it is not yet deployed to the live service, and the web/API side (`MARKET_SEC_TYPES`, the charts picker, MCP `market_bars`) does not expose it.

### Option chain quotes: `GET /vertex-history/v1/option-chain` (service 1.4.0, 2026-11-13)

Status: in the repository only. It is NOT deployed and NOT enabled until the owner says so (card `vertex-options-chain-ibkr`). Two owner steps are needed: deploy service 1.4.0, then set the switch. The account also needs OPRA top-of-book market data for API use; without it, when IB refuses every option row, the request answers 502 `not_subscribed` and the service asks IB at most once per 15 minutes (see "Account without option market data" below).

Switch: the endpoint works only when the service environment has `VERTEX_HISTORY_OPTION_QUOTES` set to exactly `1` (read once at start, so a change needs a restart; a systemd drop-in with `Environment=VERTEX_HISTORY_OPTION_QUOTES=1` does it). Reason: market data snapshots use the market data lines of the IB gateway that the live engine shares. While it is off the answer is 403 `{"error":"disabled","message":...}` before validation and without any IB call. `/health` reports the state as `optionQuotes: true|false`.

Time zone data: the expiry rule needs the `America/New_York` zone, so the host must have tz data (the `tzdata` package of the system, or the Python `tzdata` package). The service resolves the zone once at start. If that fails it forces the switch off and logs one line, `option_quotes_forced_off` with `reason=tz_data_missing`; `/health` then reports `optionQuotes: false` and every request gets the 403 above.

Parameters:

| Parameter | Value |
| --- | --- |
| `symbol` | required; stock symbol rule of the other endpoints. The underlying is always STK on SMART in USD |
| `expiry` | optional; exactly 8 digits `YYYYMMDD` and a real date. Given: must be a listed expiration whose 16:00 America/New_York close is after the service clock, else 404 `expiry_not_listed` (an expiry that has closed is refused before any IB call). Omitted: the first listed expiration whose close is after the service clock |
| `strikes` | optional; integer 1 to 12, default 8. That many listed strikes nearest the underlying price (ties: the lower strike first) get one call and one put quote |

Any other parameter (including `secType`, `exchange`, `currency`) or a repeated one is 400 `bad_request`.

Known limit of the expiry rule: the close is always taken as 16:00 America/New_York. Early-close days (13:00) and options that trade until 16:15 are not handled: on an early-close day an expiry still counts for three hours after its real close, and from 16:00 a given expiry is refused with no IB call also for a class that still trades.

Response (HTTP 200; the usual `cache` envelope `{hit, ageSeconds, ttlSeconds, stale}` is added as for news):

```json
{
  "schema": "vertex-history-option-chain-v1",
  "source": "ibkr-gateway",
  "client_id": 77,
  "request": {"symbol": "SPY", "expiry": "20261120", "strikes": 8},
  "expirations": ["20261116", "20261120"],
  "expiry": "20261120",
  "tradingClass": "SPY",
  "multiplier": "100",
  "underlying": {"bid": 600.1, "ask": 600.14, "last": 600.12, "close": 598.0, "price": 600.12, "dataType": "live"},
  "quotes": [
    {"strike": 600.0, "right": "C", "bid": 4.1, "ask": 4.15, "last": 4.12, "dataType": "live", "error": null},
    {"strike": 600.0, "right": "P", "bid": null, "ask": null, "last": null, "dataType": "live", "error": "timeout"}
  ],
  "count": 2,
  "fetchedAt": "2026-11-13T15:00:00Z"
}
```

- `request.expiry` is `null` when the caller gave none; `expiry` is the one used.
- `expirations`: every listed expiration of the chosen SMART row, ascending. The row is the SMART one whose trading class equals the symbol (for a class share such as `BRK B` also the class without the space, `BRKB`). No SMART row, or no SMART row of that class, is 404 `no_option_chain`: the service never uses another class, because it may be an adjusted chain. The list is cached 24 h, so an expiration that has closed can stay in it for up to a day; it is never chosen.
- `quotes`: ascending by strike, call before put. `count` is their number.
- `dataType`: what IB reported for that request (`marketDataType`): `live`, `frozen`, `delayed`, `delayed-frozen` or `null`. When `marketDataType` did not arrive for the request (a request can be done before it comes): `delayed` if any of its prices came from a delayed tick type (66, 67, 68, 75), else `null`. Prices from the live tick types alone are not reported as `live`; read `null` as "not known to be live". The service never calls `reqMarketDataType`.
- A price is published only when it is finite, not negative and below 1e9 (`OPTION_PRICE_MAX`); a tick with any other value (-1, NaN, the `DBL_MAX` sentinel) is ignored. It never replaces a price that the field already has, so a request that is done stays done. A field without a valid tick is `null`. The latest valid tick of a field wins. ibapi 9.81 decodes an empty price field as 0, so that case is published as `0.0`. Delayed ticks (66, 67, 68, 75) fill the same fields as live ones (1 bid, 2 ask, 4 last, 9 close).
- `underlying.price` is last if above 0, else the bid/ask midpoint (both above 0), else close. In a 200 body it is always a number: without one the request fails with 502 or 504 (table below). The other `underlying` fields are what had arrived when the underlying snapshot was done and can be `null`.
- When a request is done. The service does not wait for `tickSnapshotEnd`, which IB can hold for about 11 s. A request of a wave is done at the first of:
  - `tickSnapshotEnd`;
  - an error that IB addressed to that request;
  - for an option: a bid that is not `null` (0 is a real bid) and an ask above 0;
  - for the underlying: a last above 0, or a bid and an ask above 0. A close alone does not end the wait. The underlying waits at most 4 s (`OPTION_UNDERLYING_SECONDS`); then the price rule takes what is there, the close included, and the option wave is sent.
- The wave ends when every request is done, or when its window ends. Ticks that arrive until that moment are kept, so `last` is in a row when it came with the first burst and `null` when it did not.
- `error` per quote, one of:
  - `null`: a good row. It has a bid and an ask (rule above), or IB ended the snapshot with `tickSnapshotEnd` and no error. In the second case a price that IB did not send is `null`.
  - `no_security_definition`: IB code 200, that strike is not listed for the expiry.
  - `not_subscribed`: only the market data subscription codes 354, 10089, 10090, 10091, 10167, 10168.
  - `timeout`: at the end of the window the row had no bid and ask, no `tickSnapshotEnd` and no error. The window is 12 s, or what is left of the 14 s request budget when that is less. The service decides this once, at the moment it stops listening to the wave; what IB sends later changes nothing.
  - `ib_error`: every other error for that request, for example 10197 (competing live session), 10092, 10186 or a permission message.
- Codes 10090, 10091 and 10167 are warnings: IB can still send prices after them. The service records the warning and keeps waiting. A row that gets a bid and an ask after the warning (bid not `null`, ask above 0) is a good row with `error: null`. A warning row without them at the end of the window, or at `tickSnapshotEnd`, is `not_subscribed`.
- A row whose `error` is not `null` has `bid`, `ask` and `last` `null`, also when some ticks arrived before the error or the end of the window; `dataType` is what IB reported for it, or `null`.
- The strikes come from the list IB gives for the whole trading class, which is the union over all expirations. Some of the nearest strikes may not exist for the chosen expiry: those rows answer `no_security_definition`, so there can be fewer usable quotes than `strikes` asked for, and each such row still costs one snapshot request.
- One failed contract never fails the response. The one exception is the rule below for an account without option market data.

Account without option market data: when every option row of a wave is `not_subscribed`, the service remembers this for 900 s (`OPTION_NOT_SUBSCRIBED_SECONDS`), in memory, for the whole process and for every symbol. One `not_subscribed` row among other rows (good rows, `no_security_definition`, `timeout`, `ib_error`) does not set the memo. That request and the later requests in the next 900 s answer 502 `{"error":"not_subscribed","message":...,"retry_after_seconds":N}` (N is the rest of the 900 s). Order of the checks: switch, validation, a fresh cached answer (it is still served while the memo is fresh), then the memo, then the lock. So while the memo is fresh a request without a fresh cached answer gets the 502 with no IB call, no connect and no wait for the lock; a stale copy is not served in its place. The refusal itself is not cached. The service logs one line, `option_chain_not_subscribed`, when it sets the memo. After 900 s the next request asks IB again. So an account without OPRA costs at most one wave per 15 minutes. After the owner adds the subscription, wait up to 15 minutes or restart the service.

Other answers:

| Status | Body `error` | When |
| --- | --- | --- |
| 400 | `bad_request` | invalid, unknown or repeated parameter |
| 403 | `disabled` | the switch is off (also for an invalid request) |
| 404 | `no_option_chain`, `expiry_not_listed` | unknown symbol, no SMART option chain of the symbol's trading class, expiry not listed or already closed, or no listed expiry still open. A service older than 1.4.0 answers 404 `not_found` |
| 422 | `no_contract` | IB knows the stock but answers code 200 (no security definition) to the option chain request or to the underlying snapshot |
| 429 | `busy`, `pacing_violation` | `busy`: another option chain request held the lock for the whole wait (2 s), or the 5 s spacing would leave less than the 3 s minimum window of the budget (not possible with the present numbers). `pacing_violation`: IBKR reported pacing. Both carry `retry_after_seconds` (5, or the rest of the spacing). There is no `paced` answer on this endpoint |
| 500 | `internal` | an unexpected failure inside the service; the body carries no detail |
| 502 | `ibkr_error`, `entitlement` | the underlying snapshot ended without a usable price, or IB refused the underlying or the chain definition. An underlying that got only a warning code (10090, 10091, 10167) and no price answers 502 `entitlement`, also when its window ran out |
| 502 | `not_subscribed` | the account has no option market data (rule above); with `retry_after_seconds` up to 900 |
| 503, 504 | `unavailable`, `timeout` | 503: gateway down or lost during the request. 504: the underlying snapshot got no price at all (not even a close), no warning and no answer in its 4 s window; or the 14 s budget ended; or less than 3 s of it were left when a wave had to start (no snapshot of that wave is sent). A stale copy (up to 300 s) is served instead when there is one |

IB calls per request, all read-only: `reqContractDetails` (cached 24 h), `reqSecDefOptParams` (cached 24 h), then `reqMktData` once for the underlying and once per call and put in one wave. When a wave ends the service first stops listening to its request ids and only then sends `cancelMktData`, and only for the sent requests that are still open at IB: no `tickSnapshotEnd` and no error that IB addressed to that request. In the usual case that is every request of the wave: a request that is done on its prices is still open at IB, and the cancel closes its market data line at once. It also covers a request that got only a warning code, a request without prices when the window ends, the requests left by a failure in the middle of a wave, and the open requests after a gateway loss that IB reported for all requests. A request that IB ended with `tickSnapshotEnd` or with its own error (200, 354 and so on) gets no cancel. If IB answers a cancel with code 300, the message is logged and changes no row, because the service no longer listens to that id.

Load on the shared gateway, which is what the live engine cares about:

- Requests: at most 25 snapshot requests per endpoint call (1 underlying, then up to 24 options).
- Lines: at most 24 market data lines open at one time. A line is normally open only for the first burst of ticks: until the bid and the ask of that request have arrived and its wave has ended, then it is cancelled. It is open for the whole window only when prices do not come: 4 s at most for the underlying, 12 s at most for an option, and never past the 14 s budget. First the underlying alone (1 line), then, after it is closed, the option wave (up to 24 lines). One wave at a time.
- Messages: at most 52 per call: 2 lookups, 25 `reqMktData` and at most 25 `cancelMktData`. A usual call with `strikes=12` sends all of them; with the default `strikes=8` it is 2 + 17 + 17. A wave that IB refuses at once (354 on every option, the likely answer without OPRA) is 25 requests and, in the usual case, 1 cancel: the underlying is done on its prices and is cancelled; the refused options get none.
- Message rate: `reqMktData` and `cancelMktData` go through one limiter, at most 40 in any one second (`OPTION_MESSAGES_PER_SECOND`), counted over all calls. The two lookups are not counted, so this endpoint sends at most 42 messages in a second. IB documents a limit of 50 messages per second per client; these messages count for client 77, not for the client of the engine. Up to `strikes=9` a call that runs alone stays under 40 and does not wait; the limiter also counts the cancels of the call before it, so a call that follows another at once can wait. With `strikes=12` the 50 messages can fall in one second; then the last 10 cancels wait until one second after the first message, so up to 10 lines stay open about 1 s longer. One wait of the limiter is 1 s at most. It is not cut to the rest of the budget, but the time it takes is gone from the budget of the request.
- Account without OPRA: at most one wave per 15 minutes (rule above). If IB refuses at once, the lines close at once. If IB sends only warning codes and nothing after them, that one wave holds up to 24 lines for the whole window.

Budget: one request has 14 s (`OPTION_DEADLINE`), because the consumer waits 15 s. All waits share it: the wait for the lock (2 s at most, then 429 `busy`), the 5 s spacing, the two lookups, a wait of the message limiter, and both waves. The lock wait, the lookups and the wave windows are cut to what is left, so the option wave gets 12 s or the rest of the budget, whichever is less. A wait of the limiter is 1 s at most and is not cut. The spacing is measured from the start of the fetch before. A wave is not started with less than 3 s of budget left (`OPTION_MIN_WINDOW`): the answer is then 504 and no snapshot of that wave is sent. This holds for the underlying and for the option wave. The wave maximum stays at 12 s and is not lowered to 10 s: IB ends a snapshot without a market by itself after about 11 s, and a window of 10 s would turn such a row into `timeout` even when the budget has room. A usual call is much shorter than the budget, because each wave ends when its prices are in. The underlying waits 4 s at most (`OPTION_UNDERLYING_SECONDS`). Worst case: 2 s for the lock, 5 s of spacing and 4 s for the underlying leave 3 s, the minimum window, for the option wave when the two lookups are cached; uncached lookups that take time can then lead to 504. Known limit: a reconnect to the gateway (TCP connect, then up to 10 s for the handshake, code shared with the other endpoints) is not cut to the budget. When the connection is down, a call can therefore take longer than 14 s; it then answers 503 or 504 and sends no market data request.

Caps and safety rules, and what `test_vertex_history.py` pins for each:

- `reqMktData` is always sent as `(reqId, contract, "", True, False, [])`: a one-shot snapshot, never a streaming subscription, never a regulatory snapshot (those cost money per request), no generic ticks. Pinned by a static test on the source: exactly one call, with these literal arguments, inside `_snapshots`; any other `.reqMktData` attribute (an alias, for example), any `getattr` with a computed name, and the text `reqMktData` in any string value outside the `IB_CALLS` allow-list fail it. Docstrings are not counted. The test reads the source of this one file; it cannot see code that builds the name in another way at run time.
- At most 2 × 12 + 1 = 25 snapshot requests per endpoint call. There is no single runtime counter: `_snapshots` refuses a wave of more than 24, the gateway cuts `strikes` to 12, and `fetch_option_chain` calls `_snapshots` twice (underlying, then options). Pinned by tests that count the requests the fake IB client receives (25 for `strikes=12`, and 25 for a request that skipped validation), and by the static test that only `fetch_option_chain` may call `_snapshots`.
- One option chain fetch at a time, at least 5 s between the starts of two fetches (a fetch that ran longer than 5 s is followed at once), results cached 30 s, so at most 25 snapshot requests per 5 s. Tests pin the numbers (14 s budget, 2 s lock wait, 5 s spacing, 4 s underlying window, 12 s wave maximum, 3 s minimum window), the spacing, the cache, the `busy` answer while the test holds the lock and when the spacing does not fit, that the lock wait, the lookups and the wave windows are cut to the rest of the budget, that an underlying with only a close answers after its 4 s window and the option wave is still sent in the worst case (2 s lock, 5 s spacing), that no wave is sent with less than 3 s left, and that the lock is free again after a failure in the middle of a wave. No test runs two real concurrent requests.
- No IB call while the switch is off: pinned by tests that count the calls of the fake client (zero, and no connect), also for the forced-off case without tz data.
- When a request is done: tests pin that the tick which brings the bid and the ask (or the last of the underlying) ends the wait, with the fake client and with ticks from a second thread, that such a row is a good row and is cancelled, and that a row with only a bid at the end of the window is `timeout`.
- Cancels: tests with the fake client pin which requests get `cancelMktData` (done on prices, warning only, still open at the end of the window, after an exception between two sends, after a gateway loss) and which do not (ended by `tickSnapshotEnd` or by an error for that request), and the message counts above (28 for a refused wave with the cancel of the underlying, 52 at most). A test with a limiter that fails pins that every open request still gets its cancel. A test with a fake cancel that answers code 300 and late ticks at once pins that such answers change no row.
- Message rate: a test with `strikes=12`, where every request is done on its prices, pins that no window of one second holds more than 40 `reqMktData` and `cancelMktData` sends (40 at once, 10 one second later), also over two calls in a row, and that the wait of the limiter shortens the wave window. Other tests pin that one wait sleeps 1 s at most and that a clock that goes back starts a new window. The limiter runs on a fake clock in the tests; the real one uses `time.monotonic` and `time.sleep`.
- Account without option market data: tests pin that the memo is set only when every option row is `not_subscribed`, that a fresh cached answer is still served, that no IB call follows for 900 s, and that IB is asked again after that.
- The IB call allow-list grew by exactly `reqSecDefOptParams`, `reqMktData`, `cancelMktData` (pinned). The scan for order, account and position API names is unchanged.
- Log lines (`ib_option_chain`, `option_chain`, `option_chain_not_subscribed`) carry symbol, expiry, counts and error labels only; IB messages in error bodies have account numbers masked.

Not yet verified against the live gateway (no deploy in this change; every test runs against a fake IB client, and one test checks the callback signatures against ibapi 9.81.1):

- the real `securityDefinitionOptionParameter` rows for a symbol with several trading classes;
- which of 354, 10090, 10091 or 10167 the account gets without OPRA, whether prices follow the warning codes, and whether `tickSnapshotEnd` follows a warning code;
- whether IB really closes a snapshot after every error it addresses to that request. The service sends no cancel then; a snapshot that IB still holds ends by itself about 11 s after its start;
- whether IB answers a cancel with code 300;
- whether the underlying gets a last, or a bid and an ask, outside trading hours. If IB sends only a close, the request answers after the 4 s window with the close as price;
- whether `marketDataType` always arrives before the first tick of a request. If not, a row can be done with `dataType` `null` (live tick types) or `delayed` (delayed tick types);
- whether an account with OPRA gets 10090 on single rows, for example on a strike without a market. Such rows are `not_subscribed`; they set the memo only when every row of the wave is `not_subscribed`;
- how fast the bid and the ask of an option arrive after the request, and whether both always come for a quoted option. A row whose bid or ask does not come in the window is `timeout` with null prices;
- whether a `cancelMktData` for a snapshot that is still open really frees its market data line at once.

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
