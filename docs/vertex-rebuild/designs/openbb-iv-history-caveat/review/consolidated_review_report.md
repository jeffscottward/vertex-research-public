# Goldfish Consolidated Review Report

![OpenBB IV history caveat: before and proposed behavior](../openbb-iv-history-caveat.svg)

**Mode:** Full consolidated review with all supplied rubrics  
**Target:** `docs/vertex-rebuild/designs/openbb-iv-history-caveat/openbb-iv-history-caveat.md` (lines 1–178)  
**Inputs:** Stage 5 Zoom Out, Stage 6 Comprehension, Stage 7 Critic, Stage 8 Intermediate Zoom Out, Stage 9 Implementation Readiness. Only findings in these five artifacts are included. Line numbers below refer to the target document, not the stage reports.

## Reviewer Status by Stage

| Stage | Reviewer | Status |
| --- | --- | --- |
| 5 — Zoom Out | `egm-zoom-out` | completed |
| 5 — Zoom Out | `egm-inventive-catalyst` | completed |
| 6 — Comprehension | `egm-comprehension` | completed |
| 7 — Critic | `egm-design` | completed |
| 7 — Critic | `egm-structural` | completed |
| 7 — Critic | `egm-style` | completed |
| 8 — Intermediate Zoom Out | `egm-zoom-out` | completed |
| 9 — Implementation Readiness | `egm-implementation-readiness` | completed |
| 9 — Implementation Readiness | `egm-codebase-details` | completed |
| 9 — Implementation Readiness | `egm-style` | completed |

## Prioritized Findings

Disposition records the supplied resolution instruction: apply every **PROPOSE FIX**; preserve **CONTEST** and **DECLINE** as recorded; only a genuine owner-only factual issue is **ESCALATE**. No stage finding supplies a CONTEST or DECLINE disposition, and no finding here requires an owner-only fact beyond the expressly pending KB gate. Therefore all actionable fixes are PROPOSE FIX; provisional KB-dependent mappings remain gated, not settled.

### 1. Legacy row source/cutoff and row-to-run mapping are not proven — Severity: Major — **PROPOSE FIX**

* **Reviewer provenance:** Stage 5 `egm-zoom-out`; Stage 6 `egm-comprehension`; Stage 7 `egm-design`, `egm-structural`; Stage 8 `egm-zoom-out`; Stage 9 `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`.
* **Affected scope:** 39–40, 71, 89, 118, 154–155, 157.
* **Discrepancy:** The pre-fallback cutoff assigns Cboe based on quote `asOf`, which does not prove the date a Yahoo fallback was written. For later rows, marker format/predicate, New York date mapping, qualifying run status and completeness, source-to-row correlation, ordering/ties, later Cboe proof, and multiple/partial-run reconciliation are not reproducibly specified. Aggregate counts and warning text do not establish a particular surviving row's source.
* **Rationale & recommendation:** Keep this mapping provisional pending the approved KB consultation. Define an evidence-based row/run mapping and deterministic treatment of partial, superseding, ambiguous, and tie cases before implementation; use `unknown` unless exact row-level evidence proves source. Do not infer Cboe from absence of a Yahoo warning. A date cutoff alone is not provenance evidence.

### 2. Audit timestamp semantics and ledger evidence are underspecified — Severity: Major — **PROPOSE FIX**

* **Reviewer provenance:** Stage 5 `egm-zoom-out`; Stage 6 `egm-comprehension`; Stage 7 `egm-design`; Stage 9 `egm-implementation-readiness`, `egm-codebase-details`, `egm-style` (overlap with Finding 1 is limited to shared ledger field definitions; this is a distinct audit-timestamp contract).
* **Affected scope:** 48, 72, 91, 111, 117, 157–158, 160–161.
* **Discrepancy:** `lastFallbackAt`'s definition as run metadata is distinct from proof of a surviving row, but the exact marker/status fields, zero-write/skip handling, partial-then-complete behavior, same-key later Cboe overwrite, multiple underlyings, `null` semantics, and equal-`finishedAt` tie behavior are not defined. A newer positive partial run returning null does not establish whether an earlier timestamp is invalidated or what the field represents.
* **Rationale & recommendation:** Keep timestamp policy provisional pending the approved KB consultation. State whether the field means a latest confirmed fallback attempt or a fallback write currently surviving in a row; define exact ledger evidence and partial/superseding-run rules consistently with its audit-only role. Do not use it as row membership or caveat-clear evidence.

### 3. Public status disclosure and security rationale are missing — Severity: Major — **PROPOSE FIX**

* **Reviewer provenance:** Stage 7 `egm-structural`; Stage 8 `egm-zoom-out`.
* **Affected scope:** 73, 128–132.
* **Discrepancy:** Raw row source is kept private, while `historyState` and `lastFallbackAt` are exposed, but the access/disclosure implications, access-control assumption, and mitigation (or reason additional controls are unnecessary) are not stated.
* **Rationale & recommendation:** Explicitly assess what the public state and audit timestamp disclose, document the applicable access-control assumption and mitigation, and keep raw per-row source out of public results as specified.

### 4. Alternatives comparison lacks concrete trade-offs — Severity: Major — **PROPOSE FIX**

* **Reviewer provenance:** Stage 7 `egm-design`, `egm-structural`.
* **Affected scope:** 99–107.
* **Discrepancy:** The section refers to missing concept-brief headings, “post-merge Concept synthesis tensions,” and “current-base evidence”; alternatives are labeled rejected without consistently comparing technical and scope costs/benefits. Append-only ledger and sidecar provenance need clearer contrast with inline source.
* **Rationale & recommendation:** Make this an explicit, self-contained comparison. Remove or explain drafting jargon and state concrete costs, benefits, and scope trade-offs against inline row source, including the event-ledger and sidecar alternatives.

### 5. Non-goal conflicts with audit-ledger use — Severity: Nit — **PROPOSE FIX**

* **Reviewer provenance:** Stage 7 `egm-style`.
* **Affected scope:** 39, 48, 72.
* **Discrepancy:** The non-goal limits exact ledger evidence to one-time legacy backfill, while the plan also uses the ledger to derive `lastFallbackAt`.
* **Rationale & recommendation:** Narrow the non-goal to ledger evidence for current-sample membership/clean labeling, and explicitly permit the separate audit-timestamp use, subject to the KB gate.

### 6. Performance threshold is not actionable — Severity: Nit — **PROPOSE FIX**

* **Reviewer provenance:** Stage 7 `egm-design`.
* **Affected scope:** 97, 132.
* **Discrepancy:** “No index unless measured need” has no baseline or threshold for query-plan/latency regression.
* **Rationale & recommendation:** State the measurement baseline and an actionable threshold that would trigger reconsidering an index or query change; do not invent a threshold before defining its evidence basis.

### 7. Verification procedures lack actionable references — Severity: Nit — **PROPOSE FIX**

* **Reviewer provenance:** Stage 6 `egm-comprehension`.
* **Affected scope:** 175.
* **Discrepancy:** Graphify checks, `egm-drift-report`, and full verification have no commands or links, so a reader cannot determine how to run them or what constitutes a pass.
* **Rationale & recommendation:** Add reproducible commands or references and pass criteria for each listed verification procedure.

### 8. Unsupported predecessor reconciliation judgment — Severity: Nit — **PROPOSE FIX**

* **Reviewer provenance:** Stage 7 `egm-style`.
* **Affected scope:** 113.
* **Discrepancy:** “Predecessor reconciliation: No contradiction” asserts a conclusion despite unresolved KB, partial-write, and legacy-mapping decisions in the same paragraph.
* **Rationale & recommendation:** Remove the unsupported judgment and state only concrete changes and remaining unresolved decisions.

### 9. Failed, zero-row, and skipped fallback test outcomes are ambiguous — Severity: Major — **PROPOSE FIX**

* **Reviewer provenance:** Stage 9 `egm-style`.
* **Affected scope:** 148–151.
* **Discrepancy:** Tests are asked to assert source for failed, zero-row, and skipped fallback cases even though those cases may emit no daily row; expected row/source outcomes are unclear.
* **Rationale & recommendation:** For each case state whether a row is expected. If one exists, assert its source; if none is emitted, assert an empty result and the relevant run/ledger outcome, not an invented row source.

### 10. Plan lacks phased, verifiable checkpoints — Severity: Major — **PROPOSE FIX**

* **Reviewer provenance:** Stage 9 `egm-codebase-details`, `egm-style`.
* **Affected scope:** 146–175.
* **Discrepancy:** Steps 1–7 form one implementation list rather than stable, buildable/testable phases. Documentation, generated artifacts, verification, review, and PR readiness are bundled without per-phase commands or pass criteria.
* **Rationale & recommendation:** Split into dependent phases (for example ingestion/schema+migration, repository/API, UI/docs, final verification). For each checkpoint give focused commands, expected result, and pass criteria; make generated-artifact checks, Graphify, drift report, full verification, and fresh-context review separate gates.

### 11. Planned file paths lack Create/Modify/Delete labels — Severity: Major — **PROPOSE FIX**

* **Reviewer provenance:** Stage 9 `egm-codebase-details`.
* **Affected scope:** 148–175.
* **Discrepancy:** Listed paths do not identify whether each is created, modified, or deleted, including migration metadata and generated outputs.
* **Rationale & recommendation:** Label every planned path Create, Modify, or Delete, including migration SQL, `packages/db/migrations/meta/_journal.json`, the numbered snapshot, generated `packages/api/openapi.json`, tests, and documentation. Remove Delete where no deletion is intended and leave no path unclassified.

### 12. Migration/OpenAPI generator commands and numbered artifacts are missing — Severity: Major — **PROPOSE FIX**

* **Reviewer provenance:** Stage 9 `egm-codebase-details`, `egm-style`.
* **Affected scope:** 154, 170.
* **Discrepancy:** “Generate the next numbered migration” and “with the repository generator” are not reproducible instructions and omit concrete journal/snapshot paths. The stage report records the current sequence ending at `0090_golive_single_leg.sql`.
* **Rationale & recommendation:** Specify `pnpm db:generate` for Drizzle, the next path form `packages/db/migrations/0091_<descriptive_name>.sql`, the numbered snapshot in `packages/db/migrations/meta/`, and journal update at `packages/db/migrations/meta/_journal.json`; record the actual generated name/snapshot after generation rather than guessing it. Specify `pnpm openapi:generate` and verify with `pnpm openapi:check`.

### 13. Sample return shape should be described accurately — Severity: Nit — **PROPOSE FIX**

* **Reviewer provenance:** Stage 5 `egm-zoom-out`.
* **Affected scope:** 70 and the `optionIvDaily` storage/sample description.
* **Discrepancy:** The query returns all table columns plus an internal `session` ranking field, which is stripped before rows are returned; a subset-only description is inaccurate.
* **Rationale & recommendation:** Say returned rows contain all table columns and the internal ranking field is removed before return.

### 14. Sample ordering and inclusive 252nd-row boundary are not fully defined — Severity: Nit — **PROPOSE FIX**

* **Reviewer provenance:** Stage 9 `egm-codebase-details`.
* **Affected scope:** 21, 70, 92, 161–162.
* **Discrepancy:** The plan names a 252nd-row boundary but not ordering or exact newest-252 selection/inclusion rule. The handler uses `optionIvDaily(...)`, computes percentile from returned rows, and selects latest with `rows.at(-1)`.
* **Rationale & recommendation:** Specify `optionIvDaily` ordering, define the exact newest 252 rows and whether the 252nd is included, and test a known 253-row fixture so sample membership, percentile, and latest selection are unambiguous.

## Traceability Matrix

Each source finding is mapped once to its consolidated item. “PROPOSE FIX” is the resolution disposition; the legacy/timestamp policy details remain provisional until KB consultation. The Stage 8 security finding cites an earlier report finding that is not present in the supplied Stage 5 detailed findings; it is retained as Stage 8's own reported issue, not represented as an additional Stage 5 finding.

| Stage artifact | Source finding | Consolidated item | Proposed action |
| --- | --- | --- | --- |
| Stage 5 `zoom_out_report.md` | Backfill cutoff does not prove actual row source | 1 | PROPOSE FIX |
| Stage 5 `zoom_out_report.md` | Aggregate run metadata cannot establish row-level fallback provenance | 1, 2 | PROPOSE FIX — row proof vs run timestamp remain separate |
| Stage 5 `zoom_out_report.md` | Sample return shape should be described accurately | 13 | PROPOSE FIX |
| Stage 5 `zoom_out_report.md` | `egm-inventive-catalyst`: no false compromise reported | — | No finding / no action |
| Stage 6 `comprehension_report.md` | Legacy-row backfill criteria are not reproducible | 1 | PROPOSE FIX |
| Stage 6 `comprehension_report.md` | Audit timestamp evidence is underspecified | 2 | PROPOSE FIX |
| Stage 6 `comprehension_report.md` | Verification procedures lack actionable references | 7 | PROPOSE FIX |
| Stage 7 `critic_report.md` | Legacy-row evidence and migration outcomes are underspecified | 1 | PROPOSE FIX |
| Stage 7 `critic_report.md` | `lastFallbackAt` semantics do not resolve partial and superseding runs | 2 | PROPOSE FIX |
| Stage 7 `critic_report.md` | Security implications and mitigations are absent | 3 | PROPOSE FIX |
| Stage 7 `critic_report.md` | Alternatives comparison lacks concrete trade-offs | 4 | PROPOSE FIX |
| Stage 7 `critic_report.md` | Non-goal conflicts with later ledger use | 5 | PROPOSE FIX |
| Stage 7 `critic_report.md` | Performance review threshold is not actionable | 6 | PROPOSE FIX |
| Stage 7 `critic_report.md` | Unsupported predecessor reconciliation judgment | 8 | PROPOSE FIX |
| Stage 8 `intermediate_zoom_out_report.md` | Legacy backfill still cannot establish row provenance | 1 | PROPOSE FIX |
| Stage 8 `intermediate_zoom_out_report.md` | Security and disclosure rationale is unstated | 3 | PROPOSE FIX |
| Stage 9 `implementation_readiness_report.md` | Migration provenance mapping and audit-run selection are underspecified | 1, 2 | PROPOSE FIX — keep KB-dependent mapping/timestamp provisional |
| Stage 9 `implementation_readiness_report.md` | Plan lacks staged, verifiable checkpoints | 10 | PROPOSE FIX |
| Stage 9 `implementation_readiness_report.md` | No expected row/source outcomes for failed, zero-row, or skipped fallback cases | 9 | PROPOSE FIX |
| Stage 9 `implementation_readiness_report.md` | Planned file paths have no Create/Modify/Delete actions | 11 | PROPOSE FIX |
| Stage 9 `implementation_readiness_report.md` | Migration and OpenAPI generation commands and numbered artifacts are not specified | 12 | PROPOSE FIX |
| Stage 9 `implementation_readiness_report.md` | Sample ordering and 252nd-row boundary test are not fully defined | 14 | PROPOSE FIX |

## Counts and Next Gate

**Consolidated findings:** 14 total — **0 Blockers, 8 Major, 6 Nit**.  
**Disposition counts:** 14 PROPOSE FIX; 0 CONTEST; 0 DECLINE; 0 ESCALATE.  
**Reviewer status:** 10 completed entries across the five requested stages; none marked not run in the supplied artifacts.  
**Original next gate (completed after this review):** At review time, apply the fixes while keeping method and legacy mapping provisional, consult the two approved origins, and resolve the task-claim question before implementation.
**Post-review status:** The consultation is complete; neither KB answer provided relevant source-backed guidance. The task decision selected the fixed two-origin boundary without a separate claim. Implementation is complete. Full verification passed before the final SQL suffix correction; focused DB unit and Postgres tests pass after it, and final full verification remains pending.
