# Goldfish annotated review report: bearish put-spread design

- **Target:** [design.md](design.md) (first draft 2026-11-22, revised the same day)
- **Mode:** consolidated report with all review rubrics (owner standing rule 2026-11-15), resolution "Auto accept" (owner rule 2026-11-13): every PROPOSE FIX is applied to the design or the code; CONTEST and DECLINE stay as recorded here.
- **Reviewers (fresh context, one subagent each):** zoom-out, inventive catalyst, comprehension, design critic, structural, style, implementation readiness, codebase details. Raw reports: [review/](review/). Brainstorm lenses: [brainstorm_review.md](brainstorm_review.md) (one synthesizer applied seven lenses; its subagent spawns were refused).

## Counts

| Class | Findings |
| --- | --- |
| PROPOSE FIX (applied) | 96 |
| CONTEST | 8 |
| DECLINE (nits recorded, not changed) | 23 |
| ESCALATE | 0 |
| Total | 127 |

## Prioritized findings and resolutions

| # | Findings (reviewer IDs) | Severity | Suggestion | Resolution |
| --- | --- | --- | --- | --- |
| 1 | Pass rule can pass on noise: 20-session blocks shorter than holds, overlapping signals counted (design C1) | Blocker | PROPOSE FIX | Blocks of 60 sessions; gate on 30 independent signals; amendment record in D4/D5. Code: `bearish_put_study.py`. |
| 2 | No Risks and Mitigations section (structural F1, design C2) | Blocker | PROPOSE FIX | Section added. |
| 3 | Job report never located (comprehension F2, style F4) | Blocker | PROPOSE FIX | Path given in the decision record. |
| 4 | Agent read key cannot call `optionsChain.*` (implementation B1, comprehension F4, style F1 and D1, design C8) | Blocker | PROPOSE FIX | Decision: no access change (security gate); agents use an operator session; listed as a non-goal; acceptance updated. |
| 5 | Parity gate stated as 1e-6 (codebase 1) | Blocker | PROPOSE FIX | Terms: API 1e-9 (`ENGINE_STATS_TOLERANCE`), worker 1e-6 (`PARITY_REL_TOL`). |
| 6 | 1e-9 delta agreement test impossible (codebase 2, zoom-out Z6) | Blocker | PROPOSE FIX | Test dropped; price and delta from the runner model, Greeks from `blackScholes`. |
| 7 | Close above SMA200 exit ends most trades at once (brainstorm B1, design C4) | Blocker | PROPOSE FIX | Exit is `crossesAbove`; D7 states when it fires. |
| 8 | 30-trade gate unreachable with one spread at a time (brainstorm B2, M13, zoom-out Z4) | Blocker | PROPOSE FIX | Event study over every signal in the repo with tests; window B decides. |
| 9 | Breadth id in qc_ports `data.SERIES_IDS` breaks file-backed runs (brainstorm B3) | Blocker | PROPOSE FIX | Id only in the worker list. |
| 10 | Images missing (comprehension F1, structural F3, zoom-out Z8) | Major | PROPOSE FIX | `before-after.png`, `data-flow.png` added. |
| 11 | Which artifact D5 judges; entry timing; return on risk; owner exit time undefined (comprehension F3, F6, F8; style F8, F16; design C6; implementation M6) | Major | PROPOSE FIX | Terms section, D4/D5 text, Limitations. |
| 12 | Model and project terms undefined, references unlinked (comprehension F5, F7, F9, F12; structural F7; style F13) | Major | PROPOSE FIX | Terms section; links to brainstorm and spec; consult path. |
| 13 | Run count, D8 wording, window B start (comprehension F10, F11, F13; style F6, F7) | Major/Nit | PROPOSE FIX | G3 lists five runs; D8 two variants; D2 explains the start. |
| 14 | KB summary inconsistent; flip example contradicts the claim; live engine without evidence (style F2, F3, F5; design C13) | Major | PROPOSE FIX | Rewritten; example removed; engine evidence from `backtest_runs`. |
| 15 | Expiries outside 45-60 days (design C3) | Major | PROPOSE FIX | Measured: 54% of sessions have one; Limitations and data section. |
| 16 | Out-of-sample window overlaps the period the rule came from (design C5) | Major | PROPOSE FIX | D3 states the rule was written by judgment, not fitted; the split is a stability check. |
| 17 | Ledger skips spreads above the 2% budget (design C7) | Major | PROPOSE FIX | Limitation; the event study is per contract. |
| 18 | Model inputs stale and unshown; tolerance too loose (design C9, inventive F6, brainstorm M6) | Major | PROPOSE FIX | As-of dates echoed; 7-day limit; model tolerance 0.001. |
| 19 | Breadth fill-forward and look-ahead (design C11, brainstorm M2) | Major | PROPOSE FIX | No gaps in 1,011 sessions (checked); entries one session after the signal; final rows only. |
| 20 | Event study outside the repo and CI; pre-registration not provable (design C12, zoom-out Z4, inventive F3) | Major | PROPOSE FIX | Study module and tests in the repo; amendment record; TypeScript test proves both runners give the Python trades. |
| 21 | Real flips pruned after 14 days; forward test depends on another card (inventive F1, design C20, brainstorm M14) | Major | PROPOSE FIX | `flow_gex` keeps 730 days; forward test registered on the QuantData flip. |
| 22 | Phases, file boundary, fixtures, spec format, CI paths, handler failure modes, output fields (codebase 3-10, implementation M1-M5, N1-N6) | Major | PROPOSE FIX | Detailed Implementation rewritten in phases with exact files, reasons, fixtures and commands. |
| 23 | Writes to the virtual id would be invisible (codebase 11) | Major | PROPOSE FIX | `validateMarketDailySeries` refuses the id; test added. |
| 24 | Academy runs replace each other while queued (brainstorm M4, design C14, inventive F5) | Major | PROPOSE FIX | One request at a time with the claim wait; bounded by the existing 15-minute wait. |
| 25 | Proxy result framed as the consult's rule (zoom-out Z2, inventive F7) | Major | PROPOSE FIX | Overview, D1 and Limitations name the proxy rule. |
| 26 | Structure: Problem headings, diagram, Alternatives as pros, cons and reason (structural F2, F5, F6) | Major | PROPOSE FIX | Rewritten. |
| 27 | Four deliverables in one design and PR (zoom-out Z1, brainstorm M16) | Major | CONTEST | The driver deploy is its own step (its runner checkout) and can be rolled back alone; a second PR adds a CI cycle with no rollback gain. Recorded as an alternative. |
| 28 | Breadth series serves a descriptive result only (zoom-out Z3) | Major | CONTEST | Condition 3 is part of the rule; the stored runs on both engines need it (acceptance), and the regime view card reads the same series. |
| 29 | Breadth served from the generic store couples it to the breadth table (brainstorm M1) | Major | CONTEST | The registry sits in the package that owns both tables, one file; the API-layer route threads a second repository through three builders. Recorded as an alternative. |
| 30 | Academy runs do not exercise the DSL options runner (brainstorm M5) | Major | CONTEST | Options DSL runs are already checked against the TypeScript runner on every completion; the academy runs are the existing option path into `comparisons.list` (G5). Limitation recorded. |
| 31 | Store the 15:45 decision values daily (inventive F2) | Major | CONTEST | A new scheduled collector is out of scope; condition 4 is checked live by `optionsChain.spread`, and the flip history now persists. |
| 32 | Engine spread narrower than the consult's 45 points (design C10) | Major | CONTEST | The width follows `widthSigma` × ATM IV; the short-leg delta (-0.23 to -0.25) is the rule's target, and the consult's 45 points came at VXN 33. |
| 33 | Daily academy runs vs rejected daily DSL submit (design C15) | Nit | CONTEST | Academy runs go into `comparisons.list` (G5); a daily DSL run would not. |
| 34 | Separate parity code for the series id lists (inventive F4) | Nit | CONTEST | A parity test fails CI on drift; a generated manifest is more machinery for one list. |
| 35 | Remaining nits: existing block bootstraps (zoom-out Z5), open questions and user journeys sections, title length, bullets, dividers (structural F4, F8-F13), style nits (style F9-F12, F14-F24, D3-D9), codebase nits (12-17), design nits (C16-C19) | Nit | DECLINE (23) or PROPOSE FIX where the rewrite covered them | The rewrite covers most; the rest are recorded here. The existing bootstraps resample one series; the study needs a paired rule-and-baseline bootstrap keyed by signal bar. |

## Stage 8 (intermediate zoom-out) and stop

After the fixes, one fresh zoom-out pass read the revised design ([review/intermediate_zoom_out_report.md](review/intermediate_zoom_out_report.md)). The review stops there (one re-audit per stage).

## Stage 8 findings and resolutions

| # | Finding | Severity | Suggestion | Resolution |
| --- | --- | --- | --- | --- |
| I1 | The spec registers the forward test on the OpenBB flip with 14-day retention and plain signals | Blocker | PROPOSE FIX | Spec forward test: QuantData flip from `flow_gex` (730 days), independent signals, never pooled with OpenBB. |
| I2 | Method and amendment only in the design; "cannot turn into a pass" is argued, not shown | Major | PROPOSE FIX | Spec gains Backtest design, Pass/fail rule, Deviations and Results sections; the claim is removed and the first run is kept in the job report. |
| I3 | Deciding result off-repo; input rows without a digest | Major | PROPOSE FIX (digest, spec Results) and CONTEST (research-studies import) | The report records the SHA-256 of the input rows and the spec Results section gets the verdicts. The research-studies document schema is the qc-port idea format; a new document kind is out of scope. |
| I4 | Overview and G3 still call the proxy runs "the rule"; no reason to do the proxy study now | Major | PROPOSE FIX | Overview item 3 and G3 say "SMA20 proxy rule" and give the reason. |
| I5 | Images missing | Major | PROPOSE FIX | Added. |
| I6 | Study lives in `qc_ports`, which the worker loads; the skew case changes `options.SKEW` | Major | CONTEST | The study runs only through its CLI in its own process; `shifted_skew` restores the value in `finally`, a test checks it, and the module docstring states the rule. Moving it to a new package would copy the book imports for no behaviour change. |
| I7 | TypeScript test copies numbers by hand from the Python fixture | Nit | DECLINE | The values come from one printed Python run of the same fixture; a generated golden needs a new generator for four numbers. |
| I8 | Second user of G2 and the access model only in the resolution record | Nit | PROPOSE FIX | G2 and Non-Goals say it. |
| I9 | Monte Carlo drawdown neither adopted nor declined | Nit | PROPOSE FIX | Added to the study and D5. |
| I10 | Status "Approved" while stage 8 open | Nit | PROPOSE FIX | Status "Accepted after EGM review" with both reports linked. |

The access question for the driver's key scope (phase 5) went to the owner on 2026-11-22 as an ask menu (security gate). The review stops after this stage (one re-audit per stage).
