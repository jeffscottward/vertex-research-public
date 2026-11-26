# Consolidated Goldfish review: GEX wall × net drift read

**Target:** [design.md](design.md) (whole file) and the companion study spec
[gex-wall-drift-confluence.md](../../../specs/strategies/gex-wall-drift-confluence.md), state of 2026-11-25 19:00 ET.
**Mode:** consolidated report with all review rubrics (standing owner choice of 2026-11-15 and 2026-11-18).

## How the review ran

All stages ran at the same time as eight fresh-context subagents, each with only its persona file, the document
standard and the target paths. Step 8 (intermediate zoom-out) was not run as its own pass: the stages did not run in
sequence, so it had no earlier findings to check; the Step 5 zoom-out covered the full file.

| Stage | Reviewer | Status | Report |
| --- | --- | --- | --- |
| 5 Initial zoom-out | `egm-zoom-out` | completed | [zoom_out_report.md](zoom_out_report.md) |
| 5 Inventive lens | `egm-inventive-catalyst` | completed | [zoom_out_inventive_report.md](zoom_out_inventive_report.md) |
| 6 Comprehension | `egm-comprehension` | completed | [comprehension_report.md](comprehension_report.md) |
| 7 Critic | `egm-design` | completed | [critic_design_report.md](critic_design_report.md) |
| 7 Critic | `egm-structural` | completed | [critic_structural_report.md](critic_structural_report.md) |
| 7, 9 Critic and readiness | `egm-style` | completed | [critic_style_report.md](critic_style_report.md) |
| 8 Intermediate zoom-out | `egm-zoom-out` | not run | see above |
| 9 Readiness | `egm-implementation-readiness` | completed | [implementation_readiness_report.md](implementation_readiness_report.md) |
| 9 Code accuracy | `egm-codebase-details` | completed | [codebase_details_report.md](codebase_details_report.md) |

## Consolidated action items

Raw counts: 9 Blockers, 54 Majors, many Nits; after deduplication 24 action items. Dispositions are in
[goldfish_review_report.md](goldfish_review_report.md).

### 🔴 Blockers

| Id | Item | Raw findings |
| --- | --- | --- |
| C1 | The hold test can pass because of the flip side alone: compare `hold-A` with `flat` above the flip only; stratify H1 by flip side. | critic B1 |
| C2 | The study is too small for a 10-point effect: add a power statement, a larger minimum, an end date. | critic B2 |
| C3 | The touch definition conflicts with the re-arm rule. | style B1, critic M3 |
| C4 | The stopping rule and the split disagree on the touch counts. | style B2 |
| C5 | The test threshold mixes Holm and Bonferroni. | style B3 |
| C6 | The rule codes are not defined in the design. | comprehension B1, readiness M1 |
| C7 | The badge height does not cover its content, so states shift the page. | codebase B1 |
| C8 | `/stock` shows no badge while analytics loads or fails, so missing GEX has no state there. | codebase B2 |
| C9 | The price may come from a minute older than the newest one. | codebase B3 |

### 🟡 Majors

| Id | Item | Raw findings |
| --- | --- | --- |
| C10 | Touches are clustered by session and across SPX and QQQ; the z-test treats them as independent. | critic M1 |
| C11 | Peeking: data before the freeze and early runs could leak outcomes. | critic M9, style M |
| C12 | The spec test checks only the numbers, not the behaviour. | critic M6, codebase M6 |
| C13 | Live and study drift inputs differ (`longer` is not stored; vendor revisions). | inventive M2, critic M5 |
| C14 | A graded read can stay on `/stock` after its inputs age out. | critic M7, codebase M1 |
| C15 | No-data reads report `no_flip` even when the GEX has a flip. | readiness M2 |
| C16 | Both walls missing reads "not at a wall" instead of "No data". | codebase M4 |
| C17 | A failed `/flow` snapshot is described as "loading". | codebase M2 |
| C18 | The badge can grade while the collector freshness row says stale. | codebase M3 |
| C19 | Design structure: no user journeys, no open questions section, flat alternatives, no security requirement, no file actions. | structural M1-M5, readiness M4-M7, codebase M7 |
| C20 | Undefined terms and process references (touch, band, rising, operator, sources, auto-decider). | comprehension M1-M9, style M |
| C21 | Design copy of the rules goes stale; the spec must be the authority. | zoom-out M4, style M |
| C22 | `/stock` adds scope and uses an untested source. | zoom-out M1, inventive M3 |
| C23 | Green and amber pills look validated. | zoom-out M2 |
| C24 | The 15-minute window is rebuilt instead of shared with the slope. | zoom-out M3 |
| C25 | The badge grades every minute; the study counts first touches only. | inventive M1 |
| C26 | Nothing counts progress toward the stopping rule. | inventive M4, critic M2 |
| C27 | Falling drift lines (put selling at the put wall) are graded `flat`. | critic M4 |
| C28 | A drift-only badge is a missing alternative. | critic M8 |
| C29 | The frozen age limits depend on collector settings. | inventive N5 |

### 🟢 Nits

Stale design lines after the renames, SPX band in strikes, UTC input times, the duplicate ticker-to-group map, the
help text, `"-"` in money text, reordered props in `page.tsx`, the lab fixtures always reading stale, and smaller
wording items. All are handled in [goldfish_review_report.md](goldfish_review_report.md).

## Traceability

Every raw finding maps to one row above or to the Nits line; the per-finding text, line references and
recommendations are in the stage reports linked in the first table.
