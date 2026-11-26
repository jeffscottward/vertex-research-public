# Goldfish Review Report

![OpenBB IV history caveat: before and proposed behavior](../openbb-iv-history-caveat.svg)

**Target:** `docs/vertex-rebuild/designs/openbb-iv-history-caveat/openbb-iv-history-caveat.md` (`1-133`)

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-design` | completed |
| `egm-structural` | completed |
| `egm-style` | completed |

## Prioritized Findings (Blockers -> Major -> Nits)

### Legacy-row evidence and migration outcomes are underspecified - Severity: Major

* **Reviewer Lens:** `egm-design`, `egm-structural`
* **Affected Scope:** Lines 39-40, 71, 89, 118
* **Discrepancy Description**: The proposal asserts that rows before 2026-11-21 are Cboe-derived and that exact ledger evidence can prove later legacy rows, but does not cite evidence for the cutoff or fully specify the ledger fields, row-to-run date mapping, ordering, or reconciliation when multiple runs affect a symbol/date. In particular, a same-date completed `ok` run does not by itself define completeness or settle partial/ambiguous intervening writes.
* **Rationale & Recommendation**: Backfill must be reproducible and must not label uncertain rows as clean. Cite source/history proving the cutoff and verify it against deployed data; define the required marker and ledger fields, New York `asOf` mapping, run ordering, completeness, and treatment of later ambiguous writes. Otherwise retain `unknown` rather than asserting provenance.

### `lastFallbackAt` semantics do not resolve partial and superseding runs - Severity: Major

* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Lines 48, 72, 91, 111, 117
* **Discrepancy Description**: The proposed rule returns `null` when a newer positive partial fallback run follows an earlier confirmed timestamp, without establishing that the partial run supersedes or invalidates that earlier timestamp. It also does not define the timestamp's relationship to a later same-key Cboe overwrite or how multiple underlyings contribute to the global value.
* **Rationale & Recommendation**: Specify whether the field means the latest confirmed fallback attempt or the latest fallback write still surviving in the table, what `null` means, and how partial-then-complete runs, later Cboe overwrites, and multiple underlyings are handled. Name the exact ledger evidence and make the rule consistent with the field's audit-only purpose.

### Security implications and mitigations are absent - Severity: Major

* **Reviewer Lens:** `egm-structural`
* **Affected Scope:** Lines 128-132
* **Discrepancy Description**: Non-functional requirements cover source privacy and unknown evidence, but do not state security considerations or mitigations for the new persisted provenance and exposed status fields.
* **Rationale & Recommendation**: Explicitly assess access and disclosure implications for row-level source and the public `historyState`/`lastFallbackAt` fields, and document applicable mitigations or why no additional controls are needed.

### Alternatives comparison lacks concrete trade-offs - Severity: Major

* **Reviewer Lens:** `egm-design`, `egm-structural`
* **Affected Scope:** Lines 99-107
* **Discrepancy Description**: The document says the concept brief lacks an `Alternatives Weighed` section and refers to “post-merge Concept synthesis tensions” and “current-base evidence”; the alternatives are labeled rejected but do not consistently state concrete technical and scope trade-offs. The append-only ledger and sidecar provenance options in particular need a clearer comparison.
* **Rationale & Recommendation**: Make this section the explicit, complete alternatives evaluation; remove or explain drafting jargon and state each option's concrete costs, benefits, and scope trade-offs against the selected inline-source design.

### Non-goal conflicts with later ledger use - Severity: Nit

* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Lines 39, 48, 72
* **Discrepancy Description**: Line 39 limits exact ledger evidence to one-time legacy backfill, while the technical plan also uses the ledger to derive `lastFallbackAt`.
* **Rationale & Recommendation**: Limit the non-goal to using ledger evidence for current-sample membership or clean labeling; explicitly allow its separate audit-timestamp use.

### Performance review threshold is not actionable - Severity: Nit

* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Lines 97, 132
* **Discrepancy Description**: The instruction to avoid an index absent measured need does not define a baseline or a threshold for reviewing query-plan or latency regression.
* **Rationale & Recommendation**: State the baseline and an actionable threshold for reconsidering an index or query change.

### Unsupported predecessor reconciliation judgment - Severity: Nit

* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Lines 113
* **Discrepancy Description**: “Predecessor reconciliation: No contradiction” is a conclusion rather than evidence, while the same paragraph identifies unresolved KB, partial-write, and legacy-mapping decisions.
* **Rationale & Recommendation**: Remove the judgment and report only the concrete changes and remaining unresolved decisions.

## Coverage Note

This report synthesizes only the three completed reviewer outputs supplied for this assignment. Findings were deduplicated where they identify the same gap; distinct legacy-cutoff, timestamp, security, scope, and performance concerns are retained. The target was checked at lines 1-133 to normalize affected references; no additional reviewers or standards audit was performed.
