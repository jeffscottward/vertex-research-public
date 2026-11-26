# EGM Drift Report — Stock Put/call OI Tile (revision of 2026-11-25)

![Dark before-and-after illustration of the implemented UI; mock counts](before-after.svg)

This report covers the revision of 2026-11-25: the tile value reads `No ratio` in place of a bare dash, the detail texts are shorter, and the status language allow list is unchanged. A fresh read-only agent compared each document of this folder with the code. The first run lists each difference and what was done about it. The second run checked the three documents that were edited after the first run.

**First run:**

## First run: plan.md

- The status line pointed to a drift report that described the earlier dash version. Fixed: the plan has a "Verification record" section, and the status line names this report.
- Acceptance check 4 said that component tests verify the `StatCard` slots for every state. The tests check the rendered slots for the loading and no-answer states, and the `chainKpis` values for every state. Fixed: the plan says this.
- Phase 2 said that 14 call cells and 11 put cells read `no OI`. The test counts 25 cells by their title and reads the text of the first cell. Fixed: the plan says this.
- Implementation step 3 listed two rules (no OI reported on both sides; some contracts without OI) where the code has one branch with the same text. Fixed: the plan has one rule.
- Phase 3 named one commit subject. Fixed: the plan points to `git log` of the branch.

## First run: before-after.svg

- The description said "a short dash". Fixed: it says the short value "No ratio".
- The before panel shortened "open interest" to "OI". Fixed: it quotes the text of the code before the change.

## First run: comprehension_report.md

- The report describes the plan with a dash as the value and uses the wording "why the ratio is unavailable". This is the record of the review of 2026-11-21. Not changed; the plan and the code use `No ratio` and do not use the word "unavailable".

## First run: consolidated_review_report.md

- The report names the dash as the value, eight required checks, 19 unit tests and pending review steps. Fixed: a section "Revision of 2026-11-25" at its end states what replaced these points. The text above it stays as the record of 2026-11-21.

## First run: critic_report.md

- The report records the selected "dash-plus-detail" approach and a proposed page-width check. Both are records of the review of 2026-11-21. Not changed; the plan rejects the bare dash and records why the page-width check was narrowed.

## First run: goldfish_review_report.md

- The report proposes a dash for all states without a ratio, and a page-width assertion. Both are records of the review of 2026-11-21. Not changed; the plan section "Alternatives considered" records the change to `No ratio`.

## First run: implementation_readiness_report.md

- The report says that the plan names eight required checks and a list of deleted paths. The plan names the checks that branch protection requires (`ci-gate` at the time of the revision) and a note about the removed reproduction test. Not changed: record of 2026-11-21.

## First run: intermediate_zoom_out_report.md

No drift detected.

## First run: zoom_out_report.md

- The report says that the plan keeps a dash for the loading, no-answer and error states, and cites a screenshot of the removed reproduction test. Record of 2026-11-21. Not changed; the states now read `No ratio`.

**Second run, after the fixes (plan.md, before-after.svg and the section "Revision of 2026-11-25" of consolidated_review_report.md):**

## plan.md

No drift detected.

## before-after.svg

No drift detected.

## consolidated_review_report.md

No drift detected.

The second run compared the quoted texts, test names and fixture counts with the code. It did not run tests and cannot confirm the live trace counts; those are in the plan section "Verification record".
