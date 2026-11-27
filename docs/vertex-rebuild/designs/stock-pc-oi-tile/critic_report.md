# Stage 7 — Feature-Spec Critique

![Dark before-and-after UI diagram; mock](before-after.svg)

**Target:** `plan.md`, FeatureRange (problem and goal through acceptance checks)  
**Standard:** Feature Specification Standard  
**Reviewers:** `egm-design`, `egm-structural`, `egm-style` — all completed

## Findings

### Major — Alternatives were not evaluated

**Reviewers:** `egm-design`, `egm-structural`  
**Scope:** Goal and verified cause; acceptance criteria.

The plan selected a short value plus muted detail without evaluating alternatives. The standard requires viable alternatives and concrete reasons for rejection. **Resolved:** The plan now compares the full explanation in the large value, a short status word, and the selected dash-plus-detail approach.

### Major — Returned-chain coverage needs scope and mitigation

**Reviewer:** `egm-design`  
**Scope:** Source limitation; count wording and risks.

Quant Data reads only its first provider page. Counts based on the returned chain could be mistaken for full-expiry coverage. **Resolved:** The plan defines the denominator as contracts in the current returned chain, states that full-expiry coverage is not claimed, and defers provider pagination.

### Major — State distinctions need observable outputs and tests

**Reviewers:** `egm-comprehension`, `egm-design`, `egm-style`  
**Scope:** Proposed display; acceptance checks; implementation plan.

The plan required distinct no-contract, no-reported-OI, zero-call-OI, loading, no-answer, and error states without defining each display or requiring tests for all of them. **Resolved:** The plan now gives each state a value and muted detail, including one-sided chains, partial coverage, both-side zero OI, and complete zero-call OI, and requires tests for each row.

### Major — Responsive browser checks need pass criteria

**Reviewer:** `egm-style`  
**Scope:** Responsive browser acceptance check.

“A headless browser check” and “the detail can wrap” did not define a pass condition. **Stage 7 resolution:** the plan named the stock-detail Playwright suite, required wrapping at 375 px, bounded the detail within its tile at all four widths, and proposed document-wide scroll-width checks. **Later scope update:** readiness review narrowed the final check after the existing options-chain table measured 1179 px at 1024 px. The plan now checks tile bounds and wrapping, records page-level overflow as a separate limitation, and leaves the table out of scope.

### Major — Risks and limits were not explicitly assessed

**Reviewer:** `egm-structural`  
**Scope:** Risks and limits.

The standard requires explicit treatment of failure modes, security, scalability, and mitigation. **Resolved:** The plan names misleading coverage as the presentation risk, specifies its mitigation, and states that this UI-only change adds no data access, persistence, provider requests, or request volume.

### Nit — Selected-expiry wording needed definition

**Reviewer:** `egm-comprehension`  
**Scope:** Problem and goal; complete-chain criterion.

“This-expiry OI” was not defined. **Resolved:** The plan defines selected expiry as the expiry chosen in the options-chain control.

### Nit — Mock and source evidence needed clearer wording

**Reviewer:** `egm-style`  
**Scope:** Goal and verified cause.

The original wording made exact counts appear to come from runtime evidence even though the infographic is a mock; the contrast with a table-formatting error added emphasis. **Resolved:** The plan removes the exact screenshot counts and directly describes the adapter, merge, and null-cell behavior.

## Completion

All requested reviewers completed. All Major findings and Nits were accepted and resolved. No findings were contested, escalated, or declined.
