# Consolidated review report: strike bar profiles design

- **Target:** `design.md`, draft of 2026-11-22 (313 lines; FeatureRange 1-249, DetailedRange
  250-313).
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
(reviewer and finding number from each report).

| # | Sev | Action item | Raw findings |
| --- | --- | --- | --- |
| A1 | 🔴 | The snapshot's single order-flow page covers minutes, not "the last N h"; captions false | DesignS7 1; CatalystS5 2 |
| A2 | 🔴 | V1 rejected on a wrong fact: QuantData documents a per-strike volume request; card asks for volume | DesignS7 2; StyleS7 7 |
| A3 | 🔴 | Premium sign: schema "not negative" but `parseFlow` keeps negative premiums | ReadinessS9 1; CodebaseS9 2 |
| A4 | 🔴 | `displayStrikes` default `size` cannot be typed; code and doc differ | StyleS9 2; ReadinessS9 2; CodebaseS9 1 |
| A5 | 🔴 | `trades` update not specified | StyleS9 1 |
| A6 | 🟡 | Two strike sets: rows move when the profile changes; Risk 4 false | ZoomOutS5 1; CatalystS5 1; DesignS7 4; StyleS7 3; ComprehensionS6 5 |
| A7 | 🟡 | Max-pain strike outside the display set: marker rule undefined; CUJ 4 overstated | CatalystS5 3; DesignS7 6; StructuralS7 4; StyleS7 2; ReadinessS9 4; CodebaseS9 6; ComprehensionS6 2 |
| A8 | 🟡 | Max pain bars unreadable when far strikes set the scale | CatalystS5 4; DesignS7 5; CodebaseS9 7 |
| A9 | 🟡 | `holderPayout` on the GEX row type forces `Omit` and a `gex-context.ts` change | ZoomOutS5 5; CatalystS5 6 |
| A10 | 🟡 | "Net premium" means call minus put in the flow section and bull minus bear here | ZoomOutS5 4 |
| A11 | 🟡 | Two strike tables in opposite order; mock BEFORE panel wrong | ZoomOutS5 3 |
| A12 | 🟡 | No alternative "extend the GEX table"; no rendering or orientation alternatives | ZoomOutS5 2; StructuralS7 7; DesignS7 8 |
| A13 | 🟡 | Caption strike rule wrong without spot and ambiguous "largest" | StructuralS7 5; DesignS7 7; ComprehensionS6 3; ReadinessS9 3; CodebaseS9 3 |
| A14 | 🟡 | View states: `ok` sections with a message; empty and zero cases | ReadinessS9 5; CodebaseS9 5; ComprehensionS6 4 |
| A15 | 🟡 | View-model types, scale rule, spot-equal rule, label formats, formatters | ReadinessS9 6, 7, 11; CodebaseS9 8, 9, 15; StyleS9 3, 9; ComprehensionS6 6, 7 |
| A16 | 🟡 | Phase A leaves the repository unbuildable (strict fixture) | ReadinessS9 8; CodebaseS9 10 |
| A17 | 🟡 | File table not an exact allowlist; missing doc, tests, Create/Modify | ReadinessS9 9; CodebaseS9 13; StyleS9 6 |
| A18 | 🟡 | Test cases named, not specified; missing edge cases | ReadinessS9 10; CodebaseS9 14; StyleS9 4 |
| A19 | 🟡 | Fixture payout must agree with its max pain | ReadinessS9 4; CodebaseS9 11 |
| A20 | 🟡 | Figures disagree with the text (labels, spot position, colours, edges) | StructuralS7 1-3; StyleS7 9; DesignS7 13; CodebaseS9 17; ReadinessS9 15 |
| A21 | 🟡 | Undefined project terms (QuantData, GEX, `/lab`, QuantVPS, display strikes) | ComprehensionS6 1, 9; StructuralS7 10 |
| A22 | 🟡 | Risks lack security, payload and cost entries; Risk 5 has no risk sentence | StructuralS7 6, 11; StyleS7 19 |
| A23 | 🟡 | Open Questions "None" not supported; card text not quoted | StructuralS7 8; StyleS7 7 |
| A24 | 🟡 | Goal 4 not measurable; "tested at 375 px" stated as done | StyleS7 5, 6 |
| A25 | 🟡 | Per-expiry OI is a choice, not a vendor limit | DesignS7 3 |
| A26 | 🟡 | Coverage command missing; acceptance widths and URL | CodebaseS9 12; ReadinessS9 14; StyleS9 8, 12, 13 |
| A27 | 🟢 | Flow print filter differs from the options chain (`flowByContract`) | ZoomOutS5 6 |
| A28 | 🟢 | Toggle semantics: one of four is a radio group | DesignS7 9 |
| A29 | 🟢 | Wording, labels, units, metadata, rollback, view-model folder, literal code in plan | StyleS7 1, 4, 8, 10-18; StructuralS7 9, 12-15; ZoomOutS5 7-11; DesignS7 10-12, 14; CatalystS5 5; CodebaseS9 16, 18, 19; StyleS9 5, 7, 10, 11, 14, 15; ReadinessS9 12, 13, 16; ComprehensionS6 8, 10, 11 |

Totals: 5 Blockers, 23 Majors, 3 Nit groups. Resolutions: [goldfish_review_report.md](goldfish_review_report.md).
