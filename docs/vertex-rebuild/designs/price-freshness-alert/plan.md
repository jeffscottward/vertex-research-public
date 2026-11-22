# Plan: alert when a stored daily price series or 1d bar series is more than 2 NYSE sessions behind

![Before and after. Before: when daily-prices refuses a work unit or the rig is down, stale series produce only a partial run status and exit 0 with no alert. After: a QuantVPS systemd timer calls server-owned openbb.checkPriceFreshness, which evaluates all 31 daily series and 14 1d bar series against a 06:00 ET NYSE SLA, stores per-monitor incident state in Postgres price_freshness_state, sends via price-alerts-ntfy.ts, and falls back to #omp-alerts with pending-delivery retry.](plan-overview.png)

- Card: `vertex-price-freshness-alert` (follow-up from `vertex-daily-series-refresh`, review item D1; [daily-series-refresh plan](../daily-series-refresh/plan.md), Risks).
- Related roadmap design: [smart-money design](../smart-money/design.md) (L166, L230 — PR 6 plans a QuantVPS overdue alert timer using `price-alerts-ntfy.ts` to cover rig-down outages).
- EGM review resolution: [goldfish_review_report.md](goldfish_review_report.md) (10 PROPOSE FIX applied, 1 CONTEST, 1 DECLINE, 0 ESCALATE).
- Baseline: commit `2c5804c8`. Every "today" statement below describes that commit.
- Scope: research data alerting only. This change touches no order, execution, arming, risk, money-movement, security, or deletion path.

## Objectives

Every night after US market close, Vertex refreshes 45 stored market-data series (31 daily price and volatility series plus 14 daily price bar series) used by strategy research and backtests. Today, if a single series fails a data safety check or if the home collection machine stops running, the affected series silently falls behind with no alert.

This change adds an automated freshness watch on the QuantVPS server that checks all 45 stored series every hour after the 06:00 New York overnight refresh window. When any series falls more than 2 NYSE trading sessions behind (or more than 25 sessions for the monthly Shiller-derived ratio), or is missing from the database, Vertex sends one consolidated alert naming the stale series and sends one recovery alert after all series catch up.

## Impact, Cost, and Timeline

- **Impact**: Strategy research, backtest comparisons, and the operator learn within 15 minutes after the 06:00 New York SLA when a stored series exceeds the 2-session lag ceiling, instead of discovering stale backtest inputs days or weeks later. A stuck series no longer hides a second series falling behind later.
- **Cost**: One small implementation PR (~12 files across `packages/db`, `packages/api`, `scripts/`, `infra/`, and `docs/`). Runtime cost on QuantVPS is negligible: one 1-row Postgres state table, zero database writes on steady-state healthy ticks, and 18 lightweight hourly checks per day.
- **Timeline**: Single PR implemented, verified with unit/integration/CI gates, and deployed outside market hours on the same day. Out-of-band rig-down delivery via ntfy activates as soon as the owner authorizes provisioning `VERTEX_PRICE_ALERTS_NTFY_*` in QuantVPS `.prod.vars` and restarts `vertex-web.service` (separate owner-gated follow-up).

## Risks, Payoffs, and Exams

- **Payoffs**: Eliminates silent multi-day staleness across all 45 daily series, catches `vertex-openbb.timer`/`service` outages while the rig tunnel is up, and prepares the QuantVPS outbox and `sendPriceAlertsNtfy` path for full rig-down alerting once ntfy credentials are provisioned.
- **Top risks**: Day-1 rig-down alerts queue in Postgres until the rig tunnel returns while `VERTEX_PRICE_ALERTS_NTFY_*` is unconfigured; ntfy 5xx/timeouts after publish produce at-least-once duplicates; `vertex-web.service` or Postgres downtime on QuantVPS is visible only in local systemd logs. See [Risks & Mitigations](#risks--mitigations) for details.
- **Exams**: Mid-term gate = 100% test coverage on all new/changed TS files, real Postgres integration tests, `--dry-run` verification, and green PR `ci-gate`. Final exam = live QuantVPS migration, live `openbb.priceFreshness` reporting 31 daily + 14 bar series with `stale: []`, and a live `vertex-openbb-freshness.service` run exiting `0` with `vertex-openbb-freshness.timer` active. See [Acceptance Checks](#acceptance-checks).

## Problem Statement

Measured on 2026-11-22 (read-only calls to `openbb.dailyPricesState`, `openbb.volContext`, and `openbb.status` on the live deployment; the last finished NYSE session was Friday 2026-11-20):

- `market_daily_series` holds 31 monitored series: 14 Cboe volatility indices (`OPENBB_VOL_INDEX_IDS`, written by `cboe-vol-indices`) and 17 daily price series (`OPENBB_PRICE_SERIES_IDS`: 7 Core ETFs, 7 futures, `IRX`, `TNX`, and `EY_TNX_RATIO`, written by `daily-prices`). All 31 hold `2026-11-20`.
- `market_bar_series` holds 14 monitored `1d` bar series (`OPENBB_DAILY_BAR_SYMBOLS`: the same 7 Core ETFs and 7 futures, written by `daily-prices`). All 14 hold `2026-11-20`.
- When `daily-prices` refuses a data work unit (seam check failure, missing seam date, Treasury par-yield fallback, or invalid row) or when `cboe-vol-indices` misses an index, `scripts/openbb/tick.ts` records `partial` (or `blocked_upstream`) and exits `0`. No alert fires, and an open `partial` status hides a second series going stale later.
- In addition, `vertex-openbb.timer` runs on the rig. If the rig, `vertex-openbb.timer`, or `vertex-openbb.service` stops, all 45 series stall together; any freshness check hosted on the rig stops running during that exact outage.
- Measured QuantVPS transport state (2026-11-22): `vertex-web.service` includes `sendPriceAlertsNtfy` (`packages/api/src/server/price-alerts-ntfy.ts`), but `private/basic-app-named/.prod.vars` on QuantVPS does not configure `VERTEX_PRICE_ALERTS_NTFY_*` (`sendPriceAlertsNtfy` returns `"not-configured"`). Live QuantVPS timers (`vertex-sector-rotation`, `vertex-odte-quotes-check`, `vertex-nautilus-health-alert`) currently post alerts to `#omp-alerts` through the loopback reverse tunnel (`http://127.0.0.1:47821/post`) to the rig Discord bot.

## Terms

- **The rig**: the owner's Linux workstation that runs the `vertex-openbb.timer` ingest scheduler, `bun`, repository checkouts, and the Discord bot.
- **QuantVPS**: the always-on server running `vertex-web.service`, `vertex-postgres`, and research timers (`vertex-sector-rotation`, `vertex-odte-quotes-check`, `vertex-nautilus-health-alert`).
- **Seam check**: the `daily-prices` safety check that refuses to append new rows when the newly fetched close on the stored last date differs from the stored close beyond tolerance (2% for equities/indices, 10% for futures).
- **Work unit / series / systemd unit**: a **work unit** is one symbol fetch inside `daily-prices`; a **series** is one stored time series in `market_daily_series` or `market_bar_series`; a **systemd unit** is a `.service` or `.timer` unit managed by systemd.
- **`tick-runner` and `unitheal`**: rig-side scheduler tools (`self-healing-harness`). `tick-runner` runs steps in `vertex-openbb.steps` and exits `1` if any step fails; `unitheal` triages failed systemd units as broken services.
- **`#omp-alerts` loopback tunnel**: `http://127.0.0.1:47821/post` on QuantVPS, forwarded over a reverse tunnel to the rig's Discord bot `/post` endpoint.
- **`.prod.vars`, `vertex_research`, `vertex-autopilot`**: `.prod.vars` (`private/basic-app-named/.prod.vars`) stores `vertex-web.service` server bindings; `vertex_research` is the Postgres role used by `vertex-web` for OpenBB queries; `/opt/vertex-autopilot/bin/node` and `/etc/vertex-autopilot/autopilot.env` provide Node 24, `VERTEX_ORIGIN`, and the default operator write key on QuantVPS.
- **Monitored series (45 total)**: all 31 daily series (`OPENBB_VOL_INDEX_IDS` [14] + `OPENBB_PRICE_SERIES_IDS` [17]) in `market_daily_series` and all 14 `1d` bar series (`OPENBB_DAILY_BAR_SYMBOLS` [14]) in `market_bar_series`.
- **Series key**: canonical identifier `<table:id>`, where `table` is `"daily_series"` or `"daily_bars"` and `id` is the series ID or bar symbol (for example `daily_series:SPY` or `daily_bars:ES=F`).
- **Expected session (06:00 ET SLA)**: the newest NYSE trading day on or before the SLA boundary date (`nyToday - 1 day` when New York hour `>= 6`, else `nyToday - 2 days`), computed with `isNyseTradingDay` (`packages/api/src/nyse-calendar.ts`: weekdays minus regular NYSE holidays and `NYSE_SPECIAL_CLOSURES`, verified 50/50 identical to `services/openbb/vertex_openbb/jobs/nyse_closures.py` for 2024–2028). Aligns with [daily-series-refresh plan](../daily-series-refresh/plan.md) Goals 1 and 3 (overnight ingest finishes before 06:00 America/New_York).
- **Sessions behind**: count of NYSE trading days `d` with `lastDate < d <= expectedSession` (`0` when `lastDate >= expectedSession`; `null` when the series is missing from Postgres).
- **Stale threshold**:
  - 30 daily series (14 Cboe vol indices, 7 Core ETFs, 7 futures, `IRX`, `TNX`) and 14 `1d` bar series: **stale** when missing or `sessionsBehind > 2` (3 or more NYSE sessions behind). Absorbs 1-day US bond market holidays on `IRX`/`TNX` and 1–2 day unlisted emergency closures.
  - `EY_TNX_RATIO` (derived from `TNX` and Shiller monthly workbook with `EARNINGS_LAG_MONTHS = 6`): **stale** when missing or `sessionsBehind > 25` (about 1 calendar month of NYSE sessions). Prevents monthly false alarms when Shiller's `month - 6` row is unpublished ([daily-series-refresh plan](../daily-series-refresh/plan.md) Goal 1), while `TNX` still monitors the daily feed at `> 2` sessions.
- **Clear threshold (1-session hysteresis)**: an active series key clears when `lastDate !== null` and `sessionsBehind <= 1` (or `<= 24` for `EY_TNX_RATIO`). Prevents boundary flapping (`2 <-> 3`) on partial backfills while absorbing 1-day bond holidays.
- **Monitor**: a named freshness watcher row in Postgres `price_freshness_state` (primary key `monitor`; this change uses `"price-freshness"`).

## Goals & Non-Goals

### Goals

1. Expose read-only `openbb.priceFreshness` (accessible to operators and read-only agent API keys via `AGENT_API_KEY_READ_PROCEDURES`) reporting `expectedSession`, `ntfyConfigured`, counts (`31` daily, `14` bars), every stale/missing series, `activeAlertKeys`, and pending delivery status (`pendingKind`, `pendingDelivery`).
2. Expose server-owned write procedures `openbb.checkPriceFreshness` (supporting `dryRun: true`) and `openbb.recordPriceFreshnessChat` (both requiring operator agent write keys) backed by a dedicated Postgres table `price_freshness_state` (1 row per monitor, zero DB writes on steady-state healthy ticks, serialized with `pg_advisory_xact_lock`, no DB transaction held during outbound HTTP, and a 60 s in-flight lease preventing concurrent double-sends).
3. Deliver one consolidated alert per incident (`newlyStale` non-empty) and one recovery alert when all active keys clear (`activeKeys` transitions from non-empty to empty), with silent per-series pruning on partial recovery so a fixed series alerts again if it breaks a second time while another series stays stale.
4. Run the scheduled check on **QuantVPS** (`infra/openbb-freshness/quantvps/vertex-openbb-freshness.{service,timer}`, hourly `06..23:15` America/New_York every day including weekends, `Persistent=true`). On day 1, QuantVPS detects `vertex-openbb.timer`/service failures and delivers live via the `#omp-alerts` tunnel, and detects and durably queues rig-down staleness in Postgres until the tunnel returns; once the owner configures `VERTEX_PRICE_ALERTS_NTFY_*` in QuantVPS `.prod.vars` and restarts `vertex-web.service`, server-side `sendPriceAlertsNtfy` delivers rig-down alerts out-of-band without code changes.
5. Follow the QuantVPS deployment and drop-in conventions (`sendPriceAlertsNtfy`, optional `agent-key.env` and `alert.env` drop-ins, monitor-keyed state table) established by `infra/sector-rotation/quantvps/` and referenced in [smart-money design](../smart-money/design.md) (L166, L230 — PR 6), while keeping this change strictly scoped to the 45 daily price and bar series.

### Non-Goals

- Provisioning private `VERTEX_PRICE_ALERTS_NTFY_*` credentials in QuantVPS `.prod.vars` (credential/security owner gate; tracked as a follow-up while `ntfyConfigured: false` remains visible).
- Automatic repair or re-import of refused seams (repairs remain manual `vertex:series:import` / `vertex:bars:import`).
- PR 6's `/smart-money` UI, `OPENBB_JOBS` max-age registry, or `flow_samples` 30-minute in-session overdue checks (PR 6 will define its own cadence and evaluator).
- Changes to `OPENBB_JOBS`, `openbb_ingest_runs`, Python fetchers, order routing, execution, arming, or risk settings.

## Proposed Architecture

### Alternatives Considered

1. **Rejected: Rig-hosted step in `vertex-openbb.steps` (using `tick-runner` exit `1` or `omp-notify`).**
   - Stops running when the rig, `vertex-openbb.timer`, or `vertex-openbb.service` is down.
   - `tick-runner` exit `1` triggers `unitheal` down-unit triage on data seam refusals, resets `.alerted` on windowed exit `0`, omits series names, and hides a second series going stale.
2. **Rejected: Storing incident keys in `openbb_ingest_runs.warnings` under `job = "price-freshness"`.**
   - `OpenbbRecordRunInputSchema.job` is `z.enum(OPENBB_JOBS)`, pinned 1:1 to Python fixtures (`packages/api/src/openbb-server.test.ts:306`).
   - `openbb.latestRuns()` returns all rows in `openbb_ingest_runs` unfiltered, polluting `openbb.status`, and hourly writes append ~6,570 rows/year of state-machine noise.
3. **Rejected: Local JSON state file on QuantVPS or the rig.**
   - Violates `AGENTS.md` rule 13 (`bun run test:json-data`) and hides active incident state from Postgres and `openbb.priceFreshness`.
4. **Rejected: Posting directly to `127.0.0.1:47821/post` inside `vertex-web.service` (`packages/api`).**
   - Couples Cloudflare Worker-portable `packages/api` code to a host-local Discord tunnel URL and breaks parity with `scripts/sector-rotation/tick.ts` and `infra/sector-rotation/quantvps/`.
5. **Chosen: QuantVPS timer (`vertex-openbb-freshness`) + dedicated Postgres table `price_freshness_state` + server-side `sendPriceAlertsNtfy` + tick-side `#omp-alerts` pending-outbox fallback.**
   - Keeps `OPENBB_JOBS` and `openbb_ingest_runs` strictly ingest-only.
   - Zero row growth (1 row per monitor; healthy steady-state ticks write 0 rows).
   - Prepares rig-independent out-of-band delivery via `sendPriceAlertsNtfy` while delivering live today via `#omp-alerts` with automatic pending-delivery retries.

### Read Path, Auth Boundaries, and Drop-In Reuse

- **Read path (`openbb.priceFreshness`, `GET /openbb/price-freshness`)**: requires `requireOperator`; listed in `AGENT_API_KEY_READ_PROCEDURES` (`packages/api/src/server/operator-access.ts`) and `REVIEWED_READS` (`packages/api/src/agent-viewer.test.ts`), so operators, read-only agent keys, and agent viewers can inspect current freshness, `ntfyConfigured`, `activeAlertKeys`, `pendingKind`, and `pendingDelivery` with zero side effects.
- **Write path (`openbb.checkPriceFreshness`, `openbb.recordPriceFreshnessChat`)**: requires `requireOperator` plus `requireWriteKey` (operator agent write key in `x-api-key` header; read-only keys receive `403`).
- **QuantVPS drop-ins**: `vertex-openbb-freshness.service` reads `/etc/vertex-autopilot/autopilot.env` (`VERTEX_ORIGIN`, `VERTEX_AGENT_API_KEY`) by default, and `install.sh` conditionally installs or removes systemd `.conf` drop-ins (`agent-key.conf` for `/etc/vertex-openbb-freshness/agent-key.env`, `alert-route.conf` for `/etc/vertex-openbb-freshness/alert.env`), matching `infra/sector-rotation/quantvps/`.

### Data Flow and Two-Phase Outbox State Machine

1. **Schedule (QuantVPS)**: `vertex-openbb-freshness.timer` triggers `vertex-openbb-freshness.service` hourly from `06:15` to `23:15` America/New_York every day (`OnCalendar=*-*-* 06..23:15:00 America/New_York`, `RandomizedDelaySec=60`, `Persistent=true`). Saturday `06:15` ET checks Friday's session 15 minutes after the `06:00` ET SLA boundary instead of waiting until Monday.
2. **Evaluation inputs**: `openbb.checkPriceFreshness({ dryRun })` reads `series.latestPoints(OPENBB_ALL_DAILY_SERIES_IDS)` (31 IDs) and `bars.latestBars("1d")` filtered to `OPENBB_DAILY_BAR_SYMBOLS` (14 symbols), computes `expectedSession = expectedFreshnessSession(clock())`, and evaluates all 45 series into deterministic sorted `stale` items (`daily_series` before `daily_bars`, then lexicographical by `id`) and `clearableKeys`.
3. **Dry-run fast path (`dryRun: true`)**: performs a read-only `openbbFreshness.getFreshnessState("price-freshness")` (no write transaction, no advisory lock, 0 DB writes, 0 ntfy calls). Evaluates the state transition below and returns `pendingChat: null`, `delivery: "dry-run"`, and `plannedAlert: { kind, title, body } | null`.
4. **Phase 1 — Plan transition (`!dryRun`, short DB tx under `pg_advisory_xact_lock`)**:
   - Takes `pg_advisory_xact_lock(hashtextextended('price_freshness_state:price-freshness', 0))` and reads the `"price-freshness"` row (if any).
   - **In-flight lease guard**: if `row.pendingEventId !== null` and `now.getTime() - row.updatedAt.getTime() < IN_FLIGHT_LEASE_MS` (`60_000` ms), returns `action: "in-flight"`, `delivery: null`, `pendingChat: null`, `plannedAlert: null` without modifying the row or re-sending. Guarding all non-null `pendingEventId` states covers both Phase 2 (ntfy) and Phase 4 (`#omp-alerts` fallback + ack) against concurrent manual/timer overlap while hourly retries remain 3,600 s apart.
   - Computes per-series sets with 1-session hysteresis and retired-key pruning:
     - `monitoredKeys` = set of all 45 current monitored `<table:id>` keys.
     - `staleKeys` = keys in `stale` (missing or `sessionsBehind > maxSessions`).
     - `retainedActive` = prior `activeKeys` that are **both** in `monitoredKeys` and **not** in `clearableKeys`.
     - `newlyStale` = `stale` items whose key is not in `activeKeys`.
     - `nextActiveKeys` = sorted union of `retainedActive` and `staleKeys`.
   - **Exhaustive 5-way transition partition**:
     1. **`alert` (`newlyStale.length > 0`)**: covers initial incident open, expanded incident, and retry of any undelivered alert while stale items remain. Stages `pendingEventId = randomUUID()`, `pendingKind = "alert"`, `pendingKeys = nextActiveKeys`, `pendingDelivery = "pending"` (preserving `activeKeys` unchanged until delivery succeeds). Formats `title` and `body` transiently.
     2. **`recovery` (`nextActiveKeys.length === 0 && activeKeys.length > 0`)**: covers initial full recovery and retry of an undelivered recovery. Stages `pendingEventId = randomUUID()`, `pendingKind = "recovery"`, `pendingKeys = []`, `pendingDelivery = "pending"` (preserving `activeKeys` unchanged until delivery succeeds). Formats recovery `title` and `body` transiently.
     3. **`prune-active` (`nextActiveKeys` differs from `activeKeys`)**: silent partial recovery (1 or more active keys cleared while at least 1 active key stays stale, and no new stale key appeared). Commits `activeKeys = nextActiveKeys`, clears all `pending_*` columns to `NULL` (`pendingKeys = []`), updates `lastTransitionAt = now`. Sends no alert.
     4. **`clear-pending` (`pendingEventId !== null`)**: `newlyStale` is empty, full recovery does not apply, and `nextActiveKeys` equals `activeKeys` (for example, an undelivered alert healed before retry, or an undelivered recovery slipped back into lag 2). Silently clears all `pending_*` columns to `NULL` (`pendingKeys = []`) without modifying `activeKeys` or `lastTransitionAt`. Sends no alert.
     5. **`noop` (otherwise)**: writes 0 DB rows. Sends no alert.
5. **Phase 2 — Outbound ntfy delivery (`openbb.checkPriceFreshness`, outside any DB transaction)**:
   - Only when Phase 1 returned `"alert"` or `"recovery"`: calls `sendPriceAlertsNtfy(context.priceAlertsNtfy ?? null, { title, body }, idempotencySource, now, notifyFetch)` where `notifyFetch` is the test seam (`setOpenbbPriceFreshnessOptionsForTesting`) or `undefined` (default `globalThis.fetch`).
   - `idempotencySource` is derived transiently: `price-freshness:${kind}:${expectedSession}:${targetKeys.join(",")}`.
   - Any thrown exception from `sendPriceAlertsNtfy` is caught and mapped to `"failed"` so Phase 3 always updates the pending row.
6. **Phase 3 — Commit ntfy result (`openbb.checkPriceFreshness`, short DB tx under `pg_advisory_xact_lock`)**:
   - Calls `openbbFreshness.completeFreshnessDelivery("price-freshness", eventId, delivery, clock())`, which checks `row.pendingEventId === eventId`.
   - If `eventId` no longer matches (superseded by another run after lease expiry): returns `committed: false` and `pendingChat: null` so Phase 4 never posts an uncommittable duplicate.
   - If `delivery === "sent"`: commits `activeKeys = row.pendingKeys`, clears all `pending_*` columns (`pendingKeys = []`), sets `lastTransitionAt = now`, and returns `{ delivery: "sent", pendingChat: null }`.
   - If `delivery === "not-configured"` or `"failed"`: updates `pendingDelivery = delivery` (leaving `pending_*` intact) and returns `{ delivery, pendingChat: { eventId, kind, title, body } }`.
7. **Phase 4 — QuantVPS `#omp-alerts` fallback and ack (`scripts/price-freshness/tick.ts`)**:
   - Guarded by `!dryRun && reply.pendingChat !== null`.
   - Reads `VERTEX_ALERT_POST_URL` and `VERTEX_ALERT_CHANNEL`.
     - If either env var is absent: if server `reply.delivery === "not-configured"`, do not overwrite `pendingDelivery` with `"failed"` (preserves `"not-configured"` visibility); otherwise send best-effort `recordPriceFreshnessChat({ eventId, delivery: "failed" })`. Log error to stderr and exit `1`.
   - Posts `{"channel": channel, "text": "**<title>**\n<body>"}` (10 s timeout, truncated to `<= 1,900` chars).
   - Accepts HTTP 2xx only when the JSON body contains `{ ok: true }` (matching `scripts/sector-rotation/tick.ts`).
   - On chat acceptance: calls `POST ${origin}/api/orpc/openbb/recordPriceFreshnessChat` (10 s timeout) with `{ eventId, delivery: "sent" }`. If the ack HTTP call fails or returns `{ committed: false }`, writes an error to stderr noting possible next-hour duplicate and exits `1`.
   - On chat failure (network error, timeout, non-2xx, or non-`{ ok: true }` body): sends best-effort `recordPriceFreshnessChat({ eventId, delivery: "failed" })` (keeps `pending_*` intact for the next hourly retry), logs to stderr, and exits `1`.

### Payload Bounds and Degraded Rig-Down Visibility

- `packages/notifications/src/validation.ts` enforces `title <= 160` UTF-8 bytes (single line, no control characters) and `body <= 4096` UTF-8 bytes; Discord caps messages at `2000` characters.
- All formatted alert and recovery messages use printable ASCII only (single-line titles), so character counts equal UTF-8 byte counts.
- Exact message contracts:
  - **Alert title (`<= 120` bytes)**: `Vertex: <newlyStale.length> daily price/bar series stale (<expectedSession>)` (`<N>` is always `newlyStale.length`).
  - **Alert body (`<= 1,000` bytes)**: lists up to 8 `newlyStale` items (in deterministic order: `daily_series` before `daily_bars`, then lexicographical by `id`) formatted as `SPY (3d, last 2026-11-17)` / `SPY 1d bars (3d, last 2026-11-17)` / `VIX (missing)`, appends `+<K> more` when `newlyStale.length > 8`, states total stale count (`Total stale: <stale.length>/45; expected <expectedSession>`), and appends `Repair: vertex:series:import or vertex:bars:import`.
  - **Recovery title (`<= 120` bytes)**: `Vertex: daily price/bar series fresh again (<expectedSession>)`.
  - **Recovery body (`<= 400` bytes)**: `All 31 daily series and 14 1d bar series are fresh as of <expectedSession> (<recoveredCount> recovered).` where `recoveredCount = activeKeys.length`.
- Both `openbb.priceFreshness` and `openbb.checkPriceFreshness` return `ntfyConfigured: boolean` (derived from `context.priceAlertsNtfy !== null`, never secrets). When `false`, `scripts/price-freshness/tick.ts` prints one non-secret status line noting that ntfy is unconfigured on the server and alerts use the `#omp-alerts` fallback tunnel.

## Detailed Implementation Plan

### 1. Database schema, migration, rollback, and repository (`packages/db`)

- **Create `packages/db/src/schema/openbb-freshness.ts`** (separate leaf file; does not modify `packages/db/src/schema/openbb.ts`, defining a local `utcTimestamp` helper):
  - Export `OPENBB_FRESHNESS_KINDS = ["alert", "recovery"] as const` and `type OpenbbFreshnessKind`.
  - Export `OPENBB_FRESHNESS_PERSISTED_DELIVERIES = ["pending", "not-configured", "failed"] as const` and `type OpenbbFreshnessPersistedDelivery`.
  - Export `openbbFreshnessState = pgTable("price_freshness_state", ...)`:
    - `monitor: text("monitor").primaryKey()`
    - `activeKeys: text("active_keys").array().notNull().default(sql`'{}'::text[]`)`
    - `pendingEventId: text("pending_event_id")`
    - `pendingKind: text("pending_kind").$type<OpenbbFreshnessKind>()`
    - `pendingKeys: text("pending_keys").array().notNull().default(sql`'{}'::text[]`)`
    - `pendingDelivery: text("pending_delivery").$type<OpenbbFreshnessPersistedDelivery>()`
    - `lastTransitionAt: utcTimestamp("last_transition_at")`
    - `updatedAt: utcTimestamp("updated_at").defaultNow().notNull()`
  - CHECK constraint `price_freshness_state_check`:
    - `monitor ~ '^[a-z0-9-]{1,40}$'`
    - `array_position(active_keys, NULL) is null and array_position(pending_keys, NULL) is null`
    - Either `(pending_event_id is null and pending_kind is null and pending_delivery is null and pending_keys = '{}'::text[])` OR `(pending_event_id is not null and pending_kind is not null and pending_delivery is not null and char_length(trim(pending_event_id)) between 1 and 80 and char_length(pending_event_id) <= 80 and pending_kind in ('alert', 'recovery') and pending_delivery in ('pending', 'not-configured', 'failed') and ((pending_kind = 'alert' and cardinality(pending_keys) > 0) or (pending_kind = 'recovery' and pending_keys = '{}'::text[])))`
- **Modify `packages/db/src/schema/index.ts`**: export `* from "./openbb-freshness.ts"`.
- **Generate Drizzle migration**: run `bunx --bun --no-install drizzle-kit generate --config drizzle.config.ts --name price_freshness_state` to produce migration `0092_price_freshness_state.sql`, snapshot `meta/0092_snapshot.json`, and updated `packages/db/migrations/meta/_journal.json` (generated once the `packages/db/migrations/*` claim clears). Append the role grant block to `0092_price_freshness_state.sql`:

  ```sql
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "price_freshness_state" TO "vertex_research";
    END IF;
  END
  $$;
  ```

- **Create guarded rollback `packages/db/rollback/0092_price_freshness_state.down.sql`**: header comment noting to stop `vertex-openbb-freshness.timer` first and noting Drizzle ledger reconciliation; `BEGIN; SET LOCAL search_path = pg_catalog, public; SET LOCAL row_security = off; LOCK TABLE "public"."price_freshness_state" IN ACCESS EXCLUSIVE MODE; DROP TABLE "public"."price_freshness_state"; COMMIT;`.
- **Create `packages/db/src/server/price-freshness.ts`, and wire in `packages/db/src/server/index.ts` and `packages/db/src/server/repositories.ts`**:
  - Export `createOpenbbFreshnessRepository`, `OpenbbFreshnessRepository`, `OpenbbFreshnessState`, `OpenbbFreshnessStageDecision`, `OpenbbFreshnessStageResult`, and `OpenbbFreshnessDeliveryOutcome` from `packages/db/src/server/price-freshness.ts`, re-export them from `packages/db/src/server/index.ts`, and wire `openbbFreshness?: OpenbbFreshnessRepository` in `packages/db/src/server/repositories.ts`.
  - Exact discriminated union types:
    - `OpenbbFreshnessStageDecision = { kind: "noop" } | { kind: "in-flight" } | { kind: "prune-active"; activeKeys: readonly string[] } | { kind: "clear-pending" } | { kind: "stage-pending"; eventId: string; pendingKind: OpenbbFreshnessKind; pendingKeys: readonly string[] }`
    - `OpenbbFreshnessStageResult = { kind: "noop" | "in-flight" | "prune-active" | "clear-pending"; activeKeys: string[] } | { kind: "stage-pending"; activeKeys: string[]; eventId: string; pendingKind: OpenbbFreshnessKind; pendingKeys: string[] }`
  - Implement 3 methods on `OpenbbFreshnessRepository`:
    - `getFreshnessState(monitor: string): Promise<OpenbbFreshnessState | null>`
    - `stageFreshnessTransition(monitor: string, decide: (current: OpenbbFreshnessState | null) => OpenbbFreshnessStageDecision, now: Date): Promise<OpenbbFreshnessStageResult>` — takes `pg_advisory_xact_lock(hashtextextended('price_freshness_state:' || monitor, 0))`; `"noop"` and `"in-flight"` perform 0 DB writes; `"prune-active"`, `"clear-pending"`, and `"stage-pending"` execute `INSERT ... ON CONFLICT (monitor) DO UPDATE` (`lastTransitionAt` updated only on `"prune-active"`).
    - `completeFreshnessDelivery(monitor: string, eventId: string, delivery: "sent" | "not-configured" | "failed", now: Date): Promise<boolean>` — under the same advisory lock, returns `false` if no row exists or `row.pendingEventId !== eventId`; on `"sent"` commits `activeKeys = row.pendingKeys`, clears all `pending_*` columns (`pendingKeys = []`), updates `lastTransitionAt = now` and `updatedAt = now`; on `"not-configured"` or `"failed"` updates `pendingDelivery = delivery` and `updatedAt = now`, returning `true`.
- **Add DB unit tests and Postgres integration tests**:
  - `packages/db/src/server/openbb.test.ts` stays unchanged because `price_freshness_state` does not use the `openbb_` prefix.
  - Create `packages/db/src/server/price-freshness.test.ts`: unit tests for all 3 repository methods and the Drizzle `price_freshness_state` table config and CHECK constraint.
  - Create `tests/integration/database/price-freshness.test.ts`: real Postgres integration tests verifying `0092_price_freshness_state.sql`, `price_freshness_state_check` constraints, advisory lock SQL, 0-write `"noop"`, `"prune-active"`, `"clear-pending"`, `"stage-pending"`, `completeFreshnessDelivery` (`"sent"`, `"not-configured"`, `"failed"`, mismatched `eventId`), and rollback/re-apply.

### 2. Calendar leaf module, freshness domain logic, contracts, server handlers, and OpenAPI (`packages/api`)

- **Create `packages/api/src/nyse-calendar.ts`** (pure leaf module, zero external imports):
  - Move `NYSE_SPECIAL_CLOSURES`, `nyseHolidays(year: number)`, and `isNyseTradingDay(day: number)` (UTC day number = `Date.UTC(y, m - 1, d) / 86_400_000`) from `packages/api/src/strategy-dsl-compile.ts` into `packages/api/src/nyse-calendar.ts`.
  - Re-export them from `packages/api/src/strategy-dsl-compile.ts` so all existing callers remain untouched.
  - Add a parity test in `packages/api/src/price-freshness.test.ts` verifying `nyseHolidays(2024..2028)` matches `services/openbb/vertex_openbb/jobs/nyse_closures.py` 50/50.
- **Create `packages/api/src/price-freshness.ts`** (pure domain module importing only `./nyse-calendar.ts` and `./contracts/openbb.ts`):
  - Export constants: `OPENBB_PRICE_FRESHNESS_MONITOR = "price-freshness"`, `OPENBB_PRICE_FRESHNESS_MAX_SESSIONS = 2`, `OPENBB_PRICE_FRESHNESS_CLEAR_SESSIONS = 1`, `OPENBB_EY_TNX_RATIO_MAX_SESSIONS = 25`, `OPENBB_EY_TNX_RATIO_CLEAR_SESSIONS = 24`, `OPENBB_FRESHNESS_MAX_LISTED_ITEMS = 8`, `OPENBB_FRESHNESS_IN_FLIGHT_LEASE_MS = 60_000`.
  - Export `expectedFreshnessSession(now: Date): string` (extracts NY year/month/day/hour via `Intl.DateTimeFormat`, converts to UTC day number, subtracts `1` if `hour >= 6` else `2`, steps backward until `isNyseTradingDay(day)` is true).
  - Export `nyseSessionsBehind(lastDate: string, expectedSession: string): number` (converts ISO dates to UTC day numbers; returns `0` when `lastDay >= expectedDay`; counts days `d` in `(lastDay, expectedDay]` where `isNyseTradingDay(d)` is true).
  - Export `thresholdForSeries(table, id)`, `freshnessKeyOf(item)`, `evaluatePriceFreshness({ bars, series, expectedSession })` (imports `OPENBB_ALL_DAILY_SERIES_IDS` and `OPENBB_DAILY_BAR_SYMBOLS`; deterministic sort: `daily_series` before `daily_bars`, then lexicographical by `id`), `formatFreshnessAlertMessage(newlyStale, totalStale, expectedSession)`, `formatFreshnessRecoveryMessage(recoveredCount, expectedSession)`, and `diffFreshnessIncident(...)` (implementing the 5-way transition partition + 60 s in-flight lease check + retired-key intersection).
- **Create `packages/api/src/price-freshness.test.ts`**: 100% coverage across every branch and edge case.
- **Create `packages/api/src/contracts/price-freshness.ts` and mount in `packages/api/src/contract.ts`**:
  - Keep `OPENBB_JOBS` and `OpenbbRecordRunInputSchema` unchanged in `packages/api/src/contracts/openbb.ts`.
  - Export `OPENBB_FRESHNESS_TABLES = ["daily_series", "daily_bars"] as const` and `OPENBB_FRESHNESS_ACTIONS = ["noop", "in-flight", "prune-active", "clear-pending", "alert", "recovery"] as const` (with `OPENBB_ALL_DAILY_SERIES_IDS` exported from `packages/api/src/price-freshness.ts`).
  - Export exact Zod schemas (`OpenbbStaleSeriesSchema`, `OpenbbPlannedAlertSchema`, `OpenbbPendingChatAlertSchema`, `OpenbbPriceFreshnessInputSchema`, `OpenbbPriceFreshnessOutputSchema`, `OpenbbCheckPriceFreshnessInputSchema`, `OpenbbCheckPriceFreshnessOutputSchema`, `OpenbbRecordPriceFreshnessChatInputSchema`, `OpenbbRecordPriceFreshnessChatOutputSchema`) and `openbbPriceFreshnessContract`, spread into `appContract.openbb` in `packages/api/src/contract.ts`:
    - `priceFreshness` (`GET /openbb/price-freshness`, oRPC RPC path `POST /api/orpc/openbb/priceFreshness`)
    - `checkPriceFreshness` (`POST /openbb/price-freshness/check`, oRPC RPC path `POST /api/orpc/openbb/checkPriceFreshness`)
    - `recordPriceFreshnessChat` (`POST /openbb/price-freshness/chat-delivery`, oRPC RPC path `POST /api/orpc/openbb/recordPriceFreshnessChat`)
- **Modify `packages/api/src/server/operator-access.ts`**: add `"openbb.priceFreshness"` to `AGENT_API_KEY_READ_PROCEDURES`.
- **Modify `packages/api/src/agent-viewer.test.ts`**: add `"openbb.priceFreshness"` to `REVIEWED_READS`.
- **Create `packages/api/src/server/price-freshness.ts` and mount in `packages/api/src/server/router.ts`**:
  - Export `setOpenbbPriceFreshnessOptionsForTesting`, `handlePriceFreshness`, `handleCheckPriceFreshness`, `handleRecordPriceFreshnessChat`, and `openbbPriceFreshnessRouter` (spread into `appRouter.openbb` in `packages/api/src/server/router.ts`).
  - Implement `priceFreshness` (`requireOperator`), `checkPriceFreshness` (`requireOperator` + `requireWriteKey`), and `recordPriceFreshnessChat` (`requireOperator` + `requireWriteKey`).
  - Map `bars.latestBars("1d")` with `isoDay(bar.lastT)` filtered to `OPENBB_DAILY_BAR_SYMBOLS` (matching `dailyPricesState`).
  - Wrap repository errors in `failures.STORAGE_ERROR`; catch throws from `sendPriceAlertsNtfy` as `"failed"`.
- **Create `packages/api/src/price-freshness-server.test.ts`**: unit and end-to-end router tests covering all 3 handlers, read-only vs write-key vs session auth, `dryRun: true`, in-flight lease, ntfy `"sent"` / `"not-configured"` / `"failed"` / thrown error, superseded `eventId` returning `pendingChat: null`, `recordPriceFreshnessChat` `"sent"` / `"failed"` / `committed: false`, `STORAGE_ERROR`, contract schema validation, and storage-not-configured guards.
- **Regenerate `packages/api/openapi.json`**: run `bun run openapi:generate` and verify `bun run openapi:check`.

### 3. QuantVPS tick client, systemd units, installer, and documentation (`scripts/`, `infra/`, `docs/`)

- **Create `scripts/price-freshness/tick.ts` and `scripts/vertex-price-freshness-tick.ts`**:
  - Dependency-injected `PriceFreshnessTickIo` (`argv`, `env`, `post`, `stdout`, `stderr`).
  - Required env vars: `VERTEX_ORIGIN` and `VERTEX_AGENT_API_KEY` (sent as `origin` and `x-api-key` headers with `{"json": ...}` body to `${origin}/api/orpc/openbb/checkPriceFreshness` and `${origin}/api/orpc/openbb/recordPriceFreshnessChat`, 15 s timeout on check, 10 s timeout on chat POST and ack).
  - Optional chat fallback env vars: `VERTEX_ALERT_POST_URL` and `VERTEX_ALERT_CHANNEL`.
  - Exit-code contract:
    - `0`: check succeeded with no pending chat, or `--dry-run` succeeded, or chat POST returned HTTP 2xx `{ ok: true }` and `recordPriceFreshnessChat({ delivery: "sent" })` returned `{ committed: true }`.
    - `1`: API error (`401`/`403`/`5xx`/network/bad JSON/schema), missing required env, missing chat fallback env when `pendingChat !== null`, chat POST failure or non-`{ ok: true }` reply, or `recordPriceFreshnessChat` failure / `{ committed: false }`.
    - `2`: unknown CLI argument (only `--dry-run` is accepted).
  - When `pendingChat !== null` and chat env vars are unset: if `reply.delivery === "not-configured"`, do not overwrite server `pendingDelivery` with `"failed"`; log error to stderr and exit `1`.
  - Add `"vertex:price-freshness:tick": "bun --no-env-file scripts/vertex-price-freshness-tick.ts"` to root `package.json`.
  - Create `scripts/price-freshness/tick.test.ts` (100% coverage of all paths and exit codes).
- **Create `infra/openbb-freshness/quantvps/`**:
  - `vertex-openbb-freshness.service`: hardened `oneshot` unit (`After=network-online.target vertex-web.service`, `Wants=network-online.target`, `EnvironmentFile=/etc/vertex-autopilot/autopilot.env`, `WorkingDirectory=/opt/vertex-openbb-freshness`, `ExecStart=/opt/vertex-autopilot/bin/node /opt/vertex-openbb-freshness/vertex-price-freshness-tick.mjs`, `TimeoutStartSec=120`, `Nice=10`, `NoNewPrivileges=yes`, `CapabilityBoundingSet=`, `AmbientCapabilities=`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp=yes`, `PrivateDevices=yes`, `ProtectKernelTunables=yes`, `ProtectKernelModules=yes`, `ProtectControlGroups=yes`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`).
  - `vertex-openbb-freshness.timer`: `OnCalendar=*-*-* 06..23:15:00 America/New_York`, `RandomizedDelaySec=60`, `Persistent=true`.
  - `vertex-openbb-freshness.service.d/agent-key.conf` (`/etc/vertex-openbb-freshness/agent-key.env`) and `alert-route.conf` (`/etc/vertex-openbb-freshness/alert.env`).
  - `install.sh` (runs on the rig, deploys over SSH to QuantVPS; env `VERTEX_OPENBB_FRESHNESS_SSH`, `VERTEX_OPENBB_FRESHNESS_ALLOW_DIRTY`; supports `--build-only DIR`, `VERTEX_INSTALL_ROOT`, `VERTEX_SYSTEMCTL`): bundles `scripts/vertex-price-freshness-tick.ts` with `bun build --target=node --format=esm`, keeps `*.prev`, validates both optional `.env` files when present (regular file, not symlink, mode `0600`, required keys non-empty), installs drop-ins with mode `0644`, and symmetrically removes `agent-key.conf` or `alert-route.conf` when its corresponding `.env` file is absent.
  - `install.test.ts`: tests unit directives, timer calendar, bundle build, `--build-only`, valid/invalid `.env` validation, and symmetrical drop-in installation and removal.
- **Create `docs/vertex-rebuild/openbb-price-freshness.md`**: document `openbb.priceFreshness`, `openbb.checkPriceFreshness`, `openbb.recordPriceFreshnessChat`, `price_freshness_state`, `vertex-openbb-freshness.timer`, thresholds (44 series `> 2`, `EY_TNX_RATIO > 25`), 1-session hysteresis, ntfy + `#omp-alerts` fallback, and `ntfyConfigured`.

### 4. Deploy and live verification (after merge, outside market hours)

Order: **Database migration first, then QuantVPS `vertex-web`, then QuantVPS `vertex-openbb-freshness` timer**. Rollback: disable/stop `vertex-openbb-freshness.timer`, roll back `vertex-web` via `infra/quantvps/restart-when-idle.sh` (safe on the migrated schema). Running `0092_price_freshness_state.down.sql` is an optional schema-reversal step that requires Drizzle ledger reconciliation before re-applying `0092`.

1. `[Rig]` Confirm outside market hours (after 16:00 ET, before 08:30 ET, or weekend) and claim `deploy:quantvps:vertex-web`.
2. `[QuantVPS]` Apply migration `0092_price_freshness_state.sql` on QuantVPS Postgres and verify `price_freshness_state` table and `vertex_research` grants.
3. `[Rig]` From a clean detached worktree at `<merged-sha>`: run `bun run build`, write `git rev-parse HEAD > apps/web/dist/DEPLOYED_SHA`, run `infra/quantvps/stage-build.sh` and `infra/quantvps/stage-runtime.sh`, then run `infra/quantvps/restart-when-idle.sh --deploy <merged-sha>`.
4. `[Rig]` Call live `openbb.priceFreshness` and verify `dailySeriesCount: 31`, `dailyBarsCount: 14`, `stale: []`, `expectedSession` equals the current expected NYSE session, and `ntfyConfigured` matches `.prod.vars`.
5. `[QuantVPS]` Create mode `0600` `/etc/vertex-openbb-freshness/alert.env` with `VERTEX_ALERT_POST_URL=http://127.0.0.1:47821/post` and `VERTEX_ALERT_CHANNEL=omp-alerts`.
6. `[Rig]` Run `infra/openbb-freshness/quantvps/install.sh` from the clean detached checkout at `<merged-sha>`.
7. `[QuantVPS]` Run `/opt/vertex-autopilot/bin/node /opt/vertex-openbb-freshness/vertex-price-freshness-tick.mjs --dry-run`, then run one non-dry-run `systemctl start vertex-openbb-freshness.service`; verify exit `0`, journal success, `vertex-openbb-freshness.timer` enabled and active, and `openbb.priceFreshness` healthy.

## Acceptance Checks

1. **100% test coverage on every new/changed TS file**: `packages/db/src/server/price-freshness.test.ts`, `packages/db/src/server/openbb.test.ts`, `packages/api/src/price-freshness.test.ts`, `packages/api/src/price-freshness-server.test.ts`, `packages/api/src/agent-viewer.test.ts`, `scripts/price-freshness/tick.test.ts`, and `infra/openbb-freshness/quantvps/install.test.ts` pass with 100% lines, branches, functions, and statements on all new/changed files.
2. **Calendar, SLA, and threshold proofs**:
   - `05:59 ET` vs `06:00 ET` SLA boundary, weekends (including Sat `06:15` ET catching Friday), NYSE holidays (Thanksgiving and special closure `2025-01-09`), DST transitions, and 50/50 parity between `nyseHolidays(2024..2028)` and `nyse_closures.py`.
   - `0`, `1` (bond holiday), and `2` fresh vs `3` stale for 30 daily series + 14 `1d` bar series; `25` fresh vs `26` stale for `EY_TNX_RATIO`; missing (`null`) always stale.
3. **State machine, outbox, and safety proofs**:
   - 1 alert on incident open; 0 on repeat; 1 alert when a second series joins an open incident; silent partial recovery pruning (`<= 1`) + re-alert on later re-breakage; retired-key pruning; hysteresis at lag 2; 1 recovery alert on full recovery; obsolete pending cleared silently on heal-before-delivery or recovery re-stale; 60 s in-flight lease blocks concurrent double-sends.
   - Failed ntfy + failed chat preserves `pending_*` for retry; missing chat env preserves `"not-configured"`; superseded `eventId` returns `pendingChat: null`; `dryRun: true` writes 0 DB rows, sends 0 alerts, returns `pendingChat: null` and `plannedAlert`.
   - Read-only API key allowed on `openbb.priceFreshness` and rejected (`403`) on `checkPriceFreshness` / `recordPriceFreshnessChat`; `openbb.status` unaffected; `OPENBB_JOBS` fixture parity preserved; ASCII payload strictly bounded (`title <= 120` B, alert `body <= 1,000` B, recovery `body <= 400` B) when all 45 series are stale.
4. **Real Postgres and repository gates**: `tests/integration/database/price-freshness.test.ts` passes against real Postgres; `bun run db:check`, `bun run openapi:check`, `bun run test:json-data`, `bun scripts/public-names.ts`, `bun run verify:prepush`, `bun run verify:coverage`, `bun run test:integration`, and PR `ci-gate` pass on the reviewed head SHA.
5. **Live QuantVPS verification**: migration applied with `vertex_research` grants, `openbb.priceFreshness` returns 31 daily + 14 bars with `stale: []`, `vertex-openbb-freshness.service` exits `0`, and `vertex-openbb-freshness.timer` is enabled and active.

## Risks & Mitigations

- **Rig-down delivery while `VERTEX_PRICE_ALERTS_NTFY_*` is unconfigured on QuantVPS.** Measured on 2026-11-22: `.prod.vars` does not set `VERTEX_PRICE_ALERTS_NTFY_*`, and `127.0.0.1:47821/post` tunnels to the rig Discord bot. Mitigation: QuantVPS still runs, detects all 45 stale series, persists the pending alert in Postgres, and retries on each scheduled hourly tick (`06:15–23:15` ET), delivering on the next tick after the tunnel returns. `openbb.priceFreshness` exposes `ntfyConfigured: false` and the tick logs the non-secret fallback notice. Owner authorization to add `VERTEX_PRICE_ALERTS_NTFY_*` to `.prod.vars` and restart `vertex-web.service` enables out-of-band rig-down delivery with zero code changes.
- **ntfy wire non-idempotency on 5xx/timeout.** `packages/notifications/src/server/ntfy.ts` does not transmit `providerIdempotencyKey` to the ntfy server, and `price-alerts-ntfy.ts` maps `acceptance: "unknown"` to `"failed"`. A timeout after publish can therefore trigger an immediate `#omp-alerts` fallback and, if chat fails, an hourly ntfy retry (at-least-once delivery; preferred over dropping an outage alert).
- **Chat post succeeds, then `recordPriceFreshnessChat` ack fails.** Both services run on QuantVPS, so localhost ack failure is rare. When it happens, the tick logs to stderr and exits `1`, and `pending_*` stays set so the next hourly tick sends at most one duplicate alert.
- **`vertex-web.service` or Postgres outage on QuantVPS.** If `vertex-web.service` or Postgres is down, `vertex-openbb-freshness.service` exits `1` into QuantVPS journald without an external alert path (monitored by existing QuantVPS host/service health checks).
- **Unlisted emergency NYSE full-day closure and 2028 parity horizon.** An unlisted emergency closure adds 1 apparent missed session; the `> 2` threshold absorbs a 1-day or 2-day special closure with zero false alerts. `nyse-calendar.ts` computes regular NYSE holidays algorithmically past 2028; `nyse_closures.py` covers 2024–2028 and is parity-tested.
- **Autopilot key rotation.** `vertex-openbb-freshness.service` supports the optional dedicated key drop-in `/etc/vertex-openbb-freshness/agent-key.env` at initial deployment and exits non-zero on `401`/`403`.
- **Deploy order mismatch.** Apply migration `0092_price_freshness_state.sql` first, deploy `vertex-web`, then install `vertex-openbb-freshness`. Rollback runs in reverse order.
