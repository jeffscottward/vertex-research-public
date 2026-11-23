# Stage 8: Intermediate Zoom Out report

Reviewer: egm-zoom-out (fresh-context Goldfish) on the revised design.md, after the Stage 5-9 resolutions.

## Stage 8 Zoom Out review: Strike bar profiles (`design.md`, 476 lines)

### Summary

The revision fixes almost every Stage 5 finding, and the fixes are simple:

- One ladder for all four profiles. The max-pain strike is always on it, and prints at strikes that are not shown are reported in `offLadderTrades` (Stage 5 #1 and Catalyst #3).
- The Alternatives section now considers extending the GEX table (P3) and moving the payout onto the GEX rows (P4), and rejects both (#2, #5).
- `strikeProfiles` is a separate top-level field, so `ExposureStrikeSchema` and `gex-context.ts` do not change (#5, Catalyst #6).
- Premium is stored per side (`bullishPremium` / `bearishPremium`), so "net premium" keeps one meaning in the flow section (#4).
- `isCountedPrint` is shared with `options-chain-quantdata.ts` (#6).
- The toggle says "Flow volume" (#7).
- The Max pain bars draw the payout above the smallest payout (Catalyst #4).
- The prefix-sum rewrite of `maxPain` was correctly not adopted, which is the right YAGNI call.
- `buildOptionsAnalytics` stays free of database reads, which is the right call because the collector also uses it.

The largest addition since Stage 5 is the stored-prints path. The card asks for it ("stored flow_option_prints"), so it is justified. But it rests on a wrong fact about which tickers the collector stores. It also writes its own overlap and freshness logic, although a sibling feature already has helpers for both. The fallback for a missing OI response brings back the generic selection refactor and the double meaning of "largest" that the design itself rejected in P2.

There is one blocker (wrong ticker set), three majors and five nits.

### Findings

#### 1. 🔴 Blocker: Only SPY and SPX have stored prints, not QQQ and NDX (lines 65–67, 98–100, 145–147, 410–414; `data-flow.svg` node "SPY · SPX · QQQ · NDX")

**Problem:**

- In `FLOW_INSTRUMENTS` (`packages/api/src/flow-features.ts`), only ES and SPY have `"options"` in `sources`. NQ is `["ticks","depth","gex","net_drift"]` and QQQ is `["depth","gex","net_drift"]`.
- `flow-collect.ts` collects a source only for instruments whose `sources` contain it (line ~1571; `optionSymbols` at line ~1344 counts only those).
- The repository already states the correct set: `FLOW_HEDGING_SYMBOLS = ["SPY", "ES"]` in `contracts/flow.ts:226`, with the comment "The symbols with stored option prints (FLOW_INSTRUMENTS sources include "options")".
- The four-ticker list in the design appears to come from the CHECK constraint on `flow_option_prints.ticker`. That constraint allows four tickers; it does not mean all four are collected.
- Phase A.7 triggers the stored path when the symbol is "the `optionsTicker` of a `FLOW_INSTRUMENTS` entry". That includes QQQ and NDX. For them the query returns no rows and no gaps, and `applyStoredFlow` replaces real page data with zeros.
- The result is labelled `stored_prints`, `complete: true`, with the caption "All stored prints of the last N h" and then "No values for this profile."
- This is silently wrong data presented as complete. The SPY-only check in Acceptance 5 would not catch it.

**Fix:**

- Base the trigger on the existing source of truth: `FLOW_INSTRUMENTS[x].sources.includes("options")`, or reuse `FLOW_HEDGING_SYMBOLS`. Do not write a new four-ticker list.
- Correct Terms (line 65), Goal 2, CUJ 2, Risk 1, the Read path section, Non-Functional Requirements line 343 and the `data-flow.svg` label to "SPY and SPX".
- Add a handler test: a QQQ snapshot makes no stored query.

#### 2. 🟡 Major: "Complete" ignores collector lag; the stored path can be older than the page it replaces (lines 162–165, 191, 242–243, 407–409)

**Problem:**

- `complete` means only "no recorded gap overlaps the window".
- Prints after the collector's last run are not a recorded gap. If the collector is behind, paused or rate-limited, the stored totals stop early, yet the caption says "All stored prints of the last N h".
- Meanwhile the first page that the snapshot already fetched would be fresher, and it is thrown away.
- The fallback rule covers only errors ("when either throws"), not an empty or stale result.

**Fix:**

- Reuse the sibling's existing freshness signal instead of inventing one. Hedging pressure already reports `options: buildSourceFreshness(rows, "options")` (`flow-snapshot.ts:186`) together with its `storedUntil`.
- Set `complete` from "no gap and the options source is fresh". When the source is stale, state it in the caption, or keep the page data.
- Name this rule in Risk 5. One sentence is enough; no new mechanism is needed.

#### 3. 🟡 Major: Gap overlap rebuilt instead of reusing the hedging-pressure helper (lines 164–165, 209, 407–409)

**Problem:**

- `flow-hedging-pressure.ts:44` already has `unreadOf(gaps, from, to)`. It does exactly the "a recorded gap overlaps the window" check, on the same `optionGaps` rows, and also returns the uncovered range.
- `applyStoredFlow` would write a second overlap test. The sibling viz card also already reads `flow_option_prints` for a window, and its handler pattern (rows in, pure builder) is the precedent for this design.

**Fix:**

- Lift `unreadOf` into a shared module, for example next to `buildSourceFreshness`, and use it in both features.
- Mention hedging pressure as the precedent in the Technical Plan. Optionally show the unread range in the gap caption ("The collector has gaps in this window, HH:MM to HH:MM").

#### 4. 🟡 Major: The no-OI fallback brings back the generic selection refactor and the double meaning of "largest" (lines 152–155, 247–250, 367, 393–396, 400–402, 421, 426)

**Problem:**

- When QuantData sends no OI, the ladder is built from the prints with "largest" meaning premium. This needs `selectDisplayStrikes` with a size function, a second branch in `profileStrikes`, a second caption variant ("by premium") and its own tests.
- These are the same costs that Stage 5 #1 said the single ladder would remove, and the same two meanings of "largest" that Alternative P2 rejects (line 305).
- The case is narrow: without OI, two of the four profiles already show the GEX message. No journey or goal requires flow bars when OI is missing; CUJ 5 covers missing flow, not missing OI.

**Fix (YAGNI):**

- When OI is missing, show the GEX message for all four profiles. Alternatively, use all counted-print strikes in ascending order, capped, with no ranking.
- Drop `selectDisplayStrikes`, the size parameter and the "by premium" caption. `displayStrikes` stays as it is.
- If the fallback is kept, add one line under Goals that justifies it.

#### 5. 🟢 Nit: The scroll-to-spot logic is a second copy (lines 266–268, 446–447)

**Problem:** `options-analytics-panel.tsx` already centres `[data-spot-row]` in its scroll box (`useEffect` near line 338). The new panel adds a second copy for `data-spot-line`.

**Fix:** extract one small shared hook (or helper) for "centre the marked row in this scroll box" and use it in both sections. The Files table changes the panel file anyway.

#### 6. 🟢 Nit: Reversing the GEX table is a behaviour change logged as "Added" (lines 217–218, 379, 448–449, 462–464)

**Problem:** Turning the GEX table upside down fixes Stage 5 #3 and is fine. But it changes an existing view, and the CHANGELOG plan lists only an `### Added` line.

**Fix:** add a `### Changed` line: "GEX table lists strikes from high to low".

#### 7. 🟢 Nit: The fixture copies the payout formula into the web app (lines 450–452, 381–382)

**Problem:** The `/lab` fixture reimplements the Terms formula in web code ("the web cannot import server code") and then also changes the fixture's `maxPain` plus a test of it. This is a second implementation of a server rule, kept only for MOCK data.

**Fix:** hard-code the fixture's `holderPayout` values and its `maxPain` strike as literal MOCK data, consistent by construction. Drop the formula from web code and drop the new fixture test.

#### 8. 🟢 Nit: Some code-level detail remains (lines 203–208, 397–398, 415–417, 439–443)

**Problem:**

- Some code-level choices are still pinned, although Stage 5 #10 asked to leave them to the implementer:
  - the `spotAfter` sentinels (`-1`, `null`);
  - the literal body of `isCountedPrint`;
  - "mapped with `Number` and `Date`".
- The query filters on both `symbol` and `ticker`, but `symbol` already determines `ticker` (ES gives SPX).

**Fix:**

- State the behaviour and the tested cases (spot above, below, between, equal and missing), and leave the encodings to the implementer.
- Filter on `symbol` only, which is the indexed key.

#### 9. 🟢 Nit: `mcp.ts` still has no path (line 198)

**Problem:** This is Stage 5 #11, still open.

**Fix:** write `packages/api/src/server/mcp.ts`.

### What the revision got right (no change needed)

- `strikeProfiles` is a separate top-level field, so the GEX and flow sections do not change.
- `buildOptionsAnalytics` stays pure. The handler alone reads the database, which fits the collector's use and the hedging-pressure pattern.
- The max-pain strike is pinned to the ladder (at most 81 rows), without the speculative prefix-sum rewrite.
- `isCountedPrint` is one predicate shared with the options chain.
- An HTML table with CSS bars (R1) and a vertical strike axis.
- No new QuantData request, no new procedure and no migration. Rollout goes through `restart-when-idle.sh`.
