# Structural Goldfish report: GEX wall x net drift read (design.md)

- **Stage:** 7 (EGM review, structural lens)
- **Mode:** REVIEW
- **Target:** `docs/vertex-rebuild/designs/gex-wall-drift-confluence/design.md`
- **Scope reviewed:** FeatureRange, lines 1-167 (Overview through Future Improvements)
- **Blueprints used:** EGM `resources/document_standards/feature-spec-standard.md` and the EGM design template
  `skills/egm-draft/references/design_doc.md`; the sibling `vertex-viz-tape-speed/design.md` was read as the house
  convention for this folder.
- **Date:** 2026-11-25

## Summary

The document is well formed Markdown: every table has a header row, a separator row and a matching cell count; there
are no unclosed code fences; the relative links (`concepts_brief.md`, `before-after.svg`, `data-flow.svg`)
resolve to files in the folder. The structural problems are section-level: three template sections are missing or
replaced by sections of another shape (Open Questions, Critical User Journeys, Additional Resources), Alternatives
Considered does not use the per-alternative layout, and Non-Functional Requirements omits the security and privacy
part even though the design depends on an operator-only gate.

No Blocker. Five Major. Eight Nit.

## Heading map (FeatureRange)

| Line | Level | Heading | Template counterpart |
| --- | --- | --- | --- |
| 1 | H1 | GEX wall x net drift read (card ...) | Title |
| 15 | H2 | Overview | Overview |
| 22 | H3 | Terms | (none; acceptable) |
| 33 | H2 | The Problem | The Problem |
| 40 | H2 | Goals | Goals |
| 49 | H2 | Non-Goals | Non-Goals |
| 58 | H2 | Decisions taken (auto-decider, 2026-11-25) | replaces Open Questions |
| 84 | H2 | Technical Plan | Technical Plan (Architecture) |
| 86 | H3 | Rule (`gex-wall-drift-rules.v1`) | (subsection) |
| 116 | H3 | Pages | (subsection) |
| 128 | H2 | User experience | stands in for Critical User Journeys |
| 136 | H2 | Risks and Mitigations | required by the feature-spec standard |
| 146 | H2 | Alternatives Considered | Alternatives Considered |
| 154 | H2 | Non-Functional Requirements | Non-Functional Requirements |
| 159 | H2 | Rollout | belongs under Non-Functional Requirements |
| 163 | H2 | Future Improvements | Future Improvements |

Hierarchy is sequential: no level is skipped (H1 to H2 to H3 only).

## Findings

### Major

**1. Critical User Journeys section is missing (lines 128-134).**
The template requires an H2 "Critical User Journeys (CUJs)" with one H3 per journey and Given / When / Then bullets;
the sibling tape-speed design follows it. This design has a prose "User experience" section with three bullets and
places it after the Technical Plan instead of before it. The bullets mix three journeys (operator on `/flow`, outage
or after close, member or non-index ticker on `/stock`) and give no explicit precondition or verifiable outcome,
so they cannot be traced to acceptance tests.
*Recommendation:* rename to "Critical User Journeys (CUJs)", move it between Non-Goals (or Open Questions) and the
Technical Plan, and split it into at least four H3 journeys: graded read on `/flow`; no-data after close or on a
QuantData 401; operator on `/stock/SPY`; member on `/stock/SPY` and anyone on `/stock/NVDA` (no badge, no
request). Use Given / When / Then bullets in each.

**2. Open Questions section is replaced, not retained (lines 58-82).**
The template keeps an "Open Questions" H2 across drafting sessions and removes items as they resolve. The design
substitutes "Decisions taken (auto-decider, 2026-11-25)". A fresh reader cannot tell whether any question is still
open. The section also bundles three different contents: the decision table (Q1-Q6), an "applied" list of brainstorm
findings, and a "Declined" list, all under one heading with no sub-headings.
*Recommendation:* keep an "Open Questions" H2 that says "None open" (or lists what remains, for example the owner
confirming the auto-decisions), and either rename this section "Resolved Questions" or split it into H3 sub-sections
"Decisions (Q1-Q6)", "Brainstorm findings applied" and "Brainstorm findings declined".

**3. Brainstorm disposition list is incomplete and its IDs are not linked (lines 73-82).**
The paragraph enumerates the brainstorm findings by ID as applied or declined. Checked against `concepts_brief.md`,
it covers B1-B4, M1, M2, M4-M11, but omits M3 ("The regime depends on which flip source is used", brief line 211) and
the four N items (N1-N4). M3 is arguably answered by Q2 and by the "`/stock` and `/flow` levels differ" risk row,
but the list does not say so, so closure cannot be confirmed by reading. M2 and M6 appear in both the applied and the
declined lists without being marked as partly applied. None of the IDs are linked or defined in this document.
*Recommendation:* turn the paragraph into a table with columns ID, Finding (short title), Disposition (applied,
partly applied, declined, covered by Qn) and Where (section of this design). Include M3 and N1-N4. Link the ID column
to the brief's headings (for example `concepts_brief.md#-m3-...`) or at least to `concepts_brief.md`.

**4. Alternatives Considered does not use the per-alternative layout (lines 146-152).**
The template gives each alternative its own H3 with Pros, Cons and Reason for Rejection; the sibling design follows it
(Alternatives A through O). Here there are four flat bullets of one or two clauses. Three end with "Rejected" (two as
"Rejected." and one as "Rejected for v1."); the fourth ("Spec and rule only, no UI") never says whether it was
rejected. Further rejected options live elsewhere: the dollar floor and the shared window helper (lines 80-82,
"Declined"), backfill (Q3, line 68), a distance cutoff (Q2, line 67) and a mirrored hold below the flip (Q4, line 69).
The feature-spec standard's Alternatives Rule asks for concrete trade-offs per alternative; scattering them makes the
section look thinner than the analysis actually is.
*Recommendation:* give each alternative an H3 ("Alternative A: compute the read on the server", and so on) with
Pros, Cons and Reason for Rejection bullets; add the rejected options now held in the decision table and the
"Declined" paragraph, or cross-reference them from this section; state an explicit outcome for "Spec and rule only".

**5. Non-Functional Requirements omit Security & Privacy; Rollout is split out (lines 154-161).**
The template's NFR section covers Security & Privacy, Performance & Latency, and Rollout & Rollback. This section has
only performance and accessibility bullets; Rollout is a separate H2 (line 159). The operator-only gate on drift data
(Goals line 43, Non-Goals line 55, Q6 line 71, Pages lines 121-123) is an access-control requirement, yet it
is not stated as one anywhere in the NFRs, and no risk row covers it leaking to members.
*Recommendation:* add H3 sub-sections "Security & Privacy" (operator-only rendering and request, no request for
members, collector messages shown only to operators), "Performance & Latency" (current two bullets) and "Rollout &
Rollback" (move lines 159-161 here). Optionally add a risk row "drift data shown to a non-operator".

### Nit

**6. Heading name differs from template (line 84).** "Technical Plan" should be "Technical Plan (Architecture)", as in
the template and the sibling design.

**7. No Additional Resources section (FeatureRange end).** The design cites the companion study spec (line 46, as a
code path, not a link), `docs/vertex-rebuild/flow-pipeline.md` (line 178, code path), the brainstorm brief, the
owner reel and task file (line 11, no path), the job channel post and the job report (lines 60-62, no link) and the
knowledge bases. Add an "Additional Resources" section before Future Improvements with Markdown links, for example
`[gex-wall-drift-confluence.md](../../../specs/strategies/gex-wall-drift-confluence.md)`, and a path or ID for the
task file and job report. The companion spec is the most important link in the document and is not clickable.

**8. Status value outside the template set (line 8).** "draft for EGM review (...)" is not one of Draft, Proposed,
In Review, Approved. Use "In Review" and keep the brainstorm note on its own line.

**9. Front-matter order and separators (lines 1-13).** The two diagrams sit between the title and the metadata block;
the template puts Author, Status, Date directly under the title, followed by a horizontal rule. Move the images into
Overview (or after the metadata) and add the rule.

**10. Title glyph inconsistency (line 1 vs line 130).** The title uses a plain "x"; the UX copy and the brief use
"×". Pick one.

**11. Truth table detached from its list item and has a constant column (lines 104-110).** Item 3 "The truth table:"
is followed by an unindented table, so the list item renders empty and the table renders as a separate block. The
"Wall" column has the same value ("put or call") in every row and carries no information. Indent the table under item 3
(or end the list before it with a lead-in sentence) and drop the Wall column, stating once above the table that it
applies to both walls.

**12. Long values and output fields written as run-on prose (lines 95-96 and 112-114).** Nine frozen constants and
seventeen output fields are each packed into one paragraph. A two-column table for the constants (name, value, source)
and a bullet list for the output fields would make them scannable and easier to diff against `GEX_WALL_DRIFT_RULES`.

**13. The Problem states only the problem (lines 33-38).** The template asks for the problem and the proposed solution
in summary. One closing sentence pointing at the rule, badge and study would match.

## Outside FeatureRange (for the DetailedRange reviewer)

Lines 168-190 use "Files" and "Acceptance" instead of "Target Files to Create/Modify" and "Verification Plan"; no file
is marked Create or Modify and none has a "Proposed Changes" bullet; the verification categories (build, unit, lint,
coverage, E2E) are not separated. Noted only so it is not lost; not scored here.
