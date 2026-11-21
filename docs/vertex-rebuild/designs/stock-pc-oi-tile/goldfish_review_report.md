# Goldfish Annotated Review Report

**Status:** resolved

![Dark before-and-after UI diagram; mock](before-after.svg)

**Target:** `docs/vertex-rebuild/designs/stock-pc-oi-tile/plan.md` (FeatureRange and DetailedRange)

## Prioritized Findings & AI Suggestions

### Issue 1 [egm-design, egm-structural] — Severity: Major

- **Affected scope:** Problem and goal; Alternatives considered.
- **Discrepancy:** The feature-spec standard requires evaluation of viable alternatives with concrete rejection reasons. The feature range presents a short value with a muted explanation as the only option.
- **Rationale:** A reader cannot compare its trade-offs with other ways to keep the value compact.
- **AI Suggestion:** PROPOSE FIX
- **Justification:** The code already provides a large `StatCard` value and a muted description slot. Comparing the current paragraph, an abbreviated value, and the selected dash-plus-detail approach explains the choice without new code or abstraction.
- **Proposed Edit:** Add an alternatives section. Reject the full explanation in the large value because it wraps and displaces the metric; reject a short status word alone because it loses the state reason and coverage counts; choose `—` with a muted, state-specific explanation because it reuses the existing slots and keeps the value compact.

### Issue 2 [egm-design] — Severity: Major

- **Affected scope:** Problem and verified cause; Risks and limits.
- **Discrepancy:** The adapter reads only the first Quant Data provider page, but the plan does not explain how a denominator based on the returned chain should be interpreted.
- **Rationale:** Readers could mistake counts for full-expiry provider coverage.
- **AI Suggestion:** PROPOSE FIX
- **Justification:** The contract and source adapter in the review context show nullable OI and the first-page limit. State the counts’ scope and leave pagination outside the UI change.
- **Proposed Edit:** Say that coverage counts use contracts in the current returned chain and do not claim full-expiry coverage. Record that provider pagination is deferred and that the tile must preserve this interpretation.

### Issue 3 [egm-structural] — Severity: Major

- **Affected scope:** Risks and limits.
- **Discrepancy:** The plan states unchanged data and risk behavior but does not explicitly identify failure modes, security implications, scalability limits, and mitigations as required by the feature-spec standard.
- **Rationale:** The reader cannot confirm that these categories were assessed.
- **AI Suggestion:** PROPOSE FIX
- **Justification:** This UI-only change adds no data access, persistence, provider request, or order behavior. State that new security and scalability risks are not introduced; identify misleading full-expiry coverage as the presentation risk and mitigate it with explicit count scope.
- **Proposed Edit:** Add a Risks and limits section with these statements and the rollback point.

### Issue 4 [egm-comprehension, egm-design, egm-style] — Severity: Major

- **Affected scope:** Acceptance checks; Implementation plan.
- **Discrepancy:** The plan requires distinct ready, no-contract, no-reported-OI, zero-call-OI, loading, no-answer, and error states but does not map each state to observable detail or require tests for each.
- **Rationale:** The implementation and its tests cannot be checked against a precise state contract.
- **AI Suggestion:** PROPOSE FIX
- **Justification:** The current formatter already distinguishes no contracts, unreported OI, fully reported zero OI, incomplete counts, loading, timeout, and failure. Define each displayed value/detail and test each distinct branch. Treat zero call OI separately from no OI reported.
- **Proposed Edit:** Add the state-to-detail mapping and require focused tests for every row. All non-ready states use `—` as the large value; details state loading, timeout, or the existing failure message.

### Issue 5 [egm-style] — Severity: Major

- **Affected scope:** Responsive browser acceptance check.
- **Discrepancy:** “A headless browser check” and “the detail can wrap” do not define an observable pass condition.
- **Rationale:** The check does not say which test runs, when wrapping is required, or how horizontal overflow is detected.
- **AI Suggestion:** PROPOSE FIX
- **Justification:** The existing Playwright stock-detail suite can check the four required viewport widths and inspect the page geometry.
- **Proposed Edit:** Name the Playwright spec, assert the detail wraps at 375 px, assert the detail remains inside its card at every requested width, and assert `document.documentElement.scrollWidth <= window.innerWidth` at 375, 768, 1024, and 1440 px.

### Issue 6 [egm-comprehension] — Severity: Nit

- **Affected scope:** Goal and verified cause; complete-chain acceptance check.
- **Discrepancy:** “This-expiry OI” is not defined.
- **Rationale:** It appears to mean OI for the currently selected expiry, but the plan does not say so.
- **AI Suggestion:** PROPOSE FIX
- **Justification:** A short definition makes the acceptance criterion self-contained.
- **Proposed Edit:** Define “selected expiry” as the expiry selected in the options-chain control; use that term consistently.

### Issue 7 [egm-style] — Severity: Nit

- **Affected scope:** Goal and verified cause.
- **Discrepancy:** The phrase “The card’s screenshot records…” can imply runtime evidence, while the infographic is a mock.
- **Rationale:** The plan should not blur mock content and observed source data.
- **AI Suggestion:** PROPOSE FIX
- **Justification:** Exact task-screenshot totals are not needed to explain the issue. The code and merged null-cell behavior establish the source gap.
- **Proposed Edit:** Remove the exact counts and describe the observed behavior without calling mock content evidence.

### Issue 8 [egm-style] — Severity: Nit

- **Affected scope:** Goal and verified cause.
- **Discrepancy:** “This is a real source-coverage gap, not a table formatting error” adds emphasis and repeats the explanation immediately before it.
- **Rationale:** State the source behavior directly.
- **AI Suggestion:** PROPOSE FIX
- **Justification:** The adapter and merge behavior explain the limitation without this contrast.
- **Proposed Edit:** Remove the sentence and combine the source behavior with the count-scope explanation.

## Resolution

The plan applies the accepted findings. Issue 5's proposed document-wide `scrollWidth` assertion was narrowed during readiness review because the existing options-chain table overflows at 1024 px. The final plan keeps KPI tile bounds and 375 px wrapping in scope, records page-level overflow separately, and leaves the table unchanged. No findings were contested, escalated, or declined.
