# Goldfish Review Report

![OpenBB IV history caveat: before and proposed behavior](../openbb-iv-history-caveat.svg)

**Target:** `docs/vertex-rebuild/designs/openbb-iv-history-caveat/openbb-iv-history-caveat.md` (Lines 134–178)

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-implementation-readiness` | completed |
| `egm-codebase-details` | completed |
| `egm-style` | completed |

## Prioritized Findings (Blockers -> Major -> Nits)

### Migration provenance mapping and audit-run selection are underspecified - Severity: Major

* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Lines 154–158
* **Discrepancy Description**: The backfill and audit query rely on an exact-symbol Yahoo marker, a “complete” run, same-New-York-date matching, and “newest” candidate ordering, but the marker predicate, qualifying run status, meaning of completeness, how to reconcile multiple runs, and `finishedAt` tie behavior are not defined. Nor is it explicit how later Cboe proof is matched against the row. The legacy cutoff is stated without specifying the concrete evidence and symbol/order rules that establish it.
* **Rationale & Recommendation**: Before implementation, document the exact marker predicate and mapping for each source; define qualifying statuses, run completeness, date/source reconciliation, ordering and deterministic ties when `finishedAt` values match, and how multiple runs or partial writes affect a row and timestamp. Treat KB-dependent mappings and timestamp policy as provisional throughout this plan; require an approved mapping/timestamp policy before implementation. Keep the stated no-inference rule for absence of a Yahoo warning.

### Plan lacks staged, verifiable checkpoints - Severity: Major

* **Reviewer Lens:** `egm-codebase-details`, `egm-style`
* **Affected Scope:** Lines 146–175
* **Discrepancy Description**: Steps 1–7 are a single implementation list rather than phases with stable, buildable/testable checkpoints. The final steps bundle documentation, generated artifacts, verification, review, and PR readiness without concrete per-phase commands or pass criteria.
* **Rationale & Recommendation**: Split the list into phases with explicit dependencies and checkpoints (for example, ingestion/schema+migration, repository/API, UI/docs, final verification). For each checkpoint state the focused command(s), expected result, and pass criterion; make generated-artifact checks, Graphify, drift report, full verification, and fresh-context review individually verifiable gates.

### No expected row/source outcomes for failed, zero-row, or skipped fallback cases - Severity: Major

* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Lines 148–151
* **Discrepancy Description**: The tests are asked to assert source for failed, zero-row, and skipped fallback cases, but these cases may emit no daily row, so the expected row and source outcomes are ambiguous.
* **Rationale & Recommendation**: Specify for each case whether a row is expected; where a row exists, specify its source, and where no row is emitted, assert the empty result and the relevant run/ledger outcome rather than inventing a row-level source.

### Planned file paths have no Create/Modify/Delete actions - Severity: Major

* **Reviewer Lens:** `egm-codebase-details`
* **Affected Scope:** Lines 148–175
* **Discrepancy Description**: The plan lists paths but does not identify whether each is to be created, modified, or deleted; this also leaves migration metadata and generated outputs without an explicit action.
* **Rationale & Recommendation**: Label every planned path with its action (Create, Modify, or Delete), including the migration SQL, `packages/db/migrations/meta/_journal.json`, the numbered snapshot, generated `packages/api/openapi.json`, and each test/documentation artifact. Remove Delete labels where no deletion is intended; do not leave any listed path unclassified.

### Migration and OpenAPI generation commands and numbered artifacts are not specified - Severity: Major

* **Reviewer Lens:** `egm-codebase-details`, `egm-style`
* **Affected Scope:** Lines 154, 170
* **Discrepancy Description**: “Generate the next numbered migration” and “with the repository generator” do not state reproducible commands or the exact next migration, journal, and snapshot paths. The migration sequence currently ends at `0090_golive_single_leg.sql`.
* **Rationale & Recommendation**: Specify `pnpm db:generate` for the Drizzle migration and `pnpm openapi:generate` for OpenAPI generation; verify generated OpenAPI with `pnpm openapi:check`. State that the next migration is `packages/db/migrations/0091_<descriptive_name>.sql`, with its numbered snapshot under `packages/db/migrations/meta/` and the journal update in `packages/db/migrations/meta/_journal.json`; record the actual generated descriptive name and snapshot filename in the plan after generation, rather than guessing them in advance.

### Sample ordering and 252nd-row boundary test are not fully defined - Severity: Nit

* **Reviewer Lens:** `egm-codebase-details`
* **Affected Scope:** Lines 161–162
* **Discrepancy Description**: The plan names the 252nd-row boundary but does not state row ordering or the exact newest-252 selection/boundary rule. The current handler uses `openbb.optionIvDaily(...)`, computes the percentile on returned rows, and takes `rows.at(-1)` for latest.
* **Rationale & Recommendation**: State the ordering used by `optionIvDaily`, define the exact newest 252 rows included (including whether the 252nd row is included), and test the boundary with a known 253-row fixture so percentile/history membership and latest-row selection are unambiguous.

## Coverage Note

`egm-codebase-details` reports that the referenced code paths exist. The handler uses the same returned rows for percentile and latest-row selection; the tick records `finishedAt`, counts, and warnings; and the UI's newest-run notice and carry-forward skip are distinct from the proposed history state and audit timestamp. This coverage note does not add a finding.
