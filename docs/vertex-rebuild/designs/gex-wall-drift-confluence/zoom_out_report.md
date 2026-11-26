# Zoom-out report: GEX wall x net drift read

- **Reviewer:** Skeptical Architect (Zoom Out Goldfish), EGM Stage 5 (Initial Zoom Out)
- **Target:** `docs/vertex-rebuild/designs/gex-wall-drift-confluence/design.md` (all 185 lines)
- **Standard:** `resources/document_standards/zoom-out-standard.md`
- **Date:** 2026-11-25

## Zoom-out lens

### Verdict

Context is sufficient: a fresh reader can tell what is built (one pure, versioned rule, a badge, a pre-registered
study) and why (today two panels are combined by eye, so the read is neither repeatable nor testable). The core of the
design is lean and well placed: a pure rule in `packages/api` next to the other `*-rules.ts` modules, computed in the
browser from data the pages already load, no schema bump, no new table or collector, no runner or backfill before they
are needed, and no vote in `flow.snapshot` confluence. The spec-equals-code test has precedent
(`bearish-put-spread-spec.test.ts`). Forward accrual is not a dead end: `flow_gex` and `flow_net_drift` are both kept
730 days (`flow-pipeline.md`, retention section).

No blocker. Five major findings; the largest is that the design ships more surface than the root problem needs
(a second page and graded colours for a rule that cannot be tested before 2027-03-01), and that it re-implements the
net drift window the codebase already has.

### Findings

#### Major 1: the `/stock` badge is speculative scope and reads an untested source

- **Scope:** Goals line 44; Decisions Q6 line 71; Pages lines 121-123; Risks "levels differ" row; Non-Functional
  Requirements lines 154-157; Files list lines 174-176.
- **Rationale:** `/stock` shows the read only to operators and only for SPY, SPX, QQQ and NDX. Those same operators
  already get the same read for the same four tickers on `/flow`. On `/stock` the levels come from
  `options_analytics`, an on-demand estimate that the study explicitly never tests (spec "Data": `flow_gex` only), yet
  the read carries the same `gex-wall-drift-rules.v1` label. The cost is real: the server page now reads the session
  through `headers()` (the page becomes request-dependent), the gateway grows an optional `flowControl` method, an
  `operator` prop is threaded through `StockDetailWorkspace` and `OptionsAnalyticsPanel`, and an extra request is
  made per analytics answer. The only stated reason is "the task asks for it", which is a scope question for the
  owner, not a design reason.
- **Recommendation:** Drop `/stock` from v1 and, if a pointer is wanted, show a link to `/flow` for the four tickers.
  If the owner insists, either feed `/stock` with the `flow.snapshot` (`flow_gex`) levels so it shows the tested read,
  or mark reads built from `options_analytics` as a different, untested source in the read itself (not only in a
  tooltip).

#### Major 2: green and amber pills for a rule that has no verdict yet

- **Scope:** Goals lines 41-43; Q1 line 66; Badge line 124-126 (tones "Hold success, Break risk warning"); Risks row
  "The badge reads as advice".
- **Rationale:** The root problem (line 33 onward) is that there is no rule and nothing to test. The rule module and
  the spec solve that completely. The badge is the speculative part: the stopping rule forbids a verdict before
  2027-03-01 and 40 touches per class, so for at least three months the badge shows an untested grade. A green
  "Hold" and an amber "Break risk" pill are a visual verdict; the small "Unvalidated: study accruing" line and
  descriptive copy work against the colour, not with it. The mitigation treats the symptom (wording) and keeps the
  cause (graded colours).
- **Recommendation:** Until the study reports `supported`, render every graded state with the neutral tone and let
  the text carry the read; reserve success/warning tones for a validated rules version. If the owner wants the badge
  at all before the verdict, keep it on `/flow` only (see Major 1).

#### Major 3: the 15-minute net drift window is re-implemented instead of shared

- **Scope:** Decisions "Declined" lines 80-81 (brainstorm M2); Rule values line 96; Order of checks lines 99-103
  (`window_short`, `window_gap`, `thin_window`, `zero_premium`).
- **Rationale:** The reason given for declining a shared helper ("the slope is one call-minus-put number; the read
  needs each side") is about the output, not the window. The window itself already exists twice in the codebase:
  `packages/api/src/server/flow-control.ts` (around lines 400-425) picks the baseline as the newest settled minute at
  or before `last - FLOW_NET_DRIFT_SLOPE_MINUTES` and holds the per-side cumulative sums (`sums.total.call`,
  `sums.total.put`) before collapsing them into `slopeUsdPerMinute`; `packages/api/src/flow-control-rules.ts`
  (`inWindow`, `totalsOf`, `windowTotals`) already computes the gross denominator, sum of |call| + |put| per minute,
  and already has `session_start`/`gap` no-data reasons and `minBuckets` 10. The new rule adds a third window
  definition with its own tolerance (3 minutes) and its own gap codes. The spec's "Rule provenance" even justifies
  the values as "equal to" the existing ones, so the two are meant to describe the same window and will drift apart
  silently. (`server/gex-context.ts` also carries a third premium-share threshold, `FLOW_BIAS_SHARE` 0.2, for a
  similar idea; worth one sentence in the design so readers know the three are deliberately different.)
- **Recommendation:** Extract one pure helper into `flow-control-rules.ts` that, given settled cumulative points and
  an end minute, returns the baseline, the per-side changes, the gross and the bucket count (plus a typed reason when
  the window is short or gapped). Use it for both `slopeUsdPerMinute` and the new read. This is a refactor of an
  existing pure function, not a new abstraction, and it removes a duplicated definition of "the 15-minute window".

#### Major 4: the rules are restated in the design and can drift from the canonical spec

- **Scope:** Rule section lines 86-114 (inputs, values, order of checks, truth table, output fields); Acceptance line
  185.
- **Rationale:** The values, the check order and the truth table appear three times: in this design, in the spec
  "Rules" section, and in code. Only spec and code are bound by `gex-wall-drift-spec.test.ts`. The design copy is
  unchecked; the first rules-version change will leave it stale, and a reader will not know which copy wins.
- **Recommendation:** Keep in the design only the shape (inputs, the four read values, "no-data before no-read before
  the truth table", and that the read returns its inputs) and point to the spec "Rules" section as the single
  canonical statement. Keep the truth table in one place (the spec).

#### Major 5: the decisions section depends on an unexplained process and opaque codes

- **Scope:** Header line 8; Decisions heading and intro lines 58-62; "Brainstorm findings applied" lines 73-79;
  "Declined" lines 80-81.
- **Rationale:** A fresh reader meets "auto-decider rule", "job channel", "posted once" and the codes B1, B2, B3, B4,
  M1, M2, M4 to M11 with no definition in the document. The list repeats decisions that the body already states
  (price from the drift minute, forward accrual, typed codes, age limits, ticker pairing, browser compute). It costs
  attention and adds nothing that the body does not carry; the codes only make sense with `concepts_brief.md` open.
- **Recommendation:** Replace lines 73-81 with two or three plain sentences: what was declined and why (gross-premium
  floor, shared window helper if Major 3 is rejected). Define "auto-decider" in one clause or drop it.

#### Nit 1: altitude drop in "Pages"

- **Scope:** Lines 121-126.
- **Rationale:** CSS utilities (`min-h-20`, `line-clamp-2`), the 44 px disclosure, prop names
  (`operator` passed as `wallDrift`), and component names are implementation detail. The Non-Functional Requirements
  (lines 154-157) already state the constraints that matter (no layout shift, 44 px targets, tokens).
- **Recommendation:** Keep in "Pages" only where the read appears, its two data sources, and when it requests data.
  Move class names and prop threading to the Detailed Implementation Plan or leave them to the code.

#### Nit 2: the output field list is code-level

- **Scope:** Lines 112-114.
- **Rationale:** Eighteen named fields (with sub-fields of `window`) are a type definition, not architecture. "The
  read returns every input it used, its rules version and a descriptive reason" says the same at design altitude.
- **Recommendation:** Replace the list with that sentence; the type in `gex-wall-drift-rules.ts` is the reference.

#### Nit 3: some no-data codes guard invariants the types already enforce

- **Scope:** Order of checks lines 99-103 (`ticker_mismatch`, `gex_no_spot`, `no_price`); decision M7 "ticker pairing
  in the types" (line 76).
- **Rationale:** Twelve no-data codes plus six no-read codes is a large surface for a one-line badge. Codes that the
  operator or the study coverage report needs (input missing or stale per source, window short or gapped, not at a
  wall, flat, both rising, hold below or without a flip) earn their place. A ticker mismatch that the design says the
  types already rule out is a programming error, better caught by a test or an assertion than surfaced to a user as a
  data state.
- **Recommendation:** Drop or fold codes that cannot occur when the pages pass correctly typed inputs; keep
  `price_scale_mismatch` and `wall_geometry`, which guard real vendor data.

#### Nit 4: "hold-A" names a grade ladder that does not exist

- **Scope:** Q1 line 66.
- **Rationale:** "A" implies B and C. The design patches this with help text that says A is the only hold grade.
- **Recommendation:** Ask the owner to accept `hold` in `gex-wall-drift-rules.v1`; if the task wording is binding,
  keep it, but the help-text workaround is the symptom fix.

#### Nit 5: rollout wording

- **Scope:** Lines 159-161.
- **Rationale:** "Web-only change" is not exact: a new module and export land in `packages/api`. The point that
  matters is that no server route, schema or stored data changes.
- **Recommendation:** Say "no server, schema or data change; rollback is a revert of the change".

#### Nit 6: copied values versus referenced values (spec side)

- **Scope:** Spec "Rule provenance" (`risingShare`, `minBuckets` "equal to `flow-control-rules.v1`").
- **Rationale:** The age limits are read from `FLOW_SOURCE_METADATA`, but these two are copied literals. For a frozen
  pre-registration a literal copy is right; the document should say so, so nobody expects a later edit of
  `FLOW_CONTROL_RULES` to carry over.
- **Recommendation:** Add "frozen copy; not linked" to those two rows.

### What to keep as is

- Rejecting server-side compute for v1 (no schema version bump; stored rows make every read reproducible).
- No study runner and no backfill until the stopping rule can be met.
- Keeping the read out of the `flow.snapshot` confluence vote.
- Price from the newest drift minute rather than the possibly 30-minute-old GEX spot.
- No extra request on `/flow`.
