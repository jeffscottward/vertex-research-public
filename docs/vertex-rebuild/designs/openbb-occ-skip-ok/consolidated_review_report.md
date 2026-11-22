# Consolidated EGM Goldfish Review Report — `openbb-occ-skip-ok`

- **Target Document:** `docs/vertex-rebuild/designs/openbb-occ-skip-ok/plan.md`
- **Review Mode:** Consolidated report with all review rubrics (standing owner rule 2026-11-18)
- **Reviewers (fresh-context goldfish subagents):**
  - Stage 5: `egm-zoom-out`, `egm-inventive-catalyst`
  - Stage 6: `egm-comprehension` (document-only, no external files)
  - Stage 7: `egm-design`, `egm-structural`, `egm-style`
  - Stage 9: `egm-implementation-readiness`, `egm-codebase-details`

## Consolidated Findings by Priority

### Blocker

- **F1 — Missing `## Alternatives Considered` section** (Design Critic #1, Structural #1): `feature-spec-standard.md` requires an explicit evaluation of viable architectural alternatives with concrete trade-offs (producer-side `stderr` info, structured `notes`/`info` field in `openbb-batch.v1` + DB migration, shared constant in `packages/api/src/contracts/openbb.ts`, vs. `tick.ts` single-job filter).
- **F2 — Non-existent repository path and unlinked external references** (Design Critic #2, Structural #2, Zoom Out #5, Comprehension #3): the gamma-flip-sources design doc (unmerged branch) does not exist on this branch, and tracker/workflow jargon (`card note`, `claimed by openbb-iv-history-caveat`, `EGM`, `pr-visual`, `ci-gate`, `scripts/merge-pr`) is undefined for a fresh reader.

### Major

- **F3 — Factual inaccuracies on UI consumers and Cboe vs. Yahoo skip semantics** (Design Critic #4, Zoom Out #1, Comprehension #6): Portal panels (`apps/web/src/features/openbb/openbb-panels.tsx`) do not display raw `run.warnings`; the real consumers are `openbb_ingest_runs`, `openbb.status` API, and MCP `openbb_status` (`packages/api/src/server/mcp.ts`). In addition, Cboe's `options_math.parse_contracts` also increments `skipped` on invalid OCC calendar dates (Yahoo additionally skips missing/non-positive strikes and is already a `partial` fallback path).
- **F4 — Risks hierarchy, missing downstream surfaces, doc follow-up, and single-job ceiling** (Structural #3, Design Critic #5): Promote `### Risks and Mitigations` to peer H2 `## Risks and Limits`; include MCP `openbb_status`, `--dry-run`/`stderr` warning-count ergonomics, follow-up obligation for `docs/vertex-rebuild/openbb.md`, and an explicit single-job architectural ceiling so `tick.ts` never accumulates an ad-hoc regex allowlist.
- **F5 — Underspecified `recordOutcome`/`statusOf` control flow and Yahoo session guard terms** (Comprehension #1, #2): Clarify `recordBlocked` (`blocked_upstream`) vs. `recordOutcome` (`document === null` -> `failed`, else `statusOf`), why `document` is non-null at `statusOf` but optional-chained at `recordRun`, exit codes for CUJ 2 and CUJ 3, `"every table is empty"` as a warning entry, and the string value `"used the Yahoo option chain"` for `OPENBB_YAHOO_FALLBACK_NOTE` / `YAHOO_FALLBACK_NOTE` plus how the Yahoo session guard reads prior runs.
- **F6 — Code-level implementation details duplicated in high-level sections** (Zoom Out #3): Keep `Overview` and `Technical Plan (Architecture)` at component/contract/data-flow altitude and move regex literals, function signatures, and call-site code solely to `Detailed Implementation Plan`.
- **F7 — Reuse `TICKER_SYMBOL_PATTERN`, keep `statusOf` job-agnostic, drop unnecessary export and brittle `.py` source scraping** (Zoom Out #2, #4, #6, Design Critic #6): Reuse `TICKER_SYMBOL_PATTERN` from `packages/api/src/contracts/openbb.ts` instead of duplicating `[A-Z0-9.^=-]{1,16}`; keep `statusOf(outcome, warnings)` job-agnostic with filtering in `recordOutcome`; keep the regex private and test through `runOpenbbTick`; replace raw Python `.py` file scraping in Vitest with explicit behavior tests matching existing repo conventions.
- **F8 — Producer-side channel split vs. `tick.ts` classifier** (Inventive Catalyst #1, Zoom Out #1): Evaluates moving classification to `cboe.py`/`openbb-batch.v1` or `packages/api/src/contracts/openbb.ts` vs. `tick.ts`.
- **F9 — Unbounded skip count `[1-9]\d*` could mask partial format drift** (Inventive Catalyst #2, Design Critic #3): If a Cboe format change drops most contracts while leaving at least one valid contract, `no unexpired contracts` does not fire and `status` still records `ok`.

### Nit

- **F10 — Style, structure, and verification precision nits** (Style #1–4, Structural #4–5, Comprehension #4–6, Codebase Details #1, Implementation Readiness #1): Fix "21-character" -> "16-to-21-character" OCC length and add path `services/openbb/vertex_openbb/options_math.py`; replace "writes all rows cleanly" and colloquial "on purpose"; narrow Security/Safety bullet; convert `Terms:` to `### Terms`, group `## Goals & Non-Goals`, drop empty `## Open Questions`; give exact single-file coverage command (`--coverage --coverage.include=scripts/openbb/tick.ts`) and `bun run verify:coverage`.

## Traceability Matrix

| Consolidated ID | Priority | Source Findings |
| --- | --- | --- |
| F1 | Blocker | Design Critic #1, Structural #1 |
| F2 | Blocker | Design Critic #2, Structural #2, Zoom Out #5, Comprehension #3 |
| F3 | Major | Design Critic #4, Zoom Out #1, Comprehension #6 |
| F4 | Major | Structural #3, Design Critic #5 |
| F5 | Major | Comprehension #1, Comprehension #2 |
| F6 | Major | Zoom Out #3 |
| F7 | Major | Zoom Out #2, Zoom Out #4, Zoom Out #6, Design Critic #6 |
| F8 | Major | Inventive Catalyst #1, Zoom Out #1 |
| F9 | Major | Inventive Catalyst #2, Design Critic #3 |
| F10 | Nit | Style #1–4, Structural #4–5, Comprehension #4–6, Codebase Details #1, Impl Readiness #1 |
