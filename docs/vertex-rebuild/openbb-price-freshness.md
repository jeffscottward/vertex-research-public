# OpenBB Stored Price Freshness Alert

Design: [docs/vertex-rebuild/designs/price-freshness-alert/plan.md](designs/price-freshness-alert/plan.md).
Research data alerting only: this subsystem never places orders, changes arming, or modifies risk limits.

## Monitored Series and Thresholds

The freshness watch evaluates 45 stored series on every check:

- 31 daily series in `market_daily_series`: 14 Cboe volatility indices (`OPENBB_VOL_INDEX_IDS`, refreshed by `cboe-vol-indices`) and 17 daily price series (`OPENBB_PRICE_SERIES_IDS`, refreshed by `daily-prices`).
- 14 daily (`1d`) bar series in `market_bar_series` (`OPENBB_DAILY_BAR_SYMBOLS`: the Core 7 ETFs and 7 futures, refreshed by `daily-prices`).

Expected session SLA:

- At or after `06:00` America/New_York on calendar day `D`, the expected stored date is the newest NYSE trading session strictly before `D`.
- Before `06:00` America/New_York on calendar day `D`, the expected stored date is the newest NYSE trading session strictly before `D - 1`.
- NYSE holidays and special full-day closures come from `packages/api/src/nyse-calendar.ts` (parity-tested against `services/openbb/vertex_openbb/jobs/nyse_closures.py` for 2024–2028).

Lag thresholds and hysteresis:

- 44 daily series and `1d` bar series: alert when more than `2` NYSE sessions behind (`sessionsBehind > 2`) or when the series is missing (`lastDate === null`); clear when `<= 1` NYSE session behind.
- `EY_TNX_RATIO` (monthly Shiller-derived ratio): alert when more than `25` NYSE sessions behind (`sessionsBehind > 25`) or missing; clear when `<= 24` NYSE sessions behind.

## Incident State Machine and Table (`price_freshness_state`)

Durable state lives in Postgres table `price_freshness_state` (schema `packages/db/src/schema/openbb-freshness.ts`, repository `packages/db/src/server/price-freshness.ts`, migration `0092_price_freshness_state.sql`):

- One row per named monitor (`monitor = 'price-freshness'`).
- Every write acquires `pg_advisory_xact_lock(hashtextextended('price_freshness_state:' || monitor, 0))` for a short transaction only; outbound HTTP calls never run inside a database transaction.
- A 60-second in-flight lease (`pending_event_id IS NOT NULL` and `now - updated_at < 60 s`, covering `'pending'`, `'not-configured'`, and `'failed'` during Phase 2 ntfy and Phase 4 `#omp-alerts` handoff/ack) prevents overlapping ticks from sending duplicate alerts.
- Newly stale series (keys not yet in `active_keys`) trigger one consolidated alert listing up to 8 series plus an overflow count. A stuck series in `active_keys` does not silence a second series that later becomes stale.
- When all series recover within their clear threshold, one recovery alert fires and clears `active_keys`.

## API Procedures (`packages/api/src/contracts/price-freshness.ts`, `packages/api/src/server/price-freshness.ts`)

Mounted under the `openbb.*` oRPC namespace:

- `openbb.priceFreshness` (`GET /openbb/price-freshness`): operator read-only status (allowed for read-access API keys and read-only agent viewers). Reports `dailySeriesCount` (31), `dailyBarsCount` (14), `expectedSession`, `stale`, `activeAlertKeys`, `pendingKind`, `pendingDelivery`, and `ntfyConfigured`.
- `openbb.checkPriceFreshness` (`POST /openbb/price-freshness/check`): requires an operator write API key (`x-api-key`). Supports `{ dryRun: true }` (strictly read-only, zero writes, no outbound alerts, `pendingChat: null`). On non-dry-run transitions, sends through `sendPriceAlertsNtfy` first; if ntfy returns `"not-configured"` or `"failed"`, returns `pendingChat` so the QuantVPS tick client can deliver the fallback to `#omp-alerts`.
- `openbb.recordPriceFreshnessChat` (`POST /openbb/price-freshness/chat-delivery`): requires an operator write API key. Commits `active_keys` and clears `pending_*` on `{ delivery: "sent", eventId }`, or keeps `pending_*` for retry on `{ delivery: "failed", eventId }`.

## QuantVPS Timer and Fallback Delivery

- Tick client: `scripts/price-freshness/tick.ts` and `scripts/vertex-price-freshness-tick.ts` (`bun run vertex:price-freshness:tick [--dry-run]`).
- QuantVPS systemd units and installer: `infra/openbb-freshness/quantvps/` (`vertex-openbb-freshness.timer`, `vertex-openbb-freshness.service`, drop-ins for `/etc/vertex-openbb-freshness/agent-key.env` and `/etc/vertex-openbb-freshness/alert.env`, and `install.sh`).
- Schedule: `*-*-* 06..23:15:00 America/New_York` (`RandomizedDelaySec=60`, `Persistent=true`).
- Outbound delivery order:
  1. Server-side `sendPriceAlertsNtfy` when `VERTEX_PRICE_ALERTS_NTFY_*` is configured on QuantVPS (`ntfyConfigured: true`).
  2. QuantVPS tick fallback to `#omp-alerts` via `VERTEX_ALERT_POST_URL` and `VERTEX_ALERT_CHANNEL` when ntfy is `"not-configured"` or `"failed"`. If fallback delivery fails (for example while the rig tunnel is down), the pending alert remains in `price_freshness_state` and retries on each scheduled hourly tick until delivered or superseded.

## Deploy

Deploy after 16:00 or before 08:30 New York time, or on a weekend (owner rule 2026-11-16). This deploy restarts `vertex-web` only; it does not touch the gateway, the trading engine or a trading container. Order: migration, then web app, then timer.

1. Take the web deploy claim: `fm claim <card> deploy:quantvps-web`.
2. Apply `packages/db/migrations/0092_price_freshness_state.sql` alone with `psql -v ON_ERROR_STOP=1 --single-transaction` in the `vertex-postgres` container. Never run `db:migrate` against the QuantVPS database: its Drizzle ledger is incomplete ([flow-pipeline.md](flow-pipeline.md#deploy)). Never use `ibkr-nautilus-exec-node-postgres-1`: it belongs to the trading exec node.
3. Check that `price_freshness_state` exists and that `vertex_research` has SELECT, INSERT, UPDATE and DELETE on it (`\dp price_freshness_state`).
4. Deploy the web app of the merged commit as in [infra/quantvps/README.md](../../infra/quantvps/README.md#deploy-a-new-web-build) (`stage-build.sh`, `stage-runtime.sh`, `restart-when-idle.sh --deploy <sha>`).
5. Call `openbb.priceFreshness` with a read key: `dailySeriesCount` is 31 and `dailyBarsCount` is 14.
6. Create `/etc/vertex-openbb-freshness/alert.env` (mode 0600, owner root) with `VERTEX_ALERT_POST_URL=http://127.0.0.1:47821/post` and `VERTEX_ALERT_CHANNEL=omp-alerts`.
7. From a clean checkout of the merged commit on the rig, run `infra/openbb-freshness/quantvps/install.sh`.
8. On QuantVPS run the tick once as a dry run (`/opt/vertex-autopilot/bin/node /opt/vertex-openbb-freshness/vertex-price-freshness-tick.mjs --dry-run` with the variables of `/etc/vertex-autopilot/autopilot.env`), then `systemctl start vertex-openbb-freshness.service`. Check exit 0 in `journalctl -u vertex-openbb-freshness.service` and that `vertex-openbb-freshness.timer` is enabled and active.

Rollback, in reverse order: `systemctl disable --now vertex-openbb-freshness.timer`; deploy the previous web app with `restart-when-idle.sh` (it runs on the migrated database). `packages/db/rollback/0092_price_freshness_state.down.sql` is optional; if `drizzle.__drizzle_migrations` holds a row for 0092, delete it before 0092 is applied again.
