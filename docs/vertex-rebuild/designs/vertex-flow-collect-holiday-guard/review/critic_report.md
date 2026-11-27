# Stage 7: Critic Review (FeatureRange 1-110)

## Reviewer: egm-design

### Design Critic report: `vertex-flow-collect-holiday-guard/plan.md` (Stage 7, FeatureRange lines 1-110)

The plan meets the Feature Specification Standard on structure: problem, goal, architecture, alternatives, risks and acceptance criteria are all present. Several of its claims hold up against the code:

- `nyseSession` contains the early-close rule as described (`strategy-dsl-compile.ts:1821-1838`).
- `isFlowSourceSessionOpen` already checks trading days (`openbb-overdue.ts:177-191`).
- `price-freshness.test.ts:27-40` pins the holiday rules for 2024-2028.
- The proposed early-close rule matches the exchange-sourced list `infra/quantvps/nyse-calendar.txt` for every weekday from 2025 to 2028. I checked this by running `isNyseTradingDay` plus the rule against the file.

But the list of readers on line 21 is incomplete, and one reader it misses gets worse because of this change. The remaining findings are factual errors, missing alternatives, and test and risk gaps. Each finding gives the problem, the evidence and a fix.

---

#### B1 🔴 Blocker: options analytics will report incomplete strike-profile flow on every holiday, and early closes stay broken

**TargetFile lines:** 21, 33, 83

**Problem.** `collectorCaughtUp` reads `buildSourceFreshness`, which calls `flowSessionOpen`. When the state is `closed`, it requires `lastOkAt >= close - 300 s`, where `close` is the fixed 16:15 close of `flowSessionDate(end)`.

- **Holidays (new regression).** After this change the holiday state becomes `closed`, but `flowSessionDate` still names the holiday as the session (it is holiday-blind, see M2). So `close` is 16:15 on the holiday, while the newest ok sample is from the previous trading day. Between 09:30 and 16:15 + `flowHours` on a holiday, `strikeProfiles.flow.complete` becomes `false`. Before the change it was `true` while holiday reads succeeded; the plan itself records an ok options read at 16:14 on 2026-11-26.
- **Early-close days (still wrong).** After 13:15 the newest ok sample is about 13:14 but the code still expects 16:10. The profile reads incomplete for the rest of the day. On the weekend `flowSessionDate` maps back to Friday, so it continues there for any window that still overlaps Friday's assumed 16:15 close.

Line 83 rules out `optionsSessionRange` on the grounds that it "bound[s] stored rows". Here it decides whether data is complete, which is a different job, so that rationale does not cover this use.

**Evidence:**

- `packages/api/src/server/options-analytics.ts:359-375` (`collectorCaughtUp`, `optionsSessionRange(flowSessionDate(end)).to`)
- `options-analytics.ts:405-417` (`complete` is the AND with `collectorCaughtUp`)
- `options-analytics.ts:70-76` (window end = `now`)
- `options-analytics.ts:505-511` (served by `optionsAnalytics.snapshot`)
- `server/options-analytics-engine.ts:655-657` (`flow.complete` reaches the output)

**Fix:**

1. Add `optionsAnalytics.snapshot` (`storedProfileFlow`) to the reader list on line 21.
2. Make `collectorCaughtUp` use the newest NYSE trading session at or before `end`, and its close `nyseCloseMinute(day, 975)`.
3. Move `optionsSessionRange` out of the line 83 out-of-scope item for this one use.
4. Add acceptance tests:
   - On 2026-11-26 at 12:00 (holiday), with a 6 h window and the newest ok sample at 2026-11-25 16:14, `complete` is true.
   - On 2026-11-27 at 14:00, with the newest ok sample at 13:14, `complete` is true.

---

#### M1 🟡 Major: the "Readers of the same check" inventory is incomplete

**TargetFile lines:** 21, 58

**Problem.** Line 21 lists only `flow.snapshot`, `flow.control` and `flow.optionPrints`. `buildSourceFreshness`, and through it `flowSessionOpen`, is also used by:

- `flow-hedging-pressure.ts:79`
- `flow-liquidity-heatmap.ts:78` (depth)
- `flow-off-exchange-levels.ts:99`
- `flow-option-bubbles.ts:44`
- `flow-put-call-ratio.ts:103`
- `flow-strike-heatmap.ts:92`
- `flow-tape-speed.ts:191`
- `flow-trade-bubbles.ts:86`
- `options-analytics.ts:406` (see B1)

`flow-collect.ts:765` (`openTapeRanges`) also calls `flowSessionOpen`. It only touches ES and NQ, but it should be named as unaffected.

Without the full list a reviewer cannot confirm that "No ranking or number is wrong" (line 27) still holds after the change. B1 shows one place where it does not.

**Fix:** List every caller, either as changed or unchanged-by-design with a reason. Add at least one reader-level test, for example `flow.snapshot` freshness reporting `closed` on a holiday.

---

#### M2 🟡 Major: `flowSessionDate` stays holiday-blind, so "show the last trading session, as on a weekend" is not delivered everywhere

**TargetFile lines:** 33, 62

**Problem.** `flowSessionDate` maps Saturday and Sunday back to Friday, and a weekday before 09:30 to the previous weekday. It never skips a holiday.

Example: `flow.offExchangeLevels` anchors on `flowSessionDate(newestMinuteAt(symbol))`. SPY minutes start at 04:00. Between 04:00 and 09:30 on the day after a holiday, the page anchors on the holiday, which after this change has no rows. On a weekend the same page shows Friday.

The plan neither changes `flowSessionDate` nor lists it as out of scope. The documentation repeats the weekday-only rule (`flow-pipeline.md:528`, `:796`).

**Evidence:**

- `server/flow-snapshot.ts:117-140`
- `server/flow.ts:955-957`
- `options-analytics.ts:367`

**Fix:** Either make `flowSessionDate` step back over non-trading days with `isNyseTradingDay` (and add an acceptance test: 2026-11-27 06:00 maps to 2026-11-25), or move it to Out of scope with the stated effect and a follow-up card.

---

#### M3 🟡 Major: QQQ depth is affected but missing from the spec and the tests

**TargetFile lines:** 18, 33, 44, 62-64, 96, 102-103

**Problem.** QQQ is a stock-session instrument with a `depth` source (and `options`, `gex`, `net_drift`). `flowSessionOpen("depth", "QQQ", …)` takes the same stock-session branch as SPY. The feature text, the window table, the before/after table and the acceptance criteria all say only "SPY ticks and depth" or "SPY tape".

The detailed plan (line 116 and following) does cover QQQ through its "stock-session `FlowSymbol`" rule, so the behaviour changes without being specified or tested. This also hits `/flow` liquidity heatmap freshness (`flow-liquidity-heatmap.ts:78`).

**Evidence:** `packages/api/src/flow-features.ts:96-113` (QQQ: `session: "stock"`, `sources: ["depth", …]`); `server/flow-snapshot.ts:75-76`.

**Fix:**

- Rename the rows to "SPY ticks and depth, QQQ depth (stock session)".
- Add acceptance tests: QQQ `depth` is false on 2026-11-26 at 12:00, true on 2026-11-27 at 16:59, and false at 17:00.

---

#### M4 🟡 Major: the option-stream list is wrong (RUT does not exist; the real list is SPX, NDX, IWM, QQQ, SPY, NVDA)

**TargetFile lines:** 15, 41, 93

**Problem.** Line 15 lists six streams that close at 16:15, including RUT, plus NVDA: seven in total. Line 41 repeats the RUT list. Line 93's mitigation argument ("All six streams …") rests on the stream identities. The code has six streams:

| Stream key | Options ticker | Close |
| --- | --- | --- |
| ES | SPX | 16:15 |
| NQ | NDX | 16:15 |
| IWM | IWM | 16:15 |
| QQQ | QQQ | 16:15 |
| SPY | SPY | 16:15 |
| NVDA | NVDA | 16:00 |

There is no RUT anywhere in `packages/api/src`.

**Evidence:** `packages/api/src/flow-features.ts:190-232`; a grep for `RUT` in `packages/api/src` finds no matches.

**Fix:** Correct lines 15 and 41 to the actual streams, and note that ES and NQ carry the SPX and NDX streams. Better, refer to `FLOW_OPTION_STREAMS[*].closeMinuteEt` instead of copying the list.

---

#### M5 🟡 Major: Alternatives omit the repository's existing verified calendar data, and "one rule, in one place" is not true

**TargetFile lines:** 37, 68-76

**Problem.** The Alternatives Rule asks for the viable designs. The plan does not evaluate any of these:

- **(a) Reuse the existing exchange-sourced list.** `infra/quantvps/nyse-calendar.txt` holds the holidays and `early:1300` closes for 2025-2028. Its source is nyse.com, checked 2026-11-08, and it states it was cross-checked against `scripts/breadth-90/calendar.ts`, `services/openbb/vertex_openbb/jobs/nyse_closures.py` and `services/execution/vertex_execution/paper_deploy/calendar.py`. The deploy guard (`infra/quantvps/restart-when-idle.sh:474-475`) already uses it. The alternative is to use this list, or pin the rule to it with a test, instead of a pure rule.
- **(b) Per-instrument trading hours from the data vendor**, for example IBKR contract-details trading hours, which would also cover the CME calendar.
- **(c) Absolute early-close times per window instead of a shift.** The 180-minute shift only holds because every exchange happens to move by the same amount.

There are already at least five early-close representations in the repository: the `.txt` file, `breadth-90/calendar.ts:38`, `nautilus-golden.ts:371`, the two Python modules, and `nyseSession`. "One rule, in one place" is only true inside `packages/api`.

Row 1's rationale also leans on "The card asks for both" without linking or quoting the card, which the standard's rule on unlinked attribution forbids.

**Fix:**

- Add rows (a)-(c) with concrete trade-offs.
- Scope line 37 to `packages/api`.
- Add a parity test that runs `isNyseTradingDay` and `isNyseEarlyClose` against `infra/quantvps/nyse-calendar.txt` for its covered years. They agree today, and the test keeps it that way.
- Link or quote the card.

---

#### M6 🟡 Major: the risk of a wrong calendar entry understates its cost and gives a mitigation that does not exist

**TargetFile lines:** 91-92

**Problem.**

- **Line 92 accepts the common-mode fault but leaves out its cost.** If a trading day is wrongly marked closed (or early-closed), no option prints, GEX or net drift are collected. Net drift and GEX have no backfill. The collector records no option gaps for a day it believes is closed, so the loss is permanent.
- **No same-day fix is possible.** The QuantVPS deploy is blocked from 08:30 to 16:00 (13:00 on an early close) on trading days (`restart-when-idle.sh:96`, `:474`), so a corrected calendar cannot ship that day.
- **Line 91 handles an unscheduled early close with "add the date to … the early-close rule".** The rule is pure date arithmetic with no exception list, so this mitigation requires changing code.
- **There is no year-range guard.** `research-screen-slots.ts:9-10,97-99` gates on `LAST_VERIFIED_CALENDAR_YEAR = 2028`; the plan has nothing equivalent.

**Fix:**

- State the data loss and the deploy-window constraint in the risk table.
- Add an `NYSE_SPECIAL_EARLY_CLOSES` list next to `NYSE_SPECIAL_CLOSURES`, or say that this is out of scope.
- Consider a test that fails once the current year passes the verified range.

---

#### N1 🟢 Nit: the goal and load claims ignore option-gap reads after the close

**TargetFile lines:** 33, 96

**Problem.** When the options source is closed, the collector still drains stored option gaps with QuantData requests ("market closed, gaps only"). So "no option print … read runs" and "no option … requests" on a holiday are not exactly true; the behaviour matches a weekend instead. Line 96 also gives no numbers (requests saved per holiday or per early close), which is the cost dimension the standard expects.

**Evidence:** `server/flow-collect.ts:1645-1690`, `2032-2061`.

**Fix:** Say "no live window read; stored gaps drain as on a weekend", and add an estimated request count.

#### N2 🟢 Nit: "every source except the futures" is ambiguous

**TargetFile line:** 53

**Problem.** ES and NQ also carry `options`, `gex` and `net_drift` (SPX and NDX based), and those do shift.

**Fix:** Say "except `ticks` and `depth` of ES and NQ".

#### N3 🟢 Nit: market-hours claims from outside the repository are not sourced

**TargetFile lines:** 48, 93

**Problem.** These claims are unsourced:

- On an early-close day, index and ETF options close at 13:15 and equity options at 13:00.
- Extended-hours stock trading ends at 17:00.

Also, SPY, QQQ, IWM and NVDA options are multi-listed across many exchanges, not "on Cboe" only.

**Fix:** Cite the Cboe, Nasdaq or NYSE Arca holiday-hours notices, and replace "Cboe" with "US options exchanges".

#### N4 🟢 Nit: acceptance criteria skip several boundaries that the window table claims

**TargetFile lines:** 100-106 (versus 41-45)

**Problem.** There is no test for:

- the GEX boundary at 13:14/13:15 on an early close;
- the NVDA boundary at 12:59/13:00;
- the overdue SPY `ticks`/`depth` window at 12:59/13:00 (table line 45);
- QQQ (see M3);
- the reader-level behaviour (M1, B1).

**Fix:** Add these cases.

#### N5 🟢 Nit: the out-of-scope rationale for the fixed ranges is incomplete

**TargetFile line:** 83

**Problem.** `optionsSessionRange(...).to` is also shown to users as `sessionEnd` in `flow-option-bubbles.ts:103`, so it reads 16:15 on an early close. It is also used for the completeness decision in B1.

**Fix:** Name these uses, or narrow the exclusion.

#### N6 🟢 Nit: the CME follow-up has no card, and the suggested live check day will show stale futures

**TargetFile lines:** 76, 80, 109

**Problem.** CME holidays are deferred without a follow-up card. On 2026-12-25 (the optional live look) Globex is closed, but ES and NQ will still be read and shown as stale.

**Fix:** Name the follow-up card, and note the expected futures state so the live look is not misread.

## Reviewer: egm-structural

### Structural Goldfish review: `vertex-flow-collect-holiday-guard/plan.md` (FeatureRange, lines 1-110)

**Verdict:** the layout passes. The heading hierarchy, Markdown syntax and relative links are all sound. One alternative's rejection reason breaks the standard's Alternatives Rule, and the Fix section is hard to follow because it has no subheadings and one table has no introduction. The other findings are nits.

### Structure map

| Line | Level | Heading | Standard requirement |
| --- | --- | --- | --- |
| 1 | H1 | Plan: … | — |
| 3-8 | — | Image and metadata list (card, kind, baseline commit, related plan) | — |
| 10 | H2 | Background | — |
| 25 | H2 | Problem | Problem Statement ✔ |
| 31 | H2 | Goal | Goals (non-goals are split off, see ST-03) |
| 35 | H2 | Fix | Proposed Architecture ✔ (has a data flow at line 58) |
| 68 | H2 | Alternatives considered | Alternatives Considered ✔ |
| 78 | H2 | Out of scope | Non-Goals ✔ |
| 87 | H2 | Risks and limits | Risks & Mitigations ✔ (security and load at line 96) |
| 98 | H2 | Acceptance criteria | — |

**Checks that pass:**

- **Headings:** there is one H1, all sections are H2, and no level is skipped. The section order is the same as the sibling plan `smart-money/plan-holiday-session.md` (lines 1, 11, 25, 34, 38, 55, 65, 73, 84, 91).
- **Tables:** all five tables (lines 39-46, 60-66, 70-76, 89-94 and the header rows) have 3 columns in every row and a delimiter row. None is malformed.
- **Lists:** bullets use `*` throughout with 2-space nesting, and the numbered list in Problem (27-29) is well-formed. No fenced code block is left open.
- **Links:** `./before-after.svg` and `../smart-money/plan-holiday-session.md` exist, and `../../flow-pipeline.md` resolves.
- **Quoted text:** both quotes in Problem item 3 match the source. "Holidays and half days are not modelled" is at `flow-pipeline.md:952-953`, and "Holidays are not modelled." is at `flow-pipeline.md:1018`.

### Findings

#### ST-01 🟡 Major: an alternative is rejected by pointing at the card, and the technical reason is unclear

- **Lines:** 72; also 5.
- **Problem:** The Alternatives Rule requires concrete technical or scope trade-offs. It forbids attributing a rejection to an outside authority without linking the issue, discussion or PR. Row 72 starts with "The card asks for both", and the card (line 5) is a bare identifier with no link.
  - The second sentence does not hold up under its own alternative. In "holiday check only", nothing models early closes. The collector and the overdue windows would then both run until 16:15/16:20 and agree. So "disagree … in the other direction once the collector stops" describes no real situation.
- **Fix:** Replace the reason with a concrete trade-off. For example: "Leaves about three hours of no-data option, GEX, net drift and market premium reads per early-close day (Problem 2). It also keeps the overdue alert expecting samples until 16:15/16:20, which is silent today only because those useless reads continue." Drop the card attribution, or link the card entry.

#### ST-02 🟡 Major: the Fix section has four separate blocks under one heading, and the second table has no introduction

- **Lines:** 35-66, especially 56-66.
- **Problem:** The section the standard calls "Proposed Architecture" holds four distinct blocks with no subheadings or captions:
  - the rule and the windows table (37-48);
  - the list of changed pieces (50-54);
  - the data flow (56-58);
  - a before/after table (60-66).

  Lines 56 and 58 introduce only the data-flow line. The table at line 60 follows directly with no introducing sentence, so a fresh reader takes it as part of the data flow.
- **Fix:** Add H3 headings under `## Fix`: `### Windows`, `### Changed pieces`, `### Data flow`, `### Before and after`. At minimum, add a line such as "Before and after, by time of day (New York):" before line 60.

#### ST-03 🟢 Nit: goals and non-goals are far apart

- **Lines:** 31-33 and 78-85.
- **Problem:** The standard pairs "Goals & Non-Goals". Here `## Goal` (31) and `## Out of scope` (78) are 47 lines apart, with Fix and Alternatives between them. Line 33 also carries a non-goal sentence ("The contracts, the database and the futures sessions do not change."). The sibling plan uses the same split, so this is house style; that is why it is only a nit.
- **Fix:** Move `## Out of scope` to just after `## Goal`. Or rename to `## Goals and non-goals` and make Out of scope an H3 under it, merging line 33's non-goal sentence into it.

#### ST-04 🟢 Nit: the before/after table does not line up with the windows table

- **Lines:** 41-46 versus 62-66.
- **Problem:**
  - Row 63, "Early-close day, 13:00-16:20", lumps together three new closes from the windows table: NVDA at 13:00, options/GEX/market premium at 13:15, and net drift at 13:20.
  - Row 45 (overdue alert, SPY regular session, 16:00 → 13:00) has no before/after row.
  - Row 62 (holiday) leaves out the market premium without saying it is already closed on holidays.
- **Fix:** Add a row for the overdue alert's SPY window. Split row 63 so it shows the 13:00, 13:15 and 13:20 closes, or say "from the early close of each window (13:00-13:20)". Add "market premium: already closed on a holiday (unchanged)".

#### ST-05 🟢 Nit: file paths are written in two styles, and one bare name points to the wrong guess

- **Lines:** 14, 20, 23 (full paths) versus 22, 52-54, 74 (bare file names).
- **Problem:** Line 74 cites `gex-context.ts` without a directory. The neighbouring bare names `nyse-calendar.ts` and `openbb-overdue.ts` live in `packages/api/src/`, but `gex-context.ts` does not. The real file is `packages/api/src/server/gex-context.ts` (`marketSession` at line 319, imported by `server/flow-snapshot.ts:40`), so a reader who guesses from the neighbours looks in the wrong place.
- **Fix:** Use the full path the first time each file appears, especially at line 74 (`packages/api/src/server/gex-context.ts`).

#### ST-06 🟢 Nit: the card reference is not a link

- **Line:** 5.
- **Problem:** "Related plan" (line 8) is a working relative link, but "Card" is plain text with only a description ("the job tracker entry").
- **Fix:** Link the card, or name the exact command or location to read it (for example the `fm` card ID used at line 141).

#### ST-07 🟢 Nit: a common alternative is missing

- **Lines:** 70-76.
- **Problem:** The table does not consider gating the whole `flow.collect` run on holidays, either through the QuantVPS timer's calendar or a guard before the per-source loop. A reader would naturally ask about it.
- **Fix:** Add a row: "Skip the whole collector run on NYSE holidays (timer or run-level guard) | Rejected | It would also stop ES/NQ Globex reads. It would not fix the `/flow` readers that call `flowSessionOpen` (`flow.snapshot`, `flow.control`, `flow.optionPrints`). And it does not handle early closes."

#### ST-08 🟢 Nit: inconsistent decision wording, and a CME item listed twice

- **Lines:** 76 and 80.
- **Problem:** Every other row says "Rejected", but row 76 says "Not in this fix". The same CME item also appears in Out of scope at line 80.
- **Fix:** Use "Deferred" in row 76 and point to `## Out of scope`, or drop the row and keep it only in Out of scope.

#### ST-09 🟢 Nit: security and load notes sit outside the risks table

- **Line:** 96.
- **Problem:** The standard asks for security implications and scalability limits explicitly. Here they are a loose paragraph after the table, so a scan of the table misses them.
- **Fix:** Add them as two rows (Security | none: no new input or access | — and Load | fewer requests | —). Or give the paragraph bold labels on separate lines, matching the Background bullets.

#### ST-10 🟢 Nit: the "Kind" line conflicts with the Implementation Plan

- **Line:** 6, compared with lines 116-118 (in the DetailedRange).
- **Problem:** "no new interface, module …" conflicts with three new exports in `nyse-calendar.ts` (`NYSE_EARLY_CLOSE_SHIFT_MINUTES`, `isNyseEarlyClose`, `nyseCloseMinute`) and a new test file.
- **Fix:** Reword to: "bug fix (no new API procedure, contract field or data format; three new exports in `nyse-calendar.ts`)".

## Reviewer: egm-style

### Style Goldfish review: `plan.md`, lines 1–110 (Stage 7, REVIEW)

I checked the plan's claims against the code at the working tree: `flow-snapshot.ts:43-80`, `openbb-overdue.ts:17-25,167-189,348-357`, `flow-features.ts:189-231`, `contracts/flow.ts:55-82`, `gex-context.ts:319-326`, `flow-pipeline.md:952,1018` and `plan-holiday-session.md:61,70`. I found 1 Blocker, 5 Major and 9 Nit findings. The verified claims are listed at the end and are not findings.

---

#### S1 — 🔴 Blocker — Lines 15 and 41: the stream list names RUT, which is not a stream

**Problem.** Line 15 says "16:15 for SPX, NDX, RUT, SPY, QQQ and IWM options; 16:00 for NVDA", which is seven streams. The Fix table row on line 41 repeats RUT. Line 93 says "All six streams". The text contradicts itself, and the claim about existing behavior does not match the code.
**Evidence.** `packages/api/src/flow-features.ts:189-231` defines `FLOW_OPTION_STREAMS` with exactly six keys: ES→SPX, IWM, NQ→NDX, NVDA, QQQ and SPY. There is no RUT entry. Five streams close at `16 * 60 + 15` and NVDA closes at `16 * 60`.
**Fix (CALIBRATE).**

- Line 15: "09:30 to the stream close (16:15 for the SPX, NDX, SPY, QQQ and IWM options; 16:00 for NVDA)".
- Line 41: "Options of SPX, NDX, SPY, QQQ, IWM; GEX; market premium".

#### S2 — 🟡 Major — Line 63: the early-close time range is wrong for most windows

**Problem.** The row "Early-close day, 13:00-16:20 → no read" is wrong for most windows. Under the new rule, SPX, NDX, SPY, QQQ, IWM options, GEX and market premium keep reading until 13:15, and net drift keeps reading until 13:20 (lines 41, 43, 103). Only NVDA stops at 13:00. As written, the row contradicts the Fix table and the acceptance criteria.
**Fix (CALIBRATE).** Change the row label to "Early-close day, from the shifted close (13:00-13:20 by window) to 16:20". You could also split it into one row per window close.

#### S3 — 🟡 Major — Line 62: the holiday row puts every source in one 04:00–20:00 window

**Problem.** In the "Before" cell, "Holiday, 04:00-20:00 New York | the collector reads options, GEX, net drift and the SPY tape" reads as if every source reads for the whole range. Only the SPY tape covers 04:00–20:00. Options, GEX and net drift read from 09:30 to 16:00/16:15/16:20 (lines 15–18).
**Fix (CALIBRATE).** Write "Holiday (each window's regular hours)", or say "the SPY tape 04:00-20:00; options, GEX and net drift 09:30 to their regular close".

#### S4 — 🟡 Major — Lines 48 and 93: the exchange claim is wider than the evidence

**Problem.** Line 48 says "The equity option markets (Cboe) … close three hours early". Line 93 says "All six streams are US equity or index options on Cboe". That is not accurate for all six:

- NDX options are listed mainly on Nasdaq exchanges.
- SPY, QQQ, IWM and NVDA options are multi-listed.

The decision the reader needs is that every stream's venue shifts its close by 180 minutes. Naming Cboe as the single venue is the part that cannot be verified.
**Fix (CALIBRATE).**

- Line 48: "US listed equity and index options (all six streams) and the extended-hours stock session close three hours early on NYSE early-close days."
- Line 93, Handling column: "All six streams are US-listed equity or index options; their listing exchanges follow the NYSE early-close schedule."

#### S5 — 🟡 Major — Line 8: "the same fix" overstates what the related plan did

**Problem.** `plan-holiday-session.md` added only a holiday check for market premium. Its line 61 and line 70 list the wider work, including the other sources, as this card's follow-up. It did not add early closes. Calling it "the same fix" suggests that market premium already handles early closes. This plan changes `isMarketPremiumSessionOpen` precisely because it does not (line 54).
**Fix (CALIBRATE).** "(the holiday check for the market premium source; it named this card as its follow-up)".

#### S6 — 🟡 Major — Lines 27–28: impact claims with no evidence

**Problem.**

- Line 27 says "The reads return little or no data." and "No ranking or number is wrong." These are general claims with no cited check. The related plan (`plan-holiday-session.md:30`) records that holiday reads did store a `partial` market-premium row, which showed in the newest slot.
- Line 28 says "The extra reads return no new data (same totals)." This is also an observation with no source.

The reader cannot tell whether these were measured or assumed.
**Fix (CALIBRATE).** Cite the observation, for example "the 2026-11-26 `openbb.status` read showed …". Or narrow the claims:

- "Holiday reads store few or no rows."
- "No stored ranking changes; the market premium case was fixed by plan-holiday-session.md."

If neither is checked, DROP the sentence "No ranking or number is wrong".

#### S7 — 🟢 Nit — Line 28: indirect phrasing

**Problem.** "this has not fired only because the collector also keeps reading until then" is a negative clause inside another clause.
**Fix.** "The alert stays silent today only because the collector also reads until then; once the collector stops at the early close, the alert would fire."

#### S8 — 🟢 Nit — Line 72: hard-to-follow rejection reason

**Problem.** "would then disagree with the collector on early-close days in the other direction once the collector stops" refers back to an unstated "first direction".
**Fix.** "If only the collector stopped at the early close, the overdue windows (still 16:15/16:20) would report the stopped sources as overdue."

#### S9 — 🟢 Nit — Line 74: unclear tense, and the change is not listed

**Problem.** "`flowSessionOpen` no longer calls it" describes the state after the change inside a rejection rationale. Line 53 ("Changed pieces") does not say that the SPY branch stops calling `marketSession`. Today it does, at `flow-snapshot.ts:75-76`.
**Fix.** In line 53, add "the SPY stock branch replaces its `marketSession` call with the 04:00–20:00 window and the close minute". On line 74, say "After this change, `flowSessionOpen` does not call it."

#### S10 — 🟢 Nit — Lines 52 and 101: function names appear first in the tests

**Problem.** Line 52 says only "one function that returns the close minute of a day". The names `isNyseEarlyClose` and `nyseCloseMinute` appear first in the acceptance criteria on line 101.
**Fix.** Name both functions on line 52: "`isNyseEarlyClose(day)` (moved from `nyseSession`) and `nyseCloseMinute(day, regularCloseMinute)`".

#### S11 — 🟢 Nit — Line 37: slogan phrasing

**Problem.** "One rule, in one place" works as a slogan. It is also loose: two window copies remain, `flowSessionOpen` and `isFlowSourceSessionOpen` (line 73). Only the calendar rule is shared.
**Fix.** "One calendar rule in `nyse-calendar.ts`: an equity or option window is open only on an NYSE trading day, and on an early-close day its close moves 180 minutes earlier."

#### S12 — 🟢 Nit — Line 65: "as today" is ambiguous

**Problem.** In "reads as today", the word "today" is easy to read as the trading-session date. Line 21 uses "today" in that sense.
**Fix.** "unchanged".

#### S13 — 🟢 Nit — Line 96: the load statement is missing a noun

**Problem.** "on an early-close day about three hours fewer" does not say three hours fewer of what.
**Fix.** "on an early-close day, about three fewer hours of reads per source (180 minutes per window)."

#### S14 — 🟢 Nit — Lines 104–105: test wording

**Problems.**

- Line 104: "`isFlowSourceSessionOpen` (through `evaluateOpenbbSources`) reports no overdue option sample". The function returns a boolean; `evaluateOpenbbSources` produces the report.
- Line 105: the cutoff of 12:45 appears with no derivation.

**Fix.**

- Line 104: "`evaluateOpenbbSources` (using `isFlowSourceSessionOpen`) lists no overdue option source on 2026-11-27 at 14:00 New York."
- Line 105: add "(cutoff = shifted close 13:15 minus the 30-minute `market_premium` max age)". This matches `openbb-overdue.ts:23-25` and `contracts/flow.ts:66`.

#### S15 — 🟢 Nit — Lines 5, 33, 85, 109: wording and caveats

**Problems and fixes.**

- Line 5: "(the job tracker entry of this work)" is wordy. Write "(job tracker card)".
- Line 33: in "every one of these windows", "every one of" is filler. Write "these windows".
- Line 85: "This change is in a collector of research data and its read views." repeats line 12. DROP it and keep the out-of-scope bullet item.
- Line 109: "a look on those days is optional" names no decision for the operator. Either DROP it, or RELOCATE it as a concrete step, for example: "On 2026-12-24 after 13:20, check that `openbb.status` lists no overdue source."

---

#### Claims checked and accurate (no finding)

- The 60-second timer exists: `infra/flow/quantvps/vertex-flow.timer:8`.
- The windows in `flowSessionOpen` (`flow-snapshot.ts:43-80`) match lines 15–20, including `market_premium → true`.
- The overdue windows and the trading-day check match line 22: `openbb-overdue.ts:177-189`. The stock window is 09:30–16:00.
- `marketSession` uses 04:00–20:00: `gex-context.ts:323`.
- `NYSE_SPECIAL_CLOSURES` exists: `nyse-calendar.ts:60`.
- The 2024–2028 holiday rules are pinned: `price-freshness.test.ts:27`.
- `flow-pipeline.md:952,1018` contain the quoted text.
- None of the changed source files appears in `scripts/ci/coverage-baseline.json`.
- The 12:45 clear cutoff is correct: 16:15 minus 1800 s gives 15:45, and shifting by 180 minutes gives 12:45.
