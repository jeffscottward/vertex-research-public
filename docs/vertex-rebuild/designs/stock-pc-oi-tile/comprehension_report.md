# Stage 6 — Comprehension Review

![Dark before-and-after UI diagram; mock](before-after.svg)

## What this proposes

The plan changes only the `/stock` put/call open-interest (OI) KPI’s presentation: show a formatted ratio when coverage is complete and calls OI is above zero; otherwise show `—` and move the explanation and reported-versus-total counts into the muted description. It preserves the existing API, OI null semantics, provider behavior, and risk behavior. Acceptance checks cover distinct states, component and Playwright tests, responsive widths, and unchanged table labeling.

## How the existing system works, per this document

The current tile puts a long “No put/call ratio…” explanation in a `StatCard` value slot styled as `text-2xl`, while its description uses muted `text-sm`. The plan attributes missing OI to a source-coverage gap: the Quant Data adapter derives OI from order-flow prints, reads only the first provider page, and sets OI to `null` when prints do not report it; the merge preserves that null when Yahoo has no value. A previously merged change displays null chain cells as “no OI,” and the plan says to keep that behavior.

## Findings

### Major — State-to-message mapping is missing

**Affected scope:** Goal and verified cause; Acceptance check 3; Implementation plan.

The plan says the muted detail should explain why the ratio is unavailable, and acceptance check 3 requires distinct details for no-contract, no-reported-OI, zero-call-OI, loading, no-answer, and error states. But the implementation plan only specifies “the state-specific reason and coverage counts,” without defining those reasons or how the states are distinguished, especially for asynchronous states such as loading, no-answer, and error. The intended behavior is understandable, but a reader cannot determine the required state-to-message mapping from this document.

### Nit — “This-expiry OI” is undefined

**Affected scope:** Goal and verified cause.

“This-expiry OI” is used as required wording in acceptance check 1 but is not explained. It appears to mean OI for the currently selected expiry, but that interpretation is not stated; briefly defining it would make the acceptance criterion self-contained.

## Resolution

Applied. The plan defines selected expiry and specifies a separate value/detail output for every OI state, including loading, timeout, and error, with test coverage for each.
