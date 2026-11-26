# Goldfish Review Report

![OpenBB IV history caveat: before and proposed behavior](../openbb-iv-history-caveat.svg)

**Target:** `docs/vertex-rebuild/designs/openbb-iv-history-caveat/openbb-iv-history-caveat.md` (`1-178`)

**Review step:** 8 — Intermediate Zoom Out

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-zoom-out` | completed |

## Prioritized Findings (Blockers -> Major -> Nits)

### Legacy backfill still cannot establish row provenance - Severity: Major

* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `71`, `154-155`
* **Earlier finding references:** `zoom_out_report.md`, “Backfill cutoff does not prove the row's actual source” (line 18); “Aggregate run metadata cannot establish row-level fallback provenance” (line 24).
* **Discrepancy Description**: `asOf` is the quote date, not the actual write date. The 2026-11-21 cutoff, exact-symbol marker, same-New-York-date matching, and a later complete `ok` run are not sufficiently defined to prove provenance for a specific surviving row. Existing fallback code supplies per-symbol warning text and aggregate counts, not row-to-run evidence.
* **Rationale & Recommendation**: Aggregate run evidence does not establish row-level source. Retain `unknown` unless there is verifiable row-specific evidence; define any accepted evidence precisely before using it for backfill.

### Security and disclosure rationale is unstated - Severity: Nit

* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `73`, `130`
* **Earlier finding reference:** `zoom_out_report.md`, security/disclosure rationale related to the Stage 7 security finding (the supplied prior report does not include this finding among its detailed findings).
* **Discrepancy Description**: The document says raw source remains private and exposes `historyState` and `lastFallbackAt`, but does not state why those public fields are appropriate or whether existing access controls are sufficient.
* **Rationale & Recommendation**: State the disclosure rationale for these fields and the access-control assumption. Do not expose the raw source.

## Coverage Note

The completed intermediate zoom-out review found that the existing sample/query reuse and ledger reuse are simpler and adequate. Aggregate records nevertheless do not establish row-level provenance. The audit timestamp is substantially addressed as run-level metadata, and the earlier sample-return-shape nit is addressed. The supplied findings map to legacy cutoff/mapping (lines 71 and 154-155) and public status disclosure (lines 73 and 130). No additional findings are introduced.

## Severity Counts

* Blocker: 0
* Major: 1
* Nit: 1
