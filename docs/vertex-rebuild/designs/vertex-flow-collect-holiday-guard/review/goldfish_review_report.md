# Goldfish Annotated Review Report

**Target:** `docs/vertex-rebuild/designs/vertex-flow-collect-holiday-guard/plan.md` (revision 1, lines 1-142)

Resolution gate: **Auto accept** (standing owner exception 2026-11-13): every PROPOSE FIX is applied to the plan (revision 2); CONTEST and DECLINE stay as recorded here. No ESCALATE finding.

## Prioritized Findings & AI Suggestions

### [A1] [`egm-design, egm-zoom-out`] - Severity: Blocker

* **Discrepancy Description:** Shared helpers flowSessionDate and optionsSessionRange ignore holidays and early closes; options analytics completeness and page anchors break once reads stop.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid: collectorCaughtUp (options-analytics.ts:367) uses optionsSessionRange(flowSessionDate(end)).to. Fix at the two helpers; every reader follows.
* ***Proposed Edit:*** applied in revision 2: Fix > Changed pieces; Implementation steps 1, 3, 4

### [A2] [`egm-codebase-details, egm-zoom-out`] - Severity: Blocker

* **Discrepancy Description:** flow.control futures side shows the previous session's state as live on a holiday.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid: futuresReason uses isWeekday(today) (flow-control.ts:622) while sessionDate moves to the previous trading day. Use isNyseTradingDay.
* ***Proposed Edit:*** applied in revision 2: Fix; Out of scope; Implementation step 5

### [A3] [`egm-zoom-out, egm-design, egm-implementation-readiness`] - Severity: Major

* **Discrepancy Description:** QQQ depth is a stock-session source and changes too.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid: flow-features.ts QQQ session stock, sources include depth.
* ***Proposed Edit:*** applied in revision 2: Background, tables, tests, CHANGELOG

### [A4] [`egm-style, egm-design, egm-comprehension`] - Severity: Major

* **Discrepancy Description:** RUT listed as a stream; Cboe named as the only venue.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid: FLOW_OPTION_STREAMS has six streams (SPX via ES, NDX via NQ, SPY, QQQ, IWM, NVDA).
* ***Proposed Edit:*** applied in revision 2: Background; Fix table; Risks

### [A5] [`egm-comprehension, egm-style, egm-structural`] - Severity: Major

* **Discrepancy Description:** Before/after rows contradict the window table.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid.
* ***Proposed Edit:*** applied in revision 2: Fix > Before and after

### [A6] [`egm-implementation-readiness, egm-codebase-details, egm-style`] - Severity: Major

* **Discrepancy Description:** Day-number derivation ambiguous (1-based month) and name clash with the weekday local.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid: gex-context.ts newYorkParts month is 1-based; utcDay takes 0-based.
* ***Proposed Edit:*** applied in revision 2: Implementation step 3

### [A7] [`egm-codebase-details, egm-zoom-out`] - Severity: Major

* **Discrepancy Description:** closedDetail text says 16:15 after an early close.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid: flow-control-rules.ts:441. Compute the close from the session date with nyseCloseMinute (no new constant).
* ***Proposed Edit:*** applied in revision 2: Implementation step 5

### [A8] [`egm-implementation-readiness, egm-style, egm-codebase-details, egm-comprehension`] - Severity: Major

* **Discrepancy Description:** fm market, CI checks and claim release undefined.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** fm market is the rig job tracker's market-hours check (task instructions, owner rule 2026-11-16); define it in one clause; name the four checks; cite README steps 1-8.
* ***Proposed Edit:*** applied in revision 2: Implementation steps 9-10

### [A9] [`egm-implementation-readiness, egm-codebase-details`] - Severity: Major

* **Discrepancy Description:** Open-ended fixture repair; no phases.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid; scans found no affected fixture.
* ***Proposed Edit:*** applied in revision 2: Implementation

### [A10] [`egm-codebase-details, egm-implementation-readiness, egm-design, egm-zoom-out`] - Severity: Major

* **Discrepancy Description:** Reader-level and boundary tests missing.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid; adopt the table-driven test, helper tests, reader tests and a parity test against infra/quantvps/nyse-calendar.txt (precedent: price-freshness.test.ts reads services/openbb nyse_closures.py).
* ***Proposed Edit:*** applied in revision 2: Acceptance criteria; Implementation

### [A11] [`egm-structural, egm-style, egm-design`] - Severity: Major

* **Discrepancy Description:** Alternatives: weak reason for holiday-only, missing rows.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid.
* ***Proposed Edit:*** applied in revision 2: Alternatives considered

### [A12] [`egm-comprehension, egm-zoom-out, egm-design`] - Severity: Major

* **Discrepancy Description:** Background misses the market premium readers, the shared helpers and the clear rule.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid; reduced form of Design M1 (helpers named instead of nine callers).
* ***Proposed Edit:*** applied in revision 2: Background

### [A13] [`egm-style, egm-design, egm-codebase-details, egm-comprehension`] - Severity: Major

* **Discrepancy Description:** Impact claims uncalibrated; gap draining continues when closed.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid: flow-collect.ts drains stored option gaps when !open.
* ***Proposed Edit:*** applied in revision 2: Problem; Goal; Risks

### [A14] [`egm-style, egm-implementation-readiness, egm-codebase-details`] - Severity: Major

* **Discrepancy Description:** Text edits produce nested parentheses; more copies of the window text.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid.
* ***Proposed Edit:*** applied in revision 2: Implementation step 8

### [A15] [`egm-structural`] - Severity: Major

* **Discrepancy Description:** Fix section lacks subheadings.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid.
* ***Proposed Edit:*** applied in revision 2: Fix

### [A16] [`egm-design, egm-zoom-out, egm-inventive-catalyst`] - Severity: Major

* **Discrepancy Description:** Risk rows understate a wrong calendar; one-off early close; duplicated windows.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid as text.
* ***Proposed Edit:*** applied in revision 2: Risks and limits

### [A17] [`several`] - Severity: Nit

* **Discrepancy Description:** Derivation and cleanup details.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Cheap and removes implementer choices.
* ***Proposed Edit:*** applied in revision 2: Implementation

### [A18] [`several`] - Severity: Nit

* **Discrepancy Description:** Wording and definitions.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Cheap.
* ***Proposed Edit:*** applied in revision 2: Whole document

### [D1] [`egm-inventive-catalyst IC-1`] - Severity: Major

* **Discrepancy Description:** Calendar-disagreement probe read.
* ***AI Suggestion:*** DECLINE
* ***Justification:*** A new probe path and requests for a risk with no seen case; rule-based calendar pinned by the parity test (A10).

### [D2] [`egm-inventive-catalyst IC-2, IC-4`] - Severity: Major

* **Discrepancy Description:** Shared declarative window table.
* ***AI Suggestion:*** DECLINE
* ***Justification:*** Wider refactor than a bug fix; the duplication is recorded in Risks (A16).

### [D3] [`egm-inventive-catalyst IC-3`] - Severity: Nit

* **Discrepancy Description:** Back-off on unchanged totals or a runtime closure list.
* ***AI Suggestion:*** DECLINE
* ***Justification:*** No current requirement.

### [D4] [`egm-design B1 step 2`] - Severity: Blocker

* **Discrepancy Description:** Rewrite collectorCaughtUp locally.
* ***AI Suggestion:*** CONTEST
* ***Justification:*** A1 fixes the helper it reads (options-analytics.ts:367 calls optionsSessionRange(flowSessionDate(end))); a local copy would duplicate the session logic.

### [D5] [`egm-design M6`] - Severity: Major

* **Discrepancy Description:** NYSE_SPECIAL_EARLY_CLOSES list and a year guard.
* ***AI Suggestion:*** DECLINE
* ***Justification:*** No one-off early close is announced; the parity test pins 2025-2028 to the exchange-sourced list; the limit is stated in Risks.

### [D6] [`egm-design N6`] - Severity: Nit

* **Discrepancy Description:** CME follow-up card.
* ***AI Suggestion:*** DECLINE
* ***Justification:*** Pre-existing and documented; no seen harm.

## Counts

* PROPOSE FIX: 18 (applied)
* CONTEST: 1
* DECLINE: 5
* ESCALATE: 0
