# Implementation Readiness Report: GEX wall x net drift read

- **Reviewer:** Implementation Readiness Goldfish (EGM Stage 9, Mode: REVIEW)
- **Target:** `docs/vertex-rebuild/designs/gex-wall-drift-confluence/design.md`
- **Detailed range reviewed:** lines 84-127 (Technical Plan) and 168-185 (Detailed Implementation Plan; the file ends
  at line 185, so the requested 168-190 is the same section).
- **Standard:** `resources/document_standards/implementation-readiness-standard.md` (Zero-Decision Rule, phasing,
  exact file boundary, actionable steps, test plan).
- **Cross-checked against:** the companion spec `docs/specs/strategies/gex-wall-drift-confluence.md` and the
  implementation already in the worktree (baseline `d86d57d9`).
- **Snapshot note:** the design, the rule module and its tests changed while this review ran (the flip side was
  renamed from `unknown` / `hold_flip_unknown` to `no_flip` / `hold_no_flip` around 19:00). This report reflects
  `design.md` as of 19:00:17 and `packages/api/src/gex-wall-drift-rules.ts` as of 19:01:33. Tests were read, not
  run (read-only review); the "100% covered" and `verify:prepush` claims are not verified here.

## Verdict

**Not yet implementation-ready by the standard, but no blockers.** Every decision that the design names (inputs,
rule values, check order, truth table, output fields, page wiring, badge classes and tones) matches the code. The
gaps are that several rule semantics live only in the study spec or only in the code, two clock/timestamp choices
were left to the implementer, the file list is not an exact allowlist, there is no phasing, and the test plan is a
coverage target instead of named cases. One gap (the flip side of no-data reads) produced a misleading output value.

Counts: 0 Blocker, 7 Major, 7 Nit.

## What matches the code

- Inputs (lines 90-94) equal `GexWallLevelsInput`, `GexDriftInput` and `now: Date` in `gex-wall-drift-rules.ts`.
- Values (lines 96-97) equal `GEX_WALL_DRIFT_RULES`; the two age limits are derived from `FLOW_SOURCE_METADATA`
  (`gex` 1800 s, `net_drift` 300 s), and the spec's JSON block equals the object (`gex-wall-drift-spec.test.ts`).
- The no-data order (lines 101-102) is exactly the order of `readInputs`; the no-read wall order (line 103) is the
  order of `locateWall`; the truth table (lines 106-110) is exactly `gradeTouch` (both rising is checked first, then
  push side, then flat, then hold by flip side).
- The `drift.points` really are settled: `packages/api/src/server/flow-control.ts` drops the in-progress minute
  (`totals.slice(0, -1)` while the session is open) before building `points`.
- Pages (lines 118-123): `flow-workspace.tsx` renders `WallDriftBadge` before `FlowControlPanel`, uses
  `snapshot.gex.levels` (not `symbolLevels`) and the `flow.control` series of `gex.ticker`; loading and failed
  control become `drift_missing`; the freshness message is shown only on no-data reads. `/stock/[symbol]/page.tsx`
  reads the session, `StockDetailWorkspace` passes `operator` as `wallDrift`, `StockWallDrift` renders and requests
  only for operators on SPY/SPX/QQQ/NDX, and reloads on a new `analytics.receivedAt`.
- Badge (lines 124-126): `min-h-20`, `line-clamp-2`, the four tones, the "Unvalidated: study accruing · research
  only" marker on every state, and a `min-h-11` (44 px) "About this read" summary with help text and input times.

## Findings

### Major 1: Rule semantics are in the spec or the code, not in the Technical Plan

- **Scope:** lines 96-114 (Values, Order of checks, Output).
- **Finding:** the plan names each code but does not define when it fires. An implementer reading only the design
  must decide: how the baseline minute is chosen (code: newest point at or before `newest - 15 min`); what a
  "bucket" is (points after the baseline); what span is compared with `windowMinutes + windowToleranceMinutes`
  (newest minus baseline, `> 18` is a gap); whether the band is a percent of price or of the wall and whether its
  edge is inclusive (code: of price, inclusive); whether "rising" is `>` or `>=` 0.30 (code: `>=`); which price is
  used (newest non-null `underlyingPrice` in the window, which can be older than the newest minute); the base of the
  2% scale gap (code: percent of drift price); and how a price equal to the flip is classed (code: `above`). Most of
  these are written in the spec (lines 62-73), which the plan lists as a deliverable but does not point to as the
  normative definition. Two choices are in neither document: `drift_stale` measures age from the end of the newest
  minute (`newestMinute + 1 min`), and `gex_stale` measures age against the caller's `now`, not against the read
  minute as the spec's study wording does ("at most 30 minutes old" at `m`).
- **Guidance:** add one sentence after line 103: "Each code fires exactly as defined in the spec section Rules
  (lines 62-73)", and add the two live-only clock rules (drift age from the end of the newest settled minute; GEX
  age against `now`). Also list the `flipSide` domain (`above`, `below`, `no_flip`) and the tie rule
  (`price >= flip` is `above`) in the Output paragraph.

### Major 2: The flip side of a no-data read is undefined, and the code reports `no_flip` even when a flip exists

- **Scope:** line 112 (Output lists `flipSide` without saying when it is set); `gex-wall-drift-rules.ts`
  `EMPTY_DRAFT.flipSide = "no_flip"` and `readInputs`, which copies `flip` but never sets `flipSide`.
- **Finding:** every no-data read carries `flipSide: "no_flip"`, including reads where the levels have a flip and
  the drift is merely stale or thin, and reads where the GEX is missing entirely. The value then says "the GEX
  estimate had no flip", which is false. The spec (line 131) reports "the share of read times by flip side per
  ticker"; a runner that counts all read times will inflate `no_flip`. The badge is not affected today because the
  view model only shows a context line when a wall is touched.
- **Guidance:** decide and document one of: (a) `flipSide` is `null` (or a distinct `not_evaluated`) on no-data
  reads; (b) compute `flipSide` whenever both a flip and a price are known; or (c) state that `flipSide` is only
  meaningful when `read !== "no-data"` and that the study counts flip sides on non-no-data reads only. Add a test for
  the chosen rule.

### Major 3: Which clock and which level timestamp each page passes was left to the implementer

- **Scope:** lines 94 and 118-123.
- **Finding:** the plan says `now` and `at` but not their sources. The code chose: on `/flow`, `now` is
  `loadedAt` (set when a refresh settles, so the read does not age between refreshes); on `/stock`, `now` is the
  time the `flow.control` answer arrived (`checkedAt`) and the levels `at` is `analytics.receivedAt`. On `/stock` a
  new analytics answer also keeps the previous `flow.control` answer on screen until the reload settles, so for a
  moment new levels are graded with the old drift and the old `checkedAt`. These are reasonable but they decide what
  "stale" means on each page.
- **Guidance:** state the three choices in the Pages section (`/flow`: `now = loadedAt`; `/stock`:
  `now = checkedAt`, `levels.at = analytics.receivedAt`, the last control answer stays visible during a reload) and
  say whether the badge should re-grade on a timer between refreshes (today it does not).

### Major 4: The file list is not an exact write allowlist

- **Scope:** lines 172-178.
- **Finding:** "(+ test)" and "(+ their tests)" are not paths. The actual change set differs from what a reader
  would infer: `apps/web/src/app/(portal)/stock/[symbol]/page.test.tsx` is new (the page now calls
  `next/headers`, which only resolves in the node environment), `route-files.test.tsx` lost its two page tests
  (moved, not deleted, but the plan does not say so), and `features/stock-detail/stock-detail-workspace.test.*`
  is not changed although the plan implies a test for it. The session lookup helper
  (`lib/request-portal-session.ts`, `getRequestPortalSession(cookie, cf-connecting-ip)`) and the switch of the
  stock page to reading request headers are design-level choices that the plan does not name. Formatting churn also
  landed outside the stated logic change (`prefetch` prop reordering in `page.tsx`, a removed blank line in
  `options-analytics-panel.test.tsx`).
- **Guidance:** replace the bullets with the full repository-relative paths, one per line, marked new or modified:
  the eight implementation files, `gex-wall-drift-rules.test.ts`, `gex-wall-drift-spec.test.ts`,
  `wall-drift-view-model.test.ts`, `wall-drift-badge.test.tsx`, `flow-workspace.test.tsx`,
  `options-analytics-panel.test.tsx`, `stock/[symbol]/page.test.tsx` (new), `stock/[symbol]/route-files.test.tsx`
  (page tests moved out), the spec, `flow-pipeline.md`, and the design folder files. Name
  `getRequestPortalSession` as the session source. Either add a `stock-detail-workspace` test or state that the
  forwarding is covered by `page.test.tsx` plus `options-analytics-panel.test.tsx`.

### Major 5: The test plan is a coverage target, not a list of cases; the code leaves cells and boundaries untested

- **Scope:** line 182.
- **Finding:** the standard asks for specific happy-path and edge cases. The acceptance line asks for "every row,
  every code, both walls and all flip sides", which the tests meet only loosely. Untested today: call-wall
  `break-risk` below the flip and with no flip; call-wall `hold_no_flip`; call-wall `both_rising` and `flat`;
  put-wall `break-risk` with no flip; a share of exactly 0.30 (the `>=` boundary); a span of exactly 18 minutes
  (not a gap) and 19 (gap is tested); exactly 10 buckets; price exactly equal to the flip; a falling side (negative
  share) on each wall; a scale gap of exactly 2%; the flip side of a no-data read (Major 2). The band edge and the
  5/6-minute drift age boundary are tested.
- **Guidance:** replace line 182 with a table of named cases: the 24 truth-table cells (2 walls x 3 flip sides x 4
  drift columns) as a parameterised test, the boundary list above, and one test per page for the operator gate
  (non-operator and non-net-drift ticker send no request; this exists in `wall-drift-badge.test.tsx`).

### Major 6: The badge copy, the main mitigation for "reads as advice", is not specified

- **Scope:** lines 112-114 ("`reason` (descriptive)") and 124-126 ("the help text").
- **Finding:** the Risks table relies on "Descriptive copy", and Non-Goals forbid advice wording, but the plan gives
  no strings. The implementer wrote `WALL_DRIFT_HELP`, the four labels, every `reason` template (for example
  "put drift rising at put wall 600, above gamma flip 590; call +$0.30M, ...") and the no-flip text "no gamma flip in
  the GEX estimate". The current text reads as descriptive, but nothing in the plan would have caught advice wording.
- **Guidance:** put the exact label, help text and reason templates (with their placeholders) in the design, or state
  that the copy in `wall-drift-view-model.ts` and the rule module is reviewed copy and must not contain the
  forbidden phrases, and add a test that scans all reasons and the help text for a deny-list ("do not", "wait",
  "buy", "sell", "enter", "exit").

### Major 7: No phases or checkpoints

- **Scope:** lines 168-185.
- **Finding:** the standard requires incremental phases that each leave the tree buildable and testable. The plan is
  one undifferentiated list. The natural order (rule module + spec + spec test; then view model + badge; then
  `/flow` wiring; then `/stock` session, workspace, panel and client) is not written, so there is no checkpoint at
  which the rule and spec can be reviewed before UI work.
- **Guidance:** add three or four phases in that order, each with the tests that must pass at its end, or state
  explicitly that the change ships as one commit and why that is acceptable for a web-only change.

### Nit 1: Output names and extra exports

- **Scope:** lines 112-114.
- **Finding:** the window fields are `baselineMinute`, `newestMinute`, `spanMinutes`, `buckets`, `callChange`,
  `putChange`, `gross`, `price`, `priceMinute`; the plan's shorthand ("baseline, newest, span, ... changes") does
  not give these names or nullability. `code` is `null` for graded reads (implied by line "typed code for every
  non-graded result" but not stated). The module also exports `GEX_WALL_DRIFT_READS`, `GEX_WALL_DRIFT_CODES`,
  `gexDriftWindow` and its types through `index.ts`; the plan names only `gradeGexWallDrift` and the rules object.
- **Guidance:** list the exported names and the exact window field names, and state `code: null` for `hold-A` and
  `break-risk`.

### Nit 2: Location of `StockWallDrift`

- **Scope:** lines 121-123.
- **Finding:** the bullet is headed `options-analytics-panel.tsx`, which suggests `StockWallDrift` lives there; it
  lives in `wall-drift-badge.tsx` with its `flow.control` loader.
- **Guidance:** name the file for each component.

### Nit 3: Optional gateway method and its fallback

- **Scope:** line 123.
- **Finding:** `OptionsAnalyticsGateway.flowControl` is optional, and a missing loader produces a no-data read with
  the detail "this page does not load flow.control". Neither choice is in the plan.
- **Guidance:** state that the method is optional (so existing fakes keep compiling) and the fallback text.

### Nit 4: Group mapping and the "settled" guarantee are implicit

- **Scope:** lines 92 and 119-123.
- **Finding:** `/stock` must pick a `flow.control` group; the code uses SPY/SPX -> `sp500`, QQQ/NDX -> `nasdaq100`
  (`wallDriftGroupOf`). The "settled" guarantee comes from `flow-control.ts`; the plan does not cite it.
- **Guidance:** state the mapping and cite `flow-control.ts` (in-progress minute dropped while the session is open).

### Nit 5: Naming drift across documents

- **Scope:** line 110 versus `concepts_brief.md` line 232.
- **Finding:** the design, spec and code now use `no_flip` / `hold_no_flip`; the brief still says `unknown`.
- **Guidance:** update the brief or note the rename in "Decisions taken".

### Nit 6: Acceptance checks without a named verifier

- **Scope:** lines 184-185.
- **Finding:** "The badge renders on `/flow` and `/stock` (operator) with an explicit no-data state" does not say how
  it is verified. It is covered by `flow-workspace.test.tsx` (badge before the control panel; no-data on stale lab
  GEX) and `options-analytics-panel.test.tsx` (operator on SPY), and the spec equality by
  `gex-wall-drift-spec.test.ts`.
- **Guidance:** name those tests in the acceptance list.

### Nit 7: Non-operator exposure on `/flow` relies on an existing gate

- **Scope:** line 118 versus the Non-Goal "Showing drift-derived reads to members who are not operators".
- **Finding:** the `/flow` badge is safe only because `FlowWorkspace` returns `OperatorAccessRequired` on a
  forbidden snapshot before the badge renders. Until the first snapshot answer, any visitor sees the badge in its
  "No data: flow snapshot is loading" state; no drift-derived value is shown, so this is acceptable, but the plan
  does not say so.
- **Guidance:** add one clause: "`/flow` is operator-only (`OperatorAccessRequired`), so no extra gate is needed."
