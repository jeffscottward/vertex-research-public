# Goldfish Review Report

![OpenBB IV history caveat: before and proposed behavior](../openbb-iv-history-caveat.svg)

**Target:** `docs/vertex-rebuild/designs/openbb-iv-history-caveat/openbb-iv-history-caveat.md` (`1-178`)

**Standard:** `resources/document_standards/zoom-out-standard.md` (Zoom Out Standard)

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-zoom-out` | completed |
| `egm-inventive-catalyst` | completed |

## Prioritized Findings (Blockers -> Major -> Nits)

### Backfill cutoff does not prove the row's actual source - Severity: Major

* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `154`
* **Discrepancy Description**: The migration proposes labeling every row with `asOf` before 2026-11-21 as Cboe. Since `asOf` is the quote trade date, it can predate the actual Yahoo fallback write; a fallback written after the cutoff may therefore be mislabeled Cboe.
* **Rationale & Recommendation**: A date cutoff based on quote date is not evidence of write provenance. Backfill a row only when available evidence ties the actual write/source to that row; leave unsupported rows unknown.

### Aggregate run metadata cannot establish row-level fallback provenance - Severity: Major

* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `157` (and the `lastFallbackAt` status mapping in `160-161`)
* **Discrepancy Description**: `rowsReceived`/`rowsWritten` aggregate across tables and symbols, and the Yahoo marker is a warning string. Together they do not prove that a particular daily row was written or that the timestamp identifies the latest surviving fallback row.
* **Rationale & Recommendation**: Define `lastFallbackAt` explicitly as run metadata, not proof of a row write or surviving row provenance. Require row-specific evidence before using it to establish that a row was written. Keep the history caveat's row-level source derivation distinct from this run-level timestamp.

### Sample return shape should be described accurately - Severity: Nit

* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** Storage/sample description (the `optionIvDaily` behavior described in the document)
* **Discrepancy Description**: `optionIvDaily` returns all table columns plus an internal `session` ranking field, which is removed before rows are returned. Describing its result as though it contains only a subset of table columns would be inaccurate.
* **Rationale & Recommendation**: Clarify that returned rows contain all table columns and that the internal ranking field is stripped before return.

## Coverage Note

The supplied zoom-out review considered root-problem fit, reuse of the existing query and PostgreSQL/run-ledger infrastructure, caveat separation, sample boundaries, and implementation-detail level; it judged those aspects reasonable overall and noted that detailed implementation lists may fit better in the companion plan. The inventive-catalyst reviewer reported no false compromise. No findings beyond the supplied reviewer outputs are included.
