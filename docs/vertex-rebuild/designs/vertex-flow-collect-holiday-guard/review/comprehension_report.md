# Stage 6: Comprehension Test

## Reviewer: egm-comprehension (fresh context)

**What this proposes:**

The plan makes the flow collector follow the NYSE calendar. On an NYSE full holiday, the equity and option sources (option prints, GEX, net drift, and SPY ticks/depth) are not read. The `/flow` pages show these sources as `closed` and fall back to the last trading session, as they do on a weekend. On an NYSE early-close day (3 July, 24 December, or the day after Thanksgiving, when that day is a trading day), every equity/option window ends 180 minutes earlier than usual. This includes the market premium window and the overdue-alert windows; each window keeps its own offset from the close. The implementation moves the early-close rule into `nyse-calendar.ts` as `isNyseEarlyClose`, adds `nyseCloseMinute`, and uses both in `flowSessionOpen` and in the session and clear checks of `openbb-overdue.ts`. ES and NQ futures keep CME Globex hours, and CME holidays remain unmodelled.

**How the existing system works, per this document:**

`flow.collect` runs every 60 s on QuantVPS. Before each source's live read it asks `flowSessionOpen`, which checks only the weekday and the New York clock, so it reads all day on weekday holidays and until the regular close on early-close days. The same function decides what `/flow` shows: the fresh/stale/closed state, the `market_closed` reason, the session date, and the option-prints window. Market premium bypasses `flowSessionOpen` and uses `isMarketPremiumSessionOpen`, which is already holiday-aware. The overdue alert (`openbb.status`, `evaluateOpenbbSources`) uses a separate copy of the windows, `isFlowSourceSessionOpen`. That copy is already holiday-aware, but no check anywhere knows about early closes. The early-close formula exists only inside `nyseSession` in `strategy-dsl-compile.ts`.

---

### Findings

**C1 — 🟡 Major — line 93 (Risks: "All six streams"):**

- **Problem:** The risk row says "All six streams are US equity or index options on Cboe." Lines 15, 41 and 42 list seven option symbols: SPX, NDX, RUT, SPY, QQQ, IWM and NVDA. A reader can't tell whether one symbol is not a stream, whether NVDA was left out of the Cboe claim, or whether the count is simply wrong. The safety argument for applying the 180-minute shift to every stream rests on this sentence.
- **Fix:** State the exact count and list the streams. If NVDA is a separate case, say how it closes on early-close days.

**C2 — 🟡 Major — line 62 (Before/After row "Early-close day, 13:00-16:20"), and line 91 ("or after 13:00"):**

- **Problem:** The After column says "no read; sources show `closed`" for the whole 13:00-16:20 span. The window table (lines 41-43) and the acceptance criteria (line 102: SPY options open at 13:14, net drift open at 13:19) say the options, GEX and market-premium sources still read until 13:15, and net drift until 13:20. Line 91 also says "after 13:00". The two tables contradict each other on when reads stop.
- **Fix:** Change the row to "Early-close day, after each window's shifted close (13:00 NVDA options; 13:15 options/GEX/market premium; 13:20 net drift)", or split it into rows. On line 91, say "after the shifted close".

**C3 — 🟡 Major — lines 20, 28, 54, 128-130 (market premium session and its "clear" logic):**

- **Problem 1:** "Market premium" is never defined.
- **Problem 2:** The document doesn't say who calls `isMarketPremiumSessionOpen`. It lives in `openbb-overdue.ts`, yet Problem 2 (line 28) implies the collector also uses it to stop reading. A reader learns this only indirectly from line 138 (`flow-market-premium-collect.ts`).
- **Problem 3:** The clearing behaviour is never explained: line 54 mentions "the two checks that decide when a closed market premium session clears the alert". Line 130 replaces `MARKET_PREMIUM_CLEAR_MINUTE` with `floor(maxAgeSeconds / 60)`, but gives neither the current value of the constant nor the value of `maxAgeSeconds`. So the reader can't check that the regular-day cutoff is unchanged. The 12:45 cutoff on line 104 implies a 30-minute margin, but this is never stated.
- **Problem 4:** `sessionDay` (line 130) is undefined.
- **Fix:**
  - Add a one-line definition of the market premium source.
  - State that the market premium collector gates its live capture on `isMarketPremiumSessionOpen`.
  - Add a sentence explaining the clear rule: an overdue market-premium alert clears once the session is closed and the last capture is within N minutes of the close.
  - Give the current `MARKET_PREMIUM_CLEAR_MINUTE` value and the `maxAgeSeconds` value, and state that the regular-day cutoff stays the same.
  - Define `sessionDay`.

**C4 — 🟡 Major — line 122, together with lines 64 and 74 (rewriting `flowSessionOpen`'s windows):**

- **Problem:** Step 3 replaces the current window logic with hard-coded half-open windows (570/975/980/240/1200, `closeMinuteEt`). The Alternatives table (line 74) is the first place that says the current code calls `marketSession`. The Background never says so, and never says whether today's boundaries are inclusive or exclusive.
- **Why it matters:** Line 64 promises "reads as today (no change)" on a normal trading day. The reader can't verify that the new local function matches the current `marketSession`-based boundaries. No acceptance criterion pins regular-day boundaries such as SPY options true at 16:14 and false at 16:15 on a normal day.
- **Undefined terms:** "stock-session `FlowSymbol`" and `minutes` are also undefined. It is not said what happens when `symbol` has no entry in `FLOW_OPTION_STREAMS`.
- **Fix:**
  - In Background, state the current implementation (it calls `marketSession`) and its exact boundary convention.
  - Add regular-day boundary cases to the acceptance criteria, or state that the existing `flowSessionOpen` tests cover them.
  - Define a stock-session `FlowSymbol` and `minutes`.
  - Specify what happens for an options symbol without a stream entry.

**C5 — 🟡 Major — lines 117 and 119 (`isNyseEarlyClose` derivation):**

- **Problem:** The function takes a numeric `day`, but its body uses `year`, a "3 July" test, a "24 December" test, and `nthWeekday(year, 10, 4, 4) + 1`. The plan doesn't name the helper that derives the year, month and day from a day number. It doesn't explain `nthWeekday`'s argument meanings (zero-based month 10 = November? weekday 4 = Thursday? 4th occurrence?). It doesn't say where `nthWeekday` lives: line 119 says to drop it from `strategy-dsl-compile.ts`'s import, but not from which module, or whether `nyse-calendar.ts` already has it.
- **Fix:** Name the day-number-to-date helper that is used. Annotate the `nthWeekday` arguments ("4th Thursday of November, month index 10"). State that `nthWeekday` is defined in, or imported into, `nyse-calendar.ts`.

**C6 — 🟡 Major — lines 80, 21 and 137 (`flow.control` on a holiday after the fix):**

- **Problem:** The old `flow-pipeline.md` text being replaced (line 137) describes a holiday mismatch: the futures side computes a state from 09:30 while the options side has no data, giving agreement `not_comparable`. The new text drops this sentence without saying what happens instead. After the fix, ES/NQ stay open on a holiday (line 102), while the options side shows the last trading session (line 21: the session date becomes the newest net-drift date). The reader can't tell:
  - whether `flow.control` now compares today's futures against the previous session's options;
  - whether it still reports `not_comparable`;
  - whether either outcome is intended.
- **Fix:** State the expected `flow.control` agreement state on an NYSE holiday after the fix, and keep or rewrite that sentence in the new `flow-pipeline.md` text.

**C7 — 🟡 Major — lines 141-142 (deploy and live check prerequisites):**

- **Problem:** The deploy step relies on project tooling and concepts that the plan doesn't define or link:
  - `fm claim … deploy:quantvps-web` and "`fm market` exits 0": what `fm` is, and what a 0 exit means (market closed? safe window?);
  - "the four CI verification lanes", and "lane" on line 107;
  - "the agent viewer session".
- `infra/quantvps/README.md` is referenced only for `restart-when-idle.sh`.
- **Fix:** Add one clause for each item, for example:
  - "`fm` is the job/market tool; `fm market` exits 0 when …";
  - name the four lanes;
  - say what an agent viewer session is and how to obtain one;
  - or link the relevant README section for each.

**C8 — 🟢 Nit — line 28 ("expects fresh … samples … has not fired only because the collector also keeps reading"):**

- **Problem:** The same paragraph says the early-close reads "return no new data". The reader has to infer that a successful but empty read still counts as a "fresh sample" for the overdue alert.
- **Fix:** Add "(a successful read counts as fresh even when it returns no new rows)".

**C9 — 🟢 Nit — line 27 ("reads … all day"):**

- **Problem:** The evidence given (newest options read 16:14, GEX 16:02) shows reads within each source's window, not "all day".
- **Fix:** Say "for each source's full regular window".

**C10 — 🟢 Nit — lines 16, 17, 18, 27 and 44 (project terms):**

- **Problem:** Several terms are used without a definition:
  - "net drift" (project-specific);
  - "SPY tape": inferable as SPY ticks plus depth, but never stated;
  - which provider serves ticks and depth (IBKR, which is implied only by "QuantData and IBKR requests");
  - which provider serves GEX;
  - why the overdue module is named "openbb".
- **Fix:** Add a short parenthetical to each source line, for example "SPY ticks and depth (the 'SPY tape', from IBKR)" and "net drift (…)".

**C11 — 🟢 Nit — line 91 (`NYSE_SPECIAL_CLOSURES`, "or the early-close rule"):**

- **Problem:** First mention of `NYSE_SPECIAL_CLOSURES`, with no description. "Add the date … to the early-close rule" is also unclear: the rule is a formula, and there is no table for ad-hoc early closes.
- **Fix:** Describe `NYSE_SPECIAL_CLOSURES` (an ad-hoc closure list in `nyse-calendar.ts`). State that an unscheduled early close needs a code change to `isNyseEarlyClose`.

**C12 — 🟢 Nit — lines 84 and 107 ("seed run", `coverage-baseline.json`):**

- **Problem:** "Seed run" of `flow.collect` is not defined. The role of `scripts/ci/coverage-baseline.json` (a list of files exempt from 100%?) is assumed knowledge.
- **Fix:** Add a short definition of each.

**C13 — 🟢 Nit — line 123 versus line 128 (two day-number conventions):**

- **Problem:** `flowSessionOpen` computes `day` with `utcDay(newYorkParts …)`, while `openbb-overdue.ts` uses `parts.utcDayNum`. The reader can't tell whether these are the same unit as the one `isNyseTradingDay` expects.
- **Fix:** State that both produce the same UTC-day-number of the New York date that `isNyseTradingDay` and `nyseCloseMinute` expect.
