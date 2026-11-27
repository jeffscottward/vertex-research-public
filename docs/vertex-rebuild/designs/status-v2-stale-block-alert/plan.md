# Plan: Add Stale-Block Alerting to `vertex-status-v2-alert.service`

![Before and after: vertex-status-v2-alert.service adds a third independent stale-block state machine checking generatedAt and orders, fills, positions, and equity on QuantVPS /vertex-status/v2 with a 3-tick threshold, deduplicated alert, and recovery notice to #omp-alerts.](./before-after.svg)

| Field | Value |
| --- | --- |
| Card | `vertex-status-v2-stale-block-alert` |
| Found by | `vertex-open-orders-report-stale` (re-scoped to current setup on 2026-11-27, owner Discord message (private)) |
| Builds on | `docs/vertex-rebuild/designs/vertex-deploy-status-403-regression/plan.md` (PR `5f5d509d`), `docs/vertex-rebuild/designs/status-v2-orders-ibkr-monitor/plan.md` (PR #479), `docs/vertex-rebuild/designs/status-v2-positions-equity-ibkr-monitor/plan.md` (PR #481) |
| Target host | QuantVPS (`infra/quant-vps/status/`) |
| Trading / execution impact | Read-only monitoring probe only; zero order, arming, risk, exec-node, or container changes |

## Context and Re-Scoping to Current Setup

1. Originally, `status-v2` read `orders`, `fills`, `positions`, and `equity` from disk JSON reports under `/opt/vertex-exec-node/data/nautilus/reports/`. When `ibkr-open-orders.json` stopped updating for 13 days and `ibkr-fills.json` went stale for months, `vertex-status-v2-alert.service` stayed silent because it only checked HTTP 200, JSON validity, `schema == "vertex-deploy-status-v2"`, and the two auth-guard probes.
2. Under the current setup (`collect.py` 2.3.0 in PR #479/#480 and `collect.py` 2.4.0 in PR #481), all four broker blocks—`orders`, `fills`, `positions`, and `equity`—are populated 24/7 from a single read-only `GET /api/snapshot` against `ibkr-monitor.service` (IBKR client id 195). Every healthy block carries `available: true`, `stale: false`, `age_seconds`, and `as_of`; every degraded/failed block carries `available: false, reason` or `stale: true`.
3. A second silent failure mode exists when `vertex-status-collect.timer` stops rewriting `/opt/vertex-status/private-v2/status-v2.json`: Caddy continues returning HTTP 200 with a frozen payload whose recorded `stale` booleans stay `false` while `generatedAt` and every block's `as_of` fall further behind wall-clock UTC time.

## Acceptance Check

- `status_v2_alert.py` inspects the parsed authorized `status-v2` document for:
  1. Snapshot freshness (`generatedAt` present, valid ISO-8601 UTC, wall-clock age `<= --stale-max-age`, default `360` s).
  2. Broker-block freshness and availability for `--stale-blocks` (default `orders,fills,positions,equity`): fail-closed on missing/non-dict block, `available is not True`, `stale is not False`, missing/unparseable `as_of`, or wall-clock `now - as_of > --stale-max-age`.
- Runs an independent third incident state machine (`stale_*`) persisted atomically in `/var/lib/vertex-status-v2-alert/state.txt` (backward-compatible with existing pre-upgrade state files):
  - Fires ONE alert to `#omp-alerts` after `--stale-threshold` (default: inherits `--threshold`, i.e. 3 consecutive 2-minute ticks = ~6 min sustained staleness) and deduplicates while open.
  - Fires ONE recovery alert once all monitored blocks and `generatedAt` are fresh again, retrying on `#omp-alerts` POST failure before clearing `stale_alert_open`.
  - Pauses (`stale_verified=False`) whenever the authorized HTTP 200 / JSON / schema probe fails, so HTTP 403/500/transport outages neither raise spurious stale alerts nor falsely clear an open stale alert.
  - Never includes secrets, bearer tokens, account numbers, positions, order details, or balances in Discord messages, stdout JSON, or `state.txt`.
- Verified with Python 3.10-compatible timestamp parsing (handles trailing `Z` without Python 3.11 `fromisoformat` dependency), expanded `test_status_v2_alert.py`, `python-collect.test.ts`, repo hygiene checks, `bun run verify:prepush`, and fresh-context diff review.

## Scope

### In Scope

1. `infra/quant-vps/status/status_v2_alert.py`:
   - Add `_parse_iso_utc()` (Python 3.10+ compatible, timezone-aware UTC only), `_sanitize_reason()` (single-line, truncated, redacts probe token if echoed), and `inspect_stale_blocks()`.
   - Extend `CheckResult` (`stale_ok`, `stale_verified`, `stale_blocks`, `stale_detail`, `block_ages`) and `AlertState` (`stale_failures`, `stale_alert_open`, `stale_started_at`, `stale_reason`, `stale_blocks`).
   - Add third independent `stale_*` state machine inside `step_state()` (keeping `avail_*` and `bypass_*` behavior intact).
   - Add CLI flags `--stale-blocks` (default `orders,fills,positions,equity`), `--stale-max-age` (default `360` s = `REPORT_STALE_SECONDS` 300 s + 60 s collector/timer jitter margin), and `--stale-threshold` (default: inherits `--threshold`, 3).
   - Add `stale_alert_open`, `stale_blocks`, `stale_failures`, and `stale_verified` to the stdout JSON summary while keeping all existing keys unchanged.
2. `infra/quant-vps/status/vertex-status-v2-alert.service`:
   - Update comment and `Description=` to document stale-block alerting; keep `ExecStart` and all systemd hardening directives unchanged.
3. `infra/quant-vps/status/test_status_v2_alert.py`:
   - Update mock server default healthy `status-v2` payload to include fresh `generatedAt`, `orders`, `fills`, `positions`, and `equity`.
   - Add comprehensive unit tests covering: stale flag (`stale: true`), unavailable block (`available: false`), missing/malformed block, non-boolean `available`/`stale`, frozen `generatedAt`/clock-stale `as_of`, 3-tick threshold + deduplication + recovery, POST failure retry on stale alert and recovery, independence from `avail_*` (HTTP 403/transport error does not clear or open `stale_alert_open`), pre-upgrade `state.txt` compatibility, token redaction in block `reason`, `--stale-blocks` / `--stale-max-age` / `--stale-threshold` CLI validation, and Python 3.10 `Z` timestamp parsing.
4. `docs/vertex-rebuild/quantvps-status-endpoint.md`:
   - Update the `status_v2_alert.py` / `vertex-status-v2-alert.service` rows to describe stale-block alerting.

### Out of Scope

- Deploying to QuantVPS from this sandbox (deploy happens via `infra/quant-vps/status/deploy-status-v2-alert.sh` outside market hours after merge and after `collect.py` 2.4.0 is live).
- Modifying `collect.py`, `Caddyfile.tailnet`, `deploy-status-v2-alert.sh`, `ibkr-monitor.service`, or any trading/execution/arming unit.

## Verification Plan

- `python3 -B -I infra/quant-vps/status/test_status_v2_alert.py`
- `pnpm exec vitest run infra/quant-vps/status/python-collect.test.ts infra/quant-vps/host-config.test.ts scripts/ci/json-data.test.ts scripts/ci/public-names.test.ts`
- `bun run verify:prepush`
- Fresh-context code-diff review at the exact pushed head SHA before marking PR ready.

## Rollback

Restore the previous `/opt/vertex-status/status_v2_alert.py` and `/etc/systemd/system/vertex-status-v2-alert.service` from git (`git revert <merge-sha>`) and run `deploy-status-v2-alert.sh` outside market hours; `state.txt` ignores unknown keys so rollback requires no state migration.
