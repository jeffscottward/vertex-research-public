# Consolidated review report: vertex-flow-collect-holiday-guard plan

**Target:** `docs/vertex-rebuild/designs/vertex-flow-collect-holiday-guard/plan.md` (revision 1; FeatureRange 1-110, DetailedRange 111-142)
**Mode:** Consolidated report with all review rubrics (full flow without stopping; standing owner rule 2026-11-15).
**Stage reports:** [zoom_out_report.md](./zoom_out_report.md) (Stage 5), [comprehension_report.md](./comprehension_report.md) (Stage 6), [critic_report.md](./critic_report.md) (Stage 7), [intermediate_zoom_out_report.md](./intermediate_zoom_out_report.md) (Stage 8), [implementation_readiness_report.md](./implementation_readiness_report.md) (Stage 9).

## Action items by priority

### 🔴 Blocker

| ID | Action | Raw findings |
| --- | --- | --- |
| A1 | Make the shared session helpers follow the calendar: `flowSessionDate` returns the newest NYSE trading session at or before now (reuse `previousNyseTradingDay`, moved to `nyse-calendar.ts`); `optionsSessionRange(date).to` ends at the early close. Otherwise options analytics reports incomplete strike-profile flow on holidays and after an early close, and the page anchors on an empty holiday. | Design B1, Design M2, ZO8-1, ZO8-2 |
| A2 | Decide the futures side of `flow.control` on a holiday: `futuresReason` uses `isNyseTradingDay` instead of `isWeekday`, so both sides are `market_closed` and the page shows the last trading session. Reword Out of scope. | Codebase B1, ZO8-3, Comprehension C6 |

### 🟡 Major

| ID | Action | Raw findings |
| --- | --- | --- |
| A3 | Name QQQ depth with the SPY tape (every `session: "stock"` instrument) in text, tables, tests and CHANGELOG. | Zoom Z1, Design M3, Readiness IR-2, Codebase N5 |
| A4 | Fix the option stream list (no RUT; six streams from `FLOW_OPTION_STREAMS`), and the venue claim (US-listed options, not Cboe only). | Style S1, S4, Design M4, N3, Comprehension C1 |
| A5 | Split the before/after rows at each window's shifted close; per-window holiday hours; add the overdue SPY row and the market premium note. | Comprehension C2, Style S2, S3, Structural ST-04 |
| A6 | Spell out the New York day number (`Number(month) - 1`) and rename the weekday local in `flowSessionOpen`; list new imports. | Readiness IR-1, IR-5, Codebase M1, Style9 S-01, Comprehension C13 |
| A7 | Fix the `closedDetail` text "Last session ended 16:15 ET" so it shows 13:15 after an early close. | Codebase M2, ZO8-7 |
| A8 | Define `fm market`, the four CI checks, and release of the deploy claim; cite README steps 1-8. | Readiness IR-3, Style9 S-05, S-06, Codebase N8, Comprehension C7 |
| A9 | Replace the open-ended fixture clause; list the plan-folder files; add phases with test checkpoints. | Readiness IR-8, IR-12, Codebase M3, M5 |
| A10 | Add reader-level and boundary tests: table-driven `flowSessionOpen`; `flowSessionDate`; `optionsSessionRange`; options analytics `complete`; `flow.control` on a holiday; overdue fixtures with a control case; a true 3 July early close; a parity test of the calendar rules against `infra/quantvps/nyse-calendar.txt`. | Codebase M4, Readiness IR-7, IR-11, Design N4, ZO8-5, Design M5(a), Codebase N6 |
| A11 | Rewrite the "holiday check only" rejection reason; add rejected rows (run-level skip, vendor hours, absolute times, exchange list as source); use "Deferred" for CME. | Structural ST-01, ST-07, ST-08, Style S8, Design M5 |
| A12 | Background: define the market premium source and its two readers; name the three shared helpers and say their readers follow them; define the clear rule and its values. | Comprehension C3, C4, Zoom Z3, Design M1 |
| A13 | Calibrate impact claims (2026-11-26 evidence; "no live window read; stored gaps drain as on a weekend"); fix "the same fix" wording. | Style S5, S6, Design N1, Codebase N7, Comprehension C8, C9 |
| A14 | Fix the text edits: exact replacements without nested parentheses; add `contracts/smart-money.ts:82`, `contracts/flow.ts` `sessionEnd`, `flow-pipeline.md:528, 796, 1013, 1067`. | Style9 S-03, Readiness IR-9, IR-10, Codebase N4 |
| A15 | Fix section: H3 subheadings. | Structural ST-02 |
| A16 | Risks: no backfill and deploy window for a wrong calendar; one-off early close not representable; window copies stay in two places. | Design M6 (text), Zoom Z2, Z4, Inventive IC-2 (note only) |

### 🟢 Nit

| ID | Action | Raw findings |
| --- | --- | --- |
| A17 | Derivation and cleanup details: `isNyseEarlyClose` body, delete unused locals in `nyseSession`, imports settled, `isCapturedNearClose` call shape, `NYSE_EARLY_CLOSE_SHIFT_MINUTES` module-private. | Readiness IR-4, IR-6, Codebase N1-N3, Style9 S-02, S-07, S-09, S-10, Zoom Z6, Comprehension C5 |
| A18 | Wording: kind line, card link, goals/non-goals placement, security/load rows, slogan, "as today", load noun, test wording, CHANGELOG wording, paths in full, minute numbers with clock times, short definitions (net drift, SPY tape, seed run, coverage baseline). | Structural ST-03, ST-05, ST-06, ST-09, ST-10, Style S7, S9-S15, Style9 S-04, S-08, S-11-S-14, Comprehension C10-C12, Zoom Z5 |

### Not adopted (recorded in goldfish_review_report.md)

| Proposal | Raw findings | Decision |
| --- | --- | --- |
| Calendar-disagreement probe read | Inventive IC-1 | CONTEST (new probe path for a risk with no seen case; ZO8-4) |
| Shared declarative window table | Inventive IC-2, IC-4 | CONTEST; the duplication is recorded as a risk (A16) |
| Back-off on unchanged totals, runtime closure list | Inventive IC-3 | DECLINE |
| Local rewrite of `collectorCaughtUp` | Design B1 fix step 2 | CONTEST (A1 fixes it at the shared helper) |
| `NYSE_SPECIAL_EARLY_CLOSES` list, year guard | Design M6 | CONTEST (no one-off early close announced; the parity test of A10 pins 2025-2028) |
| Full list of every caller with a reason | Design M1 | PROPOSE FIX in reduced form (A12): helpers named, reader tests |
| CME follow-up card | Design N6 | DECLINE (pre-existing, documented; no seen harm) |

## Traceability

Every raw finding ID of the five stage reports maps to one row above. Stage 6: C1→A4, C2→A5, C3→A12, C4→A12, C5→A17, C6→A2, C7→A8, C8-C9→A13, C10-C12→A18, C13→A6. Stage 5: Z1→A3, Z2→A16, Z3→A12, Z4→A16, Z5→A18, Z6→A17, IC-1/IC-3/IC-4→declined, IC-2→A16. Stage 7: Design B1→A1, M1→A12, M2→A1, M3→A3, M4→A4, M5→A10/A11, M6→A16, N1→A13, N2→A18, N3→A4, N4→A10, N5→A1, N6→declined; Structural ST-01/07/08→A11, ST-02→A15, ST-03/05/06/09/10→A18, ST-04→A5; Style S1/S4→A4, S2/S3→A5, S5/S6→A13, S7-S15→A18, S8→A11. Stage 8: ZO8-1/2→A1, ZO8-3→A2, ZO8-4→declined rows, ZO8-5→A10, ZO8-6→A3/A4/A5/A13/A16, ZO8-7→A7. Stage 9: IR-1/IR-5→A6, IR-2→A3, IR-3→A8, IR-4/IR-6→A17, IR-7/IR-11→A10, IR-8/IR-12→A9, IR-9/IR-10→A14; Codebase B1→A2, M1→A6, M2→A7, M3/M5→A9, M4→A10, N1-N3→A17, N4→A14, N5→A3, N6→A10, N7→A13, N8→A8; Style9 S-01→A6, S-02/S-07/S-09/S-10→A17, S-03→A14, S-04/S-08/S-11-S-14→A18, S-05/S-06→A8.
