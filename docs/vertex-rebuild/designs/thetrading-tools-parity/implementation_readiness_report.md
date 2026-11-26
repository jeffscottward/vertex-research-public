# Stage 9 Review: Implementation Readiness and Codebase Details

- **Reviewer:** Fresh-context Goldfish subagent (`egm-readiness-codebase`)
- **Date:** 2026-11-24
- **Target:** `concepts_brief.md`, `design.md` (draft v1), `before-after.svg`, `capability-matrix.svg`, `data-flow.svg`, `rollout-roadmap.svg`, `report.html` verified against live `vertex-research-public` commit `5e7d5305`
- **Verdict:** Needs Revisions before Implementation — 6 High, 7 Medium, 1 Low findings.

## Numbered Findings (`R1`–`R14`)

### R1 (High) — Three non-existent Postgres table names cited

- **References:** `design.md`, `data-flow.svg`, `report.html`; actual `packages/db/src/schema/index.ts` and `packages/db/src/schema/flow.ts`.
- **Finding:** `openbb_daily_series`, `breadth_90_days`, and `flow_snapshots` do not exist. Actual tables are `market_daily_series` + `market_daily_points` (and `market_bar_series` + `market_bars`), `breadth90_days` (with `breadth90_events` and `breadth90_status`), and `flow_option_prints` / `flow_option_buckets` / `flow_market_premium_bars` / `flow_tape_bars`.
- **PROPOSE FIX:** Replace all 3 non-existent table names across `design.md`, `data-flow.svg`, and `report.html` with exact Drizzle schema table names.

### R2 (High) — Migration range cited as `0000`–`0022` instead of actual `0000`–`0094`

- **References:** `design.md` §5.2; actual `packages/db/migrations/` (95 files, `0000`–`0094`).
- **PROPOSE FIX:** Cite the actual immutable head `0000`–`0094` (noting `0000`–`0022` are Vertex's original pre-merge immutable migrations and new migrations append after the current head via `bun run db:generate` / `pnpm db:renumber` on conflict).

### R3 (High) — Unescaped table pipes in `design.md` fail `markdownlint-cli2` (`MD056`/`MD060`)

- **References:** `design.md` §3.4 `/range-efficiency`.
- **PROPOSE FIX:** Replace `|C−O|/(H−L)` with `abs(C - O) / (H - L)` and verify `bun run lint:markdown` passes cleanly.

### R4 (High) — Hourly EIA-930 grid demand incompatible with `openbb_macro_points` `(series_id, date)` PK

- **References:** `design.md` §3.11, §5.2, §5.3; actual `packages/db/src/schema/openbb.ts`.
- **Finding:** `openbb_macro_points` has a date-granularity primary key `(series_id, observation_date)` and cannot store 24 hourly rows per day.
- **PROPOSE FIX:** Specify that `eia.py` aggregates EIA-930 hourly reads into daily summary macro series (`EIA_GRID_DEMAND_DAILY_MEAN`, `EIA_GRID_DEMAND_DAILY_PEAK`, `EIA_PJM_ERCOT_DAILY_GWH`, daily fuel-mix shares) before upserting to `openbb_macro_points`.

### R5 (High) — Academy manuals/concepts direction conflicts with `AGENTS.md` Rule 13 (`test:json-data`)

- **References:** `design.md` §3.12, §6 PR 6.3; actual `scripts/academy/build-lesson-index.ts`, `packages/db/src/schema/academy-content.ts`, `scripts/ci/json-data-allowlist.ts`.
- **Finding:** Legacy JSON lesson files under `packages/academy/` are frozen in `PENDING_JSON_DATA`; adding 25 new JSON lesson files fails `bun run test:json-data`.
- **PROPOSE FIX:** Specify authoring the 17 manuals + 8 concepts as a **database-backed Academy course** using TypeScript spec modules under `scripts/academy/` imported via `bun run vertex:academy:import` into `academy_lesson_specs` / `academy_lesson_sources` (zero JSON files).

### R6 (High) — `scripts/flow/tick.ts` mischaracterized as IBKR collector / DB writer

- **References:** `design.md` §5.3, §6 PR 4.1; actual `scripts/flow/tick.ts`, `packages/api/src/server/flow-collect.ts`, `packages/api/src/contracts/flow.ts` (`FLOW_SYMBOLS = ["SPY", "ES", "QQQ", "NQ"]`), `packages/db/src/server/flow.ts`.
- **Finding:** `scripts/flow/tick.ts` is a thin HTTP scheduler wrapper calling `flow.collect` over oRPC; it never reads IBKR or writes Postgres directly. `FLOW_SYMBOLS` does not include `YM` or `RTY`.
- **PROPOSE FIX:** Target `packages/api/src/server/flow-collect.ts`, `packages/db/src/server/flow.ts`, and `packages/api/src/contracts/flow.ts` (`FLOW_SYMBOLS`), keeping `scripts/flow/tick.ts` strictly as the HTTP oRPC scheduler caller.

### R7 (Medium) — Proposed "packages/api/src/ports/" directory does not exist and lacks server/browser boundary

- **References:** `design.md` §4, §5.1; `ARCHITECTURE.md`; `biome.jsonc`.
- **PROPOSE FIX:** Follow DarkFactory conventions (and align with `Z1` by removing premature port directories until a paid vendor is approved; keep server-only ingestion boundaries inside Drizzle tables / `@darkfactory/api/server`).

### R8 (Medium) — Section 6 contract filenames use camelCase instead of repo kebab-case

- **References:** `design.md` §6; actual `packages/api/src/contracts/`.
- **PROPOSE FIX:** Use exact kebab-case filenames (`market-monitor.ts`, `macro-catalog.ts`, `sector-rotation.ts`, `options-analytics.ts`, `smart-money.ts`, `breadth-90.ts`) while keeping camelCase for `appContract` router keys.

### R9 (Medium) — Hardcoded enum allowlists in `openbb.ts`, `rows.py`, `scripts/openbb/tick.ts`, and `OPENBB_CORE7` cap

- **References:** `packages/api/src/contracts/openbb.ts` (`OPENBB_VOL_INDEX_IDS`, `OPENBB_PRICE_SERIES_KINDS`, `OPENBB_JOBS`, `OPENBB_TABLES`, `OPENBB_JOB_TABLES`, `OpenbbIvPercentileSchema`), `services/openbb/vertex_openbb/rows.py`, `scripts/openbb/tick.ts`.
- **PROPOSE FIX:** Add an explicit checklist in §5.3 and every ingestion PR to update synchronized allowlists across `rows.py`, `openbb.ts`, `scripts/openbb/tick.ts`, and `OpenbbIvPercentileSchema.underlying`.

### R10 (Medium) — Existing freshness infrastructure (`openbb_ingest_runs`, `price_freshness_state`) not reconciled

- **References:** `packages/db/src/schema/openbb.ts`, `packages/db/src/schema/openbb-freshness.ts`, `packages/api/src/contracts/price-freshness.ts`.
- **PROPOSE FIX:** Reuse and extend `openbb_ingest_runs`, `price_freshness_state`, and `breadth90_status` as the unified freshness read model instead of adding a duplicate `feed_freshness_runs` table.

### R11 (Medium) — `shiller.py` does not parse CAPE/dividends/CPI and no direct OECD SDMX client exists

- **References:** `services/research/shiller.py`; `services/openbb/vertex_openbb/jobs/series.py`.
- **PROPOSE FIX:** Reclassify `shiller-cape` as Buildable `$0` (extending `shiller.py` to parse dividends, CPI, real price, and CAPE); note that `services/openbb` currently uses `openbb_oecd` for `OECD_CLI_USA` and will add direct OECD/FRED series ingestion.

### R12 (Medium) — Section 3.11 Economic Directory arithmetic does not sum

- **References:** `design.md` §3.11.
- **PROPOSE FIX:** Machine-reconcile all 10 source-family rows to exact `154 = 12 Present + 139 Free + 3 Caveat`.

### R13 (Medium) — CI gate compatibility hazards (`report.html` Biome 2.5.15, `.json` URLs in `services/openbb/`, `merge-conditions.ts` `risk`/`cap` filenames)

- **References:** `report.html`, `biome.jsonc`, `scripts/ci/json-data.ts`, `scripts/ci/merge-conditions.ts`.
- **PROPOSE FIX:** Convert `report.html` inline `<script>` to arrow functions + template literals and verify Biome passes cleanly; document `# json-data-ignore:` for third-party `.json` API URLs in Python jobs and `merge-conditions.ts` filename triggers (`risk`, `cap`) + `Agent review: <40-char SHA>` in §7.

### R14 (Low) — Baseline repo counts, component paths, palette count, `capabilities.yaml`, and SVG font stack

- **PROPOSE FIX:** Update baseline counts to `88` non-test contract files (`65` `appContract` keys), `34` schema files, `79` `page.tsx` routes (`64` portal); cite `apps/web/src/components/portal/futures-oi-panel.tsx`, `apps/web/src/components/portal/flow-strike-heatmap-panel.tsx`, and `docs/vertex-rebuild/flow-pipeline.md`; cite `THEME_NAMES` (`system` + `default-light` + `default-dark` + 9 named palettes); keep `capabilities.yaml` strictly wired-only; prepend `"Public Sans", "Manrope"` in all 4 SVGs.
