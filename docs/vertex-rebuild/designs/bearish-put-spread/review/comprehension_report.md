# Comprehension report: bearish put-spread design (Stage 6)

* **Reviewer:** Comprehension Goldfish (EGM, Mode: REVIEW, no document standard)
* **Target:** `docs/vertex-rebuild/designs/bearish-put-spread/design.md`
* **FeatureRange:** lines 1-148 (Overview through Alternatives Considered)
* **DetailedRange:** lines 149-189 (Detailed Implementation, Testing and acceptance, Limitations)
* **Test:** self-containment. The design was read on its own; `concepts_brief.md` and `brainstorm_review.md` were opened only to check whether a term the design uses is defined somewhere a reader could reach. Claims were checked against the repository (read-only).

## What this proposes

The design adds four research-only features to Vertex Research. First, a pure TypeScript function and a new GET procedure `optionsChain.spread` that price a two-leg vertical (debit, worse-side debit, max loss/gain, breakeven, cost as percent of width, net Greeks) from live chain quotes and, separately, from the existing backtest option model; either half may come back null with a reason. Second, a "virtual" daily series `NYSE_UPVOL_PCT`, served from the existing `breadth90_days` table through a registry inside `packages/db` so both backtest engines can filter on NYSE up-volume without copying data. Third, the consult's bearish QQQ rule, with the unavailable gamma flip replaced by a named "SMA20 proxy", written as five strategy definitions (rule and baseline over a 2022-2026 window with the breadth filter, rule and baseline over a 2001-2026 window without it, plus a hold-to-expiry variant), submitted as five stored backtest runs, plus a separate event-study script that prices every signal day as its own spread and applies a pass rule (D5) fixed in advance. Fourth, the daily engine-comparison driver gains an "academy" phase that runs two academy option strategies on QQQ so option strategies appear in `backtestRuns.comparisons.list`.

## How the existing system works, per this document

Vertex has two backtest engines (a TypeScript runner in the API and a Python/Nautilus worker on a machine called "the rig"); live runs are computed by Nautilus, then the API re-runs the TypeScript runner and rejects a ledger gap above 1e-6. Both engines already trade defined-risk verticals from a DSL `options` block, placing the long leg at a target |delta| and the short leg `widthSigma` × ATM IV × √T × spot further out, entering at the close of the bar after the signal and exiting at expiry, `exitDte` calendar days, a profit target or an exit signal. Strategy series come from `market_daily_points` through a `loadSeries` loader and a fixed id list (`STRATEGY_SERIES_IDS`, mirrored in Python). Real QQQ gamma flips exist for only five sessions (`flow_gex` keeps 14 days), while `breadth90_days` covers 1,011 sessions since 2022-11-10. A timer-driven driver runs instant backtests daily at 06:15 New York and feeds the engine comparison, which today contains only long-only stock rules.

Paraphrase caveat: the first paragraph above states that the event study, not the five engine runs, decides the pass rule. The design never says this directly; it is inferred from D4, D5 and the rejected alternative at line 143. If that inference is wrong, the author should treat it as a finding (see F3).

## Verification against the repository

Confirmed: `FLOW_RETENTION_DAYS.flow_gex` is 14 (`packages/api/src/server/flow-collect.ts`); `STRATEGY_SERIES_IDS` has 32 entries and its test asserts length 32, so 33 after the change is consistent; `STRATEGY_IV_INDEX.QQQ` is `VXN`; `options-engine/pricing.ts` exports `atmIv`, `smileIv`, `bsPrice`, `bsDelta`; `options-chain-greeks.ts` exports `blackScholes`; `readChain` caches for 60 s (`CACHE_TTL_MS = 60_000`); `exitDte` must be below `dte.min` (3 < 45 holds); `widthSigma` range 0.1-3 admits 0.6; `breadth90_days` has `up_pct` and `final` columns; the driver timer is `06:15 America/New_York`; `/academy/backtest`, `itm-cash-secured-put` and `iron-condor-implied-move` exist; `infra/quantvps/restart-when-idle.sh` exists.

Not confirmed: the two embedded images (F1) and read-key access to `optionsChain.spread` (F4). Details below.

## Findings

### F1. 🟡 Major: embedded images do not exist

* **Affected scope:** lines 7, 9 (`before-after.png`, `data-flow.png`).
* **Description:** Neither file is in `docs/vertex-rebuild/designs/bearish-put-spread/`. A reader sees two broken images at the top of the document, and the "before and after" picture has no text equivalent anywhere in the design. The ASCII diagram at lines 88-101 partly covers the data flow, but the before/after content is unknown.
* **Recommendation:** Add the two images, or remove the references and state the before/after in one short table (what an agent, an operator and the comparison see today versus after the change).

### F2. 🔴 Blocker: the "job report" is the home of the key evidence but is never located

* **Affected scope:** lines 51 (G3), 65, 81, 124; also line 173 ("EGM record").
* **Description:** The design places the knowledge-base answers and sources (line 65), the five real-flip sessions (line 81), the event-study script and its results (lines 51, 124) in "the job report" or "the job report folder". No path, link, or naming convention is given, and nothing in Detailed Implementation (lines 151-173) creates it. The event study is the only artifact that applies the pass rule D5, and G5 asks that the knowledge-base answers be "written down"; a fresh reader cannot find, review, or verify either. Testing and acceptance (lines 177-180) also never checks the event study. As written, the central research question of the job has no reachable deliverable and no acceptance check.
* **Recommendation:** Give the job report's path (or the convention that names it), list it as a row in the Detailed Implementation table, and add acceptance lines: the event-study script runs from that path against named exports, and the report states the D5 verdict, sample sizes per window and split, and the bootstrap interval.

### F3. 🟡 Major: which artifact the pass rule (D5) judges is implicit

* **Affected scope:** lines 19, 51 (G3), 72-73 (D4, D5), 84, 123-124, 143.
* **Description:** The design produces two kinds of results: five stored engine runs (one open spread at a time, `exitDte` 3 or hold) and an event study (every signal priced separately, overlapping, exact owner exit). D5 talks about "mean return on risk of rule trades minus baseline" and "at least 30 signals" but does not say which of the two produces those numbers. Only the rejected alternative at line 143 ("Only one-at-a-time engine runs as the edge test") lets a reader infer that the event study decides and the engine runs are descriptive. G3 lists win rate and max drawdown for the engine runs, which a reader could mistake for the pass evidence.
* **Recommendation:** Add one sentence to D4 or D5: "D5 is evaluated on the event study only; the five engine runs are descriptive records of the proxy rule under the engine's execution model."

### F4. 🟡 Major: "agent read key" acceptance conflicts with the procedure's access gate

* **Affected scope:** lines 17 ("read-only procedure"), 49 (G1, "An agent gets"), 158 (`requireOperator`), 180 ("Live (agent read key)").
* **Description:** `requireOperator` (`packages/api/src/server/operator-access.ts`) refuses a read-access agent key unless the procedure name is in `AGENT_API_KEY_READ_PROCEDURES`. Neither `optionsChain.chain`, `optionsChain.expiries` nor the new `optionsChain.spread` is in that set, and the Detailed Implementation table has no row changing `operator-access.ts`. So the live acceptance check "optionsChain.spread on QQQ returns both parts" with an agent read key would get "This API key is read-only". For the reader, "read-only procedure" (no side effects) is also easy to confuse with "callable by a read key".
* **Recommendation:** State who may call `optionsChain.spread` (operator session, write key, read key). If read keys should reach it, add `operator-access.ts` (and its test) to the table and say whether `optionsChain.chain` joins too; otherwise change the acceptance line to a write key or operator session.

### F5. 🟡 Major: the option model is used throughout but described only in fragments

* **Affected scope:** lines 26, 49 (G1), 74 (D6), 77 (D9), 105-106, 175, 188.
* **Description:** G1 and the tolerances (line 175) require "model value within 5% of 12.76", and D6/D9 depend on the model's half-spread and constant skew. The design never states the model or its inputs in one place: Black-Scholes, ATM IV = 0.9 × VXN for QQQ, linear skew -0.25, rate from IRX, half-spread 1.5% of mid, and the consult's inputs (VXN 33.12, rate 4.00%, spot 645.04, 57 days) that produce 12.76. The constants appear only in Limitations (line 188); the inputs appear only in `concepts_brief.md`. A reader cannot reproduce the G1 check or judge D6 ("model half-spread on both sides") from the design.
* **Recommendation:** Add a short "Option model" paragraph in The Problem or Technical Plan §1 with the formula, constants and the exact consult inputs used for the 12.76 fixture, and reference it from G1, D6 and line 175.

### F6. 🟡 Major: entry timing of the event study is not stated

* **Affected scope:** lines 30, 45, 72 (D4), 83, 185.
* **Description:** The rule enters "near 15:45 New York" on the signal session; the engine enters at the close of the next bar (line 45, 185). D4 says the event study prices "every signal day ... as its own spread" but not whether it enters on the signal close or the next close. Pathway item 3 ("Same-session entry ... still missing") suggests the event study also enters one session late, but that contradicts "the exact owner rule per trade" being applied there. The reader cannot tell which entry the D5 verdict is about.
* **Recommendation:** In D4, state the event study's entry bar (signal close or next close) and its exit-day counting (trading days, per the owner rule).

### F7. 🟡 Major: "engine comparison" and the academy path are not defined

* **Affected scope:** lines 1, 20, 28, 52 (G4), 100, 128, 146, 189.
* **Description:** The design never says what the engine comparison compares (the brief says TypeScript engine against the Python/Nautilus worker) nor what an "academy" backtest is. Line 189 then says academy runs use a different option model (realized volatility) from the DSL runner. A reader cannot tell what G4 proves: that both engines agree on academy option strategies, or only that an option strategy row appears in the list.
* **Recommendation:** Define the engine comparison in one sentence (what is compared, what passes) and the academy backtest feature (where it lives, which model it uses), then restate G4's intent: presence only, or a parity check.

### F8. 🟡 Major: pass-rule metric "return on risk" is undefined

* **Affected scope:** line 73 (D5); also line 51 ("average result").
* **Description:** D5's main criterion is "mean return on risk of rule trades minus baseline". The design does not define return on risk (P&L divided by debit? by max loss including costs?) or whether costs from D6 are included. G3 uses a different term, "average result". This is the number the pre-registered decision depends on.
* **Recommendation:** Define the metric with a formula (e.g., net P&L after D6 costs ÷ max loss at entry) and use the same term in G3 and D5.

### F9. 🟡 Major: project-specific references without definition or link

* **Affected scope:** lines 3, 15, 28, 58-59, 65, 69-77 (Source column), 81, 96-100, 111, 132-134, 141-143, 173.
* **Description:** Many project terms are used without a definition or link: "the consult" and "gap 9 of the consult" (no document linked); cards `vertex-bearish-put-spread-backtest`, `vertex-gamma-flip-sources`, `vertex-option-model-calibration` (no tracker link); "owner rule 2026-11-14"; knowledge bases DefineYourRisk, QuantFinanceToGo, DeepEdge Intelligence, DeltaTrend and citations "DeltaTrend wisdom 7", "QuantFinanceToGo Part 35", "Consult section 3"; brainstorm IDs B1, B2, B3, M11, M12, M13, N5 (they live in `brainstorm_review.md`, which the design never links); "the rig", "rig worker", "rig driver", "QuantVPS", "Web" as the API host (line 133); `qc_ports` and "file-backed qc_ports runs" (line 111); "golden-pinned" and "golden-ledger" (lines 105, 142); "instant runs"; "EGM record" (line 173); "three dependency builders" (line 141). Each is resolvable by someone on the team, but not by a fresh reader.
* **Recommendation:** Add a short glossary or a "References" list: link the consult, the brainstorm review (with a note that B/M/N ids refer to it), the cards, and the knowledge-base sources; define rig, QuantVPS, qc_ports, instant run and golden ledger in one line each.

### F10. 🟢 Nit: D8 reads as one configuration

* **Affected scope:** line 76 (D8); compare line 120.
* **Description:** "Engine runs: exitDte 3 (...) and hold to expiry" reads as a single setting. Line 120 ("exitDte 3 (or none)") and G3 ("two exit variants") show these are two runs.
* **Recommendation:** "Engine runs: two variants, exitDte 3 (...) and no exitDte (hold to expiry)."

### F11. 🟢 Nit: G3 does not match the five definitions

* **Affected scope:** lines 51 (G3), 116, 123.
* **Description:** G3 mentions "the rule (two exit variants) and its baseline" (three runs), while §3 submits five (adding window B rule and baseline). Window B has only the `exitDte 3` variant; the reason is not given.
* **Recommendation:** List the five runs in G3 (or a small table: name, window, filter, exit variant) and say why window B has no hold-to-expiry variant.

### F12. 🟢 Nit: undefined trading shorthand specific to this design

* **Affected scope:** lines 26, 35, 49, 175 ("worse sides", "worse-side debit"); line 35 ("re-struck spread"); lines 34, 42 ("heavy down-volume day").
* **Description:** "Worse sides" (pay the ask on the long leg, receive the bid on the short leg) and "re-struck spread" (strikes reselected on the signal day by the runner rules) are not defined. "Heavy down-volume day" is equated with `up_pct` ≤ 20 at line 42, but its source definition (`breadth90_days.kind` DOWN_80/DOWN_90) is only in the brief.
* **Recommendation:** Define each in a parenthesis at first use.

### F13. 🟢 Nit: window B start date is unexplained

* **Affected scope:** line 70 (D2), line 43.
* **Description:** Window B starts 2001-11-01 while VXN starts 2001-01-23. The gap presumably covers the 200-day average warm-up, but the reader has to guess.
* **Recommendation:** Add "(VXN start plus SMA200 warm-up)" or the actual reason.

### F14. 🟢 Nit: relative CI-suite paths are ambiguous

* **Affected scope:** lines 166, 168.
* **Description:** Row 166 names "tests/ci-suites.txt" and row 168 names `ci-suites.txt`. No "tests/ci-suites.txt" exists at the repository root; the file is `services/research/tests/ci-suites.txt`.
* **Recommendation:** Use the full repository path in both rows.

### F15. 🟢 Nit: rollback consequence of the roll-forward series id

* **Affected scope:** line 136.
* **Description:** "Older worker code refuses runs that read it" does not say what happens to the five stored runs or to queued runs if the worker is rolled back, or whether the API/web can be rolled back independently.
* **Recommendation:** One sentence on the effect of rolling back each of the three deploy units.

## Summary

| Severity | Count | Findings |
| --- | --- | --- |
| 🔴 Blocker | 1 | F2 |
| 🟡 Major | 8 | F1, F3, F4, F5, F6, F7, F8, F9 |
| 🟢 Nit | 6 | F10-F15 |

The document could be paraphrased section by section, and its repository facts largely check out. Its main self-containment gaps are the unlocated "job report" that holds the decision-bearing event study, the implicit split between engine runs and the event study, an option model described only across the brief and Limitations, a read-key acceptance check that the current access gate would refuse, and project references (consult, brainstorm ids, cards, knowledge bases, rig) that a new reader cannot follow.
