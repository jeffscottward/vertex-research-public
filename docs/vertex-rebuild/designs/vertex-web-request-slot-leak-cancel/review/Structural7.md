# Structural review: `plan.md`, lines 1-109 (feature range)

**Standard:** `resources/document_standards/feature-spec-standard.md`
**Scope:** lines 1-109, including the image `before-after.png`. Lines 110-125 (Detailed Implementation Plan) were not audited.

## Heading map (lines 1-109)

```text
L1   # vertex-web: request database slots stay taken after canceled requests
L3-5   metadata bullets (Author / Status / Date)
L7     image
L9     horizontal rule (80 dashes)
L11  ## Overview
L20  ## Terms
L28  ## Evidence (verified)
L44  ## Cause
L49  ## Fix
L51    ### A. QuantData client ... (`quantdata-client.ts`)
L58    ### B. Yahoo session ... (`options-chain-yahoo.ts`)
L62    ### C. Options chain cache ... (`options-chain.ts`)
L66    ### D. Request admission ... (`packages/db`)
L82    ### Not changed
L88  ## Risks
L96  ## Verification
```

The heading levels nest correctly: one H1, H2 sections, and H3 only under `## Fix`. No level is skipped. The problems are a missing mandatory section, renamed or misplaced sections, and list formatting.

## Findings

### 🔴 Blocker 1: the mandatory "Alternatives Considered" section is missing

- **Lines:** whole range. Nothing between L49 (`## Fix`) and L88 (`## Risks`) covers alternatives.
- **Discrepancy:** The standard's "Alternatives Rule" makes an evaluation of alternatives mandatory. A spec that proposes a single path without documented rejected options fails the standard. This plan has no alternatives section. The only rejected option is `idle_session_timeout`, which appears in one sentence inside `### Not changed` (L86).
- **Rationale:** The plan picks one path (per-waiter deadlines plus slot-lease reclaim) and never shows that other viable designs were weighed. Examples a reader would expect:
  - removing the module-level shared promises entirely, with a per-request client or session;
  - propagating an `AbortSignal` into the shared step;
  - a periodic or health-triggered isolate restart;
  - raising the cap;
  - reclaiming slots based on elapsed time only, without activity tracking.
- The only precedent given, `onePlacementAtATime` (L55), supports the chosen design. It is not a rejected alternative. The rejection at L86 states a concrete trade-off, which is correct in form, but it sits under "Not changed" and is the only one.
- **Required:** add `## Alternatives Considered` between `## Fix` and `## Risks`. Give each rejected option a concrete technical or scope reason.

### 🟡 Major 2: there is no "Goals & Non-Goals" section, and the non-goals are filed under `## Fix`

- **Lines:** L11-18 (Overview), L82-86 (`### Not changed`).
- **Discrepancy:**
  - The goals exist only as the numbered list inside `## Overview` (L15-16).
  - The non-goals are an H3 (`### Not changed`, L82) placed under `## Fix`, as a sibling of the lettered fix subsections A-D.
  - L18 already repeats part of the "Not changed" content (cap, 2 s wait, 503).
- **Rationale:**
  - An unlettered H3 among lettered fix items breaks the symmetry of the A-D sequence and puts scope boundaries inside the design body.
  - The same non-goal is stated twice (L18 and L84), which creates drift risk.
  - The scope sentence at L84 (trading units, orders, Nautilus, IB gateway) is a scope statement, not a fix.
- **Required:** promote it to `## Goals & Non-Goals` after `## Overview` (or after `## Cause`). Remove the duplicate at L18.

### 🟡 Major 3: the risks section is titled "Risks" instead of "Risks & Mitigations", and security implications are missing from it

- **Lines:** L88-94.
- **Discrepancy:**
  - The standard asks for failure modes, security implications and scalability limits, each with its mitigation.
  - The five bullets mix the risk and the mitigation in prose. There is no consistent "risk → mitigation" layout. For example, "QuantData spacing" (L93) states a consequence but no mitigation beyond "budget still applies".
  - There is no security entry. The only security-relevant statement ("No secret, query text or user data is in it", L80) is buried in Fix D. The security effect of destroying another request's socket across request contexts is not listed as a risk.
- **Rationale:** a reader who scans for the security posture will not find it under the heading the standard names.
- **Required:**
  - Rename the section to `## Risks & Mitigations`.
  - Give each bullet the same two-part form: **Risk** / **Mitigation**.
  - Add a security bullet covering the log-event contents and cross-context socket destroy.

### 🟡 Major 4: broken list nesting in Verification

- **Lines:** L104-105.
- **Discrepancy:**
  - L98 opens "Failing tests first" with five nested children (L99-103).
  - L104 (`apps/web/src/server/request-scope.test.ts`) is outdented to top level, so it reads as a peer of "Failing tests first" rather than one of the failing tests.
  - L105 (`request-database-diagnostics.test.ts`) is indented two spaces, so it renders as a child of the `apps/web` request-scope test.
- **Rationale:** the rendered tree misstates which tests must fail first. It also attaches the diagnostics test to the wrong parent.
- **Required:** indent L104 to two spaces, the same as L99-103. L105 then becomes a correct sibling.

### 🟡 Major 5: "Problem Statement" and "Proposed Architecture" are present only implicitly, under non-standard names

- **Lines:** L11 (`## Overview`), L49 (`## Fix`).
- **Discrepancy:**
  - The problem statement is spread across Overview (L13), Evidence (L28-42) and Cause (L44-47).
  - The architecture is called "Fix" and is a list of four file-level patches. It has no component or data-flow view of how the waiter deadline (A-C) and lease reclaim (D) interact across request contexts.
  - The image (L7) is the only flow depiction, and it shows only the QuantData path.
- **Rationale:** the standard lists these as named requirement areas. Mapping them to Overview and Fix forces the reader to reconstruct them.
- **Required:**
  - Either rename the sections (`## Problem Statement`, `## Proposed Architecture`) or add a one-line mapping.
  - Add a short data-flow description (request → shared step → waiter deadline → slot lease → reclaim).

### 🟢 Nit 6: the Fix subsections are not symmetric

- **Lines:** L51-80.
- **Discrepancy:**
  - A has "Precedent" and "Effect" bullets (L55-56). B (L60) and C (L64) are single-bullet lists with no "Effect" line.
  - D is much longer and mixes rules, a numbered sub-list, a nested "Two waiter fixes" list and wiring.
  - The parenthetical scope tags are inconsistent: A-C name a file, D names a package (`packages/db`). D also changes `apps/web` (L80).
- **Required:**
  - Use the same sub-structure in every subsection (Change / Effect / Files).
  - Make D's tag list both packages.

### 🟢 Nit 7: the Terms section is incomplete

- **Lines:** L20-26.
- **Discrepancy:** Slot, Isolate, Request context, Shared step and Lease are defined. Terms that carry weight later are not: "scope" / "request scope" (used from L35), "holder" and "takeover" (L51-53), "waiter", "pressure" (L71) and "cap".
- **Rationale:** a fresh reader meets these terms in normative rules without a definition.

### 🟢 Nit 8: the heading qualifier "(verified)" conflicts with the section's content

- **Lines:** L28.
- **Discrepancy:**
  - `## Evidence (verified)` puts a status claim in the heading. It also contains static code analysis (L36-39), which is reasoning, not observed evidence.
  - Verified vs. not verified is the subject of `## Cause` (L46-47), which splits it explicitly.
- **Required:** use a plain `## Evidence` heading and mark the status per bullet, the same way `## Cause` does.

### 🟢 Nit 9: unlinked external references

- **Lines:** L31, L24, L40.
- **Discrepancy:**
  - `live-check.mjs` of card `vertex-charts-legend-overlap-375-deploy` (L31) has no path or link.
  - The `workerd` compatibility flag `handle_cross_request_promise_resolution` (L24) has no link to its documentation.
  - The "Miniflare harness" (L40) has no location.
- **Rationale:** these claims cannot be traced from the document. The standard has no explicit link rule, so this is a Nit.

### 🟢 Nit 10: image layout and traceability

- **Lines:** L7 (`before-after.png`).
- **Discrepancy:**
  - In the AFTER panel, the labels "shared step" and "own deadline 13 s" overlap.
  - The BEFORE count "503 × 245" appears nowhere in the text, so it cannot be traced.
  - AFTER shows only the 13 s QuantData deadline, not the 22 s (B) or 45 s (C) deadlines.
- On the positive side, the relative link resolves (the file exists next to `plan.md`) and the alt text is descriptive.

### 🟢 Nit 11: a stray horizontal rule

- **Lines:** L9.
- **Discrepancy:** an 80-dash rule separates the header block from the body. No other section uses rules, and the metadata block (L3-5) is a bullet list rather than a table or front matter.
- **Rationale:** a minor style inconsistency.

## Summary

- **Blocker:** 1 (no Alternatives section, as the standard requires).
- **Major:** 4 (Goals/Non-Goals missing and misplaced; Risks not in risk→mitigation form and missing security; broken list nesting at L104-105; implicit Problem Statement and Architecture with no data-flow view).
- **Nit:** 6.

The heading hierarchy is valid. Under the feature-spec standard, the range fails on the Alternatives Rule until a dedicated section is added.
