# Goldfish Annotated Review Report

![OpenBB IV history caveat: before and proposed behavior](../openbb-iv-history-caveat.svg)

**Target:** `docs/vertex-rebuild/designs/openbb-iv-history-caveat/openbb-iv-history-caveat.md` (lines 1–205)

## Resolution

The full consolidated report contains 14 findings: 8 Major and 6 Nit. All 14 are **PROPOSE FIX**. The owner’s standing resolution rule selects auto-accept without another ask. No finding was contested, declined, or escalated. No feature code had changed when this review closed.

At review time, the approved KB consultation and task identity gate were open. The exact legacy-source mapping and `lastFallbackAt` method were provisional. No KB query or implementation had started. Later approvals completed the two-origin consultation; neither answer provided relevant source-backed guidance. The task decision and final implementation are recorded in the canonical design and private method report.

## Prioritized Findings and Applied Edits

### 1. Legacy row provenance and cutoff — Major — PROPOSE FIX

- **Source:** Stages 5–9.
- **Affected scope:** Overview; Non-Goals; Legacy rows; Open Questions; Phase 1.
- **Justification:** Quote `asOf`, warning text, and aggregate counts do not prove the source of a stored row.
- **Applied edit:** Removed the 2026-11-21 quote-date cutoff as source proof. The design keeps unproven or conflicting legacy rows `unknown` and requires row-specific evidence plus verified deployment history.

### 2. Audit timestamp semantics — Major — PROPOSE FIX

- **Source:** Stages 5–7 and 9.
- **Affected scope:** Technical Plan; Audit timestamp; Open Questions; Domain shapes; Phase 2.
- **Justification:** The ledger evidence does not define the timestamp’s meaning, exact predicates, or partial, skipped, superseding, tie, and multi-underlying behavior.
- **Applied edit:** Marked `lastFallbackAt` as a candidate only. Listed the required policy and evidence questions. Tests and code must wait for an approved, supportable rule.

### 3. Security and disclosure — Major — PROPOSE FIX

- **Source:** Stages 7–8.
- **Affected scope:** oRPC contracts; Non-Functional Requirements.
- **Justification:** The status fields expose limited information, while per-row source remains sensitive implementation detail.
- **Applied edit:** Stated that `openbb.status` and `openbb.volContext` retain the existing operator-only `requireOperator` boundary. Kept raw row source out of outputs and required authorization tests.

### 4. Alternatives comparison — Major — PROPOSE FIX

- **Source:** Stage 7.
- **Affected scope:** Alternatives Considered.
- **Justification:** The prior comparison used drafting jargon and did not state concrete costs and benefits.
- **Applied edit:** Replaced it with a self-contained comparison of warning-only, aggregate-ledger, inline-row, event-ledger, and sidecar approaches.

### 5. Non-goal and audit-ledger use — Nit — PROPOSE FIX

- **Source:** Stage 7.
- **Affected scope:** Non-Goals.
- **Justification:** The prior text restricted ledger use to backfill while the design proposed an audit timestamp.
- **Applied edit:** Separated row-membership evidence from the optional, approved audit timestamp use.

### 6. Performance threshold — Nit — PROPOSE FIX

- **Source:** Stage 7.
- **Affected scope:** Verification targets; Non-Functional Requirements.
- **Justification:** “Measured need” had no baseline or trigger.
- **Applied edit:** Added a same-data baseline using `EXPLAIN (ANALYZE, BUFFERS)` and p95 latency. An index may be reconsidered only after a greater-than-20% regression or a new full-table scan, relative to that baseline.

### 7. Verification commands and pass criteria — Nit — PROPOSE FIX

- **Source:** Stage 6.
- **Affected scope:** Verification targets; Phased implementation plan.
- **Justification:** The previous plan named checks without commands or acceptance criteria.
- **Applied edit:** Added verified repository commands and phase checkpoints for focused tests, OpenAPI, docs, Graphify, drift review, repository verification, and fresh-context review.

### 8. Unsupported predecessor reconciliation — Nit — PROPOSE FIX

- **Source:** Stage 7.
- **Affected scope:** Current Disposition.
- **Justification:** “No contradiction” was unsupported while the method remained unresolved.
- **Applied edit:** Removed the judgment and stated the current design direction and open evidence gates.

### 9. Failed, zero-row, and skipped fallback outcomes — Major — PROPOSE FIX

- **Source:** Stage 9.
- **Affected scope:** Verification targets; Phase 1.
- **Justification:** These cases may emit no row, so a source assertion on a nonexistent row is invalid.
- **Applied edit:** Specified that such cases emit no Yahoo-sourced row and tests assert the run warning or skip outcome instead.

### 10. Phased checkpoints — Major — PROPOSE FIX

- **Source:** Stage 9.
- **Affected scope:** Detailed Implementation Plan.
- **Justification:** The prior single list did not define stable, testable steps.
- **Applied edit:** Split work into an identity/evidence gate, producer/storage, repository/API, UI/docs, and final verification phases with commands and pass conditions.

### 11. Path actions — Major — PROPOSE FIX

- **Source:** Stage 9.
- **Affected scope:** Expected touch points.
- **Justification:** The prior path list did not say which files to create or modify.
- **Applied edit:** Labeled every planned path Create or Modify. No deletions are planned.

### 12. Migration and OpenAPI generation — Major — PROPOSE FIX

- **Source:** Stage 9.
- **Affected scope:** Expected touch points; Phases 1–2.
- **Justification:** The prior plan omitted generator commands and metadata paths.
- **Applied edit:** Added `pnpm db:generate`, the `0091_<descriptive_name>.sql` and `0091_snapshot.json` paths, `_journal.json`, `pnpm openapi:generate`, and `pnpm openapi:check`. The actual migration name must be recorded after generation.

### 13. Query return shape — Nit — PROPOSE FIX

- **Source:** Stage 5.
- **Affected scope:** Storage and sample.
- **Justification:** The prior description did not state that the repository strips its internal rank field.
- **Applied edit:** Documented that returned rows include all table columns and that internal `session` ranking data is removed.

### 14. Sample order and 252nd-row boundary — Nit — PROPOSE FIX

- **Source:** Stage 9.
- **Affected scope:** Storage and sample; Verification targets; Phase 2.
- **Justification:** The prior plan did not define ordering or inclusive membership at the boundary.
- **Applied edit:** Specified newest 252 rows ranked by descending `asOf`, returned oldest-to-newest, with the 252nd row included. Added a 253-row fixture and latest-row acceptance check.

## Items Not Applied

None. At review close, the KB-dependent policy was provisional and had not been accepted as a final mapping or timestamp rule. The later two-origin consultation produced no relevant source-backed guidance; see the canonical design and private method report for the final decision and provenance.

## Verification

At review time, the target document was reread after editing and kept its infographic first. The report preserved the approved source/sample direction and did not claim row provenance from aggregate evidence. It stopped before implementation until the identity and KB gates were resolved. Those gates were later resolved; implementation and verification status are recorded in the canonical design and plan.
