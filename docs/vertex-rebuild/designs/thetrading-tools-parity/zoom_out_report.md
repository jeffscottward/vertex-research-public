# Stage 5 Review: Initial Zoom Out and Inventive Catalyst

- **Reviewer:** Fresh-context Goldfish subagent (`egm-zoom-out-catalyst`)
- **Date:** 2026-11-24
- **Target:** `concepts_brief.md`, `design.md` (draft v1), `before-after.svg`, `capability-matrix.svg`, `data-flow.svg`, `rollout-roadmap.svg`
- **Verdict:** Conditional Hold — revise scope, sequencing, scraper isolation, and clock history architecture before implementation.

## Part 1: Initial Zoom Out Findings (`Z1`–`Z7`)

### Z1 (High) — Speculative paid-adapter code and premature ports violate AGENTS.md Rules 12, 11, and 4

- **References:** `concepts_brief.md` §2/§4; `design.md` §4, §5.1, §6 PR 2.1/4.1/6.1–6.2; `data-flow.svg`; `rollout-roadmap.svg`.
- **Finding:** Creating 4 premature port interfaces in a non-existent `ports/` directory and wiring disabled Polygon/ORATS/Databento adapters in PR 6.1 and `capabilities.yaml` introduces speculative dead code under 100% coverage ratchet. Drizzle Postgres tables stamped with `source_provider` and `universe_scope` already serve as the decoupling boundary between ingestion and pure TypeScript read engines.
- **PROPOSE FIX:** Remove disabled paid adapters and the 4 speculative port files from the implementation waves; retain §4 strictly as an owner-gated upgrade playbook and use Drizzle tables with provenance metadata as the seam.

### Z2 (High) — Non-options macro encyclopedia and XBRL accounting dilute options-first parity

- **References:** `design.md` §3.5, §3.9–3.11, §5.3, §6 Waves 3 & 6.
- **Finding:** Treating SEC EDGAR XBRL ad-segment/income-statement pipelines, 154 peripheral economic pages, and retail small-cap equity scanners as equal-priority core deliverables diverts engineering effort away from Vertex's options-only market-structure workflow.
- **PROPOSE FIX:** Partition the 366-page ledger into **Core Options-First Parity (Waves 1–4)** vs **Tier-2 Expansion Backlog (Wave 5, owner opt-in)**; scope Core Macro to the ~35 high-signal series feeding the 4 Clocks, Macro Panel, Volatility Outlook, and Bear Warning Signs, while preserving 100% parity accountability for all remaining pages in Tier-2.

### Z3 (High) — Brittle web-CSV scrapers coupled to a fail-closed freshness gate

- **References:** `design.md` §3.11, §4 L4, §5.3, §5.4, §5.6, §7.
- **Finding:** Packaging 7 ETF issuer websites, 8+ central banks, raw DTCC SBSR logs, and unauthenticated TradingView sessions as "6 focused jobs" coupled to a fail-closed freshness gate invites chronic stale banners. Claiming every non-official feed has a fallback is inaccurate for 5m `$TICK`/`MMTW`.
- **PROPOSE FIX:** Split feeds into **Tier A (Official Structured APIs — gating)** vs **Tier B (Best-Effort Web CSV/WS — non-gating overlay)**; decouple Fear & Greed #8 from 23-issuer CSV scraping (use FRED `WRMFSL` or `SHY`/`BIL` ratio as gating core); consolidate global 10Y yields via FRED/OECD; correct fallback claims in §7.

### Z4 (High) — Structural asymmetry in 4-Clock + Market State Atlas breaks Day-1 `$0` parity

- **References:** `design.md` §1, §3.1, §3.4, §4 L2, §5.4, §6 PR 5.2.
- **Finding:** Four of six Tape Clock inputs depend on `$0` rolling intraday feeds with zero historical archive, rendering Day-1 Market State Atlas analogs impossible at `$0`. Backfilling historical Swing/Cycle constituent breadth from static today-only `SPY` holdings introduces severe survivorship bias.
- **PROPOSE FIX:** Split Tape into **Dual-Mode**: `Tape-EOD` (1995+/2007+ survivorship-free daily inputs powering Day-1 Market State Atlas and score-band base rates at `$0`) plus `Tape-Live` intraday microstructure overlay; restrict historical Swing/Cycle replays to survivorship-free exchange-wide and ETF series.

### Z5 (Medium) — Late/duplicate freshness gate and delayed `/monitor` delivery

- **References:** `design.md` §5.2, §5.6, §6 Waves 1–5; repo `openbb_ingest_runs` and `price_freshness_state`.
- **Finding:** Proposing a new `feed_freshness_runs` table in Wave 5 duplicates existing `openbb_ingest_runs` and `price_freshness_state` and leaves Waves 1–4 ungated. Pushing `/monitor` to Wave 5 delays the highest-leverage decision desk.
- **PROPOSE FIX:** Drop `feed_freshness_runs`; extend existing `openbb_ingest_runs` + `price_freshness_state` in Wave 1 PR 1.1; pull `/monitor` (4-Clock Decision Desk + EOD Atlas) forward into Wave 3.

### Z6 (Medium) — Missing Cloudflare Workers materialization/retention topology and baseline schema drift

- **References:** `design.md` §5.2–5.4; `data-flow.svg`; repo migrations `0000`–`0094`.
- **Finding:** Heavy engines (600-stock P&F BPI, 100×100 pairwise correlation, 33-year replay) lack ingest-time materialization vs Worker-request boundaries; storage retention and `infra/openbb/rig` vs `infra/quantvps` cron ownership are missing; doc cites `0000`–`0022` instead of `0000`–`0094` and non-existent table names (`openbb_daily_series`, `breadth_90_days`).
- **PROPOSE FIX:** Add §5.7 Compute Materialization, Retention & Scheduler Topology and correct all migration and table references to match the live schema.

### Z7 (Low) — Horizontal 3-PR waves create oversized PRs under 100% coverage

- **References:** `design.md` §6; `rollout-roadmap.svg`; `AGENTS.md` Rules 4 & 8.
- **Finding:** Horizontal layer PRs (especially PR 3.1 and PR 4.1) bundle too many unrelated feeds into single mega-PRs.
- **PROPOSE FIX:** Slice PRs vertically by cohesive domain capability (each PR shipping one focused ingestion extension + engine + contract + UI + 100% tests).

## Part 2: Inventive Catalyst Proposals (`C1`–`C3`)

### C1 (High Leverage) — 3-Official-API declarative series registry + lean schema

- **PROPOSE FIX:** Consolidate macro, sovereign yield, delinquency, and housing time series onto FRED keyless CSV + US Treasury Fiscal Data + EIA API v2 (daily/weekly summaries) via a declarative registry writing to existing `openbb_macro_series` / `openbb_macro_points`; cut redundant tables (`feed_freshness_runs`, `signal_base_rate_runs`) to 5 lean core tables (plus optional Tier-2 tables).

### C2 (High Leverage) — Options-first 4-wave core + Dual-Mode Tape Clock + Tier-2 expansion wave

- **PROPOSE FIX:** Sequence **Core Waves 1–4** (12 vertical PRs at `$0/mo`: W1 Freshness/Exchange Breadth/Vol/SPY Base Rates → W2 Options/OCC/Live Tape → W3 Decision Desk/Dual-Mode Atlas/Core Macro → W4 Constituent Breadth/Sector Hubs) + **Tier-2 Expansion Wave 5** (4 vertical PRs covering full 154-series encyclopedia, global/crypto, DTCC SBSR, issuer flows, XBRL, and Academy manuals).

### C3 (Medium-High Leverage) — 4 composable math primitives and 2 cohesive new portal routes

- **PROPOSE FIX:** Consolidate ~20 bespoke engine files into 4 composable primitives (`evaluateTriggerBaseRates`, `scoreCompositeRegime`, `computeRelativeRegime`, `computeCrossSectionalBreadth`) and consolidate 4 new routes/contracts into **2 new top-level routes (`/monitor` with Breadth & Signals tabs, `/macro`)** and **2 new oRPC contracts (`marketMonitor.*`, `macroCatalog.*`)**, folding screening panels into existing `/research/screen` + `/smart-money`.
