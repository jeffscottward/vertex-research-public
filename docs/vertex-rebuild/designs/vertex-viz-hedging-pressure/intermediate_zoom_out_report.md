# Stage 8: Intermediate Zoom Out Review

Target: design.md after the resolution of stages 5, 6, 7 and 9 (full file). Reviewer: egm-zoom-out (completed). Context: zoom_out_report.md, goldfish_review_report.md, both figures.

## Stage 8: Intermediate Zoom Out review of `vertex-viz-hedging-pressure/design.md`

**Verdict:** the design passes the context check. The objective, motivation, scope and non-goals are clear, and the revision keeps the line research-only.

Several earlier findings are now resolved cleanly:

- The access model copies `flow.tapeSpeed`, including its existing tests in `server/flow.test.ts` (lines 532–534) and the reviewed list in `agent-viewer.test.ts` (line 271). It adds no new mechanism.
- The line uses the existing `optionsSessionRange`.
- `FLOW_HEDGING_SYMBOLS` follows the `FLOW_TAPE_SYMBOLS` pattern.
- The `date` input is removed.
- Largest rise and fall now appear in the totals.

The problems are in the Comprehension and Critic additions. The pre-open split and the IV and input guards add complexity where a simpler path exists, and several new pieces repeat code the repository already has.

## 🔴 Blocker

None.

## 🟡 Major

Z8-M1: The pre-open split makes the read twice as wide for a half-covered side total

- **Lines:** 50–51, 128–131, 137–138, 187, 218, 230–231, 421–424, 292–296.
- **Discrepancy:**
  - Alternative T1 put the line on 09:30–16:15. The read was still widened to start at New York midnight (`hedgingReadRange` returns `from`, `open` and `to`), only to fill `preOpen { prints, net }`.
  - Gaps are clipped to `[open, to)` (lines 131 and 424). Gaps before the open are therefore never reported, so `preOpen` can be incomplete while the panel says nothing.
  - Step 4 of the computation increments `prints`, `signed` and the other counters after the split in step 1. The design does not say whether `totals.prints` includes pre-open prints.
  - `flowSessionDate` maps any time before 09:30 to the previous session. Today's pre-open totals therefore appear only after the open, when they matter least.
- **Rationale:** this one addition adds a second time range, a contract object, a view-model text (`hedgingPreOpenLine`), an ES lab fixture branch, a test at exactly 09:30, and a coverage hole. Goal 3 asks only that the panel state which prints are not counted. SPX overnight rows also count against the read cap and the read cost on every 60-second refresh.
- **Fix:**
  - Read `optionsSessionRange(date)` only. This removes the `from`/`open`/`to` triple and the `preOpen` field.
  - Add "Prints before 09:30 ET are not counted" to the rule text.
  - If a pre-open figure is still wanted, return only `preOpen.prints`, clip gaps to the whole read range, and state that `totals` covers line prints only.

Z8-M2: The input guards repeat `bsDelta`'s own checks and need an unreachable branch that conflicts with the 100% coverage rule

- **Lines:** 149–158, 182, 389–391, 396–397, 401, 246, and the Non-Functional Requirements (303–309).
- **Discrepancy:**
  - `bsDelta` already validates its inputs in `check()` (`options-engine/pricing.ts`, lines 70–87). It rejects non-finite values, spot or strike of 0 or less, a volatility of 0 or less, and a negative `t`, and it handles `t === 0` itself.
  - The design restates every one of these checks in step 4.4, then adds a catch that "counts as not priced" which the design itself calls unreachable. A branch that cannot run cannot be covered, which conflicts with the 100% coverage rule.
  - Two rule constants have no measurable effect:
    - `volMax`: the clamp of `iv > 500` to 5.00 affects 44 prints, and `bsDelta` accepts any finite volatility above 0.
    - `minDays`: the floor of one minute repeats the `t === 0` case, and stored `dte` is never below 0.03.
  - Both constants add contract keys, branches and tests (such as `iv` 600), and they inflate `ivAdjusted` beyond the placeholder case it was created for.
- **Fix:**
  1. Keep the sign check and null checks of `iv` and `dte`.
  2. Set the volatility to 0.20 when `iv < 1` (this fallback is backed by the data facts), else `iv ÷ 100`.
  3. Set `T = max(dte, 0) ÷ 365`.
  4. Call `bsDelta` in a reachable `try`, and count a throw as not priced.

  Then drop `volMax` and `minDays` from `rules`, the contract and the tests. `ivAdjusted` then counts only the placeholder prints.

## 🟢 Nit

Z8-N1: The response's `rules` are not used, and the rule text hard-codes the same numbers

- **Lines:** 182, 221–225, 389–391, 457.
- **Rationale:** the tape speed view-model builds its rule text from `document.rules` (`tape-speed-view-model.ts:323`). This design echoes 10 constants but writes `HEDGING_RULE_TEXT` as a fixed string ("rate 4%, yield 1.5%"). That gives two sources of truth that can drift apart. `readCap`, `sessionOpen`, `sessionClose` and `multiplier` have no consumer. Because the schema is `.strict()`, removing them later breaks the contract.
- **Fix:** build the rule text from `rules`, as tape speed does, and limit `rules` to `version`, `rate`, `dividendYield` and `volFallback`.

Z8-N2: The gap list is richer than its one consumer and silently drops the newest gaps

- **Lines:** 112–113, 131, 186, 209–213, 241, 424.
- **Rationale:**
  - Journey 3 names a single range, "HH:MM–HH:MM".
  - The contract returns up to 20 ranges, oldest first. Gaps beyond 20 are dropped, and those are the ones nearest the live edge.
  - `flow.control` already reduces the same `optionGaps` rows with the same overlap filter to `oldestUnreadAt` plus `unreadRanges` (`server/flow-control.ts`, lines 492–503).
- **Fix:** follow that convention by returning a covering span plus a count, and shade the span. If per-gap shading is kept, drop the cap of 20 (the collector already bounds the number of gaps) or add a flag that says gaps were dropped.

Z8-N3: The "not collected" message repeats a notice the page already shows

- **Lines:** 87–89, 114–115, 457, 472–473.
- **Rationale:** `/flow` already renders `notCollectedLine(symbol)` (`flow-workspace.tsx`, lines 665 and 749). For QQQ and NQ it already reads "Not collected for …: … option prints". `HEDGING_NOT_COLLECTED` is a second, hand-written copy of the fact that `FLOW_HEDGING_SYMBOLS` was introduced to centralize.
- **Fix:** render no hedging panel for QQQ and NQ, or reuse `notCollectedLine`.

Z8-N4: The new `HedgingPrint` type replaces one existing type with a weaker one

- **Lines:** 392–395, 406–408.
- **Rationale:** resolution A13 removed the database import but wrote a new type with `side: string`. `FlowOptionPrintRow` in `packages/api/src/flow-options.ts` is pure, in the same package, already used by `flow-snapshot.ts` and `flow-control.ts`, and types `side` as `StoredOptionSide`.
- **Fix:** use `HedgingPrint = Pick<FlowOptionPrintRow, …>`. The compiler then checks that the "sign table for all six sides" is complete.

Z8-N5: The design adds a third copy of the side-to-sign mapping

- **Lines:** 140–142, 395.
- **Rationale:** the A38 decline considered only `flow-snapshot.ts`. `server/flow-control.ts:440` already has `SIDE_SIGN` with the same four entries, and `printSign` would be a third copy. Moving that map into `flow-options.ts` touches one import in `flow-control.ts`.
- **Fix:** move `SIDE_SIGN` to `flow-options.ts` and use it in `printSign`. The claim "the same grouping as `flow.snapshot`" then holds by construction.

Z8-N6: The design names a formatter that does not exist

- **Lines:** 442–446.
- **Rationale:** `features/flow/format.ts` has no `formatCompactUsd`. It has `formatMoney`, which already uses compact USD with one decimal.
- **Fix:** use `formatMoney` for gross, and define `formatSignedCompactUsd` as a "+" or "−" (U+2212) prefix on `formatMoney(Math.abs(value))`.

Z8-N7: The files table lists a design figure as implementation work

- **Line:** 355.
- **Rationale:** `data-flow.svg` already exists in the design folder. It belongs to the design, not to the code change.
- **Fix:** remove the row.
