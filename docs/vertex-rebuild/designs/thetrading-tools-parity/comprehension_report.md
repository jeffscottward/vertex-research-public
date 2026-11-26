# Stage 6 Review: Comprehension Audit

- **Reviewer:** Fresh-context Goldfish subagent (`egm-comprehension`)
- **Date:** 2026-11-24
- **Target:** `concepts_brief.md`, `design.md` (draft v1), `before-after.svg`, `capability-matrix.svg`, `data-flow.svg`, `rollout-roadmap.svg`, `report.html`
- **Verdict:** Needs Revisions before Implementation Handoff — 6 High, 5 Medium, 1 Low findings.

## Numbered Findings (`K1`–`K12`)

### K1 (High) — Section 3.11 Economic Data Directory table rows sum to 145 (24/119/2) instead of 154 (21/131/2)

- **References:** `design.md` §3.11, §4 L5; `report.html` `/economy` and `/mortgage-rate` rows.
- **Finding:** Summing the 10 rows yields `145` total (`24` present, `119` buildable, `2` caveats), contradicting the footer (`154 = 21 + 131 + 2`). `L5` names 3 routes (`/move-index`, `/existing-home-sales`, `/existing-home-months-supply`) while claiming `2` caveats. `report.html` cites `28` stored series without bridging to the `154` directory overlap.
- **PROPOSE FIX:** Machine-reconcile all 154 directory slugs into 10 exact disjoint families summing to `154` (`Present + Free + Caveat = 154`), align `L5` to `3` caveats, and bridge stored series counts cleanly across all artifacts.

### K2 (High) — `concepts_brief.md` holds pre-reconciliation totals (`361` pages, `140` tools, `11` domains, `~86%`)

- **References:** `concepts_brief.md` §1/§2; `design.md` §1.
- **Finding:** `concepts_brief.md` reports `361` URLs and `~86%`, while `design.md` reconciles `366` live canonical pages (`361` sitemap + `5` `/tools`-only live pages), `146` tools across `12` domains, and `82.2%` exact `$0` parity (`120/146`). `design.md` phrasing around `/chart` makes it ambiguous whether `/chart` is inside or outside the `146`.
- **PROPOSE FIX:** Update `concepts_brief.md` to the reconciled `366` / `146` / `12` / `82.2%` totals and explicitly state `/chart` is counted inside the `146`.

### K3 (High) — `design.md` Section 3 tabulates 143 tools across 10 headings instead of 146 across 12 domains

- **References:** `design.md` §3.1–3.11; `capability-matrix.svg`; `report.html`.
- **Finding:** Global (10) and Crypto (3) are merged into §3.10, and the 3 macro hubs (`/economic-calendar`, `/economy`, `/mortgage-rate`) appear only in prose without Status/Wave tags, leaving §3.1–3.10 at `143` rows.
- **PROPOSE FIX:** Split Global (§3.10) and Crypto (§3.11), add an explicit 3-row Economic Hubs table (§3.12), and renumber the 154-series breakdown and static/subpage mapping so §3.1–3.12 tables sum natively to `146` across `12` domains.

### K4 (High) — Wave 3 vs Wave 6 contradiction on 154 economic series and unassigned ingestion jobs

- **References:** `design.md` §1, §3.3, §3.10, §3.11, §5.3, §6; `rollout-roadmap.svg`; `capability-matrix.svg`; `report.html`.
- **Finding:** Prose and `rollout-roadmap.svg` claim all `154` economic series ship in Wave 3 while SEC XBRL ad-revenue series ship in Wave 6. Four required feeds (NY Fed HHDC, FINRA monthly margin debt, World Bank gold CSV, CFTC Weekly Swaps) have no assigned job in §5.3/§6.
- **PROPOSE FIX:** Reconcile economic series delivery counts per wave across every artifact and assign explicit ingestion jobs for every required feed.

### K5 (Medium) — `capability-matrix.svg` omits target waves on 3 domains; `design.md` L145 has unescaped pipes

- **References:** `capability-matrix.svg`; `design.md` §3.4 `/range-efficiency`.
- **Finding:** `capability-matrix.svg` wave pills omit waves for Sentiment, Valuation, and Stocks; `design.md` L145 writes `|C−O|/(H−L)` unescaped inside a Markdown table cell, breaking GFM rendering and `markdownlint-cli2` (`MD056`).
- **PROPOSE FIX:** Update all wave pills in `capability-matrix.svg` to match the revised wave plan and replace `|C−O|/(H−L)` with `abs(C - O) / (H - L)`.

### K6 (Medium) — Wave counts absorb 19 already-parity tools starting from 0

- **References:** `before-after.svg`, `rollout-roadmap.svg`, `design.md` §6, `report.html`.
- **Finding:** Counting the `19` baseline `PARITY` tools inside Wave delivery counts (`+39`, `+24`, ...) implies starting from `0/146` instead of `19/146`.
- **PROPOSE FIX:** Display both **net-new/upgraded (`127`)** and **baseline verified (`19`)** per wave so cumulative progress visibly starts from `19/146` and ends at `146/146`.

### K7 (Medium) — Portal surface counts (`6` vs `7` vs `10`) and limitation/port counts (`4` vs `5`) disagree

- **References:** `before-after.svg`, `data-flow.svg`, `design.md` §1/§4/§5.5, `report.html`.
- **Finding:** Existing upgraded route counts vary between 6, 7, and 10 across files, and `report.html` claims all 5 limitations have swappable ports when L5 does not.
- **PROPOSE FIX:** Standardize the exact list of new and upgraded existing routes and align limitation/upgrade seam language across every file.

### K8 (High) — Section 5.4 formulas, bounds, and state partitions are under-specified

- **References:** `design.md` §3.3, §5.4.
- **Finding:** Market Repair Flow's 4 states overlap and leave gaps; Volatility Outlook L129 lists 9 items vs L370's 10 and conflates min–max scaling with empirical percentile rank; normalization bounds, score-band cutoffs, Fear & Greed parameters, Macro Panel 15-ticker driver mapping, and edge-case rules for McClellan/Zweig/Hindenburg/Titanic/BPI/SPY triggers are omitted.
- **PROPOSE FIX:** Add a complete Formula & Parameter Specification covering mutually exclusive Market Repair Flow predicates, empirical 1,260-day percentile ranks, exact 15-instrument Macro Panel mapping, fixed bounds/quorums for Clocks & Fear & Greed, and deterministic edge-case rules.

### K9 (High) — Cross-wave data dependency inversions

- **References:** `design.md` §3.2, §3.5, §5.2, §5.6, §6.
- **Finding:** Wave 2 heatmap/short-interest referenced Wave 6 XBRL share counts; Wave 2 omitted Ken French 49 and DIA/IWM holdings; Waves 1–4 depended on Wave 5 freshness storage.
- **PROPOSE FIX:** Promote freshness tracking to Wave 1 (reusing `openbb_ingest_runs` + `price_freshness_state`); source Wave 2/4 constituent weights from holdings snapshots + reference metadata without depending on XBRL; assign Ken French and DIA/IWM holdings in the same wave that consumes them.

### K10 (Medium) — Freshness-gate 1-session boundary gap, ET cutoffs, and Proxy metadata contract

- **References:** `design.md` §5.5, §5.6.
- **Finding:** Lag of exactly 1 session sits in limbo between `fresh` (`lag === 0`) and `stale` (`lag > 1`); per-feed ET publish cutoffs, slow-cadence SLAs, and standardized `ProxyMetadataSchema` covering `universe`, `history`, and `benchmark` proxies are missing.
- **PROPOSE FIX:** Add a concise Freshness Gate Rules table (`expected_session` via `publishCutoffEt`, exact `lag === 0` vs `lag >= 1` rules, `partial < 95%`, cadence SLAs) and a standardized `ProxyMetadataSchema` Zod contract.

### K11 (Medium) — Orphaned tools in Section 6, missing canonical ticker rosters, overloaded PR 4.1, linear roadmap arrows

- **References:** `design.md` §3, §6; `rollout-roadmap.svg`.
- **Finding:** Several tools in §3 lacked explicit UI/PR entries in §6; multi-ETF counts lacked canonical ticker rosters; PR 4.1 was overloaded; `rollout-roadmap.svg` drew strictly linear arrows instead of the real parallel wave DAG.
- **PROPOSE FIX:** Account for every tool in the revised vertical PR plan, include a Canonical Universe & Roster Table for multi-instrument tools, split overloaded ingestion PRs, and draw the true parallel DAG in `rollout-roadmap.svg`.

### K12 (Low) — Undefined acronyms, `pnpm db:generate` vs `bun run db:generate`, minor SVG pixel alignment

- **References:** `design.md` §5.2 (`pnpm db:generate`); `data-flow.svg`; `capability-matrix.svg`.
- **Finding:** `design.md` used `pnpm db:generate` instead of `bun run db:generate` (`AGENTS.md`); numerous domain acronyms (`RANA`, `MMTW`/`MMFI`/`MMTH`, `VIXEQ`, `COR3M`, `SBSR`, `WNGSR`, `HHDC`, etc.) were unexpanded; `capability-matrix.svg` economic bar extended 2px past alignment.
- **PROPOSE FIX:** Change to `bun run db:generate`, add a concise Glossary & Ticker-Code Legend, and align SVG bar widths cleanly.
