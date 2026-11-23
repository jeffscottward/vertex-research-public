# Consolidated review report: hedging pressure line design

- **Target:** `design.md`, draft of 2026-11-22 (251 lines; FeatureRange 1-167, DetailedRange 168-251).
- **Mode:** "Consolidated report with all review rubrics (runs full flow without stopping)", picked
  by the job under the standing owner rule of 2026-11-15 (made permanent 2026-11-18).
- **Dispatch:** direct (flat swarm), fresh-context Goldfish subagents, all completed:

| Stage | Reviewers | Report |
| --- | --- | --- |
| 5 Initial Zoom Out | egm-zoom-out, egm-inventive-catalyst | [zoom_out_report.md](zoom_out_report.md) |
| 6 Comprehension | egm-comprehension | [comprehension_report.md](comprehension_report.md) |
| 7 Critic | egm-design, egm-structural, egm-style | [critic_report.md](critic_report.md) |
| 8 Intermediate Zoom Out | egm-zoom-out (on the revised document) | [intermediate_zoom_out_report.md](intermediate_zoom_out_report.md) |
| 9 Implementation Readiness | egm-implementation-readiness, egm-codebase-details, egm-style | [implementation_readiness_report.md](implementation_readiness_report.md) |

Stages 5, 6, 7 and 9 ran in parallel on the draft. Stage 8 ran on the revised document after the
resolution, as the check that the fixes hold.

## Consolidated action items

Severity is the highest severity any reviewer gave. "Raw findings" is the traceability matrix
(reviewer id from each report).

| # | Sev | Action item | Raw findings |
| --- | --- | --- | --- |
| A1 | 🔴 | Access model contradicts `flow.tapeSpeed`: use operator session plus agent viewer (GET); not on the agent API key list; name the tests | CodebaseS9 B1; ReadinessS9 B1; StyleS9 S-3, S-4; Comprehension C3 |
| A2 | 🔴 | Add an "Alternatives Considered" section for compute place, sign rule, session, delta source, procedure | StructuralS7 S-01; DesignS7 F3 |
| A3 | 🔴 | Add an architecture section (read path, computation, procedure, page) and a data-flow figure | StructuralS7 S-02; Comprehension C4, C5 |
| A4 | 🟡 | Collector gaps make a session incomplete: read `optionGaps`, expose, shade, say "incomplete" | CatalystS5 F1; DesignS7 F1 |
| A5 | 🟡 | Calendar-day session mixes overnight SPX flow into the line; use the 09:30-16:15 options session, pre-open as totals | CatalystS5 F2; DesignS7 F5; StyleS7 S14; ReadinessS9 N4, N6 |
| A6 | 🟡 | IV placeholder rule unverified; check moneyness; fallback volatility | DesignS7 F4; StyleS7 S7 |
| A7 | 🟡 | Rate 0 and yield 0 conflict with the repo convention | DesignS7 F6 |
| A8 | 🟡 | "Must hedge" and "every print" overstate; the delta is frozen at print time (gamma) | DesignS7 F2; StyleS7 S1, S3, S5; Comprehension C1 |
| A9 | 🟡 | The $10,000 floor is an observation, not a vendor fact | StyleS7 S2, S10 |
| A10 | 🟡 | Largest-minute mitigation is not in the totals or contract | Comprehension C2; StyleS7 S4; DesignS7 F7; CatalystS5 F5; ZoomOutS5 N7 |
| A11 | 🟡 | Exact count precedence, `gross`, units of rule 3, "price" meaning, `iv <= 0` | ReadinessS9 M3; Comprehension C7, C8; DesignS7 F8, F14; CodebaseS9 N2 |
| A12 | 🟡 | Exact contract keys, types, nullability; rules type in the contract | ReadinessS9 M4; StyleS9 S-10 |
| A13 | 🟡 | Rules module must not import database types; local print type | ZoomOutS5 M1; CodebaseS9 M4; ReadinessS9 M8 |
| A14 | 🟡 | Symbol set hard-coded; derive from `FLOW_INSTRUMENTS` with a test | ZoomOutS5 M2 |
| A15 | 🟡 | `date` input has no consumer | ZoomOutS5 M4; Comprehension C13; DesignS7 F15; CodebaseS9 M5 |
| A16 | 🟡 | Vendor delta (option B) rejected on an unchecked fact | ZoomOutS5 M3; DesignS7 F13 |
| A17 | 🟡 | File list incomplete (contract keys test, repository doubles, db index, lab gateway, research test); mark Create/Modify | CodebaseS9 M1; ReadinessS9 M1 |
| A18 | 🟡 | "bun run check after each step" cannot pass; phases; missing gates | ReadinessS9 M2; CodebaseS9 M9; StyleS9 S-5 |
| A19 | 🟡 | Lab cannot show four fixtures | CodebaseS9 M8; ReadinessS9 M5 |
| A20 | 🟡 | Forbidden-answer hold for a third call not designed | CodebaseS9 M7; ReadinessS9 M6 |
| A21 | 🟡 | Text templates and number formats not given | ReadinessS9 M7; StyleS9 S-12; ZoomOutS5 N4 |
| A22 | 🟡 | Integration test conditional; repository return type | StyleS9 S-2; CodebaseS9 M2; ReadinessS9 M8 |
| A23 | 🟡 | New York helper not named; session bounds | StyleS9 S-1; CodebaseS9 M3; ZoomOutS5 N5; ReadinessS9 N2; Comprehension C16 |
| A24 | 🟡 | Builder signature, newest-print method, null session, never-throw delta | CodebaseS9 M6; ReadinessS9 N3; Comprehension C4, C5 |
| A25 | 🟡 | Acceptance not measurable (overflow, recomputation independence, tolerance) | StyleS9 S-6; ReadinessS9 N8 |
| A26 | 🟡 | Risks lack security, failure modes and scale; heading name | StructuralS7 S-03 |
| A27 | 🟡 | Sibling template sections missing; section order | StructuralS7 S-04, S-07 |
| A28 | 🟡 | Private source link (public repository) | StructuralS7 S-05 |
| A29 | 🟡 | Mock disagrees with the text | StructuralS7 S-06 |
| A30 | 🟡 | Goal 4 theme, width, keyboard and contrast claims unmatched | StyleS7 S6 |
| A31 | 🟡 | Freshness and source terms undefined; ES versus SPX units | Comprehension C1, C9; DesignS7 F10 |
| A32 | 🟡 | Unknown regeneration command | Comprehension C6; StyleS9 S-9; ZoomOutS5 N6; CodebaseS9 N1; ReadinessS9 N1 |
| A33 | 🟢 | Read cap drops the newest prints; truncation UI duplicates the header | CatalystS5 F3; ZoomOutS5 N2 |
| A34 | 🟢 | Cache closed sessions; measure end to end | CatalystS5 F4; DesignS7 F9; StyleS7 S9 |
| A35 | 🟢 | Line colors green/red mislead | DesignS7 F11 |
| A36 | 🟢 | DST day exceeds 1,440 points | DesignS7 F12; ReadinessS9 N4 |
| A37 | 🟢 | `dte`-null path for a case never seen | ZoomOutS5 N1 |
| A38 | 🟢 | `printSign` repeats the snapshot side grouping | ZoomOutS5 N3 |
| A39 | 🟢 | Two dealer conventions on one page | ZoomOutS5 N8 |
| A40 | 🟢 | Wording, metadata, heading, list style, rewrap, cross-reference, terms, "eight times", restart window, stroke width, test paths, window select, doc placement | Comprehension C10-C12, C14, C15; StructuralS7 S-08-S-14; StyleS7 S8, S11-S13, S15; StyleS9 S-7, S-8, S-11, S-13; CodebaseS9 N3-N6; ReadinessS9 N5, N7, N9 |

Totals: 3 Blockers, 29 Majors, 8 Nit groups. Resolutions: [goldfish_review_report.md](goldfish_review_report.md).
