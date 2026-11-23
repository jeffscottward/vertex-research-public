# Stage 5: Initial Zoom Out report

Reviewers: egm-zoom-out, egm-inventive-catalyst (fresh-context Goldfish subagents, 2026-11-22). Target: design.md draft of 2026-11-22 (313 lines).

## egm-zoom-out

## Zoom-Out review: Strike bar profiles in the options analytics panel

**Target:** `docs/vertex-rebuild/designs/vertex-viz-strike-profiles/design.md` (lines 1–313), checked against `zoom-out-standard.md`.

**Read for context:** `before-after-mock.svg`, `data-flow.svg`, and the code at baseline `c7c4f6cd`: `options-analytics-engine.ts`, `options-analytics.ts`, `options-chain-quantdata.ts`, `mcp.ts`, the `options-analytics-panel.tsx` component and the hedging-pressure sibling. Other files in the worktree are already being modified to match the design, so all code claims below refer to the baseline.

### Summary

The objective is clear and the core direction is sound. The four profiles reuse the existing `optionsAnalytics.snapshot` with no new QuantData request, no new procedure and no new table. Strike grouping is done on the server, which is correctly argued. The scope is research-only and fits the project's research-view philosophy.

The problems are at the architectural fit and consistency level:

- The "one strike ladder" is really two different row sets.
- The design adds a second strike table to a panel that already has one, without considering extending the existing one.
- The two strike tables run in opposite orders, and the mock misrepresents the current one.
- `netPremium` would mean two different things inside the same `FlowSection`.
- A payout field meant only for the max-pain profile is put on the shared strike row type, and that type change ripples into `gex-context.ts`.
- The detailed plan drops into literal code.

No blockers.

### Findings

#### 1. 🟡 Major: "One strike ladder" is actually two different row sets, so profiles reshuffle rows when toggled (lines 31–32, 46–47, 125–131, 198–199, 282–283)

**Problem:**

- The Overview promises "four horizontal bar profiles on one strike ladder".
- Open interest and Max pain rows come from the exposure display set: nearest 55 plus the 25 largest by OI.
- Volume and Net premium rows come from a separate `flowStrikes` set: nearest 55 plus the 25 largest by premium.
- Toggling therefore changes which strikes are listed, and the spot line moves to a different row index.
- Risk 4 ("the rule is the same one the GEX table uses, so both views agree") is false for the two flow profiles.
- This second selection is also the only reason the design needs the generic `displayStrikes(rows, spot, size)` refactor (line 257, Phase A.2).

**Fix:** use the exposure display strikes as the single ladder for all four profiles.

- Aggregate the flow prints onto those strikes.
- Report prints at strikes outside the ladder as one line, for example "N prints at strikes not shown".
- This removes the generic `size` refactor and the second capping rule, and makes Risk 4 true.
- If a separate flow row set is truly wanted, drop the "one ladder" wording and correct Risk 4 instead.

#### 2. 🟡 Major: No alternative considers extending the existing GEX table, which already is a strike ladder with bars (lines 26–31, 145–156, 203–230)

**Problem:**

- The "Gamma exposure and open interest" section already renders:
  - a table of the same 80 display strikes,
  - Call OI and Put OI columns (the O7 data),
  - a per-row bar,
  - spot-row centring through `data-spot-row` in a `max-h-96` scroll box.
- The design builds a second strike ladder directly below it, duplicating rows, spot centring and the OI numbers.
- Alternatives P1–P4 and V1 never consider the minimal option. For O7 and O16 that would be: add put-left/call-right bars and a payout column (or a toggle) to the existing table.

**Fix:** add an alternative for "extend the GEX table" and state why it is rejected. Possible reasons: width at 375 px, or the flow profiles needing their own rows. If it is not rejected, adopt it for OI and Max pain, and use a much smaller per-strike flow ladder in the Flow section.

#### 3. 🟡 Major: The two adjacent strike tables run in opposite orders, and the mock misrepresents the current one (lines 22–24, 44–47, figure `before-after-mock.svg`)

**Problem:**

- `displayStrikes` sorts strikes ascending (`a.strike - b.strike`), so the current GEX table shows the lowest strike at the top.
- The new ladder puts the highest strike at the top, "as on a price chart".
- The two tables, one after the other in the same panel, would read in opposite directions.
- Journey 4 asks the reader to compare the two directly.
- The Figure 1 "BEFORE" panel shows the GEX table descending (530 at the top) and labelled "numbers only". It actually runs ascending and already has a GEX bar column.

**Fix:**

- Pick one orientation for both tables. Either flip the GEX table in the same change and say so, or keep ascending order for the new ladder.
- Redraw the BEFORE panel of the mock to match the real table: ascending order, GEX bar column present.

#### 4. 🟡 Major: `netPremium` gets a second, conflicting meaning inside the same `FlowSection` (lines 36, 98–99, 129–130, 138)

**Problem:**

- `FlowSectionSchema.buckets[].netPremium` already means call premium − put premium (`summarizeFlow`).
- The Flow section UI already shows "Net (call − put)".
- The design adds `FlowSection.strikes[].netPremium` meaning bullish − bearish (QuantData sentiment), and a "Net premium" toggle.
- The same panel and the same schema would then carry two different "net premium" numbers. This is a naming trap for the web panel, the MCP readers and later agents.

**Fix:** name the new field and its label by what they measure:

- field `sentimentNetPremium` (or `bullishMinusBearish`),
- toggle "Net premium (sentiment)" or "Bull − bear premium".

Alternatively, state explicitly why the sentiment definition was chosen over the existing call − put one; O9 in the gap report says bullish − bearish.

#### 5. 🟡 Major: `holderPayout` is put on the shared strike row type, forcing an `Omit` workaround and a change to `gex-context.ts` (lines 119–124, 136, 140–143, 259, 275–278)

**Problem:**

- `ExposureStrikeSchema` is the row type used in `options-analytics-engine.ts` (`ExposureEstimate.strikes`) and in `gex-context.ts` (`StrikeOi`).
- Adding a max-pain-only derived field to it forces a new type, `StrikeGex = Omit<…, "holderPayout">`, and an edit to `gex-context.ts`.
- This contradicts the claim at lines 140–143 that the change only adds fields with one reader.
- Separately, Journey 4 ("its strike equals the max-pain number") only holds "whenever the max-pain strike is a display strike". The design does not say what the Max pain profile shows otherwise.

**Fix:**

- Carry the payout curve as its own list on the exposure section, for example `payoutCurve: { strike, holderPayout }[]`. Compute it over the display strikes plus the `maxPain` strike, so the marker always appears.
- This leaves `ExposureStrikeSchema`, `StrikeGex` and `gex-context.ts` untouched.

#### 6. 🟢 Nit: `flowStrikes` duplicates an existing per-print tally, with different filtering (lines 125–131, 279–283)

**Problem:**

- `options-chain-quantdata.ts` `flowByContract` already tallies volume, premium and trades from the same cached order-flow answer. It feeds the options chain "Vol" column, which is the column the gap report cites for O8.
- It skips expired expiries, negative premium and strike ≤ 0.
- `flowStrikes` skips only strike ≤ 0.
- The same prints could therefore give different volumes in the chain and in the profile.

**Fix:** reference `flowByContract` as the precedent and apply the same print filter, ideally through one shared print-acceptance predicate. State that the chain uses a fixed 24 h window while the profile follows the panel window.

#### 7. 🟢 Nit: The "Volume" label overstates what is measured (lines 35, 166–169, 188–191)

**Problem:** the caption honestly says "not total exchange volume", but the toggle and section call it "Volume".

**Fix:** label the toggle "Flow volume" so the limit is visible before the caption is read.

#### 8. 🟢 Nit: The web view-model is placed in the wrong feature folder (lines 147, 262)

**Problem:**

- `apps/web/src/features/charts/` is the klinecharts workstation: indicators, scripts and the renderer.
- The sibling viz card puts its view-model at `features/flow/hedging-pressure-view-model.ts`.
- The options analytics panel has no features folder.

**Fix:** use features/options-analytics/strike-profiles-view-model.ts (proposed path), or co-locate the view-model with the panel, following the `*-view-model.ts` naming of the sibling viz cards.

#### 9. 🟢 Nit: Cost arithmetic in the architecture section (lines 123–124, 234)

**Problem:** "160,000 steps, less than the existing `maxPain` loop (n x n)" is an implementation-level performance note. No bottleneck is suspected.

**Fix:** keep one line in Non-Functional Requirements ("linear in OI strikes per displayed strike; below the existing max-pain cost") and drop the arithmetic from the Technical Plan.

#### 10. 🟢 Nit: The detailed plan contains literal code (lines 275–283, 291–295)

**Problem:**

- Phase A.3 embeds a `.map(row => ({ ...row, holderPayout: … }))` expression and an `Omit<…>` type.
- Phase A.4 specifies `Map<number, FlowStrike & { premium: number }>`.
- Phase B.1 pins `spotAfter` sentinel values (`-1`, `rows.length - 1`).
- These are coding choices, not plan items. They also lock in the type workaround criticised in finding 5.

**Fix:** state the behaviour and the tested cases (spot above, below, between and missing; max-pain marker present). Leave container types and sentinel encodings to the implementer.

#### 11. 🟢 Nit: The contract section names `mcp.ts` without its path (lines 141–142)

**Fix:** write `packages/api/src/server/mcp.ts` (`presentGexContext`). Note that it reads only `exposure.strikes.length`; this is confirmed unchanged.

## egm-inventive-catalyst

## Inventive Catalyst Goldfish report: Strike bar profiles (`design.md`, lines 1–313)

### Summary

Most of the design is balanced. It reuses the existing snapshot, adds no QuantData request, and keeps the profiles as pure server functions and a pure view-model. I found five places where the design accepts a trade-off as unavoidable when it is not. The two Majors:

1. **The ladder is not one shared strike axis.** Each data source picks its own top 80 strikes, so switching profiles changes which rows exist.
2. **The volume and net-premium profiles say "last N h"** but may cover only the first provider page, for an unknown time span.

The other three are about the max-pain marker, the payout-bar scale, and comparing profiles side by side. Each finding names a resolution pattern and its secondary cost.

I checked the code against the design:

- `displayStrikes` and `maxPain` in `options-analytics-engine.ts`, lines 279–336. `maxPain` is an O(n²) loop over all OI rows.
- `parseFlow` and `summarizeFlow`, lines 497–563. Events are sorted newest first.
- The first-page detection in `options-analytics.ts`, lines 145–150.
- The full paging in `flow-collect.ts`, lines 718–744. It follows `nextSearchAfter` and stores complete prints in `flow_option_prints`.

`data-flow.svg` shows QuantData OI reaching the snapshot only through `holderPayout()`; it has no direct OI → exposure-rows path.

### Findings

#### 1. 🟡 Major: "One strike ladder" against a separate top-80 per data source

- **Lines:** 32, 128–131, 174, 198–200, 273–275
- **False compromise:** The Overview promises "four horizontal bar profiles on one strike ladder" (line 32). But the two halves pick strikes differently:
  - Open interest and Max pain use the exposure display set, where "largest" means OI.
  - Volume and Net premium use a second display set from `flowStrikes`, where "largest" means premium.

  Switching profiles therefore changes the rows, the row count and the spot-centred scroll position. The reader cannot see, for example, that the 515 OI wall had no flow, because 515 may vanish from the Volume ladder. Three statements are wrong as a result:
  - The shared caption "the 25 largest" (line 174) means two different things.
  - Risk 4 claims "both views agree" (line 198–200), which holds only for the OI-based profiles.
  - With spot `null`, `displayStrikes` takes `rows.slice(0, 40)` (engine line ~312). For flow rows built from a `Map` in newest-print order, that is an arbitrary set of strikes.

  The design trades a stable axis for keeping each source's own top 80, when both can be had.
- **Proposed fix (Inversion + Segmentation):** Let the ladder own the strikes and let each profile only fill in values.
  - The server builds one axis: the union of the exposure display strikes and the flow strikes, ranked by one documented rule and capped at 80. It could also always include the max-pain strike (see Finding 3).
  - `flowStrikes` returns values keyed by strike. The view-model joins every profile onto the same rows and draws zero bars where a strike has no prints.
  - Sort flow rows by strike before any `slice` fallback.
  - Update the caption and Risk 4 to state the single rule.
- **Secondary liabilities:**
  - Some rows will show empty bars. This is a little visual noise, but it is also useful information ("no flow at the OI wall").
  - The union rule needs a tie-break and its own tests.
  - The flow list is no longer a self-contained "top flow strikes" list for other consumers.

#### 2. 🟡 Major: Flow coverage against quota. The "last N h" label hides an unknown time span

- **Lines:** 97–98, 168–171, 189–192, 205–208
- **False compromise:** When QuantData returns `nextSearchAfter`, the server keeps only the first page. Because events are newest first, the page covers the newest prints only, back to some time nobody reports. The captions still say "last N h", and CUJ 2 promises "contracts traded per strike in the prints of the last 6 hours". The mitigation is passive: the generic "First provider page only (n trades)" message. On a busy SPY day with a 72 h window, the bars may really cover the last 20 minutes while claiming 72 hours.

  Alternative P1 was rejected as all-or-nothing. Yet the repository already pages the full flow for SPY, SPX, QQQ and NDX: `flow-collect.ts` follows `nextSearchAfter` and stores the prints.
- **Proposed fix:**
  - **Blessing in Disguise (no quota cost):** Turn the truncation into a measured fact. `flowStrikes` (or the flow section) returns `coverageStart`, the time of the oldest print in the parsed page, next to `partial`. When `partial` is true, the caption reads "Newest N prints, HH:MM–HH:MM ET (first provider page); not the full N h window."
  - **Preliminary Action / Intermediary (optional, a later step):** For the four collected symbols, compute the flow profiles from the complete stored prints in `flow_option_prints` for the window. Every other symbol keeps the first-page path, with the coverage caption above.
- **Secondary liabilities:**
  - **Coverage caption:** one more contract field, and one more caption variant to test.
  - **Stored-print path:**
    - A database read on the snapshot path.
    - Two data paths, whose freshness can differ: the collector cadence versus the 60 s flow cache.
    - Results that differ by symbol, which the caption must state.
    - Goal 2 and Non-Goal 3 would need rewording, because a database read is a new query, even if it is not a new procedure or table.

#### 3. 🟡 Major: Payout cost against completeness. Max pain can disagree with the ladder

- **Lines:** 101–102, 117–126, 270–271
- **False compromise:** The design computes `holderPayout` only for the 80 display strikes, to bound the cost at "80 × OI strikes" (line 123). It also accepts that the lowest displayed bar matches `maxPain` only "whenever the max-pain strike is a display strike". That contradicts CUJ 4, which states without qualification that the marked strike "equals the max-pain number in the GEX section".

  `maxPain` runs over all OI rows. The display pool is drawn from `inRangeStrikes` (50–150 % of spot). So a far or sparsely traded max-pain strike can drop out, and the ladder would then mark a different strike as "max pain". Meanwhile the existing `maxPain` stays an O(n²) loop (about 4 million steps for 2,000 strikes).
- **Proposed fix (Preliminary Action):**
  - Holder payout is piecewise linear in P. After one sort by strike, prefix sums give the payout at every strike in O(n log n):
    - Prefix sums over strikes below P: Σ callOI and Σ K·callOI.
    - Suffix sums over strikes above P: Σ putOI and Σ K·putOI.
    - `payout(P) = 100 · [P·ΣcallOI≤P − ΣK·callOI≤P + ΣK·putOI≥P − P·ΣputOI≥P]`.
  - Compute the payout once for all strikes. Let `maxPain` take the argmin of that array, which is cheaper than today's loop.
  - Always add the max-pain strike to the display set (pin it). The marker and the GEX number then match by construction, and line 123's conditional can go.
  - Keep a test that the prefix-sum result equals the naive sum on the existing fixtures, including the rule that the first lowest strike wins.
- **Secondary liabilities:**
  - The prefix-sum formula is less obvious than the double loop, so it needs a comment that ties it to the Terms definition.
  - Floating-point rounding can differ slightly from the naive sum. Ties need a defined tolerance, or exact comparison on the same array.
  - Pinning can push the display set to 81 rows unless the cap absorbs it.

#### 4. 🟢 Nit: Absolute payout against legible bars on the Max pain profile

- **Lines:** 148–149, 180–181
- **False compromise:** Bars are "fractions of the largest value in the profile". Payout is convex in P, and the display set includes up to 25 high-OI strikes that can be far from spot. The far rows set the scale, so the near-spot rows that matter for the pin all look about the same length. The reader then cannot see the minimum the profile exists to show; only the "max pain" label carries it. The design trades legibility for literal proportionality.
- **Proposed fix (Dynamics / baseline shift):** Draw `payout − minPayout` (the excess over max pain), so the max-pain row has a zero bar. Keep the absolute payout in the row text, the `title` attribute and the screen-reader table. Say so in the caption: "Bar: payout above the max-pain level."
- **Secondary liability:** The bar no longer encodes the absolute value, so the caption has to explain it. Readers who expect absolute bars could misread relative magnitudes.

#### 5. 🟢 Nit: Phone compactness against comparing profiles

- **Lines:** 32–37, 221–224, 248
- **False compromise:** Alternative P4 rejects four ladders as too long. The chosen toggle then shows one profile at a time, everywhere. Comparing OI walls with today's volume or net premium at the same strike, the core reading in CUJ 1–3, needs memory across toggles. Side-by-side columns are deferred to Future Improvements.
- **Proposed fix (Segmentation + Dynamics):** Once Finding 1 gives every profile the same rows, side-by-side is cheap. Use one table with one column group per profile: all four groups at 1024 px and wider, and the toggle below that, driven by a container query.
- **Secondary liabilities:**
  - Wider tables and more columns per row for screen-reader users.
  - Two layouts to test at the four breakpoints.
  - The four profiles need consistent column headers.

#### 6. 🟢 Nit: Coupling. Max-pain data is attached to the GEX strike rows

- **Lines:** 136, 260–261, 276–278
- **False compromise:** `holderPayout` is added to `ExposureStrikeSchema`. That forces a type split (`StrikeGex = Omit<…, "holderPayout">`) in the engine and in `gex-context.ts`, because the in-range GEX rows do not carry it. A max-pain concern is welded onto the GEX row type, and the `Omit` workaround is the symptom.
- **Proposed fix (Extraction):** Return a separate `exposure.payoutProfile: { strike, holderPayout }[]` keyed by strike. It should be the same strike set as the ladder, so it combines naturally with Finding 1. `ExposureStrikeSchema` and `gex-context.ts` then stay unchanged.
- **Secondary liability:** One more list in the payload, which repeats the strike values. The view-model must join it by strike, which Finding 1 requires anyway.

### Where no false compromise was found

- The read path: three cached requests, no new quota.
- Server-side flow grouping instead of the browser's newest-100 events (Alternative P2).
- Server-side payout over all OI rows (Alternative P3).
- The safety boundary: research view only, no trade actions.
- The rollout through `restart-when-idle.sh`.

These are sound and need no change.
