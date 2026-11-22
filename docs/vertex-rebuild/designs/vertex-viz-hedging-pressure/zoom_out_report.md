# Stage 5: Initial Zoom Out Review

Target: design.md (draft of 2026-11-22, full file). Reviewers: egm-zoom-out, egm-inventive-catalyst (direct dispatch). Both completed.

## egm-zoom-out

### Zoom-Out review (Stage 5): `vertex-viz-hedging-pressure/design.md`

**Verdict:** The design passes the context check. Its objective, motivation, scope and non-goals are clear, and the "Data facts" table grounds the choices in measured data. It fits the project's research-only stance. It already reuses `bsDelta`, `buildSourceFreshness`, `latestSamples` and the `flow.tapeSpeed` procedure, panel and refresh pattern, and it avoids premature optimization: one indexed read, measured at 15 ms. A dedicated `readHedgingPrints` is justified over the existing `readWindow`, because `readWindow` also reads minutes, books, events and GEX and has no limit. The snapshot window is capped at 390 minutes, so a separate procedure is justified too. The Detailed Implementation Plan (lines 168–251) stays at an appropriate altitude for that range.

The findings below are reuse and consistency gaps, plus a few small speculative surfaces.

#### 🔴 Blocker

None.

#### 🟡 Major

M1 — The pure rules module would import database types, breaking a layer boundary

- **Lines:** 176, 180–181
- **Discrepancy:** `HedgingPrint = Pick<FlowOptionPrintRecord, …>` and `printSign` over `FlowOptionSideValue` both use types from `@darkfactory/db` (`packages/db/src/server/flow.ts:53`).
- **Rationale:** The other pure flow modules (`flow-tape-speed-rules.ts`, `flow-options.ts`, `server/flow-snapshot.ts`) never import `@darkfactory/db`. Only the collectors and `server/flow.ts` do. `server/flow-snapshot.ts` already types prints as `FlowOptionPrintRow` and sides as `StoredOptionSide` from `packages/api/src/flow-options.ts`. Both types hold every field the design needs, including `dte: number | null`, `iv` and `underlyingPrice`.
- **Fix:** Define `HedgingPrint = Pick<FlowOptionPrintRow, …>` and key `printSign` on `StoredOptionSide`. `server/flow.ts` maps database rows to these types, as it does for the snapshot.

M2 — Which symbols have option prints is hard-coded in five places

- **Lines:** 47–48, 106–108, 134, 187, 214, 220
- **Discrepancy:** The `SPY | ES` input enum, `hedgingSymbolOf` returning null for QQQ and NQ, the custom "not collected" copy, and the Non-goals text all restate a fact. The single source for it is `FLOW_INSTRUMENTS[symbol].sources.includes("options")` in `flow-features.ts`.
- **Rationale:** `apps/web/src/features/flow/view-model.ts:648` already has `notCollectedLine(symbol)`, which builds the "not collected: option prints" text from `FLOW_INSTRUMENTS`. Adding options collection for QQQ or NQ later would mean editing the contract, the view-model and the copy separately, and they can drift apart.
- **Fix:** Follow the `FLOW_TAPE_SYMBOLS` pattern (`contracts/flow.ts:202`):
  - Export `FLOW_HEDGING_SYMBOLS = ["SPY", "ES"] as const`.
  - Use it in the input enum and in `hedgingSymbolOf`.
  - Add a test that it equals the set of symbols whose `sources` include `"options"`.
  - Reuse `notCollectedLine` instead of new copy.

M3 — Option B for the delta source was set aside on a fact nobody checked

- **Lines:** 39, 50–51, 94–100
- **Discrepancy:** Option B (vendor delta) is held back mainly because the "field name and units [are] not verified" and stored days "stay empty". The collector drops the greeks on purpose (`flow-options.ts`: "QuantData sends more (greeks, …), which are ignored").
- **Rationale:** Checking the field is one look at a captured vendor row. With 14-day retention, empty history fills itself within two weeks. Option A brings real extra complexity:
  - the IV clamp;
  - an "IV limited" count in the rules, totals, tests and fixtures;
  - the `dte`-null path;
  - Vertex numbers that differ from the vendor's on about 5% of ES prints (the placeholder IV).
  
  Goal 2 ("no migration") is stated as a constraint but never justified.
- **Fix:** Before choosing A, check the vendor delta field on one stored raw response or a test fixture and record the result in the table. Then either:
  - keep A and write down when B should replace it (for example, a measured gap between the A delta and the vendor delta); or
  - pick B, collecting the delta now and using A only for older rows.

M4 — The optional `date` input has no consumer (YAGNI)

- **Lines:** 134, 147–148, 187, 192–193
- **Discrepancy:** The user-experience section has no date picker, the panel always sends no date, and multi-session views are a non-goal (line 52). Even so, the contract adds `date`, its validation tests, and a special case: a date outside retention returns that date with no points.
- **Rationale:** This is extra contract surface and edge-case behaviour for a caller nobody has named. The post-deploy check (lines 249–251) recomputes values from the database rows and does not need it either.
- **Fix:** Drop `date` from version 1; the newest-print session rule covers the panel. If agents need a past session, name that consumer in Goals and keep `date` because of it.

#### 🟢 Nit

N1 — The `dte`-null path covers a case the data shows never happens

- **Lines:** 63 vs 81–82, 177–178, 184
- **Rationale:** The data facts say `dte` is "never null in the stored rows". The column is nullable, but computing time to 16:00 New York on `expiry` is extra code and tests for an unseen case.
- **Fix:** Count a null `dte` as "not priced", which rule 4 already provides. If the path is kept anyway, reuse `newYorkTime(expiry, 960)` from `server/merged-bars.ts`.

N2 — The truncation UI duplicates the header

- **Lines:** 90–92, 129, 220, 235
- **Rationale:** The read cap is eight times the busiest stored day, which is a sensible guard. But "the panel names the time of the last counted print" is already the header's "as of" `storedUntil` (line 114).
- **Fix:** Keep the cap and the `truncated` boolean. Show truncation as a suffix on the existing header line, and drop the separate truncated line and its dedicated lab fixture.

N3 — `printSign` repeats an existing side grouping

- **Lines:** 84–86, 176
- **Rationale:** `server/flow-snapshot.ts` `buildOptionsSummary` (about lines 527–531) already treats `ask`/`above_ask` as buys and `bid`/`below_bid` as sells.
- **Fix:** Put one side-to-sign map in `flow-options.ts` and use it in both places, so the two /flow panels cannot disagree.

N4 — `formatSignedCompactUsd` repeats an existing formatter

- **Lines:** 117–118, 222–223
- **Rationale:** `apps/web/src/components/portal/smart-money-workspace.tsx:99` already has `SIGNED_COMPACT_USD` (compact USD, `signDisplay: "exceptZero"`). Also, `format.ts` uses a true minus sign "−" in `formatSigned`, but `Intl` produces a hyphen-minus "-".
- **Fix:** Move the smart-money formatter into `features/flow/format.ts` (or a shared formatting module), use it in both places, and state the minus-sign convention.

N5 — The "existing New York time helper" is not named

- **Line:** 200
- **Fix:** Name the helpers: `newYorkTime(day, 0)` in `server/merged-bars.ts` for midnight bounds, and `newYorkClock` in `signal-alerts.ts` or `newYorkDate` in `server/gex-context.ts` for the session date.

N6 — Hedged script reference

- **Line:** 191
- **Rationale:** "or the script the repo uses": `openapi:generate` exists in the root `package.json:66` and in `packages/api/package.json:56`.
- **Fix:** State `bun run openapi:generate` and add `openapi:check` to the step's verification.

N7 — Risks and user-experience sections disagree on where the largest minute appears

- **Lines:** 156 vs 121–122, 125–126
- **Rationale:** The risk mitigation says "the aria label and the totals name the largest minute", but the totals line has no largest minute; only the aria label does. Sighted users would not get this mitigation.
- **Fix:** Add the largest one-minute rise and fall to the visible totals line, or correct the risk text.

N8 — Two different "dealer" assumptions on the same page, not reconciled

- **Lines:** 84–86, 123–124
- **Rationale:** Elsewhere the repo's GEX convention is "dealers long calls, short puts" (`contracts/options-analytics.ts`, `dealerSignAssumption`), and /flow shows a GEX panel. This panel instead treats the dealer as the opposite side of each aggressor print. Two panels both labelled "dealer" with different assumptions invite misreading.
- **Fix:** Add one sentence to the rule text saying this assumption differs from the GEX positioning convention and why.

## egm-inventive-catalyst

I found no 🔴 Blockers, two 🟡 Majors and three 🟢 Nits. I reviewed the whole file (lines 1–251) and the SVG mock, and checked the main claims against the repository.

Areas where I found no false compromise:

- **Delta source (lines 94–100):** choosing Black-Scholes delta from the stored IV over storing the vendor delta weighs for and against honestly. Option A works on all 14 stored days, which option B cannot.
- **Panel isolation (lines 109–110):** the panel has its own call and its own failure state, so a slow or failed answer stays inside it.
- **Dealer-side rule (rule 2, lines 73–76):** this is a limit of the data, not a contradiction to engineer away. The document states it on screen.

---

### F1 — 🟡 Major — The line ignores the collector's backfill gaps, so an incomplete session is shown as complete

- **Lines:** 54–66, 86–92, 114, 141–147, 151–159, 195–206, 247–251.
- **Discrepancy:** The design treats the stored prints of a session as complete. The header shows an "as of" time of the newest print, and `truncated` is the only completeness flag. The collector does not fill busy windows in one run:
  - In `packages/api/src/server/flow-collect.ts:145-151` and 1060, a run reads at most `FLOW_OPTION_PAGES_MAX` (6) pages. The rest of a busy window is queued in `flow_option_gaps`.
  - Later runs fill each gap newest first and move its `end_time` back (`packages/db/src/schema/flow.ts:198-219`).
  - So on a busy day, some earlier minutes can be missing until later runs fill them. Those prints then change the past shape of the running sum.
- **Rationale:**
  - The design accepts "stored rows = the session" as if it were a property of the data. It is really a property of the collector's paging cap.
  - A gap shows up as flat stretches in a stepped line, which looks like "no pressure" — wrong data with nothing to flag it.
  - The repository already exposes `optionGaps(symbol)` (`packages/db/src/server/flow.ts:225`), and `flow.control` already reads it as `crossGaps` (`packages/api/src/server/flow.ts:451`). The design leaves that signal unused.
  - The acceptance check at lines 249–251 recomputes the line from the same rows, so it shares the same holes and cannot catch this.
- **Proposed resolution (Blessing in Disguise):** turn the gap queue into a visible coverage signal.
  - Step 3: `readFlowHedgingPressureRows` also reads `optionGaps(symbol)` and clips the gaps to the session bounds.
  - Contract (line 141 onward): add `gaps: [{ from, to }]` and `complete: boolean`.
  - Panel: shade the gap intervals on both charts. The header says "partial: backfill pending for HH:MM–HH:MM ET".
  - Add a row to the risk table and a gapped-session fixture in `/lab/flow` (lines 128–129, step 6).
  - Acceptance: state the open gaps of the verified session, or require a session without gaps.
- **Secondary liabilities:**
  - One more query on each 60 s refresh.
  - Gap rows are short-lived queue state: their ends move and rows are deleted, so the shading changes between refreshes.
  - Earlier parts of the line will visibly shift when backfill lands. The rule text must say so.
  - More view-model and panel test cases.

#### F2 — 🟡 Major — The calendar-day session trades comparability for completeness without stating it

- **Lines:** 65, 70–71, 199–200 (`sessionBounds`: New York midnight to the next midnight).
- **Discrepancy:**
  - Rule 1 folds the whole New York calendar date. ES (SPX) prints start at 00:00 ET (global trading hours, line 65), so the running sum enters 09:30 already carrying hours of thin overnight flow.
  - Every other session-scoped part of `/flow` uses `optionsSessionRange` (09:30–16:15, `packages/api/src/server/flow-control.ts:142-147`). The new `sessionBounds` adds a second, incompatible session definition on the same page.
  - The SPX global trading hours session starts on the previous evening, so a midnight boundary also appears to split a real trading session.
- **Rationale:** The design assumes that showing all stored prints means mixing overnight and regular-hours flow in one cumulative line. That is a false choice between completeness and comparability.
- **Proposed resolution (Segmentation):** keep the calendar-day read, but fold it in two segments.
  - A **pre-open carry**: the net, calls and puts at 09:30, shown as one labelled opening value and listed in totals.
  - A **regular-hours line** from `optionsSessionRange`, starting at zero, or at the carry if the author prefers.
  - Reuse `optionsSessionRange` instead of a new `sessionBounds`, so the panels on `/flow` share one definition. A `segment` field (`preopen` / `regular`) in each point, or a `preopenTotals` object, keeps the contract explicit.
- **Secondary liabilities:**
  - Contract and test surface grow: segment boundaries and a DST case for 09:30.
  - The meaning of the line must be stated: does regular hours start at zero or at the carry?
  - SPY's pre-open prints (from 07:00, line 65) need the same treatment.

##### F3 — 🟢 Nit — The read cap cuts the newest prints, the most relevant part of a live session

- **Lines:** 90–92, 144, 195–203.
- **Discrepancy:** The read is ascending by `traded_at` with `limit: readCap + 1` (line 196). On truncation the dropped rows are the newest ones, so the line ends early during the very part a viewer is watching. The design treats a hard row cap as the only way to bound work.
- **Proposed resolution (Segmentation):**
  - The fold is a set of additive running sums, so it can run over keyset-paginated chunks (for example 25,000 rows each, ordered by `(traded_at, id)`). Memory stays bounded with no truncation; bound total work with a time budget instead.
  - If a hard cap is kept, also return the dropped range (`truncatedFrom`), so the panel can name the missing tail directly. The panel already names the last counted print.
- **Secondary liabilities:** more round trips, a longer worst-case latency, and the need for a per-request time budget. The case is rare: the cap is eight times the busiest stored day.

##### F4 — 🟢 Nit — Each open page recomputes the whole session every 60 s, and the cost figure covers only the database

- **Lines:** 66, 109–110, 159.
- **Discrepancy:** The mitigation cites "15 ms execution" for the indexed read. It does not cover the rest of each refresh:
  - transferring and decoding about 25,700 rows;
  - running `bsDelta` once per print;
  - building and encoding up to 1,440 points.
  
  Closed sessions never change once their gaps are filled, yet they are refolded on every refresh.
- **Proposed resolution (Preliminary Action):**
  - Memoize the finished document in the process, keyed by `(symbol, session, storedUntil, gap set)`.
  - Closed sessions without gaps become cache hits.
  - The current session refolds only when `storedUntil` or the gap set changes.
  - At minimum, measure the whole handler end to end for the busiest day and state that number in the risk table.
- **Secondary liabilities:** memory per cached session, cache invalidation tied to gap changes (see F1), and no sharing between server instances. This may be unnecessary while there are few viewers.

##### F5 — 🟢 Nit — The mitigation for a large trade is passive and does not match the totals described elsewhere

- **Lines:** 121–122, 125–126, 145, 156.
- **Discrepancy:**
  - The risk row says "The aria label and the totals name the largest minute".
  - The totals line in the UX section (lines 121–122) has no largest-minute field.
  - The contract `totals` field (line 145) has none either.
  
  Only the aria label names the largest rise and fall, so sighted users get no cue that one minute, such as the 16:03 ET collar, dominates the line.
- **Proposed resolution (Blessing in Disguise):** turn the dominating minute into a labelled annotation rather than a filter.
  - Add `largestMinute: { minute, minuteNet, shareOfGross }` to `totals`.
  - Mark that point on Chart 1 with its New York time and signed dollars.
  - Show it in the totals line.
  - Update the risk row to match.
- **Secondary liabilities:** some chart clutter, more view-model text and scale tests, and one more contract field.
