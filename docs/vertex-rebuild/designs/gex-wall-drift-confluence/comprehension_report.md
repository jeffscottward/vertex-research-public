# Comprehension Goldfish report: GEX wall x net drift read

- **Reviewer:** `egm-comprehension` (Comprehension Goldfish, naive reader)
- **Mode:** REVIEW, Stage 6 Comprehension Test
- **Target:** `design.md`, FeatureRange lines 1-167 (Overview to Future Improvements), DetailedRange lines 84-127 and
  168-190 (Technical Plan, Detailed Implementation Plan)
- **Date:** 2026-11-25
- **Companion read for the self-containment check:** `docs/specs/strategies/gex-wall-drift-confluence.md`,
  `concepts_brief.md`, the two SVG diagrams, `packages/api/src/contracts/flow.ts` (only to confirm what a term means)

## Paraphrase

### What this proposes

Add one pure, versioned function (`gradeGexWallDrift`, rules `gex-wall-drift-rules.v1`) that takes the stored GEX
levels of an options ticker (call wall, put wall, gamma flip, spot) and the session-cumulative QuantData net call and
net put premium of the same ticker, and grades the current moment. If price sits within a small band of one wall, the
function looks at which side's premium rose over roughly the last 15 minutes: the side that pushes through the wall
gives `break-risk`, the opposite side gives `hold-A` only when price is above the gamma flip, and anything else gives a
`no-read` with a code. Missing, stale or inconsistent inputs give `no-data` with a code. The result is shown as a small
badge on `/flow` (all users who can see the selected view's net drift) and on `/stock` (operators only, four tickers),
always labelled "Unvalidated: study accruing · research only". A pre-registered study spec freezes the same rule values
and will later test whether `break-risk` touches break, and `hold-A` touches hold, more often than `flat` touches.

### How the existing system works, per this document

Vertex already shows GEX levels and QuantData net drift on separate panels; an operator combines them by eye. GEX
rows (`flow_gex`) are collected periodically and served on `/flow` through `flow.snapshot`; net drift is served to
operators through `flow.control`; `/stock` gets its levels from an on-demand options analytics answer. When the
QuantData collector fails (for example HTTP 401) the drift chart is simply empty with no explanation. Nothing in the
system grades a wall touch or records a testable rule.

Paraphrase caveats (these are findings below): I could paraphrase the truth table, but not most of the "Order of
checks" from the design alone. I had to read the companion spec to learn what "at a wall", "rising", the window, the
price used and most `no-data` codes mean. I am also unsure whether the `/flow` badge is visible to non-operators
(Non-Goals say drift reads are never shown to non-operators; the `/flow` section does not say who sees the badge).

## Findings

### 🔴 B1. The "Order of checks" cannot be understood from the design (lines 96-104)

- **Severity:** Blocker
- **Affected scope:** Technical Plan > Rule, lines 90-104 (the `Values:` line 96, the checks lines 99-104); DetailedRange.
- **Description:** The rule's core is a list of 15 codes with no meaning attached. A reader of the design alone cannot
  tell what `gex_no_spot`, `ticker_mismatch`, `window_short`, `window_gap`, `thin_window`, `no_price`,
  `price_scale_mismatch`, `drift_stale` or `zero_premium` test, nor how the values on line 96 are used:
  - `nearWallPct 0.25` has no unit; it could be 0.25 (25%) or 0.25%. Only the spec says "0.25% of price".
  - `windowMinutes`, `windowToleranceMinutes`, `minBuckets`: the design never says the window has a baseline at
    `m - 15`, that a baseline older than `m - 18` is a gap, or that 10 settled minutes are needed.
  - `risingShare 0.30`: "Share" is defined in Terms, but "rising" (share >= 0.30) is not, and the truth table depends
    on it.
  - `maxScaleGapPct 2`: the design never says which two numbers are compared (the drift minute's price against the
    GEX spot).
  - `maxGexAgeMinutes` / `maxDriftAgeMinutes`: age measured against what (`now`? the drift minute)?
  Some codes are not defined even in the spec: `gex_no_spot`, `no_price`, `ticker_mismatch`, `gex_stale`,
  `drift_stale`, `drift_missing` (the spec covers the window codes, `wall_geometry`, the band and the share).
- **Recommendation:** Give each code one line ("`window_gap`: the newest drift minute at or before now-15 min is older
  than now-18 min") or turn the list into a table code / condition / value used. At minimum, link the spec's "Rules"
  section at this point and add the missing definitions there. State the unit of `nearWallPct` and the reference time
  for both age limits.

### 🟡 M1. Which price is used, and when, is only implied (lines 90-94, 101-103, 112-114)

- **Severity:** Major
- **Affected scope:** Rule inputs (lines 90-94), Output (lines 112-114), Brainstorm findings (B1, line 73).
- **Description:** The input `levels` carries `spot`, and `drift` carries points "with `underlyingPrice`". The only
  hint that the touch uses the drift price, not `spot`, is "price from the net drift minute (B1)" in a list of
  brainstorm finding codes. The read time itself is not defined: is it `now`, or the newest settled drift minute? The
  spec says "the end of a settled one-minute bucket `m`" and "the newest underlying price in the window"; the design
  says neither. "Settled" is also undefined.
- **Recommendation:** In the Rule section add two sentences: "Read time = the newest settled drift minute (a minute the
  collector will not rewrite). Price = that minute's `underlyingPrice`; GEX `spot` is used only for the 2% scale
  check."

### 🟡 M2. How the reel's "flow against / through the wall" maps to push and hold sides is not explained (lines 11-14, 28-29, 106-110)

- **Severity:** Major
- **Affected scope:** Source, Terms (Push side / Hold side), truth table.
- **Description:** The source says "flow against the wall = hold, flow through it = break". The Terms define the hold
  side as "the other drift" (calls at the put wall). A reader then asks: is net put *selling* at the put wall (the put
  line falling) also "flow against the wall"? Per the table it is "Neither" and reads `flat`. Likewise a falling call
  line at the call wall. The design does not say whether a falling line is deliberately ignored, so the reader cannot
  tell if this is a choice or a gap.
- **Recommendation:** Add one sentence under Terms: "Only rising lines count; a falling line (net selling) is treated
  as no flow on that side, by design, because ...".

### 🟡 M3. "Wall touch" means two different things (line 18 versus the spec's Event section)

- **Severity:** Major
- **Affected scope:** Overview line 18 ("grades the current wall touch"), Goals, User experience.
- **Description:** The badge grades every minute in which price is inside the band. The study counts a "touch" only as
  the first such minute after price approached from the inside, with a 30-minute re-arm rule. The design uses "touch"
  for the badge without saying the badge read is not the study event. A reader comparing the badge with study results
  will expect them to line up minute for minute.
- **Recommendation:** In Overview, say "the badge grades price near a wall at every minute; the study counts only the
  first approach (defined in the spec's Event section)".

### 🟡 M4. Levels sources and the "three gamma sources" are not named (lines 53, 67-68, 90, 121-123, 144)

- **Severity:** Major
- **Affected scope:** Non-Goals line 53, Q2 and Q3 (lines 67-68), Inputs line 90, Pages lines 121-123, Risks line 144.
- **Description:**
  - "the three gamma sources" are never listed (the spec names OpenBB, market-watch-bot and on-demand options
    analytics; it is unclear whether `flow_gex` is one of the three).
  - `source: "flow_gex" | "options_analytics"` appears without saying `/flow` uses `flow_gex` and `/stock` uses
    `options_analytics`. The `/stock` bullet (lines 121-123) says where drift comes from but not where levels come
    from. Only the data-flow diagram and the Risks row make this clear.
  - Q2 says the flip side is "price versus the `flow_gex` flip", which is untrue on `/stock`, where the flip is the
    options analytics flip.
- **Recommendation:** Add a short "Inputs per page" table: page / levels source / drift source / who sees it. Name the
  three gamma sources once. Reword Q2 as "price versus the flip of the levels source (`flow_gex` on `/flow` and in the
  study)".

### 🟡 M5. `levels` versus `symbolLevels` and "shifted levels" are undefined (lines 118-119, 141)

- **Severity:** Major
- **Affected scope:** Pages > `/flow`, Risks row "Wrong pairing".
- **Description:** "`levels`, never `symbolLevels`" and "shifted levels are not an input" assume the reader knows that
  `symbolLevels` are the same levels moved by the futures basis into the futures price (ES, NQ) while `levels` are in
  the options underlying price (SPX, NDX). Without that, a reader on the ES view may expect the badge to quote ES
  prices and will be confused when it quotes SPX strikes.
- **Recommendation:** One sentence: "`levels` are in the options underlying's price (SPX for the ES view); `symbolLevels`
  are the same levels shifted by the ES-SPX basis and are not used, so the badge always quotes the options ticker."

### 🟡 M6. Who sees the badge on `/flow` is not stated (lines 55, 118-120, 130-132)

- **Severity:** Major
- **Affected scope:** Non-Goals line 55, Pages `/flow`, User experience.
- **Description:** Non-Goals say drift reads are never shown to non-operators, and `/stock` is explicitly operator-only.
  The `/flow` bullet does not say whether `/flow` is operator-only or what a member sees there. "Operator" and
  "member" are project roles that are never defined, and the design does not say how the role is determined (line
  121 only says "the page reads the session").
- **Recommendation:** Define "operator" and "member" once (or link the role doc), and state the `/flow` visibility
  rule explicitly ("`/flow` is operator-only, so no extra gate" or "members see no badge on `/flow` because ...").

### 🟡 M7. Process references are unlinked: task file, owner reel, auto-decider, job channel, job report (lines 11, 60-62, 66, 71)

- **Severity:** Major
- **Affected scope:** Header "Source", Decisions taken.
- **Description:** "an owner reel summarized in the task file", "the standing auto-decider rule", "posted once in the
  job channel", "saved with the job report", and "The task names these values" (Q1) all point to artifacts a new
  reader cannot find. The decisions table relies on "the task asks for it" (Q6) as its reason, so the reader cannot
  check that reason.
- **Recommendation:** Link the task file and the job report path (or quote the relevant task lines), and give the
  auto-decider rule a one-line definition or link.

### 🟡 M8. Brainstorm-finding shorthand hides content the design depends on (lines 73-82)

- **Severity:** Major
- **Affected scope:** "Brainstorm findings applied" and "Declined".
- **Description:** The paragraph is a run of codes with five-word summaries. Several carry design content that appears
  nowhere else in the design: "vendor total for live reads with the derived total reported in the study (M8)" (what are
  the vendor and derived totals?), "contract age limits (M1)", "window span check (M2)". M6 is used both for an applied
  finding ("zero premium is no-data") and a declined one ("a dollar floor"), and M2 likewise; a reader cannot tell
  whether these are the same finding. "the existing slope" (line 80) is not identified until line 151.
- **Recommendation:** Move each applied finding into the section it changes (inputs, checks, pages), with the finding
  code in brackets, and keep this paragraph as an index. Define vendor total versus derived total (the spec: `total`
  part versus `zero_dte` + `longer`).

### 🟡 M9. "Unvalidated: study accruing" has no end condition in the design (lines 56, 66, 124-126, 165)

- **Severity:** Major
- **Affected scope:** Q1, Badge, Non-Goals, Future Improvements ("when the stopping rule can be met").
- **Description:** The design refers to a "stopping rule" and an "accruing" status but never states either. A reader
  cannot tell when the marker could change, or that the earliest run is 2027-03-01 with 40 touches per class.
- **Recommendation:** One sentence plus a link: "Accruing until the spec's stopping rule is met (>= 40 out-of-sample
  touches per class and not before 2027-03-01); the marker stays until a verdict."

### 🟢 N1. `hold-A`: what "A" means is only promised (line 66)

- **Severity:** Nit
- **Affected scope:** Q1.
- **Description:** "the help text defines A as the only hold grade" but the help text is not shown. A reader will ask
  whether `hold-B` exists or is planned.
- **Recommendation:** Quote the help text, or add "A is the only hold grade in v1; no B grade exists".

### 🟢 N2. API and UI names used as if known (lines 118-126)

- **Severity:** Nit
- **Affected scope:** Pages.
- **Description:** `flow.snapshot`, `flow.control`, `gex.ticker`, "the group of the view", `OptionsAnalyticsGateway`,
  `StatusBadge`, "a new analytics answer" are not glossed. A software reader can guess they are API procedures and
  components, but "group of the view" and "analytics answer" are project jargon.
- **Recommendation:** Add a short gloss or a link to `docs/vertex-rebuild/flow-pipeline.md` for the two procedures and
  explain "group" and "analytics answer".

### 🟢 N3. `otm-clean.v1`, `FLOW_SOURCE_METADATA`, knowledge base names (lines 26, 60-61, 97)

- **Severity:** Nit
- **Description:** The filter profile, the metadata constant and the knowledge bases (Skydweller, QuantFinanceToGo,
  "the dealer gamma base") are named without a gloss.
- **Recommendation:** One clause each, for example "`otm-clean.v1`: out-of-the-money options, excluding complex, tied,
  floor and cancelled trades"; "`FLOW_SOURCE_METADATA`: the per-source freshness limits in `contracts/flow.ts`".

### 🟢 N4. Output fields are listed but not described (lines 112-114)

- **Severity:** Nit
- **Description:** `window` (baseline, newest, span, buckets, changes, gross, price), `levelsAt` versus `priceAt`,
  `distancePct` sign convention are names only.
- **Recommendation:** One line per non-obvious field, or point to the type's doc comments.

### 🟢 N5. "Web-only change" versus files in `packages/api` (line 161 versus lines 172-180)

- **Severity:** Nit
- **Description:** Rollout says web-only, while the rule lives in `packages/api` and is exported from its `index.ts`.
  A reader may think a server deploy is needed.
- **Recommendation:** Say "`packages/api` gains a pure module used only by the web bundle; no server behavior changes".

### 🟢 N6. Acceptance item for rendering has no method (line 184)

- **Severity:** Nit
- **Description:** "The badge renders on `/flow` and `/stock` (operator)" does not say whether this is a component test,
  an end-to-end test or a manual check.
- **Recommendation:** Name the check (test file or manual steps).

## Summary

| Severity | Count | Items |
| --- | --- | --- |
| 🔴 Blocker | 1 | B1 |
| 🟡 Major | 9 | M1 to M9 |
| 🟢 Nit | 6 | N1 to N6 |

The design's intent, truth table and boundaries (research only, no orders, no schema change) are clear. The gap is
self-containment: the rule's checks, the price and read-time choice, and the badge versus study distinction live in the
companion spec or in brainstorm shorthand, not in the design. Adding a code/condition table to the Rule section and an
inputs-per-page table to Pages would close B1, M1, M4 and M6 together.
