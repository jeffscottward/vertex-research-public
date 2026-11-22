# Structural Goldfish review: bearish put-spread design (FeatureRange)

* **Reviewer:** Structural Goldfish (EGM Stage 7 Critic Review)
* **Mode:** REVIEW
* **Target:** `docs/vertex-rebuild/designs/bearish-put-spread/design.md`, lines 1-148 (Overview through Alternatives Considered)
* **Standard:** `resources/document_standards/feature-spec-standard.md` (EGM 0.1.1); layout blueprint `skills/egm-draft/references/design_doc.md`
* **Date:** 2026-11-22

--------------------------------------------------------------------------------

## Structure map (FeatureRange)

| Line | Level | Heading | Blueprint section |
| --- | --- | --- | --- |
| 1 | H1 | Bearish put-spread rule: spread pricing, breadth series, backtest and option strategies in the engine comparison | Title |
| 3-5 | list | Author / Status / Date | Metadata (matches) |
| 7, 9 | image | `before-after.png`, `data-flow.png` | Not in blueprint |
| 11 | rule | `---` | Divider (matches) |
| 13 | H2 | Overview | Overview (matches) |
| 24 | H2 | The Problem | The Problem / Problem Statement (matches) |
| 47 | H2 | Goals | Goals (matches) |
| 55 | H2 | Non-Goals | Non-Goals (matches) |
| — | — | *(absent)* | Open Questions |
| — | — | *(absent)* | Critical User Journeys |
| 63 | H2 | Method decisions (decision record) | Extra section |
| 86 | H2 | Technical Plan | Technical Plan (Architecture) / Proposed Architecture |
| 103, 108, 114, 126 | H3 | 1. Spread pricing … 4. Engine comparison | Components |
| 130 | H3 | Deploy order and rollback | Belongs to Non-Functional Requirements (rollout) |
| 138 | H2 | Alternatives Considered | Alternatives Considered (present, format deviates) |
| — | — | *(absent)* | Risks & Mitigations / Non-Functional Requirements |

Heading levels never skip (H1 → H2 → H3). Fences are balanced (88/101, language `text`). Both tables in range are well formed (lines 67-77: 4 columns on every row).

Claims spot-checked against the code and found accurate: `flow_gex` retention 14 days (`packages/api/src/server/flow-collect.ts:162`); `readChain` 60 s cache (`CACHE_TTL_MS = 60_000`, `packages/api/src/server/options-chain.ts:37`); `bsPrice`, `bsDelta`, `atmIv`, `smileIv` exported from `packages/api/src/options-engine/pricing.ts:106,130,150,159`; `loadSeries` and `latestPoints` in `packages/db/src/server/market-daily-series.ts:95,100`; academy specs `itm-cash-secured-put` and `iron-condor-implied-move` exist in `packages/academy/src/lessons/specs/`; `EY_TNX_RATIO` exists as a derived series.

## Findings

### F1. No Risks & Mitigations section

* **Severity:** 🔴 Blocker
* **Affected lines:** 13-148 (whole FeatureRange); related content scattered at 39-45, 130-136, and 182-189 (outside range)
* **Description:** The standard's "Risks & Limits" clause requires the spec to call out failure modes, security implications, scalability limits, and their mitigations, and lists **Risks & Mitigations** as a required area. The FeatureRange has no such section and the blueprint's Non-Functional Requirements section is also absent. Risk material is fragmented: data limits are a plain paragraph inside The Problem (39-45), the roll-forward-only series id is a sentence under Technical Plan (136), and the `## Limitations` list (182-189) lies in the DetailedRange and states limits without mitigations. Not addressed anywhere in range: the security posture of the new `optionsChain.spread` procedure (operator-only access is mentioned only in the Detailed table, line 158); load on the shared chain cache from a second consumer; added runtime and failure handling of the serial academy phase in the 06:15 driver run; what happens when a worker on old code claims a run that reads `NYSE_UPVOL_PCT`.
* **Recommendation:** Add `## Risks & Mitigations` (or the blueprint's `## Non-Functional Requirements` with Security, Performance, Rollout & Rollback sub-items) after Alternatives Considered. Use a table `Risk | Impact | Mitigation`. Move "Deploy order and rollback" (130-136) into it, and either move Limitations (182-189) into it with a mitigation per row or cross-link it.

### F2. Alternatives Considered does not follow the blueprint format and has no pros

* **Severity:** 🟡 Major
* **Affected lines:** 138-147
* **Description:** The blueprint requires one `### Alternative X:` block per option with **Pros**, **Cons**, and **Reason for Rejection**. The document uses a flat bullet list with only a rejection rationale, so the benefit side of each trade-off is never stated (for example, copying breadth into `market_daily_points` would have needed no registry and no special case in `loadSeries`). Line 146 is labelled "Deferred" rather than rejected, which breaks the uniform pattern and duplicates Non-Goal line 60 ("a short stock side for instant backtests").
* **Recommendation:** Convert to either `### Alternative A: …` blocks with Pros/Cons/Reason, or one table `Alternative | Pros | Cons | Decision`. Move the deferred short-stock item to a Future Improvements list, or keep it only in Non-Goals.

### F3. Broken image links

* **Severity:** 🟡 Major
* **Affected lines:** 7, 9
* **Description:** `before-after.png` and `data-flow.png` are referenced relative to the design folder, but the folder contains only `design.md`, `brainstorm_review.md`, and `concepts_brief.md` (checked with gitignore disabled). Both images render as broken links. Sibling designs (`research-screen/`, `research-report-technicals/`) ship these files. The Detailed table (line 173) also lists "images" as part of the record.
* **Recommendation:** Add both images to the folder before review closes, or remove the references. If kept, place them under Overview or Technical Plan rather than between the metadata block and the divider, which the blueprint does not define.

### F4. Missing blueprint sections: Open Questions and Critical User Journeys

* **Severity:** 🟡 Major
* **Affected lines:** between 61 and 63 (insertion point); 79-84
* **Description:** The blueprint places `## Open Questions` and `## Critical User Journeys (CUJs)` after Non-Goals. Neither exists. The open items are present but hidden: "Pathway to proving the rule (what is still missing):" (79) is an unformatted paragraph label inside the Method decisions section, followed by a numbered list (81-84). There are no Given/When/Then journeys, although Goals G1, G3 and G4 describe three distinct actors (agent pricing a spread, operator submitting runs, daily driver populating the comparison).
* **Recommendation:** Add `## Open Questions` holding the four pathway items (each as `**Question n**: …`). Add `## Critical User Journeys` with three CUJs (agent calls `optionsChain.spread`; operator submits the five definitions and reads `backtestRuns.list`; 06:15 driver run adds academy rows to `comparisons.list`), each with Given/When/Then.

### F5. The Problem section mixes problem, specification, and environment facts under pseudo-headings

* **Severity:** 🟡 Major
* **Affected lines:** 24-45
* **Description:** Only lines 26-28 state the problem. Lines 30-37 specify the trading rule, structure, and exits, and lines 39-45 list database facts. Each block is introduced by a plain-text label ending in a colon ("The rule (check near 15:45 New York, all four on one session):" line 30, "Structure:" line 37, "Facts that limit the test (live database, 2026-11-22):" line 39) instead of a heading, so the hierarchy is invisible to a reader or parser. Line 37 is also a 346-character paragraph packing structure, invalidation, and the owner exit rule together.
* **Recommendation:** Keep The Problem to lines 26-28. Promote the rest to H3 subsections, for example `### The consult rule`, `### Spread structure and exits`, `### Data constraints (2026-11-22)`, either under The Problem or under a new `## Background` section. Split line 37 into a list.

### F6. Technical Plan diagram is misaligned and misplaces components

* **Severity:** 🟡 Major
* **Affected lines:** 88-101
* **Description:** The box's right border is inconsistent (corner `┐` at column 96 on line 89, `│` and `┤` at column 97 on lines 90-91, corner `┘` at column 97 on line 99) and absent on lines 93-98, so the box is open. The model return arrow `◀───┘` (line 92) ends on the box's right edge and reads as a corner. The box is labelled "API (packages/api)" but encloses `market_daily_points`, `breadth90_days`, "(virtual series registry, db)" and the Python worker's flow, which belong to `packages/db` and `services/research`. The standard asks for component layout; this diagram blurs the package boundary the design depends on (the registry lives in `packages/db`, line 110). Line 100 (driver lane) is 106 columns, wider than the box.
* **Recommendation:** Redraw with one box per owner (`packages/api`, `packages/db`, research worker, rig driver), consistent column widths, and arrows that terminate at labels rather than borders. The referenced `data-flow.png` (F3) could replace or complement it.

### F7. Unlinked sources and attributions

* **Severity:** 🟡 Major
* **Affected lines:** 3, 51, 58-59, 65, 69-77 (Source column), 81, 111, 124, 141, 143
* **Description:** Decisions and rejections cite "brainstorm B1/B2/B3/M11/M12/M13/N5", "Consult section 3", "owner rule 2026-11-14", "owner 2% rule", cards `vertex-gamma-flip-sources` and `vertex-option-model-calibration`, and "the job report", none as links. `brainstorm_review.md` sits in the same folder, so these are linkable. The standard requires that rejections not be attributed without a link; line 141's rejection rationale rests on "brainstorm B2" and the D-table attributes decisions to the owner. "The job report" (51, 65, 81, 124) has no path, so a reader cannot verify the knowledge-base answers the decision record depends on.
* **Recommendation:** Link brainstorm items to anchors in `brainstorm_review.md`, give the job report's path, and link the owner rules and cards to their source (card file, issue, or message record).

### F8. Rollout subsection sits among numbered components

* **Severity:** 🟢 Nit
* **Affected lines:** 103-136
* **Description:** Technical Plan subsections are numbered `### 1.` to `### 4.` and map one-to-one to Overview items 1-4, but `### Deploy order and rollback` (130) is an unnumbered sibling of a different kind (rollout, not a component).
* **Recommendation:** Move it to the Risks/Non-Functional section (see F1), or number it `### 5.`.

### F9. Heading names and the extra decision-record section deviate from the blueprint

* **Severity:** 🟢 Nit
* **Affected lines:** 63, 86
* **Description:** `## Technical Plan` omits the blueprint's "(Architecture)". `## Method decisions (decision record)` is an extra H2 placed between Non-Goals and Technical Plan; its content is valuable but it also carries the open-questions list (F4).
* **Recommendation:** Rename to `## Technical Plan (Architecture)`. Keep the decision record, but either make it `### Method decisions` under Technical Plan or keep the H2 and move lines 79-84 out (F4).

### F10. Missing section dividers

* **Severity:** 🟢 Nit
* **Affected lines:** 137, 148
* **Description:** The blueprint uses `---` rules to separate the architecture block, Non-Functional Requirements, and the Detailed Implementation Plan. The document has only the rule at line 11; nothing marks the boundary between the FeatureRange and the DetailedRange at line 148/149.
* **Recommendation:** Add a horizontal rule before the Risks/NFR section and before `## Detailed Implementation`.

### F11. Inconsistent bullet markers

* **Severity:** 🟢 Nit
* **Affected lines:** 3-5 versus 26-147
* **Description:** The metadata block uses the blueprint's `*` marker; every other list (36 items) uses `-`.
* **Recommendation:** Use one marker throughout; the blueprint's `*` is the reference.

### F12. Overlong title and unwrapped lines

* **Severity:** 🟢 Nit
* **Affected lines:** 1; 23 lines over 200 characters, worst 65 (715 characters), 73 (399), 72 (391), 106 (493)
* **Description:** The H1 is a five-part feature list. Body paragraphs and table cells are unwrapped, which makes line-anchored review comments (like these) imprecise; the blueprint wraps at 80 columns.
* **Recommendation:** Shorten the title (for example, "Bearish put-spread rule research") and let the Overview carry the four parts. Wrap prose at 80 columns; keep table rows single-line but shorten the D5 and D4 cells by moving detail to footnotes or the spec file.

### F13. Goals and Overview do not map one-to-one

* **Severity:** 🟢 Nit
* **Affected lines:** 15-20, 49-53
* **Description:** Overview items 1-4 map to Technical Plan §1-4, but Goals run G1-G5 and G5 ("method decisions … written down before the runs") has no Overview item or Technical Plan section; it is met by the Method decisions section.
* **Recommendation:** Add a cross-reference from G5 to the Method decisions section, or note in the Overview that the decision record is a fifth deliverable.

## Summary

| Severity | Count | Findings |
| --- | --- | --- |
| 🔴 Blocker | 1 | F1 |
| 🟡 Major | 6 | F2, F3, F4, F5, F6, F7 |
| 🟢 Nit | 6 | F8, F9, F10, F11, F12, F13 |

The FeatureRange has a sound H1/H2/H3 hierarchy, balanced code fences, well-formed tables, and the code claims checked are accurate. It fails the Feature Specification Standard on the missing Risks & Mitigations section (F1). The Major findings are layout gaps against the EGM blueprint (Alternatives format, Open Questions, CUJs), broken image links, a misdrawn component diagram, and unlinked sources.
