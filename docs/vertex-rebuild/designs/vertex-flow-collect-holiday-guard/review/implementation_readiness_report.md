# Stage 9: Implementation Readiness Test (DetailedRange 111-142)

## Reviewer: egm-implementation-readiness

### Implementation Readiness Review: `vertex-flow-collect-holiday-guard/plan.md`, Implementation Plan (lines 111-142)

I checked this section against `implementation-readiness-standard.md` and against the code at baseline `6db354c9`. The plan is close to ready:

- Its file targets, function names, constants and window values match the code: 570/975/980/240/1200, `closeMinuteEt`, `MARKET_PREMIUM_CLOSE_MINUTE`, `isCapturedNearClose`, `isOffHoursMarketPremiumClearable`, and `nyseSession` at `strategy-dsl-compile.ts:1821-1837`.
- The acceptance dates are correct. 2026-07-03 is the observed Independence Day holiday. 2026-11-27, 2026-12-24 and 2027-11-26 are early closes.
- The CHANGELOG target (`## [Unreleased]` → `### Fixed` at `CHANGELOG.md:102`) and the doc strings to replace (`flow-pipeline.md:952-955`, `:1018`, `:830`) exist as quoted.

Three Major gaps remain. In each, the implementer must make a choice, or a plausible reading of the plan produces a regression.

---

#### IR-1 🟡 Major: the day computation in `flowSessionOpen` invites an off-by-one month and a name clash

**TargetFile lines:** 123, 124

**Problem:** Line 123 says `day` is "`utcDay` of the `year`, `month` and `day` parts of `newYorkParts`". Taken literally, that call is wrong:

- `newYorkParts` returns zero-padded strings with `month` from 01 to 12 (`gex-context.ts:296-309`).
- `utcDay` takes a 0-indexed month (`nyse-calendar.ts:11-13`: "month is 0-indexed").
- So `utcDay(2026, 11, 26)` is 26 December, and the holiday test would silently check the wrong date.

Line 124 also says to keep the Globex rules "unchanged". Those rules read the existing local `day`, which is the weekday string (`flow-snapshot.ts:49, 77-80`: `day === "Sat"`, and so on). A new numeric `day` collides with it.

**Evidence:** `openbb-overdue.ts:76-88` already does this conversion correctly: `utcDayNum: utcDay(year, month - 1, day)` with `Number(...)` parsing.

**Fix:** State the code exactly:

```ts
const nyDay = utcDay(Number(parts["year"]), Number(parts["month"]) - 1, Number(parts["day"]));
```

Rename the existing weekday local (for example to `weekdayName`), and keep the Globex comparisons on that renamed variable.

---

#### IR-2 🟡 Major: "(SPY)" hides that QQQ depth is also a stock-session source

**TargetFile lines:** 122, and 133 and 139 for the tests and the changelog text

**Problem:** The window rule says "`ticks` or `depth` of a stock-session `FlowSymbol` (SPY) [240, 1200)". QQQ is also a stock-session instrument, and it collects `depth`:

- `flow-features.ts:106` has `session: "stock"`.
- `flow-features.ts:107` lists `sources: ["depth", "options", "gex", "net_drift"]`.

Today QQQ depth goes through `marketSession` (`flow-snapshot.ts:75-76`). If the implementer follows the parenthetical and keys the window on `symbol === "SPY"`, QQQ depth gets no window. It then falls through to "the Globex rules, unchanged" (line 124) and starts following Sunday 18:00 to Friday 17:00 hours, which is a regression. If the implementer keys on `session === "stock"` instead, QQQ depth changes behaviour (closed on holidays, ends at 17:00 on early closes). Neither the Goal, the tests, the doc text nor the changelog mentions that change.

**Fix:** In line 122, write: "`ticks` or `depth` of any `FlowSymbol` with `FLOW_INSTRUMENTS[symbol].session === "stock"` (today SPY ticks and depth, QQQ depth) [240, 1200)". Then:

- Add a QQQ `depth` assertion to both new `flowSessionOpen` tests (2026-11-26 12:00 → false; 2026-11-27 16:59 → true, 17:00 → false).
- Name the QQQ book in the changelog entry (line 139) and in the doc replacement for `flow-pipeline.md:1017-1018` (line 137).

---

#### IR-3 🟡 Major: the deploy gate `fm market` is undefined

**TargetFile line:** 141

**Problem:** "only when `fm market` exits 0" has no definition anywhere in the repository. The only occurrence is this plan, and `review/comprehension_report.md:60-65` already asked what it means. The referenced procedure gates market hours differently:

- `infra/quantvps/README.md:45` and step 5 at `:85`: `restart-when-idle.sh` refuses with exit 14 during US market hours and already knows the 13:00 early close.
- The README also requires steps 1-8: build, record `DEPLOYED_SHA`, `stage-build.sh`, `stage-runtime.sh`, the restart, the Caddyfile reload, the CSP header check, the two prune scripts, and releasing the claim.

The implementer cannot tell whether `fm market` is an extra gate, a stand-in for the exit-14 guard, or a mistake.

**Fix:** Either remove the `fm market` clause and cite the README's market-hours guard (exit 14; deploy after 16:00, or after 13:00 on an early close, or before 08:30, or on a weekend or holiday), or give its exact command and the meaning of exit 0. Name the README steps explicitly ("steps 1-8, release the claim after step 8"), so that none is skipped.

---

#### IR-4 🟢 Nit: the `isNyseEarlyClose` derivation and the `nyseSession` cleanup are only partly specified

**TargetFile lines:** 117, 119

**Problem:**

- Line 117 quotes only the Thanksgiving term. The function receives only `day`, so `year`, the month and the day of the month must be derived. In `nyseSession` that is done with `date`, `month` and `dayOfMonth` at `strategy-dsl-compile.ts:1825-1827`.
- After step 2, those three locals in `nyseSession` become unused and fail lint.
- "drop `nthWeekday` … if no other use remains" can be settled now: its only other use is `strategy-dsl-compile.ts:1831`, which this change removes. `weekday` stays, because line 1878 uses it.

**Fix:** In line 117, say: "move the whole `month`, `dayOfMonth` and Thanksgiving computation (lines 1825-1831) into `isNyseEarlyClose`". In line 119, say: "delete the `date`, `month` and `dayOfMonth` locals from `nyseSession`; change the line-17 import to `import { isNyseEarlyClose, isNyseTradingDay, weekday } from "./nyse-calendar.ts";`".

---

#### IR-5 🟢 Nit: conditional import edits and missing new imports

**TargetFile lines:** 126, 128-130

**Problem:**

- The only other use of `marketSession` in `flow-snapshot.ts` is line 76, so "if no other use remains" can be settled: remove `marketSession` from line 40 and keep `newYorkParts`.
- The plan never lists the new imports: `isNyseTradingDay`, `nyseCloseMinute` and `utcDay` in `flow-snapshot.ts`, and `nyseCloseMinute` in `openbb-overdue.ts:11`.

**Fix:** Change line 40 to `import { newYorkParts } from "./gex-context.ts";`. Add `import { isNyseTradingDay, nyseCloseMinute, utcDay } from "../nyse-calendar.ts";`. Extend `openbb-overdue.ts:11` with `nyseCloseMinute`.

---

#### IR-6 🟢 Nit: the `isCapturedNearClose` call shape is implied, not stated

**TargetFile line:** 130

**Problem:** The plan defines the cutoff in minutes. `nyWallTimeUtcMs` takes hour and minute separately (`openbb-overdue.ts:352-356`).

**Fix:** Spell it out: `const cutoff = nyseCloseMinute(sessionDay, MARKET_PREMIUM_CLOSE_MINUTE) - MARKET_PREMIUM_CLEAR_MARGIN_MINUTES; nyWallTimeUtcMs(sessionDay, Math.floor(cutoff / 60), cutoff % 60)`.

---

#### IR-7 🟢 Nit: the overdue tests do not specify fixtures or a control case

**TargetFile line:** 134, against the acceptance criteria at lines 104-105

**Problem:** "the early-close cases for the option sample and for the market premium clear" leaves the fixture design to the implementer: the sample times, the session `status`, and which output field to assert.

**Fix:** Specify the fixtures:

- **Option sample:** `flow.latestOk` options sample at 2026-11-27 13:10 New York, `now` 14:00 → the `options` entry has `overdue: false`. Add a control: the same offsets on Friday 2026-11-20 → `overdue: true`, so the test discriminates.
- **Market premium clear:** session `2026-11-27`, `status: "partial"`, `capturedAt` 13:00:
  - `now` 13:30 → `clearableKeys` contains `"flow:market_premium"`;
  - `capturedAt` 12:40 → it does not (the cutoff is 12:45).

---

#### IR-8 🟢 Nit: the open-ended fixture repair breaks the file boundary

**TargetFile lines:** 113, 135

**Problem:** "fix any fixture that sits on a holiday or an early-close date" lets the implementer edit unnamed test files, which the standard's write allowlist forbids. A scan of the 53 flow, overdue and smart-money test files found:

- Holiday fixtures that already expect a closed market: `openbb-overdue.test.ts:92, 530, 537` and `flow-market-premium-collect.test.ts:23`.
- 2026-11-27 fixtures only before 12:45: `openbb-overdue.test.ts:546` (08:00) and `flow-market-premium-collect.test.ts:405` (00:05).

None falls in a window whose behaviour changes.

**Fix:** Replace that bullet with: "No existing fixture is expected to change (scan of 2026-11-27); if one fails, stop and amend the plan." In line 113, list the plan-folder files explicitly (`plan.md`, `before-after.svg`, `review/*`).

---

#### IR-9 🟢 Nit: the text insertions produce nested parentheses

**TargetFile lines:** 137 (last sentence), 138

**Problem:** The targets read "(09:30-16:15 New York on an NYSE trading day…)" at `smart-money.ts:62`, `flow-market-premium-collect.ts:3, 253` and `flow-pipeline.md:830`. Inserting "(13:15 on an early close)" after "09:30-16:15 New York" gives "(09:30-16:15 New York (13:15 on an early close) on an NYSE trading day". Line 137 also gives no position for the `flow-pipeline.md` insertion.

**Fix:** Give exact before and after strings, for example "(09:30-16:15 New York, 13:15 on an early close, on an NYSE trading day".

---

#### IR-10 🟢 Nit: comments and docs that stay stale, with no recorded decision

**TargetFile lines:** 136-139

**Problem:** These say 16:15 but become wrong on an early-close day:

- `flow-pipeline.md:1067-1069`: "After the options close (16:15 New York) the collector keeps reading gaps…". On an early close the gap draining starts at 13:15, and on a holiday the options path is the closed path all day (`flow-collect.ts:2034-2036`).
- `contracts/smart-money.ts:82`: "while options trade (09:30-16:15 New York)".

**Fix:** Add both to step 6 with the exact replacement text, or list them under "Out of scope" with a reason.

---

#### IR-11 🟢 Nit: test gaps for the special windows

**TargetFile lines:** 132-134

**Problem:** The plan has no assertion for:

- NVDA options, the only stream with a 16:00 close (`flow-features.ts:214`): early close at 13:00.
- The overdue alert's ticks and depth window, which ends at 13:00 on an early close.
- A true 3 July early close. 2026-07-03 is a holiday; the indirect coverage is `strategy-dsl-compile.test.ts:3919` with 2028-07-03.

**Fix:**

- `nyse-calendar.test.ts`: add `isNyseEarlyClose(2028-07-03) === true`.
- `flow-snapshot.test.ts`: NVDA options on 2026-11-27, true at 12:59 and false at 13:00.
- `openbb-overdue.test.ts`: a `ticks` source on 2026-11-27, not overdue at 13:30.

---

#### IR-12 🟢 Nit: no verification checkpoint per step

**TargetFile lines:** 115-140

**Problem:** Steps 1-4 change code; step 5 holds all the tests. The standard asks that each phase leave a testable state with a checkpoint.

**Fix:** Add per-step checks:

- After step 2: `pnpm exec vitest run src/strategy-dsl-compile.test.ts` (the `nyseSession` tests must stay green).
- After step 3: run `src/server/flow-snapshot.test.ts` and `src/server/flow-option-prints.test.ts`.
- After step 4: run `src/openbb-overdue.test.ts`, `src/server/flow-market-premium-collect.test.ts` and the smart-money tests.

Alternatively, write each step's tests in the same step.

## Reviewer: egm-codebase-details

### Codebase Details Goldfish: Stage 9 (Implementation Readiness) review of `plan.md`, DetailedRange lines 111-142

Standard applied: `implementation-readiness-standard.md`. The checks in this report ran on a clean worktree at baseline `6db354c9`; the only untracked item is the plan folder.

**Verdict: not ready.** There is 1 Blocker, 5 Major findings and 8 Nits. The Blocker is a reader of the changed session date that the plan does not analyze: the `flow.control` futures side changes behaviour on NYSE holidays. The plan also leaves one off-by-one ambiguity and one missed user-visible text.

---

### 🔴 Blocker

#### B1: The futures side of `flow.control` shows the previous session's state as live on an NYSE holiday

- **Plan lines:** 120-124 (step 3) and 137, 139 (the prescribed doc and CHANGELOG text). The plan's "Out of scope" line 80 and the prescribed doc text are both contradicted.
- **Problem:** After step 3, `flowSessionOpen("options", ...)` is false on a holiday. That changes `flow.control`'s session date, and the futures side is built from that date while its closed/stale checks still use today's clock.
  - `readFlowControlRows` sets `sessionDate` to the day of the newest stored net drift minute when options are closed (`packages/api/src/server/flow.ts:743-749`). On a holiday that is the previous trading day.
  - The futures fold reads `futuresSessionRange(rows.sessionDate)`, which is the previous day's 09:30-16:00 (`server/flow-control.ts:562-566`).
  - `futuresReason` decides "closed" from *today* instead (`flow-control.ts:612-623`). It uses `isWeekday(today)` and today's 09:30-16:00 range. A holiday is a weekday, so the result is not `market_closed`.
  - The ES/NQ tape is still read under Globex hours, so the "stale" check passes. The reason then falls through to `last.noDataReason`, the prior day's last fold step (`flow-control.ts:630-635`, consumed at `:657`).
- **Effect:** On a holiday between 09:30 and 16:00, the futures side shows the previous session's closing state (for example `buyers`) as a current state, next to an options side that says `market_closed`. Today it computes a state from the holiday's own tape.
  - The prescribed doc sentence "the page shows the last trading session, as on a weekend" is false for the futures side. On a weekend `futuresReason` returns `market_closed`.
  - Line 80 says the futures side of `flow.control` is out of scope, but this change alters it.
- **Fix:** The plan must decide this behaviour; it cannot be left to the implementer. Recommended:
  - Add `packages/api/src/server/flow-control.ts` (Modify). In `futuresReason`, return `"market_closed"` when `rows.sessionDate !== newYorkClock(now).day` (the shown session is not today's).
  - Add a case to `server/flow-control.test.ts`: on 2026-11-26 at 12:00 New York, futures reason `market_closed` and `session.date` equal to `2026-11-25`.
  - Alternatively, explicitly accept and document the prior-session futures state in lines 137 and 139, and pin it with a test.

---

### 🟡 Major

#### M1: Day-number derivation is off by one month if read literally

- **Plan line:** 123, "`utcDay` of the `year`, `month` and `day` parts of `newYorkParts`".
- **Evidence:**
  - `newYorkParts` returns `month` as the 1-based string `"01"`..`"12"` (`server/gex-context.ts:297-309`).
  - `utcDay` takes a 0-based month (`nyse-calendar.ts`: "month is 0-indexed").
  - The existing code subtracts 1 in both places that do this conversion: `flowSessionDate` (`flow-snapshot.ts:133-137`) and `nyParts` (`openbb-overdue.ts:87`).
  - A literal reading maps 2026-11-26 to 2026-12-26, a Saturday. The Thanksgiving test would pass by accident; the 2026-11-27 cases would fail.
- **Fix:** Spell out `const day = utcDay(Number(parts["year"]), Number(parts["month"]) - 1, Number(parts["day"]));`.
  - State the new imports in `flow-snapshot.ts`: `isNyseTradingDay`, `nyseCloseMinute`, `utcDay` from `"../nyse-calendar.ts"`.
  - Rename the existing local `day` (the weekday string still used by the unchanged Globex rules at `flow-snapshot.ts:49,77-80`), for example to `weekday`.

#### M2: A missed reader with hard-coded close text: `closedDetail` says "Last session ended 16:15 ET"

- **Plan lines:** 113 (file list) and 120-126.
- **Evidence:**
  - `packages/api/src/flow-control-rules.ts:441` builds `Last session ended 16:15 ET on ${facts.sessionDate}`. It is shown whenever the reason is `market_closed` (`flow-control.ts:200`, through `flowSessionOpen("options")`).
  - After the change, `market_closed` appears from 13:15 on an early-close day. At 14:00 on 2026-11-27, `/flow` would say the session "ended 16:15 ET on 2026-11-27", a time still in the future.
  - On 2026-12-25 it would say "ended 16:15 ET on 2026-12-24", but that session closed at 13:15.
  - The text is pinned in `flow-control-rules.test.ts:351-367` and `server/flow-control.test.ts:410`.
  - The "Out of scope" list (line 82) excludes only `flowOptionDelayLabel`.
- **Fix:** Either add `flow-control-rules.ts` (Modify) and its test file, or add the text to Out of scope with a reason.
  - For the Modify option: format the close as `nyseCloseMinute(utcDay of facts.sessionDate, 16 * 60 + 15)`, which gives "13:15 ET" on an early close. Add a test for an early-close session date.

#### M3: Open-ended fixture fixing breaks the file boundary (zero-decision rule)

- **Plan lines:** 113 and 135 ("fix any fixture that sits on a holiday or an early-close date by moving it to a normal trading day"), with risk row line 94.
- **Problem:** This allows edits to unnamed test files, and the implementer would decide which fixtures and dates to change.
- **Evidence:** I scanned every flow, overdue, OpenBB, smart-money, `strategy-dsl-compile` and price-freshness test under `packages/api/src` for the 2024-2028 holidays and early closes. No affected fixture was found.
  - Hits in `openbb-overdue.test.ts`, `price-freshness.test.ts` and `flow-market-premium-collect.test.ts` are holiday-closed or pre-open cases (for example `openbb-overdue.test.ts:546`, 08:00 ET on 2026-11-27; `flow-market-premium-collect.test.ts:405`, 00:05). Their results do not change.
  - In `flow-option-bubbles.contract.test.ts:20-23`, 2026-11-27 is an option expiry string.
  - Flow collector, control and snapshot tests use 2026-11-05…11-23 trading days.
  - No `vi.mock` of `gex-context`, `nyse-calendar` or `openbb-overdue` was found, and no fake timers or wall-clock `new Date()` in the scanned flow and overdue tests.
- **Fix:** Replace the clause with "No existing fixture sits on a holiday or early close at an affected time (checked at `6db354c9`). A failure outside the listed files stops the work." Also list the plan-folder files explicitly (`plan.md`, `before-after.svg`: Create).

#### M4: The goal's `/flow` claims have no prescribed test

- **Plan lines:** 131-135 (tests), against Goal line 33 and CHANGELOG line 139.
- **Problem:** The plan claims `/flow` shows these sources as `closed` with the last trading session on a holiday. No test covers that reader behaviour:
  - `buildFreshness` (`flow-snapshot.ts:216`);
  - `tickerReason` `market_closed` (`flow-control.ts:200`);
  - the `sessionDate` choice (`flow.ts:743-749`);
  - the `flow.optionPrints` window (`flow-option-prints.ts:102`).
- **Fix:** Add named cases:
  - `flow-snapshot.test.ts` `describe("buildFreshness")`: on 2026-11-26 at 12:00, the `options`, `gex`, `ticks` and `depth` states are `closed` (SPY).
  - `server/flow-control.test.ts`: at the same time, the options reason is `market_closed`, plus the futures expectation from B1.
  - Optionally, a `flow.test.ts` case for `sessionDate` = 2026-11-25.

#### M5: No phases or checkpoints

- **Plan lines:** 111-140.
- **Problem:** The standard requires incremental phases, each buildable and testable. Steps 1-6 run with one verification at step 7, and the commit structure is unstated.
- **Fix:** Group the work into phases, each with "run the listed test files":
  - Phase A: steps 1, 2 and the `nyse-calendar.test.ts` file.
  - Phase B: step 3, its `flow-snapshot` tests, and B1/M2 if adopted.
  - Phase C: step 4 and the `openbb-overdue` tests.
  - Phase D: text (step 6).
  - State one commit per phase, or one commit in total.

---

### 🟢 Nits

- **N1 (line 119):** After the replacement, the locals `date`, `month` and `dayOfMonth` in `nyseSession` (`strategy-dsl-compile.ts:1825-1827`) are unused. Biome `ultracite/biome/core` (`biome.jsonc:3`) flags unused variables. State that they are deleted.
  - `nthWeekday` has no other use (only `:17` and `:1831`), so say "drop" without "if".
  - The re-export block at `:1769-1773` is unaffected.
- **N2 (lines 117, 126):** State the derivation in `isNyseEarlyClose`: `const date = new Date(day * DAY_MS)`, with month and date from `getUTCMonth()` and `getUTCDate()`. Also state that `marketSession` *is* removed from the `flow-snapshot.ts` import (its only use is `:76`; `newYorkParts` stays).
- **N3 (line 128):** It is ambiguous whether the new doc comment replaces the whole three-sentence comment at `openbb-overdue.ts:162-166` or only the window phrase. Say which. `MARKET_PREMIUM_CLEAR_MINUTE` is used only at `:23` and `:354-355`, so the replacement in line 130 is complete.
- **N4 (lines 137-138):** Prescribed text edits need clearer placement.
  - The quoted `flow-pipeline.md` sentence is wrapped across lines 952-955. Quote it as it appears, or say "the sentence starting 'Holidays and half days'".
  - In "Live capture" (`flow-pipeline.md:830`), say where "(13:15 on an early close)" goes, for example after "09:30-16:15 New York".
  - Inserting after "09:30-16:15 New York" in `smart-money.ts:62` and `flow-market-premium-collect.ts:3,253` produces nested parentheses ("(09:30-16:15 New York (13:15 on an early close) on an NYSE trading day)"). Give the final sentences.
  - Other copies of the window text are not addressed: `contracts/smart-money.ts:82` ("while options trade (09:30-16:15 New York)"), `mcp.ts:740`, and `flow-pipeline.md:1013` ("session 9:30-16:20"). Update them or list them in Out of scope.
- **N5 (line 122, Background line 18, doc and CHANGELOG text):** QQQ is also `session: "stock"` with a `depth` source (`flow-features.ts:106-109`). QQQ depth therefore also stops on holidays and at 17:00 on early closes.
  - The parenthetical "(SPY)", the "SPY tape" wording in lines 137 and 139, and the tests name only SPY.
  - Say "SPY ticks and depth, QQQ depth" and add one QQQ `depth` assertion.
- **N6 (line 132):** No new test proves the 3 July *true* branch of `isNyseEarlyClose`. 2026-07-03 is a holiday, and 2027-07-03 is a Saturday. Add 2028-07-03 (early close per `infra/quantvps/nyse-calendar.txt:71`) or 2025-07-03 (`:30`). It is currently covered only indirectly through the `nyseSession` tests.
- **N7 (Goal line 33, Load line 96, CHANGELOG line 139):** "No option print … read runs" overstates the effect. With `open` false, `collectOptions` still drains stored option gaps with QuantData requests (`flow-collect.ts:1652-1694`), the same as on a weekend. Reword to "no live option window read".
- **N8 (line 141):** `fm market` (exit 0 means the market is safe) and "the four CI verification lanes" are not defined anywhere in the repository. `fm` exists only on the rig (`infra/quantvps/README.md:80`), and no file contains "four … lanes". Cite where these are defined, or name the lanes.

---

### Verified as stated (no finding)

- **Files and functions:** `nyse-calendar.ts` exports `isNyseTradingDay`, `nthWeekday`, `utcDay` and `DAY_MS`, and has no test file yet. `nyseSession` and its inline early-close expression are at `strategy-dsl-compile.ts:1821-1835`. `flowSessionOpen` is at `flow-snapshot.ts:43-81`. `isMarketPremiumSessionOpen`, `isFlowSourceSessionOpen`, `isCapturedNearClose` and `isOffHoursMarketPremiumClearable` are in `openbb-overdue.ts` with `parts.utcDayNum`.
- **Window numbers:** match the code, including NVDA at 16:00 via `FLOW_OPTION_STREAMS[symbol].closeMinuteEt` and stock at 04:00-20:00 via `marketSession`. The `market_premium` `maxAgeSeconds` is 1800, so the 12:45 cutoff is correct.
- **Callers of `flowSessionOpen`:**
  - `flow-collect.ts:765` (Globex ES/NQ only, `TapeSymbol`; unaffected), `:2016`, `:2037`;
  - `flow-control.ts:200`, `:235`, `:529`, `:963-964`;
  - `flow.ts:743`; `flow-option-prints.ts:102`; `flow-snapshot.ts:216`.
  - Callers of `isMarketPremiumSessionOpen`: `flow-market-premium-collect.ts:255` and `smart-money.ts:65`.
  - Apart from B1 and M2 (`flow-control-rules.ts:441`), no other dependent reader was found.
- **Test targets:** `describe("flowSessionOpen")` exists (`flow-snapshot.test.ts:170`). `describe("isMarketPremiumSessionOpen")` and `describe("evaluateOpenbbSources")` exist (`openbb-overdue.test.ts:76`, `:187`). `nyseSession` tests exist (`strategy-dsl-compile.test.ts:3850`).
- **Calendar dates:** the acceptance-criteria dates (2026-11-27, 2026-12-24, 2027-11-26 early; 2026-07-03 and 2026-11-26 closed) match `infra/quantvps/nyse-calendar.txt`.
- **Coverage baseline:** none of the changed source files is in `scripts/ci/coverage-baseline.json`.
- **Other references:** `CHANGELOG.md` has `## [Unreleased]` → `### Fixed` (line 102). `verify:prepush` exists (`package.json:60`). The "Deploy a new web build" section and `restart-when-idle.sh --deploy <sha>` exist in `infra/quantvps/README.md:78-84`.

## Reviewer: egm-style

### Style Goldfish review (Stage 9, Implementation Readiness), plan.md lines 111–142

The DetailedRange is mostly dry and direct. It has no marketing language and almost no filler. The problems below are about precision and calibration: instructions an implementer could read two ways, hedges that the code already settles, and three statements the repository does not back up.

### Findings

#### S-01 🟡 Major: the `day` and month wording in step 3 is ambiguous and would produce the wrong date

- **Line:** 123
- **Problem:** "`day` is the UTC day number of the New York date (`utcDay` of the `year`, `month` and `day` parts of `newYorkParts`)" has three problems:
  1. In `flowSessionOpen` the name `day` already holds the weekday string, and the Globex branch reads it (`packages/api/src/server/flow-snapshot.ts:50`, used at lines 77–80).
  2. `newYorkParts` returns strings with a 1-based month (`packages/api/src/server/gex-context.ts:306-316`). `utcDay` takes a 0-based month: the existing call is `utcDay(year, month - 1, day)` (`packages/api/src/openbb-overdue.ts:87`), and `nthWeekday(year, 10, …)` means November (`nyse-calendar.ts`).
  3. Read literally, the sentence gives a date one month off, computed from strings.
- **Fix (CALIBRATE):** "Let `tradingDay = utcDay(Number(parts.year), Number(parts.month) - 1, Number(parts.day))`. Keep `day` (the weekday) for the Globex branch. Return `isNyseTradingDay(tradingDay) && minutes >= open && minutes < nyseCloseMinute(tradingDay, close)`."

#### S-02 🟡 Major: `year` in `isNyseEarlyClose` has no source

- **Line:** 117
- **Problem:** The signature takes only `day: number`, but the body uses `nthWeekday(year, 10, 4, 4) + 1`. The text calls this "the expression now in `nyseSession`", but that expression uses `date.getUTCFullYear()`, not `year` (`packages/api/src/strategy-dsl-compile.ts:1831`). The word "now" is also unclear: does it mean the current code or the code after the change?
- **Fix (CALIBRATE):** "…or `day === nthWeekday(year, 10, 4, 4) + 1`, where `year = new Date(day * 86_400_000).getUTCFullYear()` (the day after the fourth Thursday of November; month index 10). This is the expression that `nyseSession` currently computes inline."

#### S-03 🟡 Major: the inserted wording creates nested parentheses, and the "Live capture" edit has no anchor

- **Lines:** 137 (last sentence), 138
- **Problem:** Line 138 says to add "(13:15 on an early close)" after "09:30-16:15 New York". In all three target comments that phrase already sits inside parentheses (`smart-money.ts:62`, `flow-market-premium-collect.ts:3` and `:253`). The result would be "(09:30-16:15 New York (13:15 on an early close) on an NYSE trading day)". Line 137 gives no insertion point at all for the "Live capture" item (`flow-pipeline.md:830`, which has the same parenthetical).
- **Fix:** Give the exact replacement text in all four places: "09:30-16:15 New York (09:30-13:15 on an early close) on an NYSE trading day". Equivalently: replace "09:30-16:15 New York" with "09:30-16:15 New York, 09:30-13:15 on an early close,".

#### S-04 🟡 Major: the new `flow-pipeline.md` text drops the weekday-holiday futures behaviour without evidence that it changed

- **Line:** 137
- **Problem:**
  - The text being replaced (`flow-pipeline.md:952-955`) says what the futures side does on a weekday holiday: it "computes a state from 09:30… (agreement `not_comparable`)".
  - The replacement covers only the options side and the futures early close.
  - Futures sessions are out of scope (plan lines 80–81: they "keep Globex hours"), so the futures-side holiday behaviour probably continues.
  - The new text therefore omits current behaviour, and its claim "the page shows the last trading session" goes beyond what the plan shows for the futures line.
- **Fix (CALIBRATE):** Keep one clause about the holiday futures side. For example: "CME holidays and early closes are not modelled: on a weekday NYSE holiday the futures line still follows Globex hours, and after an early close it reads stale until 16:00." If the agreement state changes, state the new value.

#### S-05 🟡 Major: the "`fm market` exits 0" gate has no source in the repository

- **Line:** 141
- **Problem:**
  - `fm market` appears nowhere in the repository except this line. `infra/quantvps/README.md:78-88` and `AGENTS.md` do not mention it.
  - The documented guard is already in the script: `restart-when-idle.sh` exits 14 during US market hours, including early closes (`infra/quantvps/README.md:45`, `:84`).
  - The implementer cannot check what this gate means.
- **Fix (CALIBRATE or DROP):** Cite where `fm market` is defined and what exit 0 means. Otherwise replace it with "outside US market hours (the script refuses with exit 14 otherwise)".

#### S-06 🟢 Nit: step 8 leaves out the claim release and has an awkward final sentence

- **Line:** 141
- **Problem:**
  - The README's step 2 says "Release the claim after step 8" (`infra/quantvps/README.md:81`). The plan takes the claim but never releases it.
  - "A failed health check rolls back in the script" is awkward.
  - "the four CI verification lanes" does not name them. `AGENTS.md:187` calls them checks and names them: core, coverage, integration, browser.
- **Fix:**
  - Add "Release the claim after README step 8."
  - Change the last sentence to: "If the health check fails, the script rolls back."
  - Change the lanes phrase to: "after a full CI run on that exact commit passed all four verification checks (core, coverage, integration, browser)".

#### S-07 🟢 Nit: "if no other use remains" hedges where the code already gives the answer

- **Lines:** 119, 126
- **Evidence:**
  - `nthWeekday` occurs only at the import and the replaced line (`strategy-dsl-compile.ts:17`, `:1831`).
  - `marketSession` occurs only at the import and line 76 (`flow-snapshot.ts:40`, `:76`).
  - Line 122 replaces the line-76 stock branch, so both imports become unused.
- **Fix (CALIBRATE):** "Drop `nthWeekday` from the import." "Remove `marketSession` from the import."

#### S-08 🟢 Nit: bare minute numbers in step 3

- **Line:** 122
- **Problem:** The windows `[570, 980)`, `[570, 975)` and `[240, 1200)` appear without clock times, while the rest of the plan (table at lines 50–57) uses clock times. The reader has to convert them, and the "local function" has no name.
- **Fix:** Name the function, for example `nyseWindowOf`. Write the windows as `net_drift` 09:30–16:20 `[570, 980)` and so on.

#### S-09 🟢 Nit: the doc-comment text for `NYSE_EARLY_CLOSE_SHIFT_MINUTES` is too broad

- **Line:** 116
- **Problem:** The proposed doc comment ends "moves every close of that day". It gives no direction, and "every close" includes the futures closes, which do not move (plan lines 57, 80).
- **Fix:** "Minutes by which an NYSE early close (13:00 instead of 16:00 New York) moves each NYSE-calendar window close of that day earlier."

#### S-10 🟢 Nit: step 4's final bullet packs three edits into one sentence and leaves the cutoff conversion implicit

- **Line:** 130
- **Problem:**
  - The bullet combines the constant swap, `isCapturedNearClose` and `isOffHoursMarketPremiumClearable`.
  - The current cutoff is split into hour and minute for `nyWallTimeUtcMs` (`openbb-overdue.ts:352-356`). The plan does not say that the new cutoff minute keeps this split.
- **Fix:** Use three sub-bullets. For `isCapturedNearClose`, add: "pass `Math.floor(cutoff / 60)` and `cutoff % 60` to `nyWallTimeUtcMs` as today."

#### S-11 🟢 Nit: wording in the test steps

- **Lines:** 134, 135
- **Problem:**
  - Line 134: "the early-close cases" does not point to the specific acceptance bullets.
  - Line 135: "a normal trading day" is not defined.
- **Fix:**
  - Line 134: "the cases of acceptance bullets 4 and 5 (lines 104–105)".
  - Line 135: "a regular NYSE trading day (not a holiday, not an early close)".

#### S-12 🟢 Nit: wording in the CHANGELOG entry

- **Line:** 139
- **Problem:**
  - "got option reads until 16:14" is informal. It also blurs the evidence, which is the time of the newest `ok` read (plan line 35).
  - "on an early-close day these windows" refers back to "option prints, GEX, net drift and the SPY tape", which are sources, not windows.
- **Fix:**
  - "Before, on Thanksgiving 2026-11-26 the newest `ok` option read was at 16:14 and the newest GEX read at 16:02 New York."
  - "…and on an early-close day their windows, the market premium live capture and the overdue alert windows end 180 minutes early."

#### S-13 🟢 Nit: shorthand in the files sentence

- **Line:** 113
- **Problem:** "Files (all Modify, except the new test file and this plan folder)" uses the capitalized label "Modify" and leaves out the test file's name. The plan folder is not in the list at all, so excluding it explains nothing.
- **Fix:** "All files below already exist and are modified, except the new `packages/api/src/nyse-calendar.test.ts`."

#### S-14 🟢 Nit: the role of `/smart-money` in step 9 is unclear

- **Line:** 142
- **Problem:** "`openbb.status` (read by `/smart-money` with the agent viewer session)" can mean the page reads it or the operator reads it through the page.
- **Fix:** "`openbb.status`, viewed on `/smart-money` while signed in as the agent viewer, lists no overdue flow source."

### Checked and kept (no finding)

- The text quoted for replacement at line 137 matches `flow-pipeline.md:952-955` and `:1018` once line wraps are ignored.
- The `### Fixed` section under `## [Unreleased]` exists (`CHANGELOG.md:102`).
- `describe("flowSessionOpen")` exists (`flow-snapshot.test.ts:170`), and `nyse-calendar.test.ts` does not exist yet, so "New" is correct.
- `MARKET_PREMIUM_CLEAR_MINUTE`, `isCapturedNearClose` and `isOffHoursMarketPremiumClearable` exist as named (`openbb-overdue.ts:23`, `:347`, `:472`).
- `restart-when-idle.sh --deploy <sha>` and `fm claim <card> deploy:quantvps-web` match `infra/quantvps/README.md:24` and `:81`.
