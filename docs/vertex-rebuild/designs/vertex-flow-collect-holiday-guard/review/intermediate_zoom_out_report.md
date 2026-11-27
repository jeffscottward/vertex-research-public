# Stage 8: Intermediate Zoom Out

## Reviewer: egm-zoom-out

### Stage 8: Intermediate Zoom Out review of `vertex-flow-collect-holiday-guard/plan.md` (lines 1-142)

### Verdict

The core design still passes. It puts one calendar rule in `nyse-calendar.ts` and has the existing session checks consume it. There is no new module, contract or data format.

The scope as written is not coherent, though. The critic's B1 and M2 are not side issues; this plan causes both:

- The collector stops reading on holidays and after the early close.
- Two shared helpers then point at a session for which the plan has stored no data:
  - `flowSessionDate` skips weekends but not holidays.
  - `optionsSessionRange` always ends at 16:15.

The fix the caller proposes is the right size:

- `flowSessionDate` steps back over NYSE non-trading days.
- `optionsSessionRange` ends at the early close.

Together these fix B1 and M2 at the shared helpers, with no edits to any reader. The scope stays coherent if three things also hold:

- The Out-of-scope list is corrected.
- One futures-side decision is written down (ZO8-3).
- The code-adding mitigations proposed in Stages 6 and 7 are not adopted (ZO8-4).

---

#### ZO8-1 🔴 Blocker: the plan's own change breaks two shared session helpers that it declares out of scope or never mentions

**TargetFile lines:** 33 (Goal), 83 (Out of scope: `optionsSessionRange`), 21 (Readers), 62-63.

**Problem.** The Goal promises the "last trading session, as on a weekend". That is undeliverable while these two helpers keep their weekday-only, 16:15-close assumptions. Before this change they were harmless, because the collector kept writing ok samples and rows on holidays and until 16:15. After it, they anchor on empty data:

- **Holiday.** `flowSessionDate` (`server/flow-snapshot.ts:121-140`) returns the holiday itself after 09:30, and returns the previous weekday before 09:30. So `collectorCaughtUp` (`server/options-analytics.ts:367`) expects an ok sample at 16:10 on the holiday, and strike-profile `flow.complete` becomes false. Pages that anchor on `flowSessionDate(newest)` (`server/flow.ts:412, 458, 521`) show the empty holiday. One example is 04:00-09:30 on the day after a holiday.
- **Early close.** The critic calls this "still broken", but it is a new regression. Today, after 13:15, the options freshness stays `fresh` because reads continue, so `collectorCaughtUp` returns true. After this plan the state is `closed` and the newest ok read is 13:14, while `optionsSessionRange(...).to` is still 16:15. So `complete` turns false for the rest of the day. `sessionEnd` (`flow-option-bubbles.ts:103`) also shows 16:15.

**Evidence:** `flow-snapshot.ts:121-140`; `flow-control.ts:153-158`; `options-analytics.ts:361-375`; `flow.ts:412-535`; `flow-option-bubbles.ts:103`.

**Fix.** Add both helper changes to "Changed pieces" (line 52 and following) and to the data-flow line (58) as part of the same rule:

- `flowSessionDate` returns today only when today is an NYSE trading day and it is 09:30 or later; otherwise the previous NYSE trading day.
- `optionsSessionRange(date)` ends at `nyseCloseMinute(day, 16:15)`.

These are the only two places to change. Every reader, including `collectorCaughtUp`, the option bubbles, the put/call ratio, the strike heatmap and hedging pressure, becomes correct without an edit. The line-83 rationale ("they bound stored rows") is exactly why this change is safe: on an early close no stored rows exist after 13:15, so readers that only bound rows see no output change.

#### ZO8-2 🟡 Major: reuse the existing previous-trading-day helper; do not add a second "newest session" routine

**TargetFile lines:** 52-54, Implementation step 1 (115-118), step 3 (120-126).

**Problem.** The critic's B1 fix (step 2) makes `collectorCaughtUp` find "the newest NYSE trading session at or before `end`" locally. That would add a second copy of the session-date logic next to `flowSessionDate`, which is the same duplication that caused Problem 3.

The repository already has the step-back loop: `previousNyseTradingDay(todayUtcDay)` (`packages/api/src/openbb-overdue.ts:149-153`), tested at `openbb-overdue.test.ts:68-72`.

**Fix.**

- Do not edit `collectorCaughtUp`. ZO8-1 makes it correct as written.
- Write `flowSessionDate` as: today, if `isNyseTradingDay(today)` and the time is not before 09:30; else `previousNyseTradingDay(today)`. This replaces the hand-written Sat/Sun/Mon arithmetic, so the function gets shorter.
- Move `previousNyseTradingDay` (with its date formatter) into `nyse-calendar.ts`, and keep the re-export from `openbb-overdue.ts`. The plan already adds `isNyseEarlyClose` and `nyseCloseMinute` there, and `server/flow-snapshot.ts` should not import a calendar fact from the overdue module.
- At plan altitude this is one bullet: "`flowSessionDate` and `optionsSessionRange` use the calendar". Do not write the loop out in pseudocode.

#### ZO8-3 🟡 Major: Out of scope and the Background reader list contradict the corrected scope

**TargetFile lines:** 80, 83, 84, 21, 6.

**Problems and fixes.**

- **Line 83.** Split it. `optionsSessionRange` moves into scope (ZO8-1). `futuresSessionRange` stays out: it is the futures comparison window, and CME is not modelled (line 76). Changing it now is YAGNI.
- **Line 80**, "the futures side of `flow.control`" is out of scope. The core change already contradicts this, independently of M2:
  - `readFlowControlRows` picks the session date from `flowSessionOpen("options")` and the newest net drift minute (`server/flow.ts:743-749`).
  - On a holiday that date becomes the previous trading day.
  - `futuresReason` still uses `isWeekday(today)` (`server/flow-control.ts:544, 622`), so the futures side shows the previous session's state as current. Stage 9 B1 found the same problem.
  - The plan has to decide this, and the decision that fits its own rule is one line: `futuresReason` treats a day that is not an NYSE trading day as `market_closed`, replacing `isWeekday` with `isNyseTradingDay`. That window is already the NYSE-aligned 09:30-16:00 comparison, not the Globex hours, so this does not model CME.
  - Reword line 80 to: "ES/NQ reads keep Globex hours; on an NYSE holiday the futures side of `flow.control` is `market_closed`, as on a weekend."
- **Line 84** (seed run). The seed paths take `flowSessionDate` (`flow-collect.ts:1870, 1979`; market premium seed `flow-market-premium-collect.ts:245-251`). A seed run on a holiday now targets the previous trading day instead of the empty holiday. That is an improvement, but say so, so the bullet is not silently contradicted.
- **Line 21.** The critic's M1 asks for every caller to be listed with a reason. That is weeds: nine files, each with a rationale. Name the three shared helpers instead (`buildSourceFreshness`/`flowSessionOpen`, `flowSessionDate`, `optionsSessionRange`) and say that their readers follow them. One reader-level test per helper (ZO8-5) is the proof.
- **Line 6** ("bug fix, no new interface…") still holds after these changes. Keep it.

#### ZO8-4 🟡 Major: proposed mitigations that widen the fix without need (do not adopt)

The following Stage 6 and Stage 7 proposals add code or cross a dependency boundary for speculative or already-covered risks:

| Proposal | Source | Why it is not needed now |
| --- | --- | --- |
| Rewrite `collectorCaughtUp` locally | Critic B1 fix step 2 | Already solved at the helper (ZO8-1, ZO8-2); a local rewrite is a second copy. |
| `NYSE_SPECIAL_EARLY_CLOSES` list | Critic M6 | No one-off early close is announced. State the limit in the risk row (Stage 5 Z4); build the list when one is announced. |
| `LAST_VERIFIED_CALENDAR_YEAR` guard | Critic M6 | The calendar is rule-based for any year, and the holiday rules are already pinned for 2024-2028. A year gate is speculative. |
| Parity test of `packages/api` against `infra/quantvps/nyse-calendar.txt` | Critic M5(a) | It crosses a dependency boundary (a test in `packages/api` would read an infra data file). The critic already checked agreement for 2025-2028, and the infra side has its own parity tests (`restart-when-idle.test.ts:2698-2735`). At most a Nit, or a one-line rejected alternative. |
| Vendor trading hours (IBKR contract details) | Critic M5(b) | A new data dependency; that is the CME follow-up's job. At most one "Rejected" row. |
| Absolute per-window early-close times | Critic M5(c) | Line 75 already rejects the per-source table. One sentence on line 75 is enough. |
| Calendar-disagreement probe read; shared window table | Stage 5 IC-1, IC-2 | Not raised again in Stages 6 and 7, and still YAGNI for a bug fix. Stage 5 Z2 (a duplication note) is the right size. |

**Fix:** Keep these out of the plan, or record them as single "Rejected" rows in Alternatives. They must not appear in Implementation.

#### ZO8-5 🟡 Major: acceptance criteria and documentation for the corrected scope; keep them minimal

**TargetFile lines:** 100-106, step 5 (131-135), step 6 (137).

**Problem.** Nothing pins the helper changes from ZO8-1 and ZO8-3. The critic's N4 asks for one boundary bullet per window row, which grows the criteria list without adding coverage.

**Fix.**

- Add these cases, and only these:
  - `flowSessionDate`: 2026-11-26 12:00 → 2026-11-25; 2026-11-27 06:00 → 2026-11-25. The existing cases at `flow-snapshot.test.ts:872-885` stay unchanged.
  - `optionsSessionRange("2026-11-27").to` is 13:15 New York. The regular-day value is already pinned at `flow-control.test.ts:152`.
  - The two reader-level `complete === true` cases from critic B1 step 4. These prove the helper fix reaches options analytics.
  - `flow.control` on 2026-11-26 12:00: the options side and the futures side are both `market_closed`, and the session date is 2026-11-25 (closes Comprehension C6).
- Cover the per-window boundaries (GEX, NVDA, net drift, QQQ depth, overdue SPY) with one table-driven `flowSessionOpen` test, not one bullet each.
- Update the documentation line on the session date (`flow-pipeline.md:796`, "the newest weekday; before 09:30 the previous weekday") in step 6.

#### ZO8-6 🟢 Nit: additions that improve accuracy at little cost (adopt)

- QQQ depth in the stock-session rows and tests (critic M3, Stage 5 Z1).
- The corrected stream list (no RUT; critic M4, Comprehension C1). Better: refer to `FLOW_OPTION_STREAMS[*].closeMinuteEt` instead of copying the list (lines 15, 41, 93).
- Split the early-close before/after row at each window's shifted close (Comprehension C2).
- Risk row 92: state that no backfill exists and that the deploy window blocks a same-day fix (critic M6, text only).
- "No live window read; stored option gaps drain as on a weekend" (critic N1).
- Scope line 37 to `packages/api` (critic M5).

Keep the definitions from Comprehension C3, C7, C10 and C12 to one clause each, or a link (for example to `infra/quantvps/README.md` for `fm` and the lanes). Do not grow the Background into a glossary.

#### ZO8-7 🟢 Nit: the closed-session text should not need a third copy of the close

**TargetFile lines:** 82 (Out of scope), step 6.

**Problem.** `flow-control-rules.ts:441` hard-codes "Last session ended 16:15 ET on …". Once `market_closed` appears from 13:15 on an early close, this text is wrong.

**Fix.** Choose the cheaper of two options:

- Drop the time ("Last session ended on <date>"). This needs no new plumbing.
- Or feed the session end from `optionsSessionRange(sessionDate).to`, which ZO8-1 makes correct.

Do not add a separate `nyseCloseMinute` call in the rules module.

---

### Scope coherence check (with B1 and M2 fixed as proposed)

- **One rule, consumed at the right layer.** `nyse-calendar.ts` holds the trading day, the early close, the close minute and the previous trading day. Exactly four places consume it:
  - `flowSessionOpen` (the gate);
  - `flowSessionDate` (which session to show);
  - `optionsSessionRange` (where that session ends);
  - the overdue copy.
  
  `futuresReason` gains one line. Every other reader follows without an edit.
- **No new module, contract or data format.** Line 6 remains true. The changed files are the plan's files plus `flow-control.ts`, which already reads `flowSessionOpen`.
- **What stays out, correctly:** `futuresSessionRange`, CME hours, `marketSession`, the market premium gap fill, the other early-close copies (Stage 5 Z5), and every code-adding mitigation in ZO8-4.
