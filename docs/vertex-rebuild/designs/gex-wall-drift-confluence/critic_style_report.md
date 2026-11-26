# Style Goldfish report: GEX wall x net drift read

- **Mode:** REVIEW (Stage 7 feature range and Stage 9 detailed range, style lens)
- **Targets:** `design.md` lines 1-185 (FeatureRange 1-167; DetailedRange 84-127 and 168-185; the file ends at line
  185, not 190) and the companion spec `docs/specs/strategies/gex-wall-drift-confluence.md` lines 1-154.
- **Snapshot note:** both files changed while this review ran (for example `unknown` became `no flip` / `no_flip`, and
  the spec dropped the derived net drift total). Line numbers and quotes below match the files as last read.
- **Lens:** tone, precision, terminology, claim calibration. Code and behaviour were not reviewed.
- **Evidence checked:** `FLOW_SOURCE_METADATA` in `packages/api/src/contracts/flow.ts` (`gex` 1800 s, `net_drift`
  300 s) matches design line 97 and spec line 91; `FLOW_NET_DRIFT_SLOPE_MINUTES = 15` is in
  `packages/api/src/flow-control-rules.ts:46`; the cadences (GEX about every 14 minutes, net drift every 2 minutes) are
  documented in `docs/vertex-rebuild/flow-pipeline.md`; `docs/specs/strategies/flow-control-continuation.md` lines
  57-62 and 89-90 were read for the provenance claim at spec line 87.

## Summary

The tone is dry and factual, with almost no marketing language. The problems are precision problems. The spec is
frozen at the commit that adds it ("it never edits this one", spec lines 5-8), so every ambiguity in it becomes
permanent. Three spec findings are Blockers for that reason: the touch definition contradicts itself, the stopping
rule counts an out-of-sample set that exists only after the split, and the stated p threshold contradicts the named
Holm procedure. The design overloads the word "read", relies on undefined process jargon and finding IDs, still
describes a derived net drift total that the spec has dropped, and makes claims ("tests the rule before anyone relies
on it", "web-only change", "every read reproducible") that outrun the plan.

Counts: 3 Blocker, 16 Major, 16 Nit.

## Blockers (spec; fix before the freezing commit)

### B1. Touch definition contradicts the re-touch rule

- **Scope:** spec lines 99-103 (Event).
- **Rationale:** Line 99 defines a touch as "the first read time of a session" that meets the conditions. Lines
  102-103 then allow further touches of the same wall after 30 minutes outside the band, and count a new strike as a
  new wall. Both cannot hold. A frozen spec with two readings lets the runner author choose the touch count later.
- **Recommendation:** Define a touch as "a read time at which ..." and keep the re-arm rule as the only limit, or keep
  "first per session per wall" and delete the re-arm rule. Define "from the inside" (between the put wall and the call
  wall) in the same sentence.

### B2. Stopping rule counts an out-of-sample set that is defined only after the split

- **Scope:** spec lines 117-121 (Pass/fail rule).
- **Rationale:** Line 117 says the run happens when "the out-of-sample set has at least 40 touches in each" class.
  Lines 120-121 define the out-of-sample set as the later 50% of touches, which is known only once the run splits the
  data. The rule is circular, and a reader cannot tell whether 40 or 80 touches per class must exist before the run.
- **Recommendation:** State the trigger on the full set, for example "at least 80 touches in each class across SPX and
  QQQ, so that the later half can hold 40", and keep line 121 as the post-split check.

### B3. The p threshold contradicts the named Holm procedure

- **Scope:** spec lines 122-125.
- **Rationale:** "p < 0.025 (Holm over H1 and H2 at 0.05)" states two different rules. Holm with two hypotheses tests
  the smaller p against 0.025 and, if that passes, the larger p against 0.05. A flat p < 0.025 for each hypothesis is
  Bonferroni. H2 then says "with the same test" (line 125), which inherits the ambiguity.
- **Recommendation:** Write one procedure exactly, for example: "Order the two one-sided p values. The smaller passes at
  p < 0.025; the larger then passes at p < 0.05. Each also needs the 10-point difference."

## Major

### M1. "Read" has at least five meanings

- **Scope:** design lines 1, 18-20, 35-38, 112, 120, 126, 134; spec lines 1-4, 17-18, 63, 99, 105-106.
- **Rationale:** "read" is the badge output ("The read is research context"), the output field `read`, the code family
  `no-read`, the UI label "No read", a verb ("must read the GEX table", "touches read `break-risk`"), and a timestamp
  ("read time", "the read time's minute of the session"). "Nobody can test whether the read works" (line 36-37) and
  "the read does not apply there" (line 134) make the reader guess which one is meant.
- **Recommendation:** Add "Grade" and "Read time" to Terms. Use "grade" for the output (`hold-A`, `break-risk`,
  `no-read`, `no-data`), "read time" only for the evaluated minute, and "graded" for the verb ("touches graded
  `break-risk`").

### M2. Overview says the rule grades a "touch"; the rule grades any at-wall minute

- **Scope:** design line 18; Terms (lines 22-31); spec lines 99-101.
- **Rationale:** "grades the current wall touch" suggests the spec's event (approach from inside, re-arm after 30
  minutes). The live rule (design lines 99-110) has no approach or re-arm condition: it grades every minute within
  0.25% of a wall. "Touch" is never defined in the design.
- **Recommendation:** Overview: "grades the newest settled minute when price is within 0.25% of a wall". State once
  that the study's "touch" is a stricter subset of the minutes the badge grades.

### M3. The study is said to test the rule "before anyone relies on it"; the badge ships first

- **Scope:** design line 19; spec lines 117-119.
- **Rationale:** The badge ships with this change; the study cannot run before 2027-03-01. The sentence implies the
  order test, then show. Action: **CALIBRATE**.
- **Recommendation:** "... and a pre-registered study spec. The badge ships before the study can run (not before
  2027-03-01) and is marked 'Unvalidated' until then."

### M4. "Push side" definition states the hypothesis as fact

- **Scope:** design lines 28-29.
- **Rationale:** "the drift that drives price through the wall" asserts the causal claim that H1 exists to test.
  Action: **CALIBRATE**.
- **Recommendation:** "Push side: the drift the reel associates with a break: puts at the put wall, calls at the call
  wall."

### M5. "Rising" and "band" are undefined in the design; "band" is undefined in the spec

- **Scope:** design lines 96, 106-110 (truth table headers); spec lines 72-73 and 100-112.
- **Rationale:** The design lists `risingShare` 0.30 but never says a side is rising when its share is at least 0.30
  (only spec line 70 says so). The spec uses "the band" from line 100 onward, but the Rules section only says "0.25% of
  price" (line 72) and never names it the band.
- **Recommendation:** Design Terms: "Rising: a side whose share is >= 0.30." Spec Rules: "The band is 0.25% of price."

### M6. `flat` names a state that is not flat

- **Scope:** design lines 106-110 (Neither column); spec lines 17-18 and 77-81.
- **Rationale:** `flat` is assigned whenever neither side reaches a +0.30 share. That includes a window where one side
  falls sharply (for example put share -0.6, heavy put selling). H1 and H2 use `flat` as the control group, so readers
  will assume "little flow" where the group means "no side rising".
- **Recommendation:** Rename the code to `none_rising` before the freeze, or define `flat` in both documents as
  "neither side share >= 0.30, falling sides included".

### M7. Process jargon and unseen authorities used as justification

- **Scope:** design lines 1, 8, 11, 58-62, 66 and 71 (Reason column), 152; spec line 22.
- **Rationale:** "card", "EGM", "owner reel", "task file", "auto-decider rule", "job channel", "job report", and "the
  task names these values" / "the task asks for it" refer to artifacts a new reader cannot open. Three decisions (Q1,
  Q6 and the rejected "spec and rule only" alternative) rest on "the task" alone.
- **Recommendation:** Give a path or link for each artifact once (task file, reel summary, the job report that holds
  the knowledge-base answers), or replace "the task asks for it" with the requirement itself, for example "the owner
  asked for a visible badge on `/flow` and `/stock`".

### M8. Brainstorm finding IDs are unresolvable and double-booked

- **Scope:** design lines 73-82.
- **Rationale:** The paragraph lists IDs (B1-B4, M1-M11) defined only in `concepts_brief.md`. M2 and M6 appear both
  as applied (lines 75-76) and as declined (lines 80-81). M3 is absent with no disposition.
- **Recommendation:** Replace the paragraph with a table: ID, the finding in one line, disposition (applied, partly
  applied, declined), and the design line that implements it. Split M2 and M6 into their applied and declined parts and
  give M3 a row.

### M9. Design still describes a derived net drift total that the spec removed

- **Scope:** design lines 76-77; spec lines 36-38 and 136.
- **Rationale:** The design says "vendor total for live reads with the derived total reported in the study (M8)". The
  spec now says a minute without a `total` row "is a gap; no other part fills it", and reports gaps, not a derived
  total. The two documents disagree on what the study does with missing totals.
- **Recommendation:** Update the M8 entry to "vendor total only, live and in the study; minutes without a total are
  gaps and are reported".

### M10. Gamma source count disagrees between the documents

- **Scope:** design line 53; design line 90; spec line 34.
- **Rationale:** The design says "the three gamma sources" without naming them. The spec names `flow_gex` plus OpenBB,
  market-watch-bot and on-demand options analytics (four). The rule input accepts two (`flow_gex`,
  `options_analytics`).
- **Recommendation:** Name the sources once in design Terms and use the same count in both documents.

### M11. `hold-A` implies a grade scale that does not exist

- **Scope:** design line 66 (Q1); spec line 18.
- **Rationale:** "the help text defines A as the only hold grade" admits there is no B or C. A reader of the badge or
  the study output will look for the other grades.
- **Recommendation:** State in Terms why the suffix exists (for example, reserved for a later rules version), or rename
  to `hold` before the freeze.

### M12. "Every read reproducible" is broader than the stored data

- **Scope:** design lines 148-149 (Alternatives).
- **Rationale:** `/flow` reads use stored `flow_gex` and `flow_net_drift` rows. `/stock` reads can use the
  `options_analytics` levels source (lines 90 and 144), which spec line 34 lists as an on-demand source outside the
  stored data. Action: **CALIBRATE**.
- **Recommendation:** "the stored rows already make every `/flow` read reproducible", or state where `/stock` levels
  are stored, if they are.

### M13. "Web-only change" understates the rollback scope

- **Scope:** design line 161 (Rollout); compare lines 172-178.
- **Rationale:** The file list adds `packages/api/src/gex-wall-drift-rules.ts`, a spec test and an `index.ts` export,
  plus two documents. "Revert the web commit" assumes one commit that touches only `apps/web`. Action: **CALIBRATE**.
- **Recommendation:** "No server endpoint, schema, table or data change. The API package gains one pure module used by
  the browser. Rollback: revert the feature commits; nothing to migrate."

### M14. Provenance of `windowMinutes` misstates the source study

- **Scope:** spec line 87.
- **Rationale:** "variant V1 of the failed `flow-control-continuation` study, chosen there on 13 sessions." In that
  spec the 13 sessions (2026-10-28 to 2026-11-13) chose the 30-minute primary window (its lines 89-90). V1 is the
  15-minute one-value variant (its line 62) and was not chosen. Action: **CALIBRATE**.
- **Recommendation:** "Equal to `FLOW_NET_DRIFT_SLOPE_MINUTES` (the 15-minute slope on `/flow`); tested as variant V1 of
  `flow-control-continuation`, whose primary window was 30 minutes."

### M15. "This study counts them as earlier trials" has no effect on the verdict

- **Scope:** spec line 95.
- **Rationale:** The pass/fail rule corrects only over H1 and H2. The ten earlier trials enter no threshold, so the
  sentence claims an accounting step that does not happen. Action: **CALIBRATE** or **DROP**.
- **Recommendation:** State how the 10 trials enter the threshold, or write "The 10 trials of
  `flow-control-continuation` used the same net drift data; they are disclosed here and not corrected for."

### M16. "Reported alone" is ambiguous; `nearWallPct` provenance skips a verdict ticker

- **Scope:** spec lines 40-43 and 90.
- **Rationale:** "SPY and NDX are reported alone" and "early closes and FOMC decision days are reported alone" do not
  say whether those touches count toward the 40-touch stopping rule or the verdict. Line 90 justifies 0.25% as "one to
  two strikes on SPY and QQQ", but SPX is a verdict ticker and is not covered (at about 6000, 0.25% is about 15
  points, roughly three 5-point strikes). The choice of SPX (index) for one group and QQQ (ETF) for the other is not
  explained.
- **Recommendation:** Replace "reported alone" with "excluded from the stopping rule and the verdict; reported
  separately". Add SPX and NDX strike counts to line 90. Give one clause on why SPX and QQQ are the verdict tickers.

## Nit

1. **Design line 1, spec line 1:** the title uses "x"; the UI string (design line 130) uses "×". Use one form.
2. **Design line 13:** the reel summary ends "flat = wait", while Non-Goals (line 51) bans "wait" as advice wording and
   spec line 24 says "flat flow means no read". Mark the phrase as the reel's wording or use "no read".
3. **Design line 18:** "compact badge" is a subjective size. State the size (`min-h-20`, two-line reason) or drop
   "compact".
4. **Design line 36:** "two people (or two days) read the same picture differently" is asserted without an example.
   **CALIBRATE** to "there is no written rule, so the combination cannot be repeated or tested".
5. **Design lines 37-38:** "HTTP 401 has happened" has no date or log reference; add one or drop the parenthesis.
   "the combined read has no data" refers to a feature that does not exist yet; say "nothing marks the drift input as
   missing".
6. **Design line 80:** "a dollar floor on gross premium (M6) is not in v1: a per-ticker floor needs ..." chains two
   colons. Split into two sentences.
7. **Design lines 106-110, spec lines 77-81:** the Wall column says "put or call" in every row. Drop the column and
   state "Same for both walls" above the table. The Flip side column says "no flip" while the code (spec line 74) is
   `no_flip`; use the code.
8. **Design lines 101-102:** the codes `gex_missing`, `gex_stale`, `gex_no_spot`, `drift_missing`, `ticker_mismatch`,
   `drift_stale`, `no_price` and `zero_premium` are not named in the spec Rules (spec line 69 says only "Zero gross:
   `no-data`"). The frozen spec should name every code it can emit.
9. **Design line 97 vs spec line 91:** the design says the age limits are "from `FLOW_SOURCE_METADATA`"; the spec says
   they are copied as numbers so that a later collector change cannot move them. Use the spec wording in the design.
10. **Design lines 119 and 123:** "the group of the view already includes it" and "A new analytics answer reloads the
    drift" use "group" and "answer" without definition. Use "symbol group" (with a pointer) and "response".
11. **Design lines 125, 66 and 140:** the marker text appears in three forms ("Unvalidated: study accruing · research
    only", "Unvalidated: study accruing", "research-only label"). Give the exact string once and refer to it.
12. **Design line 131 vs line 124:** "a one-line description" conflicts with `line-clamp-2` (two lines). Use one number.
    "the real window span" → "the measured window span".
13. **Design line 134:** "the read does not apply there" mixes an access rule (members on SPY) with an unsupported
    ticker (NVDA). Say "members do not see drift data, and NVDA has no paired drift series".
14. **Design lines 140 and 143:** "study spec with a pass/fail rule" does not mitigate the badge reading as advice; drop
    it from that row. "QQQ flip far above spot ... which is visible, not hidden" is vague and redundant; use the spec's
    figure ("8 to 11% above spot on 2026-11-20") and drop "visible, not hidden".
15. **Design line 152:** "safest" is a subjective ranking. Name the risk avoided ("no risk of the badge being read as
    advice").
16. **Spec lines 27-28, 105-106, 111, 126, 132, 142:** "The values below are therefore Vertex choices" contradicts the
    provenance table, where four values are inherited; say "chosen by Vertex or inherited, as listed". "the read time's
    minute of the session" → "minute of the session (0-389) at the touch". "a minute close" should name the price
    field (`underlying_price` of the net drift minute). "The same sign" should say "the same sign of the rate
    difference". Cite the source of the QQQ 8 to 11% figure. "Stored walls are short" → "Stored wall history is short
    (from 2026-11-08)".

## Checked and kept (no finding)

- Design line 97 and spec line 91: the age limits (30 and 5 minutes) equal `FLOW_SOURCE_METADATA` (1800 s, 300 s).
- Spec lines 33 and 92: GEX about every 14 minutes and net drift every 2 minutes match `flow-pipeline.md`.
- Spec lines 3-4 and design line 20: "never places, arms or sizes anything" matches the Non-Goals and the file list.
- Design line 182: "new files 100% covered" is a measurable acceptance criterion.
