# Critic review: style lens (Style Goldfish)

- **Document:** `docs/vertex-rebuild/designs/bearish-put-spread/design.md`
- **Stage 7 (FeatureRange):** lines 1-148 (Overview through Alternatives Considered)
- **Stage 9 (DetailedRange):** lines 149-189 (Detailed Implementation, Testing and acceptance, Limitations)
- **Mode:** REVIEW
- **Reviewer stance:** read-only. Claims were checked against the repository at the review date; line numbers refer to the file as reviewed.

## Summary

The document is dry, direct and mostly free of marketing language. Most numeric claims checked against the code hold: `FLOW_RETENTION_DAYS.flow_gex = 14` (`packages/api/src/server/flow-collect.ts:162`), the 60 s chain cache (`options-chain.ts:37`), the 1e-6 parity tolerance (`contracts/backtest-runs.ts`, `OPTIONS_NAUTILUS_PARITY_TOLERANCE`), the strike placement `widthSigma × atm × √t × spot` (`options-engine/book.ts:413`), next-bar fills (`book.ts:6`), the model constants (VXN 0.9, QQQ skew -0.25, QQQ half-spread 1.5%, $0.65 commission in `options-engine/pricing.ts`), the current `STRATEGY_SERIES_IDS` length of 32 (so 33 after the change), the 06:15 New York timer, and the academy realized-vol model for QQQ (`server/academy.ts:341`).

The findings below are of three kinds: (1) claims that outrun the code or the plan (agent read-key access, live engine selection, the flip-distance example); (2) undefined or ambiguous terms and references (the "job report", "near", the owner exit, D8, G3/G4 counts); (3) small redundancies and vague words.

Counts: 🔴 Blocker 0 · 🟡 Major 9 (FeatureRange 8, DetailedRange 1) · 🟢 Nit 24 (FeatureRange 16, DetailedRange 8).

---

## Stage 7: FeatureRange (lines 1-148)

### F1. 🟡 Major: G1 "An agent gets ..." is not supported by the access model or the file list

- **Lines:** 49 (G1), 106; cross-ref 158, 180.
- **Description:** G1 promises that "an agent" gets the spread answer, and line 180 tests it with an "agent read key". The handler is planned behind `requireOperator` (line 158), and a read-access key may call only procedures in `AGENT_API_KEY_READ_PROCEDURES` (`packages/api/src/server/operator-access.ts:28`, enforced at `:126-130`). No `optionsChain.*` procedure is in that set today (only `optionsAnalytics.snapshot`), and the Detailed Implementation table does not add `optionsChain.spread` to it. As written, the goal and its acceptance check claim a capability the plan does not deliver.
- **Recommendation (CALIBRATE):** Either add `operator-access.ts` (read-key list) to the file table and say so in §1, or narrow G1 to "an operator session or a write key". Correctness reviewers should confirm; this may rise to a Blocker for acceptance.

### F2. 🟡 Major: "The live server sends every new run to the Nautilus engine" has no stated evidence

- **Lines:** 44.
- **Description:** The repository default for `VERTEX_BACKTEST_RUNS_ENGINE` is `"typescript"` (`packages/config/src/server.ts:626-629`). The claim depends on deployed environment configuration, but the sentence presents it as a code fact. The plan (live runs computed by Nautilus, 1e-6 gate) rests on it.
- **Recommendation (CALIBRATE):** "The live server sets `VERTEX_BACKTEST_RUNS_ENGINE=nautilus` (checked 2026-11-22), so new runs go to the Nautilus worker." Name where it was checked.

### F3. 🟡 Major: The flip-distance example contradicts the claim it supports

- **Lines:** 144.
- **Description:** "observed flips sit near price (666 against a 645 close on 2026-11-19), as SMA20 does." 645 is 3.2% below 666, which is outside the rule's own 2% band (condition 2, line 33). "Near" is unquantified, and "as SMA20 does" gives no number. The evidence offered argues against the word it is meant to justify.
- **Recommendation (CALIBRATE):** State the measured distances: flip vs close over the 5 real-flip sessions, and SMA20 vs close over the same sessions, in percent. Drop "near" unless the numbers support it.

### F4. 🟡 Major: "The job report" is referenced as an evidence store but never located

- **Lines:** 51 (G3), 65, 81, 124.
- **Description:** The KB answers and sources, the event study, the 5 saved real-flip sessions and the event-study script all live in "the job report" / "the job report folder". No path is given. A reader cannot verify G3/G5 or the decision record's sources.
- **Recommendation:** Give the path once (first use, line 65) and refer to it by name afterwards.

### F5. 🟡 Major: KB summary is internally inconsistent

- **Lines:** 65.
- **Description:** "none has material on gamma-flip proxies; all four say a price-only proxy is not a gamma flip". If none has material, the second clause is the KBs' general reasoning, not a sourced answer. D5 labels "own reasoning" for the macro KB only. "Four neutral questions" is a subjective label with no questions shown.
- **Recommendation (CALIBRATE):** "None has source material on gamma-flip proxies; asked directly, all four answered (own reasoning, labelled in the report) that a price-only proxy is not a flip." Replace "neutral" with the questions' location, or drop the adjective.

### F6. 🟡 Major: G3 count disagrees with the plan's five runs

- **Lines:** 51 (G3) vs 116, 123, 180.
- **Description:** G3 says `backtestRuns` holds "runs of the rule (two exit variants) and its baseline", which reads as three runs. §3 and the acceptance check use five (three for window A, two for window B). The window B runs are not mentioned in G3.
- **Recommendation:** "five runs: window A rule (exitDte 3, hold to expiry) and baseline; window B rule (exitDte 3) and baseline."

### F7. 🟡 Major: D8 reads as one run with both exits

- **Lines:** 76 (D8).
- **Description:** "Engine runs: exitDte 3 (all spreads close 3 calendar days before expiry) and hold to expiry." This can be read as a single configuration. The intent (two separate variants, `BEAR_PUT_EXIT3` and `BEAR_PUT_EXPIRY`) is only clear from line 116.
- **Recommendation:** "Two engine variants: exitDte 3 (...) and hold to expiry (exitDte none)."

### F8. 🟡 Major: Owner exit rule leaves the evaluation time undefined

- **Lines:** 37.
- **Description:** "a spread in profit may run to expiry ...; a spread at a loss is closed 3 trading days before expiry." The profit/loss test has no stated evaluation point (presumably the close 3 trading days before expiry) or reference (entry debit incl. costs?). The event study claims to apply "the exact owner rule" (D4, D8), so the rule needs to be exact here.
- **Recommendation:** "At the 15:45 mark 3 trading days before expiry: if the spread's mark exceeds its entry debit, hold to expiry; otherwise close."

### F9. 🟢 Nit: Check time vs "closes" in the rule

- **Lines:** 30, 33.
- **Description:** The rule is checked "near 15:45 New York" but condition 2 says "QQQ closes below the flip". "Near" is vague, and a 15:45 check cannot observe the close. The engine uses bar closes; the limitation at line 185 covers next-session entry only.
- **Recommendation:** Fix the time ("at 15:45") and say whether condition 2 uses the 15:45 price or the close; add the 15:45-vs-close difference to Limitations if the backtest uses closes.

### F10. 🟢 Nit: Duplicate safety statement

- **Lines:** 22 vs 57.
- **Description:** "Nothing here arms trading, places or changes orders, or changes risk settings" repeats the first Non-Goal. "A backtest result does not authorize a trade" names no reader decision in this document.
- **Recommendation (DROP):** Keep "Research only." in the Overview and leave the list to Non-Goals.

### F11. 🟢 Nit: "over any useful period" is vague

- **Lines:** 41.
- **Recommendation (CALIBRATE):** "Real flips cover 5 sessions; D5 needs at least 30 signals."

### F12. 🟢 Nit: Exit list in the runner description is incomplete

- **Lines:** 45.
- **Description:** `book.ts:6-8` checks expiry, stale-iv, exitDte, profit-take, signal and end of data, in that order. The sentence lists four and omits stale-iv and end of data.
- **Recommendation (CALIBRATE):** Add the two, or write "among other exits (see `book.ts`)".

### F13. 🟢 Nit: Unanchored external references

- **Lines:** 15, 28 ("gap 9 of the consult"), 71 ("wisdom 7"), 74 ("Part 35"), 75 ("Consult section 3").
- **Description:** "The consult" and the KB section labels have no location. Brainstorm IDs (B1-B3, M11-M13, N5) do resolve in `brainstorm_review.md`; the consult does not.
- **Recommendation:** Give the consult's path or ID on first use (line 15).

### F14. 🟢 Nit: G4 "at least one" vs two named strategies

- **Lines:** 52.
- **Description:** The acceptance threshold is "at least one option strategy" but the parenthesis names two. A reader cannot tell whether one passing run satisfies G4.
- **Recommendation:** Pick one: "both academy runs (cash-secured put, iron condor on QQQ)" or "at least one of ...".

### F15. 🟢 Nit: "Owner 2% rule" is ambiguous

- **Lines:** 75 (D7 Source).
- **Description:** The document uses 2% twice: `maxLossPct 2` and "at most 2% below" the flip (line 33). The source label does not say which.
- **Recommendation:** "owner 2% max-loss rule".

### F16. 🟢 Nit: D5 terms undefined

- **Lines:** 73.
- **Description:** "return on risk" and "the out-of-sample difference" are not defined.
- **Recommendation:** "return on risk = P&L / max loss per trade"; "the out-of-sample mean difference (rule minus baseline) above 0".

### F17. 🟢 Nit: D9 "hardly moves" is unquantified

- **Lines:** 77.
- **Recommendation (CALIBRATE):** Give the model's cost-per-width range across window entries, or "varies by less than X points".

### F18. 🟢 Nit: Pathway item 4 is not "missing"

- **Lines:** 79, 84.
- **Description:** The list is titled "what is still missing", but item 4 (apply D5 on window B) is work this design does.
- **Recommendation:** Move item 4 out of the list, or retitle the list "steps to proving the rule".

### F19. 🟢 Nit: Diagram time has no zone

- **Lines:** 100.
- **Recommendation:** "06:15 New York".

### F20. 🟢 Nit: "golden-pinned" is jargon

- **Lines:** 105.
- **Recommendation:** "unchanged; pinned by `options-engine/golden.test.ts`".

### F21. 🟢 Nit: Cache-sharing claim needs its scope

- **Lines:** 106.
- **Description:** "one chain read serves the chain page and the spread" holds only for the same symbol and expiry within the 60 s window (`options-chain.ts:37, 274-275`).
- **Recommendation (CALIBRATE):** Add "for the same symbol and expiry within 60 s".

### F22. 🟢 Nit: Non-DSL operator inside a code span

- **Lines:** 117.
- **Description:** `close >= 0.98 × sma(20)[1]` uses `×` inside code formatting, which suggests literal DSL syntax.
- **Recommendation:** Use `*` inside the code span, or move the expression out of code formatting.

### F23. 🟢 Nit: `costBps 0` next to D6 costs

- **Lines:** 123 vs 74.
- **Description:** A reader sees "costBps 0" after D6 states non-zero option costs.
- **Recommendation:** Add "(underlying cost; option costs come from the model, D6)".

### F24. 🟢 Nit: Alternatives repetition and vague terms

- **Lines:** 140-147, 141, 143.
- **Description:** "Rejected by author:" repeats seven times; the actor adds nothing (the feature-spec standard only requires rejected options with rationale). "adds more surface" (141) is vague. "about 18 trades" (143) has no source.
- **Recommendation:** Use "Rejected:"; replace "surface" with the concrete count (three dependency builders, one more repository parameter each); cite where 18 comes from.

---

## Stage 9: DetailedRange (lines 149-189)

### D1. 🟡 Major (same root as F1): Acceptance uses a key that cannot call the procedure

- **Lines:** 158, 180; missing row in 151-173.
- **Description:** "Live (agent read key): ... `optionsChain.spread` on QQQ returns both parts." With the planned `requireOperator` handler and no change to `AGENT_API_KEY_READ_PROCEDURES`, a read key gets FORBIDDEN (`operator-access.ts:126-130`). The file table has no row for this change.
- **Recommendation:** Add a row for `packages/api/src/server/operator-access.ts` (and its test) if read keys should reach the spread, or change the acceptance step to an operator session/write key.

### D2. 🟢 Nit: Inconsistent `ci-suites.txt` paths

- **Lines:** 166, 168.
- **Description:** Line 166 says `tests/ci-suites.txt`, which does not exist at the repository root; the file is `services/research/tests/ci-suites.txt`. Line 168 says `ci-suites.txt`.
- **Recommendation:** Use the full path in both rows.

### D3. 🟢 Nit: "Why" column holds non-reasons

- **Lines:** 154 ("100% coverage"), 172 ("Docs live"), 173 ("EGM record").
- **Recommendation:** Coverage is a test property, not a reason; "Docs live" and "EGM record" are unclear. Use the goal ID or a short reason ("G1", "operators find the deploy note", "design record").

### D4. 🟢 Nit: Refusal names drift between sections

- **Lines:** 106 vs 157.
- **Description:** §1 lists "missing IV index or spot" and "expiry today"; the test row lists "missing points" and "dte 0".
- **Recommendation:** Use one set of names in both places.

### D5. 🟢 Nit: "Both engines run it" overstates one test's scope

- **Lines:** 170.
- **Description:** `bearish-put-spread-spec.test.ts` runs the TypeScript runner only; the Python side is the separate row at 168.
- **Recommendation (CALIBRATE):** "TypeScript engine runs it (Python: row above)".

### D6. 🟢 Nit: Worse-side value has no tolerance

- **Lines:** 175 (and G1, line 49).
- **Description:** "(worse sides 13.37)" is stated next to tolerances but has none of its own.
- **Recommendation:** Give a tolerance or label it "reported, not checked".

### D7. 🟢 Nit: Test commands are placeholders

- **Lines:** 179.
- **Description:** "focused vitest" and `VERTEX_RESEARCH_PYTHON=…` do not tell a reader what to run.
- **Recommendation:** Name the vitest files (or `bun run test -- <paths>`) and the interpreter path variable's expected value.

### D8. 🟢 Nit: Live acceptance depends on time of day

- **Lines:** 180.
- **Description:** "returns both parts" needs live quotes, which may be missing or crossed outside market hours (both are listed refusal reasons in line 106). "with metrics" does not say which.
- **Recommendation (RELOCATE/CALIBRATE):** "during regular trading hours"; "with trade count, win rate, average result and max drawdown (G3)".

### D9. 🟢 Nit: Calendar vs trading days condition

- **Lines:** 186.
- **Description:** 3 calendar days and 3 trading days before a Friday expiry are the same day unless a market holiday falls in between; "holiday-shifted expiries" names only one of the cases.
- **Recommendation (CALIBRATE):** "they differ when a market holiday falls in the last 3 trading days before expiry".

### Kept (no finding)

- Lines 184, 185, 187: specific and actionable.
- Line 188: constants match `pricing.ts` (VXN 0.9, QQQ skew -0.25, QQQ half-spread 0.015).
- Line 189: matches `server/academy.ts:341` (non-SPY tickers use the realized-vol model).
- Line 164: "length 33" matches the current test (`strategy-dsl.test.ts:372` expects 32) plus one id.
