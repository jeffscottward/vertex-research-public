# Stage 7: Critic report

Reviewers: egm-design, egm-structural, egm-style on FeatureRange 1-249 of the draft (313 lines).

## egm-design

## Design critique: Strike bar profiles in the options analytics panel, lines 1–249

### Summary

I reviewed lines 1–249 against the Feature Specification Standard, read both figures, and checked the claims against the repository at `c7c4f6cd` and the current worktree. I also checked QuantData's public API documentation.

The document has every section the standard asks for, and most of its claims about the code are accurate:

- the panel is used on `/charts` and on the stock page Analytics tab;
- the display set is the 55 strikes nearest spot plus the 25 largest, capped at 80;
- `maxPain` and its n² loop exist;
- the GEX table already centres the spot row with `data-spot-row`;
- the three cached requests and spot from `stockPrice` are as described.

Two problems would block it:

- **The Volume and Net premium profiles rest on a faulty assumption about how much flow data the snapshot holds.** The snapshot requests one page of at most 50 prints (the vendor default), not a full 1–72 h window.
- **The rejection of the QuantData volume request is factually wrong.** QuantData documents a per-strike volume source, and the owner card asks for "QuantData OI and volume".

Several Major issues follow: the profiles do not share one strike set, the Max pain profile is hard to read, and the alternatives are incomplete.

### Findings

#### 1. 🔴 Blocker: the flow profiles cover at most about 50 prints, not "the last N h" (lines 97–98, 126–128, 168–171, 189–192, 211–214, 233–234)

**Problem.**

- `quantDataRequests().orderFlow` in `packages/api/src/server/options-analytics.ts` sends `{filter, timeRange}` with no `size` and no pagination.
- QuantData's `order-flow/consolidated` documentation says the page size defaults to 50 (range 1–100) and the default sort is `tradeTime DESCENDING`.
- So the snapshot holds only the newest ≤50 prints. `MAX_FLOW_EVENTS = 100` in `options-analytics-engine.ts`, which means "the newest-100 cut" (line 127) never applies.

Consequences:

- For SPY over the panel's default 24 h, or the 6 h in user journey 2, the Volume and Net premium ladders show the last few minutes of tape.
- The caption "last N h" (lines 168, 170) is false.
- Alternative P2's rejection (line 213: "per-strike sums would be wrong in a busy window") is moot, because the browser's `flow.events` and the server's `events` are the same set.
- Risk 1 mentions "first provider page only" but never says how small a page is, so the mitigation hides the scale of the gap.

**Fix.**

- State the page size and the real coverage: the time span from the oldest to the newest print and the print count.
- Choose one of these and record the quota cost of each:
  - (a) request `size: 100` and paginate up to a bounded number of pages;
  - (b) use a vendor aggregate (see finding 2);
  - (c) source the four index symbols from the paginated `flow_option_prints` collector.
- Change the captions to state the time span the prints actually cover, for example "newest 50 prints, 14:02–14:09 ET", rather than "last N h".
- Rewrite the P2 rejection.
- Rewrite user journey 2 so it does not promise six hours of trading.

#### 2. 🔴 Blocker: the O8 requirement and the rejection of V1 rest on an incorrect claim (lines 10–11, 69–72, 80–81, 88–90, 226–229, 245–247)

**Problem.**

- Line 88 says the owner card fixes the sources as "QuantData OI **and volume**". The design instead delivers contracts from flow prints and states "not total exchange volume".
- V1 is rejected because "No such request is in use or documented in this repository". QuantData's public documentation lists `/v1/options/tool/heat-map`, which returns an expiration × strike grid with `dataMode` values `NET_VOLUME`, `NET_TRADE_COUNT`, `NET_PREMIUM` and `NET_OPEN_INTEREST`, each with `{callValue, putValue}`. That is exactly O7 and O8 per strike, and per expiry. The documentation also lists `contract-statistics`.
- "Open Questions: None" therefore hides a real decision: spend one request to deliver O8 as specified, or ship a proxy.

Goal 2 (no new quota) is the author's own constraint, not the owner's. The standard requires rejections to give concrete trade-offs, not "not in this repo".

**Fix.**

- Add V1 back as a real alternative, giving `heat-map` with `NET_VOLUME` and its quota cost: one request per symbol, cacheable at the existing 300 s chain TTL. Compare that against the vertex-web per-minute budget enforced in `quantdata-client.ts`.
- Either adopt it, or keep the proxy and add an Open Question for the owner ("ship flow-print contracts instead of QuantData volume?").
- Rename the toggle "Flow contracts" (not "Volume") so the label itself does not claim O8.

#### 3. 🟡 Major: "OI arrives summed over all expiries" is a choice, not a vendor limit (lines 49, 79–81, 195–197, 245)

**Problem.**

- QuantData's `open-interest-by-strike` documentation shows an optional `filter.expirationDate` that narrows the rollup to one expiry.
- QuantData also has a `max-pain` endpoint per ticker and expiry, and `heat-map` with `NET_OPEN_INTEREST` per expiry.
- Non-Goal 1's rationale and Future Improvement 1 ("when QuantData sends per-expiry OI") are therefore wrong.

This matters for O16, because aggregate-OI max pain is a weak proxy for a pin (Risk 3).

**Fix.**

- Correct the Terms and the Non-Goal: per-expiry data is available and costs one extra request per expiry.
- Add an alternative "next-expiry max pain via `expirationDate` or the `max-pain` endpoint", with its quota cost and the reason it is deferred.

#### 4. 🟡 Major: the profiles do not share "one strike ladder" (lines 32, 129–132, 153, 174, 198–199)

**Problem.**

- The Open interest and Max pain profiles use the exposure display set, whose "largest" means largest OI.
- The Volume and Net premium profiles use `flowStrikes`, whose "largest" means largest total premium. Their strike universe is also only the strikes that appear in the prints.
- So switching toggles changes the rows and their order, and a strike's vertical position moves.
- Risk 4 ("the rule is the same one the GEX table uses, so both views agree") is false for the flow profiles.
- Spot centring happens only "on load" (line 153), so after a toggle the scroll position is arbitrary.

**Fix.** Choose one of these and update line 32 and Risk 4 to match:

- (a) Use one union strike set: the OI display set plus flow strikes, capped, with zeros where a profile has no data.
- (b) State plainly that each profile has its own strike set, and re-centre on spot whenever the toggle changes.

#### 5. 🟡 Major: the Max pain profile is unreadable as specified (lines 36–38, 148–149, 177)

**Problem.**

- Each bar is drawn as a fraction of the largest displayed payout.
- Holder payout is convex, and the display set includes up to 25 high-OI strikes far from spot, as far as ±50 % of it. Those far strikes set the scale.
- The near-spot bars then differ by fractions of a pixel, especially at 375 px, so "the lowest bar is the max-pain strike" cannot be seen.

**Fix.**

- Plot the payout above max pain (`payout − min payout`), or scale the bars over the 55 near-spot rows only, clipping the outliers with a marker.
- Show the dollar difference from max pain as the value text, and say so in the caption.

#### 6. 🟡 Major: the case where the max-pain strike is not displayed is undefined (lines 101–102, 120–124, 180)

**Problem.**

- `maxPain` ranges over all OI rows, but the display set is limited to 50–150 % of spot, the 55 nearest strikes and the 25 largest.
- For SPX, with 5-point strikes, the 55 nearest strikes cover only about ±2.3 %, so aggregate max pain can fall outside the displayed rows.
- The document admits the two agree only "whenever the max-pain strike is a display strike", yet user journey 4 promises that the shortest bar always equals the GEX max-pain number.
- It is also never said how the marked row is chosen: by the lowest displayed payout, or by equality with `exposure.maxPain`.

**Fix.**

- Always include `maxPain` in the display set (one extra entry in the `selected` map), or
- mark the row by equality with `exposure.maxPain` and show a note such as "Max pain 5,800 is outside the shown strikes" when it is absent.

#### 7. 🟡 Major: the captions misstate the selection rule (lines 174, 182–183)

**Problem.**

- The caption "the 55 nearest spot and the 25 largest" is wrong without a spot price. The code then takes the "40 lowest strikes plus the 25 largest", which for SPY is deep out-of-the-money strikes.
- "Largest" means OI on two profiles and premium on the other two, and the caption does not say which.

**Fix.**

- Give each profile its own caption, for example "25 largest by total OI" or "25 largest by flow premium".
- Add a separate no-spot caption describing the fallback rule, or hide the ladder and show a message when there is no spot price.

#### 8. 🟡 Major: the alternatives evaluation is incomplete (lines 203–229)

**Problem.**

- No rendering alternative is considered. The web app already depends on `klinecharts` (the `/charts` price chart) and `@tanstack/charts`. Drawing the profiles as a price-axis overlay on the existing price chart is the conventional way to show them, and it would keep strikes aligned with price, which is the document's own "as on a price chart" goal. There is no stated reason for choosing HTML table bars instead.
- P1 is rejected only for needing "a new procedure". It ignores that `flow-collect.ts` paginates over many pages, so its stored prints are more complete than the snapshot's single page (finding 1).

**Fix.**

- Add a price-chart overlay / chart-library alternative with concrete trade-offs: accessibility (a table is easy for screen readers), mobile layout, and effort.
- Re-evaluate P1 on data completeness for the four index symbols.

#### 9. 🟢 Nit: mutually exclusive toggles should not use `aria-pressed` (lines 164–165)

**Problem.** `aria-pressed` buttons are independent on/off toggles. Choosing exactly one of four is a radio group or a tab list in WAI-ARIA terms.

**Fix.** Use `role="radiogroup"` with `aria-checked` (or tabs with `aria-selected`), and specify arrow-key behaviour.

#### 10. 🟢 Nit: OI freshness is not labelled (lines 73, 167)

**Problem.** The existing notes say OI "can reflect the previous session", but the Open interest caption omits this, which falls short of Goal 3.

**Fix.** Add the as-of time or "previous session OI" to the OI and Max pain captions.

#### 11. 🟢 Nit: rendering of zero and empty values is unspecified (lines 176–178, 185–186)

**Problem.**

- The design does not say what a side with zero OI or zero flow shows.
- The repository's status-language guard (`scripts/lib/status-language.ts`) rejects a bare "—", "?" or "…" as a displayed value.
- For Net premium, the single signed value is split across `Negative` and `Positive` columns, which leaves one cell empty in every row.

**Fix.**

- Specify "0" or "$0".
- Consider `Bearish $` and `Bullish $` columns, since both values are already in `FlowStrikeSchema`, with net premium as the bar.

#### 12. 🟢 Nit: the ladder is categorical, but the text implies a linear axis (lines 33–34, 176)

**Problem.** The rows mix the strikes near spot with far top-25 strikes, so vertical distance does not track price. Gaps between strikes are not marked.

**Fix.** Mark gaps between non-adjacent strikes, for example with "12 strikes not shown". Do not use "…", which the status-language guard rejects.

#### 13. 🟢 Nit: the figures do not match the text (lines 20–22, 108)

**Problems in `data-flow.svg`:**

- OI feeds only `holderPayout()`, although the OI profile uses the exposure strikes directly.
- Spot is not shown feeding the display-set selection of `holderPayout` or `flowStrikes`.
- The Max pain legend is gold, while the text uses `muted-foreground` for the bars and `primary` for the marked row.

**Problems in `before-after-mock.svg`:**

- The toggles read "OI" and "Net $" where the text says "Open interest" and "Net premium".
- The toggles are 90×30 px, against the 44×44 px minimum.
- It has no caption, value labels, legend or max-pain marker.

**Fix.** Align the labels and the colour roles, and add the OI→ladder and spot→selection edges to the data-flow figure.

#### 14. 🟢 Nit: integration and rollout details (lines 141–143, 179, 237–240)

**Problems.**

- The flow collector in `flow.ts` also calls `buildOptionsAnalytics`, so `holderPayout` and `flowStrikes` will run on every collect cycle. The cost is cheap, but it should be stated.
- No rollback is described.
- Using the `destructive` (error) token for puts and bearish premium carries an "error" meaning.

**Fix.**

- Note the extra collector compute.
- Add a one-line revert/redeploy rollback through `restart-when-idle.sh`.
- Consider a neutral put colour token, or state why `destructive` is acceptable.

## egm-structural

## Structural Goldfish review: `design.md`, lines 1-249 (FeatureRange), checked against `feature-spec-standard.md`

### Summary

The document covers every area the standard requires: Problem (L61-66), Goals and Non-Goals (L68-84), Architecture (L106-157), Alternatives (L203-229) and Risks (L187-201). Headings never skip a level. No list, table or code fence is broken, and there are no unbalanced backticks or trailing spaces. Every code path it names exists in the repo: `options-analytics-engine.ts`, the contract file, `market.ts`, `restart-when-idle.sh`, `openapi.json` and `mcp.ts`. Its claims about the code also hold: 55+25 strikes capped at 80, newest 100 events, the "Max pain (aggregate OI)" label, the 24 rem scroll box.

The problems are in three places:

- **The two figures disagree with the text.** Figure 1 puts the spot line between the wrong strikes.
- **Rules break in edge cases.** The text says nothing about a max-pain strike outside the display set, and the strike caption is wrong when there is no spot price.
- **Risks and Alternatives are incomplete.** Risks has no security entry and no payload or scalability entry. Alternatives never compares rendering approaches.

Rendered PNGs of both figures were checked.

### Findings

1. 🟡 **Major. Figure 1 draws the spot line in the wrong place (L22-24, `before-after-mock.svg`).**
   - **Problem:** The line labelled "spot 512.34" sits between strikes 510 and 505. By L41 ("between the two strikes around it") it belongs between 515 and 510. A fresh implementer copying the mock would build the off-by-one row. The label is also lowercase "spot", while L182 says "Spot 512.34".
   - **Fix:** Move the dashed line to between 515 and 510. Change the label to "Spot 512.34".

2. 🟡 **Major. Figure 1 names the toggles differently from the text (L164 vs Figure 1), and the caption doesn't say what the mock leaves out (L24).**
   - **Problem:** The mock's buttons read "OI", "Volume", "Net $", "Max pain". L164 says "Open interest", "Volume", "Net premium", "Max pain". It is unclear which set is canonical.
   - **Problem:** The mock also omits:
     - the section title "Strike profiles"
     - the caption line and the "Up to 80 strikes" line
     - the per-bar compact values
     - the scroll box
   - **Problem:** It also contains an unexplained "?" glyph in the BEFORE panel. L24 only says "the numbers are invented".
   - **Fix:** Relabel the mock's buttons to match L164. Expand L24 to list what the mock leaves out, as the sibling `vertex-viz-hedging-pressure/design.md` does. Remove the "?" or explain it.

3. 🟡 **Major. Figure 2 mislabels the server additions and misses an input (L108, `data-flow.svg`).**
   - **Problem:** The caption says "the server adds two derived lists". But `holderPayout` is a field added to existing `ExposureStrike` rows (L119-121, L136), not a list. Only `flow.strikes` is a new list.
   - **Problem:** The diagram sends spot only to the snapshot. But both server additions depend on spot: the display set at L118-119, and `flowStrikes(events, spot)` at L126.
   - **Problem:** In the ladder box, Max pain is drawn gold. L179-180 says payout bars are `muted-foreground` and the max-pain row is `primary`.
   - **Problem:** The diagram also has no step for the web view-model `strike-profiles.ts` (L147).
   - **Fix:** Change the caption to "the server adds one field and one list". Draw spot arrows into both ∑ boxes. Add a `strike-profiles.ts` view-model box before the ladder. Recolour the ladder legend or drop its colours.

4. 🟡 **Major. The sections disagree about where the max-pain marker goes (L38, L101-102, L121-123, L179-180).**
   - **Problem:** The Overview (L38) and CUJ 4 (L101) promise that the shortest bar is max pain and equals the GEX max-pain number. The Server additions section concedes this holds only "whenever the max-pain strike is a display strike" (L123). No section says what the ladder shows otherwise: which row gets the `primary` marker, if any, and what text appears.
   - **Fix:** Under User experience, add a rule. Mark the row whose strike equals `exposure.maxPain`. If that strike is not displayed, show no marker plus one caption line: "Max pain {K} is outside the displayed strikes". Qualify L38 and CUJ 4 to match.

5. 🟡 **Major. The "Up to 80 strikes" caption is wrong in two cases (L174, L118-119, L130-132).**
   - **Problem:** The fixed caption says "the 55 nearest spot and the 25 largest" under every profile.
     - With no spot price, the engine selects the 40 lowest strikes plus the 25 largest (`options-analytics-engine.ts` L313-314). L182-183 already handles a missing spot for the spot line, but not for this caption.
     - "Largest" also means a different thing per profile: largest OI for the OI and Max pain profiles, largest total premium for Volume and Net premium (L131).
   - **Fix:** Specify one caption per case:
     - With spot: "…the 55 nearest spot and the 25 largest by OI" (or "by premium" for the flow profiles).
     - Without spot: "…the 40 lowest and the 25 largest".
   - Add the no-spot selection rule to the Server additions text.

6. 🟡 **Major. Risks and Mitigations has no security entry and no scalability or payload entry (L187-201).**
   - **Problem:** The standard's Risks & Limits section requires "security implications" and "scalability limits". Today the only safety statement is the research-only paragraph at L18-20, which is outside the Risks section.
   - **Problem:** Nothing in Risks covers:
     - who can read the new fields (the oRPC/OpenAPI output; the agent-viewer and operator access paths in `operator-access.ts`)
     - the growth in snapshot payload: up to 80 `FlowStrike` rows × 7 numbers, plus one number per exposure row
     - the cost of grouping every print of a 72 h window
   - **Fix:** Add three numbered entries to Risks:
     - "Access and exposure": no new procedure; the same authorization as `optionsAnalytics.snapshot`; read-only fields.
     - "Response size": an estimate in bytes per snapshot.
     - "Flow grouping cost": bounded by the first provider page, one pass.
   - Mirror the response size in the Non-Functional Requirements (L231-235).

7. 🟡 **Major. Alternatives Considered leaves out the main rendering choices (L203-229).**
   - **Problem:** Two design choices with real trade-offs are never compared against an alternative:
     - The renderer: an HTML table with CSS bars (L184), versus SVG with the `d3-scale` dependency `apps/web` already has.
     - The orientation: horizontal bars with strike on the y-axis (L40), versus the common vertical column chart with strike on the x-axis.
   - **Problem:** The accessibility approach (L184-185) depends on the table choice, so the rejected options should be on record. The prefixes "P" and "V" are also never defined, and no alternative is marked as chosen.
   - **Fix:** Add "Alternative R1: SVG chart with d3-scale" and "Alternative R2: Vertical columns, strike on x-axis", each with a concrete reason for rejection: screen-reader table semantics, row alignment with the GEX table, phone width. Add one line at the top of the section defining the prefix families: P = where and how the profiles are computed, V = volume source, R = rendering. Mark the chosen design, as the hedging-pressure doc does.

8. 🟡 **Major. "Open Questions: None" leans on a source a reader cannot find (L5, L7-8, L86-90).**
   - **Problem:** The cards `vertex-flow-viz-gap` and `vertex-viz-strike-profiles` are cited by ID only. Neither is found anywhere in the repo, and the gap report is "an internal page on the owner's private network".
   - **Problem:** L88-90 closes every open question by citing what "the owner card fixes", with no link. The quoted placement text ("…as fits") actually leaves the choice open. That conflicts with the standard's rule against attributing decisions to a maintainer without a resolvable reference.
   - **Fix:** Give the card's storage location, or its full quoted text, in the header block. Reword L88-90: "The card leaves placement open ('as fits'); this design chooses the shared panel (see Alternative P1)."

9. 🟢 **Nit. The metadata block holds body content (L7-16).**
   - **Problem:** The four gap-report row descriptions are nested under the "Source" bullet. They are problem evidence, not metadata.
   - **Fix:** Keep "Source: research card `vertex-flow-viz-gap`, charts O7, O8, O9, O16" in the header. Move the row text into The Problem (L61-66).

10. 🟢 **Nit. Terms used throughout are not defined in Terms (L44-59).**
    - **Problem:** "display strike" or "display set" (L118, L121, L131), "GEX section" or "GEX table" (L102, L153) and "exposure section" (L161) are used throughout but appear only inline or not at all.
    - **Fix:** Add "Display strikes" (the 80-strike selection rule, including the no-spot case) and "GEX section" (the panel section titled "Gamma exposure and open interest") to Terms.

11. 🟢 **Nit. Risk 5 doesn't follow the pattern of the other four (L200-201).**
    - **Problem:** Items 1-4 state a risk sentence, then "Mitigation:". Item 5 ("Layout on phones.") has no risk sentence.
    - **Fix:** Add one, for example "Two-sided bars with values may not fit 375 px."

12. 🟢 **Nit. Ambiguous "Both" in the Contract section (L141).**
    - **Problem:** "Both are additions…" follows three bullets.
    - **Fix:** Write "All three changes are additions…".

13. 🟢 **Nit. Inconsistent heading capitalization and cross-references (L159, L81, L89).**
    - **Problem:** "User experience" is sentence case while the other H2s are Title Case. The sibling docs do the same, so this is a house-wide drift. Cross-references are written both as `(see Risks)` and `Section "Alternatives Considered"`, with no anchors.
    - **Fix:** Pick one casing for the H2s. Use Markdown anchor links, for example `[Risks and Mitigations](#risks-and-mitigations)`.

14. 🟢 **Nit. Rollout has no rollback statement (L237-241).**
    - **Problem:** The section covers deploy only. The sibling `vertex-viz-tape-speed` documents "Rollout and rollback".
    - **Fix:** Add: "Rollback: revert the commit and restart through the same script; there is no data migration."

15. 🟢 **Nit. Line 6 exceeds the wrap width (L6, 110 characters).**
    - **Problem:** The body wraps at about 100 columns. L22 and L108 are image embeds and are exempt.
    - **Fix:** Wrap the "Baseline commit" bullet onto a continuation line.

## egm-style

## Style review: `design.md`, lines 1-249

I found no blockers. There are 8 major findings and 11 nits. Most of the majors are claims that say more than the design or the code supports. Examples are claims that two values "agree" or "equal", "tested at 375 px", "the only reader", and "Open Questions: None". The other majors are terms that mean two things, such as "lowest bar" on a vertical strike ladder and "the 25 largest". I checked these against the codebase and the two SVG figures. Wording, tone and sentence structure are mostly dry and direct.

### Findings

1. 🟡 **Major — lines 37-38 and ~175 (Max pain caption): "lowest" means two things.** The strike is the vertical axis, so "the lowest bar" reads as the bottom row (the lowest strike). CUJ 4 (line 101) correctly says "the shortest bar". The caption "The lowest is max pain." has the same problem on screen.
   **Fix:** Line 38 → "the shortest bar is the max-pain strike". Caption → "The smallest payout is max pain." The source quote at line 15 can stay.

2. 🟡 **Major — lines 101-102 (CUJ 4): the "equals" claim says more than line 122 supports.** Line 122-123 says the displayed minimum and `maxPain` agree only when the max-pain strike is one of the 80 display strikes. CUJ 4 states equality without that condition.
   **Fix (CALIBRATE):** "…its strike equals the max-pain number in the GEX section when that strike is in the display set." Alternatively, state what the ladder shows when the max-pain strike is outside the display set.

3. 🟡 **Major — lines 197-199 (Risk 4) and the caption "Up to 80 strikes: the 55 nearest spot and the 25 largest." (~line 176): "largest" is undefined and "both views agree" is too broad.** Line 131-132 ranks flow strikes by total premium, not OI. So the Volume and Net premium ladders can list strikes the GEX table does not, and "both views agree" holds only for the Open interest and Max pain profiles. The caption also leaves out the 50-150 %-of-spot bound and does not say what "largest" ranks.
   **Fix:** Use a caption per profile family: "…the 25 with the largest OI" and "…the 25 with the largest total premium". Narrow Risk 4 to "the OI and Max pain ladders use the same strikes as the GEX table".

4. 🟡 **Major — lines 141-143: "the only reader of the full output is the web panel and its tests" leaves out a reader.** The file table (Detailed range) changes `packages/api/src/server/gex-context.ts` ("strike row type without `holderPayout`"). So a server module also uses the strike row type.
   **Fix (CALIBRATE):** "Readers of the changed types: the web panel, its tests, and `gex-context.ts` (its strike row type leaves out `holderPayout`). `mcp.ts` and the flow collector read named fields only and are not changed."

5. 🟡 **Major — line 201 (Risk 5): "tested at 375 px" is stated as already done, but the document is a draft.** It also restates part of Goal 4.
   **Fix (CALIBRATE):** "…the acceptance check renders the panel at 375 px with no horizontal page scroll", or point to the named test.

6. 🟡 **Major — lines 74-75 (Goal 4): "Work at … with keyboard use and screen readers" cannot be measured.**
   **Fix:** State pass criteria. For example: no horizontal page overflow at 375/768/1024/1440 px; the toggles can be reached with Tab and announce `aria-pressed`; the ladder table is read by column; the contrast token pairs pass in both themes.

7. 🟡 **Major — lines 86-90 (Open Questions): "None" is not supported by the text.** The owner card names "QuantData OI and volume". The design draws flow-print contracts instead (Non-Goal 2, Risk 1, Alternative V1), and it chose the panel location itself ("as fits"). Whether flow-print volume satisfies O8 is an open owner decision.
   **Fix:** List it: "Does flow-print volume satisfy O8, or does the owner accept the quota cost of a volume-by-strike request (Future Improvement 2)?"

8. 🟡 **Major — lines 95-96 (CUJ 1): "the strikes with the longest call and put bars above and below the spot line" assumes where the walls are.** It implies call walls sit above spot and put walls below. The data does not guarantee that.
   **Fix:** "The reader sees which strikes have the longest call bar and the longest put bar, and where they sit relative to the spot line."

9. 🟡 **Major — Figure 1 (`before-after-mock.svg`) does not match the specified UI text.** The mock's toggles read "OI", "Volume", "Net $", "Max pain"; the spec (line ~166) says "Open interest", "Volume", "Net premium", "Max pain". The mock's spot label is "spot 512.34"; line 182 says "Spot 512.34". The mock also has no caption line. Line 24 says the mock "shows the layout only", but the labels in it read as the real ones.
   **Fix:** Change the mock labels to the spec text and add the caption row. Or extend line 24: "Labels are abbreviated; Section User experience gives the actual text."

10. 🟢 **Nit — line 122: tense.** "The existing `maxPain` function uses the same payout function" describes the state after the change. Today `maxPain` computes the payout inline (engine lines 274-283).
    **Fix:** "After this change, `maxPain` calls `holderPayout()`, so…"

11. 🟢 **Nit — lines 123-125: mixed units.** "multiplications" and "steps" are used for the same count, and the comparison has no number.
    **Fix:** "at most 80 × n payout evaluations (160,000 for n = 2,000), compared with n² = 4,000,000 for the existing `maxPain` loop."

12. 🟢 **Nit — lines 54-55: "the dollar value of all calls and puts at expiry" is imprecise.** The OI is summed over all expiries, so "at expiry" is ambiguous.
    **Fix:** "the intrinsic value, in dollars, of all open contracts (all expiries) if the underlying is at `P`."

13. 🟢 **Nit — lines 63-64: "where … money sit", "a table of up to 80 numbers" and "switch to another product" are vague.**
    **Fix:** "…must read the GEX table (up to 80 rows) or use another tool to see how OI, flow volume and net premium are spread across strikes."

14. 🟢 **Nit — lines 99-100 (CUJ 3 "Where the money bets") and line 104 ("Pin target"): figurative headings that claim intent.** "Bets" and "pin target" suggest trader intent or a prediction. Risk 2 and Risk 3 treat these values as a vendor label and a proxy.
    **Fix:** "Net premium by strike" and "Max-pain strike". Also replace "Green/red bars" with "bars to the right/left", in line with line 181 ("colour is never the only signal").

15. 🟢 **Nit — Figure 2 caption (line 109): "the server adds two derived lists" is inaccurate.** `holderPayout` is a new field on the existing strike rows, not a list.
    **Fix:** "…the server adds one field (`holderPayout`) and one list (`flow.strikes`)."

16. 🟢 **Nit — lines 28-29 and 60-61: "answer" is used for an API response.**
    **Fix:** Use "response" throughout.

17. 🟢 **Nit — lines 128-129: "before the newest-100 cut of the event list" is internal jargon.**
    **Fix:** "…every parsed flow print of the window, before the event list is cut to the newest 100 (`MAX_FLOW_EVENTS`)."

18. 🟢 **Nit — line 167: "Caption (one line under the toggles)" conflicts with the captions below it.** The Volume caption has three sentences, and every profile adds a second line ("Up to 80 strikes…").
    **Fix:** "Caption (under the toggles; wraps on narrow screens)". Drop "Contracts in QuantData flow prints" or "Flow prints only", which repeat each other.

19. 🟢 **Nit — repeated text and missing statements:**
    - The research-only statement appears three times: lines 18-20, Non-Goal 5, and the Figure 2 text. Keep lines 18-20 and Non-Goal 5; drop it from the figure.
    - Risk 5 (lines 200-201) has a heading but never states the risk. Add one sentence, such as "Two-sided bars with value labels may not fit a 375 px row."
    - Line 223: replace "very long" with the count: "four ladders, up to 320 rows".
    - Line 229: replace "Rejected for now" with the condition: "Rejected until the owner approves the quota use (Future Improvement 2)."
