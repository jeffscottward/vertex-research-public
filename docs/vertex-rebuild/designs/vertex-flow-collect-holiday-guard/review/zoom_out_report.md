# Stage 5: Initial Zoom Out

## Reviewer: egm-zoom-out

The plan passes the zoom-out review. It fixes the real cause: today the early-close rule lives inside `nyseSession` in the strategy DSL compiler, and the plan moves it into the shared calendar module `nyse-calendar.ts`. It keeps the change to one shared function plus calls from the existing checks, rejects the per-source table and the change to `marketSession` for good reasons, and leaves CME futures out of scope. I found no YAGNI violation, premature optimization or architectural dead end. The one Major finding is about scope accuracy; the rest are Nits.

### Findings

#### Z1 · 🟡 Major: the plan names only SPY for the stock session, but QQQ depth changes too

- **TargetFile lines:** 18, 33, 44–45, 62, 64, 96, 102–103, 122, 139 (CHANGELOG text).
- **Problem:** The plan describes the stock-session change as "the SPY tape" or "SPY ticks and depth". Step 3 (line 122) applies the new window to every stock-session symbol, which also includes QQQ. QQQ collects order-book depth and is a stock-session instrument. So on a holiday and after an early close, QQQ depth reads also stop, and `/flow` shows QQQ depth as `closed`. The Background, Goal, the window table, the before/after table, the load line, the acceptance tests and the CHANGELOG entry never mention this. A new reader would wrongly think only SPY's stock-session reads change, and no test pins the QQQ behaviour.
- **Evidence:**
  - `packages/api/src/flow-features.ts:95-108`: QQQ has `session: "stock"` and its sources include `"depth"`.
  - `packages/api/src/server/flow-snapshot.ts:75-76`: the stock branch of `flowSessionOpen` applies to any symbol with `session === "stock"`.
  - `packages/api/src/server/flow-collect.ts:2016`: the collector calls `flowSessionOpen` for every source of every instrument.
  - `docs/vertex-rebuild/flow-pipeline.md:1016`: the docs already say "QQQ: depth and GEX".
- **Fix:**
  - Name the affected set accurately everywhere: "the stock-session sources (SPY ticks and depth, QQQ depth)", or "every `session: "stock"` instrument".
  - Add one acceptance case: `flowSessionOpen("depth", "QQQ", …)` is false on 2026-11-26 at 12:00 New York.
  - Update the CHANGELOG text and the load line to match.

#### Z2 · 🟢 Nit: "One rule, in one place" overstates the result; the regular windows stay copied in two places

- **TargetFile lines:** 37, 73, 122, and Out of scope (78–85).
- **Problem:** Problem 3 (line 30) says the root issue is two copies of the windows that disagree. The fix shares only the calendar shift (`nyseCloseMinute`). The regular windows for options, GEX and net drift stay as hand-written minute values in two places, which is the same kind of duplication that caused the drift.
  - The new local window function in `flowSessionOpen` uses 570, 975 and 980 (line 122).
  - `isFlowSourceSessionOpen` keeps its own `9*60+30`, `16*60+15` and `16*60+20` (`packages/api/src/openbb-overdue.ts:187-190`).
  - The rejected alternative (line 73) explains why the stock windows differ, but not why the option, GEX and net drift windows (which are identical) are still copied.
- **Evidence:**
  - `openbb-overdue.ts:177-191`.
  - `flow-snapshot.ts:53-71`.
  - `openbb-overdue.ts:13-15`: the module has no DB or HTTP dependencies, so it cannot easily import `server/flow-snapshot.ts`.
  - `FLOW_SOURCE_METADATA` (`contracts/flow.ts:51`) is a contract, which this bug fix rules out changing.
- **Fix:** Don't widen the scope, because sharing the windows would need a new neutral home. Instead:
  - Reword line 37 to "one calendar rule, in one place".
  - Add an Out-of-scope or Risks line: "The regular open and close minutes of options, GEX and net drift stay duplicated in `flowSessionOpen` and `isFlowSourceSessionOpen`. A change to one must be mirrored in the other."

#### Z3 · 🟢 Nit: the Background does not list two readers of `isMarketPremiumSessionOpen`

- **TargetFile lines:** 20–23, against the Goal (33) and step 6 (138).
- **Problem:** The Goal shortens the market premium window on early-close days. That changes two readers the Background never names:
  - the live capture in `flow.collect` (`packages/api/src/server/flow-market-premium-collect.ts:255`);
  - the `/smart-money` coverage state (`packages/api/src/server/smart-money.ts:65`), which will show `closed` after 13:15 on an early close.
  The plan clearly knows about them, since step 6 edits their comments, but a new reader only finds this out in the implementation steps.
- **Fix:** Add one sentence to the "Readers of the same check" bullet: "`isMarketPremiumSessionOpen` also gates the market premium live capture and the `coverage` state of `smartMoney.ranking`."

#### Z4 · 🟢 Nit: the remedy for an unlisted one-off early close does not exist

- **TargetFile line:** 91.
- **Problem:** The Risks table says to "add the date to `NYSE_SPECIAL_CLOSURES` (holidays) or the early-close rule". Full-day closures have a list (`nyse-calendar.ts:60`); early closes are only a three-case rule. A one-off early close would mean distorting that rule.
- **Fix:** State the truth and build nothing now: "A one-off early close is not representable; add a special early-close list when one is announced." Do not add that list in this plan.

#### Z5 · 🟢 Nit: say that the other early-close calendars stay separate

- **TargetFile line:** Out of scope (78–85).
- **Evidence:** Two other NYSE early-close copies exist outside `packages/api`:
  - `scripts/breadth-90/calendar.ts:38-46,81-83` (`NYSE_EARLY_CLOSES`, `closeMinutes`);
  - `infra/quantvps/nyse-calendar.txt`, with parity tests in `infra/quantvps/restart-when-idle.test.ts:2698-2735`.
- **Problem:** Because the plan creates a new canonical `nyseCloseMinute`, a reader will ask whether these copies should use it. They sit across dependency boundaries (scripts and a shell guard), so unifying them is rightly not this fix.
- **Fix:** Add one Out-of-scope bullet: "The early-close lists of `scripts/breadth-90/calendar.ts` and `infra/quantvps/nyse-calendar.txt` stay separate (other dependency boundaries)."

#### Z6 · 🟢 Nit: a small speculative export and lint-level steps in the detailed range

- **TargetFile lines:** 116, 119, 126.
- **Problem:**
  - Line 116 exports `NYSE_EARLY_CLOSE_SHIFT_MINUTES` publicly, but only `nyseCloseMinute` uses it.
  - Lines 119 and 126 ("drop `nthWeekday` / `marketSession` from the import if no other use remains") are cleanup that lint and typecheck already enforce, not design.
- **Fix:** Make the constant module-private (or use it only inside `nyseCloseMinute`). Drop the two import-cleanup sub-steps, or merge them into "remove imports left unused".

### Checks that passed

- **Context is sufficient:** the objective, the motivation (the live 2026-11-26 observation) and the "no ranking or number is wrong" impact are clear.
- **Fix is in the right place:** the plan moves the early-close rule out of the DSL compiler into the calendar module. Today `server/gex-context.ts:14` and `server/research-screen-evidence.ts:15` import a calendar fact from `strategy-dsl-compile.ts`, so this move makes the layering cleaner, not more complex.
- **Overdue-clear change is needed, not speculative:** if `isMarketPremiumSessionOpen` ended at 13:15 but the clear cutoff stayed fixed (`MARKET_PREMIUM_CLEAR_MINUTE`, `openbb-overdue.ts:23-25` and `347-358`), a 13:00 capture would never clear the alert on an early-close day.
- **Futures reads are not touched:** the tape-gap ranges use `flowSessionOpen("ticks")` only for `TapeSymbol = "ES" | "NQ"` (`flow-collect.ts:568,765`), so they stay unaffected. The `"options"` calls that pass a future's group symbol (`flow.ts:743`, `flow-control.ts:963`) get the NYSE calendar through `FLOW_OPTION_STREAMS` (ES and NQ entries close at 16:15), which is the intended behaviour.
- **Altitude is right:** the Fix section stays at the level of interfaces and data flow. Code-level detail appears only in the Implementation Plan (lines 111–142).

## Reviewer: egm-inventive-catalyst

The holiday-and-early-close fix is sound. Two false compromises remain:

- **A calendar error has no independent check.** If the calendar is wrong, the collector, the `/flow` pages and the overdue alert go dark together, with no warning.
- **The windows stay duplicated.** The plan shares the close-minute rule, but each source's opening and closing times still exist in three separate copies.

There are also two minor points. I made no edits.

---

### IC-1 🟡 Major: one calendar decides the data, the page and the alarm, so a calendar error goes unreported

- **Lines:** 92 (Risks, row "The calendar marks a trading day as a holiday or an early close … common-mode fault | Accepted"), also 37 and 120–124.
- **Accepted trade-off:** The plan treats two goals as incompatible: one source of truth for the session, and independent detection of a wrong session. It accepts silence when the calendar is wrong. The predecessor plan accepted the same fault for one source and noted that the other sources were still a fallback (`designs/smart-money/plan-holiday-session.md:78`: "at the baseline the collector would still capture"). This plan removes that fallback. Option prints, GEX, net drift, the SPY tape and the market premium now all follow the same calendar. So does the `/flow` "closed" state (`flow-snapshot.ts:216`), and so does the overdue alert (`openbb-overdue.ts:177-189, 565`).
- **Impact:** If a real trading day (or the 13:00–16:15 slot) is wrongly marked closed:
  - no data is collected;
  - `/flow` shows a correct-looking `closed`;
  - `openbb.status` stays quiet.
- **What limits it today:** Tests pin the holidays for 2024–2028 and the early closes for 2026–2027 only. Nothing runs at runtime.
- **Proposed fix (Blessing in Disguise and Self-Service):**
  - When the calendar says a weekday is closed, run one cheap probe read through the existing `flow.collect` path. For example, one SPY GEX or SPY tick read at about 10:00 New York on a weekday holiday, and one at about 14:00 on an early-close day.
  - Fresh, changing data on a "closed" day becomes a `calendar_disagreement` overdue entry in `evaluateOpenbbSources`.
  - Empty data or unchanged totals confirm the calendar and record nothing.
  - This keeps the single rule for normal operation and makes the alarm independent of the rule it checks.
  - Add one acceptance test: a fixture with fresh data on a day the calendar marks closed produces the disagreement entry.
- **Secondary liabilities:**
  - One to two extra QuantData or IBKR requests per holiday or early close.
  - A new probe path to maintain.
  - The probe needs a clear "live data present" test (changed totals, not just a successful HTTP response). Otherwise thin index prints on a holiday (as on 2026-11-26) would raise false alarms.

#### IC-2 🟡 Major: "One rule, in one place" covers the calendar but leaves the source windows in three copies

- **Lines:** 29 (Problem 3 "Two windows disagree"), 37, 73 (alternative rejected because "the two stock windows differ on purpose"), 122, 127–131.
- **Accepted trade-off:** The plan assumes that sharing one definition requires identical windows. Since the stock windows rightly differ (extended hours for the collector, regular session for the alert), it shares only `nyseCloseMinute`. The open and close of each source then stay as hand-typed numbers in three places:
  - the new local function in `flowSessionOpen` (line 122: `[570, 980)`, `[570, 975)`, `[240, 1200)`);
  - `isFlowSourceSessionOpen` (`openbb-overdue.ts:184-188`: `9*60+30`, `16*60+20`, `16*60+15`, `16*60`);
  - `MARKET_PREMIUM_OPEN_MINUTE` and `MARKET_PREMIUM_CLOSE_MINUTE` (`openbb-overdue.ts:21-22`).
  - The option closes come from a fourth source, `FLOW_OPTION_STREAMS[].closeMinuteEt` (`flow-features.ts:186-228`), and only the collector reads it.
- **Why it matters:**
  - Problem 3 is the same bug class: two copies drifted apart (one learned holidays, one did not). The plan fixes this instance but keeps the structure that allows the next drift.
  - The two copies already disagree: the overdue copy closes `options` at 16:15 for every symbol, while the collector uses 16:00 for NVDA. It is harmless today only because the alert watches SPY only (`openbb-overdue.ts:574-582`).
  - The plan also uses two different New York date helpers: `newYorkParts` in `flow-snapshot.ts:40` and `nyParts` in `openbb-overdue.ts`.
- **Proposed fix (Extraction and Segmentation):**
  - Move the windows into one declarative table, for example `NYSE_SESSION_WINDOWS` next to `nyse-calendar.ts` or in `flow-features.ts`.
  - Key it by source. Store open and close minutes, take option closes from `FLOW_OPTION_STREAMS`, and give the stock tape two named variants, `extended` (04:00–20:00) and `regular` (09:30–16:00).
  - Add one evaluator: `nyseWindowOpen(window, day, minutes)`, which applies `isNyseTradingDay` and `nyseCloseMinute`.
  - `flowSessionOpen` uses the `extended` variant; `isFlowSourceSessionOpen` and `isMarketPremiumSessionOpen` use the regular rows.
  - This keeps both stock windows (the reason given on line 73) and removes the copies. If a full refactor is too large for a bug fix, add a minimal parity test instead: assert that, for every non-futures source, the collector window contains the alert window across a set of trading days, holidays and early closes.
- **Secondary liabilities:**
  - A shared module touches files the plan otherwise leaves alone: one more import edge, which needs a cycle check.
  - A table instead of explicit branches makes a single window slightly harder to read.
  - It is a slightly wider diff than a pure bug fix.

#### IC-3 🟢 Nit: an unlisted closure always needs a code change and a deploy

- **Lines:** 91 ("Same as the baseline; add the date to `NYSE_SPECIAL_CLOSURES` … or the early-close rule").
- **Accepted trade-off:** Closures not in the calendar (for example a national day of mourning; the list ends with Carter, per `nyse-calendar.ts:55-60`) can only be fixed by a code edit, CI and deploy. Line 27 notes that the extra reads return "no new data (same totals)". That signal could limit the waste without anyone knowing the date in advance.
- **Proposed fix (Dynamics, or Beforehand Cushioning):** Either:
  - **Dynamics:** when a source returns unchanged totals for N reads in a row inside an expected-open window, slow that source down (for example from 60 s to 15 min) until data changes; or
  - **Beforehand Cushioning:** let operators add closure dates at runtime (a config or env list merged into `isNyseTradingDay`), since these closures are announced days ahead.
- **Secondary liabilities:**
  - Back-off can delay recovery when a quiet but open stream (sparse NVDA prints) resumes, and must not trigger the overdue alert. The alert window would need to know about back-off.
  - A runtime list is a second source for the calendar, so it needs validation and tests to stay mirrored in the Python copy (`signals.NYSE_SPECIAL_CLOSURES`).

#### IC-4 🟢 Nit: the uniform 180-minute shift is the right simplification but is stated as fact rather than as a per-window property

- **Lines:** 37, 48, 75, 94.
- **Assessment:** This is not a false compromise. The early-close times of Cboe, NYSE Arca's extended session and the derived GEX and net drift windows all follow the NYSE early close today, and line 94 records the assumption. Rejecting "a separate early-close table per source" (line 75) is correct while every window shifts the same way.
- **Proposed fix:** If IC-2's table is adopted, give each row an `earlyClose: "shift-with-nyse"` field (the only value today) instead of applying the constant globally. A future venue that closes early on its own (or does not close early) then becomes a new value in the table, not a new code path. Keep `NYSE_EARLY_CLOSE_SHIFT_MINUTES` as the single number.
- **Secondary liabilities:** It adds a field that has only one value for now (speculative generality); add it only together with IC-2.

---

**Balanced trade-offs (no false compromise):**

- Leaving CME/Globex holidays out of scope (line 76) is a real data dependency, not a false compromise.
- Keeping `marketSession` unchanged (line 74) is a sensible way to protect the GEX context pages.
- Rejecting a direct call from `flowSessionOpen` to `isFlowSourceSessionOpen` (line 73) is correct as stated. IC-2 only objects to the conclusion drawn from it, that the windows must therefore stay duplicated.
