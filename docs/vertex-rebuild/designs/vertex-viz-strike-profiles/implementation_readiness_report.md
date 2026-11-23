# Stage 9: Implementation readiness report

Reviewers: egm-implementation-readiness, egm-codebase-details, egm-style on DetailedRange 250-313 of the draft.

## egm-implementation-readiness

## Implementation readiness review: `design.md`, Detailed Implementation Plan (lines 250-313)

### Summary

The plan has the right shape: a file table, three phases, named functions and acceptance gates. It does not pass the Zero-Decision Rule yet. I found 1 🔴 Blocker, 8 🟡 Major and 6 🟢 Nit.

- **Unanswered design questions.** The plan leaves several choices to the implementer:
  - the sign of the premium fields;
  - the rule for the max-pain marker;
  - how bar lengths are scaled;
  - how section messages map to view states;
  - what happens when spot equals a strike;
  - the value formatters.
- **Generic selector.** The proposed `displayStrikes` signature, with a default `size` argument, cannot be typed as written.
- **Buildable phases.** Phase A does not leave the repository buildable, because the strict lab fixture is only updated in Phase B.
- **Evidence from the worktree.** It already holds uncommitted Phase A work, and that work departs from the document in two places: it adds a new `selectDisplayStrikes` function, and it relaxes `bullishPremium`/`bearishPremium` to plain `finite`. Both show the implementer had to make decisions the document should have made.

### Findings

#### 1. 🔴 Blocker: the premium sign contract conflicts with the input (lines 279-283, read with 137-138)

- **Problem:** Line 138 makes `bullishPremium` and `bearishPremium` "finite, not negative". The input `FlowEventSchema.premium` is only `finite` (`packages/api/src/contracts/options-analytics.ts:116`), and `parseFlow` does not clamp it (`options-analytics-engine.ts`, `premium = toNumber(...)`).
  - Phase A step 4 sums raw `event.premium`, so one negative vendor value would make the strict `OptionsAnalyticsOutputSchema` reject the whole snapshot. Every section of the panel would be lost.
  - The worktree already relaxed the schema to plain `finite`, which contradicts line 138.
- **Fix:** Pick one rule in Phase A step 4 and in the Contract section. For example: "skip events with `premium < 0`, as with `strike <= 0`; the schema stays `nonnegative`." Alternatively, relax lines 137-138 to plain `finite`. Add a test for a negative-premium event.

#### 2. 🟡 Major: the generic `displayStrikes` signature cannot be typed (lines 272-274, 282-283)

- **Problem:** `displayStrikes<Row extends { strike: number }>(rows, spot, size)` cannot default `size` to "call OI plus put OI": a generic `Row` with only `strike` has no OI fields. The implementer must invent a design. The worktree did this by adding `selectDisplayStrikes(rows, spot, size)` plus an OI wrapper, which the file table (line 257) does not name.
- **Fix:** State the exact exports and signatures:
  - `selectDisplayStrikes<Row extends Readonly<{ strike: number }>>(rows, spot, size: (row: Row) => number): Row[]`;
  - `displayStrikes<Row extends OpenInterestRow>(rows, spot)`, which calls it with `callOpenInterest + putOpenInterest`;
  - `inRangeStrikes<Row extends Readonly<{ strike: number }>>`.

#### 3. 🟡 Major: the fallback without spot depends on input order (lines 279-283)

- **Problem:** When spot is null, `displayStrikes` takes `rows.slice(0, 40)` in input order (`options-analytics-engine.ts`, the `near = rows.slice(0, 40)` branch). Step 4 builds the rows from a `Map` filled in event order, newest first, so the 40 strikes chosen would be arbitrary. The "spot `null`" test (line 285) has no defined expected result.
  - The caption at line 174 ("the 55 nearest spot…") is also wrong in this case.
- **Fix:** Add to step 4: "sort the tallies by strike ascending before selection; without spot the set is the 40 lowest strikes plus the 25 largest by total premium." Give the test's expected strikes. Define the caption without spot, for example "Up to 80 strikes: the 40 lowest and the 25 largest."

#### 4. 🟡 Major: the max-pain marker rule is undefined (lines 291-293, read with 101-102 and 121-123)

- **Problem:** The row field `maxPain: boolean` has no rule.
  - It could mean `row.strike === snapshot.exposure.maxPain` or "the row with the lowest `holderPayout`". The two differ when the max-pain strike is outside the 80 display strikes, a case lines 122-123 admit.
  - The lab fixture sets `maxPain: atm` while its open interest is random (`apps/web/src/lab/fixtures/market.ts`). If the fixture computes `holderPayout` from that OI, the marked row may not be the shortest bar, which makes the Acceptance 3 screenshots inconsistent.
- **Fix:** Specify `maxPain = row.strike === exposure.maxPain`. Say that when no displayed row matches, no row is marked and the caption gains "Max pain N is outside the displayed strikes". Require the fixture to derive `maxPain` from the same payout formula (step 5 of Phase B, or the fixture item).

#### 5. 🟡 Major: section status and messages are not mapped to view states (lines 291-292, read with 161-163 and 189-192)

- **Problem:** Each section has a status (`ok`/`empty`/`unavailable`) and a message that may be non-null while the status is `ok`:
  - exposure: "Open interest shown; GEX needs option-chain IV and a spot price.";
  - flow: "First provider page only (N trades)." (`options-analytics.ts:147-166`).

  The view-model returns `state: "ok" | "message"` and `message`, but does not say:
  - whether an `ok` profile also carries that message;
  - whether the GEX-specific exposure message should appear on the Open interest and Max pain profiles.

  Risk 1 requires the first-page message on Volume and Net premium. The case where the status is `ok` but `flow.strikes` is empty (every print has `strike <= 0`) is also undefined.
- **Fix:** Give a mapping table:

  | Profile | Source section | `state` | `message` | Empty `strikes` |
  | --- | --- | --- | --- | --- |
  | Volume, Net premium | flow | `"ok"` when status is `ok`, otherwise `"message"` | always `flow.message` | `"message"` with the text "No strike in the flow prints." |
  | Open interest, Max pain | exposure | same rule as flow | null when `state` is `"ok"` (the GEX note is not shown) | as decided in the table |

  Also state whether the component reuses `SectionShell`, which is currently private in `options-analytics-panel.tsx`, or exports it.

#### 6. 🟡 Major: view-model fields and bar scaling are underspecified (lines 291-295)

- **Problem:** The plan leaves these open:
  - **Types:** the `metric` type and its values; the shape of `columns`; the field names of the row "display texts" and "accessible label", and their wording.
  - **Max pain sides:** which side carries the value for Max pain (`left` = 0, `right` = payout?).
  - **Bar scale:** "fractions of the largest value in the profile" (line 148) does not say whether one scale is shared across puts and calls. For Net premium, the scale should be the largest absolute value.
  - **Division by zero:** the behaviour when every value is 0.
- **Fix:** Write the type, for example `type StrikeMetric = "oi" | "volume" | "netPremium" | "maxPain"`. Then define per metric:
  - left value, right value and the column headers (for example Max pain: `["Strike","Payout"]`, left 0);
  - `scale = max over rows of max(left, right)`, or of `abs(net)` for Net premium; fractions are 0 when `scale` is 0;
  - `leftText`/`rightText`/`label` with an example string each.

#### 7. 🟡 Major: spot equal to a strike, and the spot label format (lines 294-295, 296-297)

- **Problem:** `spotAfter` covers above, below, between and missing, but not spot equal to a strike. With rows sorted high to low, the placement is a choice. The text of `spotLabel` ("Spot 512.34": `toFixed(2)`?) and the case without spot (`spotLabel` null plus the caption "No spot price from QuantData", line 183) are not stated as view-model outputs.
- **Fix:** Add a rule, for example: "`spotAfter` = index of the last row with `strike >= spot`; the line goes below a strike equal to spot." Define `spotLabel = \`Spot ${spot.toFixed(2)}\`` or `null`. Add an "equal to a strike" case to the tests at line 298.

#### 8. 🟡 Major: Phase A leaves the repository unbuildable (lines 268-287, read with 265)

- **Problem:** Phase A adds required fields (`holderPayout`, `flow.strikes`) to strict schemas. Two existing files then fail until Phase B:
  - `apps/web/src/lab/fixtures/fixtures.test.ts:121-122` parses `labOptionsAnalytics()` with `OptionsAnalyticsOutputSchema`;
  - `apps/web/src/components/portal/options-analytics-panel.test.tsx` (the fixture at line 117 typed as `OptionsAnalyticsOutput`) fails `typecheck`.

  This violates "each phase must leave the codebase … buildable".
- **Fix:** Move the `market.ts` fixture update and the `options-analytics-panel.test.tsx` fixture fields into Phase A. Alternatively, declare A and B one commit with one checkpoint. Add `apps/web/src/lab/fixtures/fixtures.test.ts` to the file table, with new assertions: every exposure strike has `holderPayout`; the row with the lowest payout equals `maxPain`; `flow.strikes` is non-empty.

#### 9. 🟡 Major: the file table is not an exact write allowlist (lines 254-266)

- **Problem:**
  - "and test" does not name the test files.
  - `gex-context.ts` needs `StrikeGex` (or a type with the same meaning) exported from the engine; the plan does not say so.
  - The lab fixture change lacks a generation rule. `market.ts` builds its snapshot in a function, so the fixture can compute `holderPayout` from its 11 OI rows and `strikes` from its events, or use literal values. The plan picks neither.
- **Fix:** List these exact paths:
  - apps/web/src/features/charts/strike-profiles.test.ts (draft path)
  - `apps/web/src/components/portal/strike-profiles-panel.test.tsx`
  - `apps/web/src/components/portal/options-analytics-panel.test.tsx`
  - `apps/web/src/lab/fixtures/fixtures.test.ts`

  State: "export `type StrikeGex = Omit<ExposureStrike, 'holderPayout'>` from `options-analytics-engine.ts`; `gex-context.ts` imports it as `StrikeOi`". Specify that the fixture computes the payout with the same formula (inline, since web does not import server code) and `strikes` by grouping its events.

#### 10. 🟡 Major: Phase A tests miss the main behavioural claims (lines 284-286)

- **Problem:**
  - **Grouping before the cut:** nothing tests that flow strikes count prints beyond the newest 100. That is the reason Alternative P2 was rejected.
  - **Both `exposure()` branches:** no test that both branches (spot or model null, and the GEX branch) attach `holderPayout`, which the 100 % coverage gate needs.
  - **Uncovered cases:** no test for the `strike <= 0` skip, for `selectDisplayStrikes` with a custom `size`, or for the new `strikes` field in `options-analytics.ts`.
  - **Payout example:** the hand-worked payout example has no numbers.
- **Fix:** List these test cases:
  - **Payout:** with OI `{100: call 10, put 0}` and `{110: call 0, put 20}`: `holderPayout(rows,100) = 20,000`, `holderPayout(rows,110) = 10,000`, so `maxPain = 110`.
  - **Grouping beyond the cut:** 150 events on one strike give `trades = 150` while `events.length = 100`.
  - **Skip:** an event with `strike = 0` is skipped.
  - **Neutral prints:** a neutral print adds to volume and `trades` but to neither premium.
  - **Cap:** 81 or more strikes are cut to 80, the 25 largest by total premium are kept, and the output is sorted.
  - **Payout in both branches:** both branches of `exposure()` carry `holderPayout`.
  - **Snapshot fields:** in `options-analytics.ts`, `flow.strikes` is non-empty for ok flow and `[]` for unavailable flow.

#### 11. 🟢 Nit: number formatters are not specified (lines 292-293, read with 177-178)

- **Problem:** The examples `12.4K` / `$1.2M` conflict with the existing `money()` in `options-analytics-panel.tsx`, which gives `$1.20M`. `money()` is private, and no contract-count formatter exists.
- **Fix:** Name the formatter and its home. For example: export `money()` from a shared module, or add `compactCount()` / `compactMoney()` to `strike-profiles.ts` with exact rounding rules. Tests assert the strings.

#### 12. 🟢 Nit: the Phase B component steps are vague (lines 296-299)

- **Problem:** The plan does not say:
  - whether the selected profile resets on a symbol or window change (local `useState` default `"oi"`?);
  - what the data attributes for tests are;
  - that "toggle with keyboard" means native buttons using Enter/Space with `aria-pressed`, not a roving radio group.
- **Fix:** State the state owner and reset rule, the `data-*` hooks (for example `data-strike-profile={metric}` and `data-max-pain-row`), and the keyboard model.

#### 13. 🟢 Nit: the CHANGELOG step has no text (lines 266, 303)

- **Problem:** No subsection or wording is given. Existing entries go under `### Added` with the card, the design path and a description.
- **Fix:** Give the line, for example: "- Strike bar profiles in the options analytics panel (Vertex, research only; card vertex-viz-strike-profiles, design `docs/vertex-rebuild/designs/vertex-viz-strike-profiles/design.md`): …", placed under `## [Unreleased]` → `### Added`.

#### 14. 🟢 Nit: acceptance commands are imprecise (lines 307-313)

- **Problem:**
  - `pnpm exec vitest run` does not name the working directory or config: root `vitest.config.ts` with projects, or per package.
  - The coverage command is missing.
  - The `/lab` URL is not given (the lab is gated by `VERTEX_UI_LAB=on`; the entry id is `charts`).
  - The headless Chrome check has no script.
- **Fix:** Give exact commands, for example `pnpm --filter @darkfactory/api exec vitest run --coverage src/options-analytics.test.ts …`. Give the lab URL (`/lab/charts` with `VERTEX_UI_LAB=on`) and the screenshot procedure or tool.

#### 15. 🟢 Nit: the mock figure disagrees with the text (Figure 1, lines 22-24, read with 164 and 182)

- **Problem:** `before-after-mock.svg` labels the toggles "OI", "Net $" and the spot line "spot 512.34", and shows no caption line. The text specifies "Open interest", "Net premium", "Spot 512.34" and a caption. An implementer matching the figure would ship the wrong labels.
- **Fix:** Update the mock labels, or state that the text wins over the figure.

#### 16. 🟢 Nit: Phase A step 3 shows one branch only (lines 275-278)

- **Problem:** The single expression must be applied in both return branches of `exposure()` (the no-model branch and the GEX branch). The step does not say so.
- **Fix:** Add "in both branches", or name a helper (the worktree's `withPayout(display, oiRows)`).

## egm-codebase-details

## Stage 9 (Implementation Readiness), codebase details: `vertex-viz-strike-profiles/design.md`

### Summary

I checked every repository reference in the whole document (lines 1–313) and both figures against baseline `c7c4f6cd` and the current working tree of branch `ws/strike-bar-profiles-oi`. Most references are correct:

- **Engine:** `maxPain`, `inRangeStrikes`, `displayStrikes`, `exposure`, `parseFlow`, `summarizeFlow` and `MAX_FLOW_EVENTS = 100` exist in `options-analytics-engine.ts`.
- **Contract:** `ExposureStrikeSchema`, `FlowSectionSchema` and `OptionsAnalyticsOutputSchema` exist, and `OPTIONS_FLOW_HOURS = [1, 6, 24, 72]` matches the windows the document names.
- **Server:** `quantDataStockPrice` supplies spot, and the three cached requests are as described.
- **Panel:** the GEX table already uses `data-spot-row` and a `max-h-96` (24 rem) scroll box, as the document says.
- **Readers:** `mcp.ts` reads only `exposure.strikes.length` and named fields.
- **Pages and tools:** the `/stock/SPY?tab=analytics` tab exists, as do `labOptionsAnalytics` in `apps/web/src/lab/fixtures/market.ts`, `bun run openapi:generate`, `bun run verify:prepush`, `CHANGELOG.md ## [Unreleased]`, and `infra/quantvps/restart-when-idle.sh` (its guard covers 08:30–16:00 New York time). None of the changed files is in `scripts/ci/coverage-baseline.json`, so the 100 % coverage rule does apply.

**Important context:** the Phase A server work is already in the working tree, uncommitted. `contracts/options-analytics.ts`, `options-analytics-engine.ts`, `options-analytics.ts` and `gex-context.ts` are modified, and in several places they already differ from the document.

The plan is **not yet implementation-ready**. The Detailed Plan still leaves decisions to the implementer:

- the message state when a section is `ok` but carries a message;
- the max-pain marker rule;
- bar scaling and the zero-maximum case;
- spot placement when spot equals a strike;
- how the lab fixture computes `holderPayout`;
- the formatters to use.

It also has phasing and file-list gaps.

### Findings

**1. 🔴 Blocker — Phase A step 2, lines 272–274; Files table, line 257. The document contradicts the code already written.**

- **Problem:** The document says to turn `displayStrikes` into a generic `displayStrikes<Row extends {strike}>(rows, spot, size)`, with `size` "defaulting" to call OI plus put OI. A TypeScript default cannot read `callOpenInterest` when `Row` only extends `{ strike }`, so the spec cannot be built as written. The working tree solved it differently:
  - a new `selectDisplayStrikes(rows, spot, size)`;
  - `displayStrikes` kept as a two-argument wrapper for OI rows;
  - `inRangeStrikes` loosened to `Readonly<{ strike: number }>`;
  - new exports `ExposureStrike` and `StrikeGex`.

  Phase A step 4 (line 281) calls `displayStrikes(rows, spot, row => row.premium)`, but the code calls `selectDisplayStrikes`. A fresh reader following the document produces different code from what is on the branch.
- **Fix:** Rewrite steps 2–4 and the engine row in the Files table to name exactly:
  - `selectDisplayStrikes<Row extends Readonly<{strike:number}>>(rows, spot, size)` (new);
  - `displayStrikes` = `selectDisplayStrikes` with `row => row.callOpenInterest + row.putOpenInterest` (unchanged signature);
  - `inRangeStrikes` constraint loosened;
  - `export type ExposureStrike` and `export type StrikeGex = Omit<ExposureStrike, "holderPayout">`. `gex-context.ts` imports `StrikeGex`, so it must be exported.

**2. 🔴 Blocker — Contract, line 138. The document says premium is "not negative"; the code and the data do not guarantee that.**

- **Problem:** The document specifies `bullishPremium` and `bearishPremium` as "finite, not negative". The working-tree `FlowStrikeSchema` uses plain `finite`. `parseFlow` accepts any finite `premium`, including negative values, and does not clamp them. If the document's nonnegative rule were implemented, one negative vendor premium would make the strict output schema fail and break the whole snapshot.
- **Fix:** State `finite` (sign not enforced) and say why: `parseFlow` keeps the vendor value. Alternatively, specify clamping or skipping negative premiums in `flowStrikes`, with a test.

**3. 🟡 Major — Phase A step 4, lines 279–282. Rows must be sorted before selection; the spot-null rule is not stated.**

- **Problem:** `displayStrikes`/`selectDisplayStrikes` without spot takes `rows.slice(0, 40)`, which assumes rows sorted by ascending strike. The `Map` built from `events` keeps insertion order, and events arrive newest first, so without a sort the spot-null result depends on event order. The working tree does sort (`[...tallies.values()].sort((a,b)=>a.strike-b.strike)`); the document does not say so. The spot-null rule itself ("40 lowest strikes plus the 25 largest") also appears nowhere in the document. Lines 116–119 and the caption on line 174 state only "55 nearest spot".
- **Fix:**
  - Add "sort rows by strike ascending before selection" to step 4.
  - Document the no-spot rule in the Terms or Server additions section.
  - Make the caption on line 174 depend on spot, for example "Up to 80 strikes: the 40 lowest and the 25 largest" when spot is null.
  - Give the expected rows for the `flowStrikes` "spot `null`" test on line 285.

**4. 🟡 Major — Phase A step 3, lines 275–278. Both `exposure()` branches need the payout.**

- **Problem:** Step 3 gives one assignment, `section.strikes = displayStrikes(...).map(...)`. `exposure()` builds `section.strikes` in two places: the no-spot/no-model early return and the main path. Missing either one breaks `holderPayout` on the strict schema. The working tree uses a `withPayout` helper in both places; the document does not mention it.
- **Fix:** Say "in both return paths of `exposure()` (no spot or model, and estimated)". Name the helper (`withPayout(display, oiRows)`) and add a test that the no-spot path also carries `holderPayout`.

**5. 🟡 Major — Phase B step 1, lines 290–294; UX, lines 161–163 and 188–192. A section can be `ok` and still carry a message.**

- **Problem:** The view-model state is `"ok" | "message"`. Both source sections can be `status: "ok"` with a non-null message:
  - flow: "First provider page only (N trades)." (`options-analytics.ts`);
  - exposure: "Open interest shown; GEX needs option-chain IV and a spot price."

  Risk 1 (line 191) requires the first-page message to show on the Volume and Net premium profiles, yet the state type cannot carry both a ladder and a message. Today `SectionShell` shows the message and the children together.
- **Fix:** Return `{ state: "ok" | "unavailable", message: string | null, ... }`. State which exposure message the OI and Max pain profiles show: probably none, since the GEX-IV message is irrelevant to OI bars. Add tests for "ok with message" on both sections.

**6. 🟡 Major — Phase B step 1, line 293; CUJ 4, lines 101–102; lines 117–120. The max-pain marker is undefined.**

- **Problem:** The document never says how `maxPain: boolean` is computed: `row.strike === snapshot.exposure.maxPain`, or the lowest displayed `holderPayout`. Lines 117–120 admit the max-pain strike may not be a display strike, and nothing says what the Max pain profile shows then. Ties are also unspecified (`maxPain` keeps the first lowest).
- **Fix:** Mark the row whose `strike === exposure.maxPain`. When none matches, mark nothing and add a caption suffix such as "Max pain {strike} is outside the shown strikes". Add both cases to the Phase B tests (line 298).

**7. 🟡 Major — Phase B step 1, line 292; Web, line 148; UX, lines 175–177. Bar scaling and the zero case are unspecified.**

- **Problem:**
  - It is not stated whether two-sided profiles share one maximum across puts and calls or scale each side separately.
  - A profile whose largest value is 0 divides by zero. Examples: `size` can be 0 (`parseFlow` falls back to 0), and Net premium is all 0 when every print is neutral.
  - For Max pain, the payouts near spot are tiny next to far strikes, so near-spot bars look identical. This is a design choice the document should make.
- **Fix:**
  - Specify `max = Math.max(...allLeft, ...allRight, ...)` across both sides of the profile (or per side).
  - When `max === 0`, use fractions of 0 and show a message such as "No volume in the prints". The existing panel uses `Math.max(..., 1)` as a guard.
  - State whether Max pain bars are scaled from 0 or from the minimum payout.
  - Add tests.

**8. 🟡 Major — Phase B step 1, line 294. Spot placement is ambiguous.**

- **Problem:** `spotAfter` is defined for spot above, below and missing, but not for spot exactly equal to a strike, nor for strikes on both sides. The rows run from high to low. The GEX table instead highlights the *nearest* row, so "as in the GEX table" (line 296) does not settle it.
- **Fix:** Define it as "the index of the last row whose strike > spot; −1 if none", so a strike equal to spot sits below the line. Add a test for spot equal to a strike. Also give the `spotLabel` format (`Spot ${spot.toFixed(2)}`); the panel header today prints the raw `spot`.

**9. 🟡 Major — Phase B, lines 290–295; UX, line 177. Existing formatters to reuse are not named.**

- **Problem:** The document asks for compact values such as `12.4K` and `$1.2M` but names no helper. In `options-analytics-panel.tsx` there is only the private `money()`, which formats `$1.20M` with two decimals, so it does not match the document. `apps/web/src/features/flow/format.ts` already exports `formatMoney` ("$1.2M") and `formatCount` ("12.4K"). Without a named helper the implementer picks one.
- **Fix:**
  - Name `formatMoney`, `formatSignedMoney` (for net premium) and `formatCount` from `apps/web/src/features/flow/format.ts` for the bar labels.
  - Name `toLocaleString("en-US")` / exact dollars for the `title` and screen-reader text.
  - State that `money()` in the panel is not reused.

**10. 🟡 Major — Phasing, lines 268–303 against the implementation-readiness "each phase buildable" rule.**

- **Problem:** Phase A makes `holderPayout` required on `ExposureStrikeSchema` and `strikes` required on `FlowSectionSchema`, both strict. After Phase A alone, two things break:
  - `apps/web/src/lab/fixtures/market.ts` (`labOptionsAnalytics`) fails `fixtures.test.ts`, which calls `OptionsAnalyticsOutputSchema.parse`, and fails typecheck;
  - the `snapshot()` helper in `apps/web/src/components/portal/options-analytics-panel.test.tsx` (lines 117–140) builds strikes without `holderPayout` and a flow section without `strikes`, so it fails typecheck.

  The fixture is listed but has no phase; the panel test helper update is not described at all.
- **Fix:** Move the fixture fields and the panel test `snapshot()` helper update (`holderPayout` on each strike, `strikes: []` on flow) into Phase A, or add a Phase A step that names both files.

**11. 🟡 Major — Files table, line 265; Web, lines 156–157. The lab fixture's payout must match its max pain.**

- **Problem:** `labOptionsAnalytics` hard-codes `maxPain: atm`. Engine functions are not exported from `@darkfactory/api`: `packages/api/src/index.ts` re-exports only `./contracts/options-analytics.ts`. So the fixture cannot call `holderPayout`, and a payout invented independently could put the lowest bar on a strike other than `maxPain`, breaking the marker in the `/lab` acceptance check (line 310). The fixture also needs `flow.strikes` built from its 10 events (the comment above them says eight) and consistent with them.
- **Fix:** Specify that the fixture computes `holderPayout` with an inline copy of the Terms formula over its 11 rows and sets `maxPain` to the argmin, or keeps `atm` only if it is the argmin. Specify that `flow.strikes` is grouped from the fixture events by the `flowStrikes` rules.

**12. 🟡 Major — Acceptance item 1, lines 307–308. The coverage check has no command.**

- **Problem:** `pnpm exec vitest run` on the changed test files measures no coverage (no `--coverage`). `verify:prepush` (line 309) does not include `verify:coverage` (root `package.json` line 60 against line 58). The 100 % gate is therefore not checked by any listed command.
- **Fix:** Give the exact command: `pnpm exec vitest run --config vitest.config.ts --project unit --coverage --coverage.include=<each changed source file> <test files>`, or `bun run verify:coverage`.

**13. 🟡 Major — Files table, lines 254–266. A doc that describes the panel is missing from the list.**

- **Problem:** `docs/data-sources-and-platform-roles.md`, § "Options analytics on /charts (QuantData)", lists the views the engine computes ("…aggregate open interest, max pain and option flow with hourly premium buckets"). After this change it is incomplete, and the Files table is the write allowlist. The table also does not mark rows Create or Modify. `strike-profiles.ts`, `strike-profiles-panel.tsx` and their tests are new; the rest are modified.
- **Fix:** Add a Modify row for `docs/data-sources-and-platform-roles.md` (per-strike holder payout, flow per strike, "Strike profiles" section), and add a Create/Modify column. Give the exact test file names: apps/web/src/features/charts/strike-profiles.test.ts (draft path), `apps/web/src/components/portal/strike-profiles-panel.test.tsx`, and the existing `options-analytics-panel.test.tsx`.

**14. 🟡 Major — Phase A test plan, lines 284–286; Phase B test plan, line 298. Edge-case tests are missing.**

- **Problem:** No tests are listed for:
  - `flowStrikes` skipping `strike <= 0`;
  - prints with `size 0`;
  - one strike holding both call and put prints;
  - `selectDisplayStrikes` with a custom size (top 25 by premium);
  - `holderPayout` in the no-spot `exposure()` branch;
  - the lowest displayed payout equal to `maxPain` when the max-pain strike is a display strike.

  Phase B lacks: the zero-maximum profile, ok-with-message, max-pain strike not displayed, spot equal to a strike, and the toggle keeping its selection after a flow-window change or refresh (the selection behaviour on symbol or window change is itself unspecified).
- **Fix:** Add these cases explicitly and say whether the selected profile resets when `symbol` changes.

**15. 🟢 Nit — Phase B step 1, lines 290–292. The view-model's types are not given.**

- **Problem:** The `metric` union and the `columns` type are not given.
- **Fix:** Use `type StrikeProfileMetric = "openInterest" | "volume" | "netPremium" | "maxPain"` and `columns: readonly [string, string] | readonly [string]`, with the exact header texts from line 185.

**16. 🟢 Nit — Line 141. "The only reader of the full output" is not accurate.**

- **Problem:** Other readers also see the full output:
  - the `/lab` fixture and `apps/web/src/lab/fixtures/fixtures.test.ts`;
  - `apps/web/src/lab/entries/charts.test.tsx`;
  - `flow-collect.ts`, which reads `context`;
  - the MCP `options_gex_context` tool.
- **Fix:** Reword to "readers of `exposure.strikes` or `flow` rows: the web panel, the lab fixture and their tests; `mcp.ts` and `flow-collect.ts` read named fields only".

**17. 🟢 Nit — Figure 2 caption, line 108; `data-flow.svg`; `before-after-mock.svg`. The figures disagree with the text.**

- **Problem:**
  - The caption says "the server adds two derived lists", but `holderPayout` is a field added to the existing strike rows, not a list.
  - Both figures label the toggle "Net $"; the text (line 166) says "Net premium".
  - The mock shows "spot 512.34"; line 182 says "Spot 512.34".
- **Fix:** Align the wording in the caption and the figures.

**18. 🟢 Nit — Web, lines 147–148. The view-model may belong with the panel.**

- **Problem:** `apps/web/src/features/charts/` holds the chart-workstation modules. The panel it feeds lives in `components/portal/`, and the comparable flow view-model is in `features/flow/`.
- **Fix:** Confirm the location, or move it to `apps/web/src/components/portal/strike-profiles-model.ts`, matching `*-model.ts` siblings such as `calendar-model.ts`.

**19. 🟢 Nit — Rollout, lines 233–237. The deploy steps and rollback are incomplete.**

- **Problem:** The rollout names `restart-when-idle.sh` but not the build stage (`infra/quantvps/stage-build.sh`, `--deploy <sha>`) and gives no rollback. The sibling design `vertex-viz-hedging-pressure/design.md` (lines 328–331) states both.
- **Fix:** Add "stage with `stage-build.sh`, restart with `restart-when-idle.sh --deploy <sha>`; rollback: deploy the previous build, nothing stored changes".

## egm-style

## Style Goldfish review: Detailed Implementation Plan (lines 250-313)

### Summary

The section is short and uses plain, factual language. It has no marketing language, praise or hedging. Most problems come from compressing too much. Several steps use code fragments or names without enough detail, so the implementer has to decide things the plan should settle: a missing `trades` update, an undefined default for `size`, the general rule for `spotAfter`, and test cases with no inputs or expected values. Some file rows in the table have no matching phase step, and two acceptance items conflict with the Goals section.

I checked these claims against the repository:

- `displayStrikes` currently ranks by OI and falls back to `rows.slice(0, 40)` when there is no spot price.
- `data-spot-row` currently marks the nearest-strike row in the GEX table (`options-analytics-panel.tsx:442`).
- `gex-context.ts` names its row type `StrikeOi`, not `StrikeGex`.
- The root script `openapi:generate` wraps `pnpm --filter … exec bun run openapi:generate`.

### Findings

1. 🔴 **Blocker: line 279-283. The `flowStrikes` steps never update `trades`.**
   Line 152 makes `trades` a per-strike field, and the contract requires it (line 172). Step 4 describes how volume and premium accumulate but never mentions `trades`. The implementer has to guess whether it counts prints or contracts, and whether neutral prints and prints with `strike <= 0` count.
   **Fix:** Add "`trades += 1` for every print that is kept, including neutral prints."

2. 🔴 **Blocker: lines 272-274. The default for `size` cannot be written as described.**
   The type bound is `Row extends { strike: number }`. A default that reads call OI plus put OI needs those fields, which this bound does not guarantee. The plan leaves the mechanism open (overloads, a required parameter, or a narrower bound). "For OI rows" does not say how the function tells row types apart. Also, the word `size` already means contracts on a flow print (line 280), so the same word means two things.
   **Fix:** Give the exact signature, for example `displayStrikes<Row extends { strike: number }>(rows: readonly Row[], spot: number | null, rank: (row: Row) => number): Row[]`. Then say "existing callers pass `oiRank = (row) => row.callOpenInterest + row.putOpenInterest`." Rename the parameter from `size` to `rank`.

3. 🟡 **Major: lines 294-295. `spotAfter` is defined only for its edge cases.**
   The three listed cases (spot above every strike, below every strike, no spot) do not give the general rule. The plan does not say what happens when spot equals a strike exactly.
   **Fix:** "`spotAfter` is the index of the last row whose strike is greater than spot (rows sorted from high to low); `-1` when no strike is greater; `null` when spot is `null`. A strike equal to spot counts as below the line."

4. 🟡 **Major: lines 284-286 and 298-299. The test cases name topics, not inputs and expected results.**
   Several test items are labels only:
   - "a two-strike example worked by hand"
   - "neutral handling"
   - "cap of 80"
   - "spot `null`"
   - "toggle with keyboard"

   With `spot === null`, the current `displayStrikes` takes the first 40 rows of a map built in print order. The expected result of that test is therefore undefined unless the rows are sorted first.
   **Fix:** Write each case as input → expected output. For example:

   | Test | Input | Expected |
   | --- | --- | --- |
   | Payout | strikes 100 (call OI 1) and 110 (put OI 2) | `holderPayout(·, 100) = 2000`, `holderPayout(·, 110) = 1000` |
   | Neutral print | one neutral print, premium 500 | adds to `trades` and volume, not to `netPremium` |
   | Cap | 120 distinct strikes | 80 rows returned |
   | Spot `null` | rows sorted by strike before `displayStrikes` | the first 40 by strike |
   | Keyboard | Tab to a toggle, then Enter and Space | the toggle activates |

5. 🟡 **Major: lines 296-297. "As in the GEX table" points to a different element.**
   In the GEX table, `data-spot-row` sits on the strike row nearest spot. Here it would sit on a separate `<tr>` for the spot line. The wording also switches from "spot line" (Terms, UX, line 203) to "spot row". The step names no component and no props, and it leaves out the legend required at line 185.
   **Fix:** "`StrikeProfilesPanel({ snapshot })` renders the toggle row, the caption, a `<table>` with one `<tr>` per row, a spot-line `<tr data-spot-row>` with a single cell `colSpan={columns.length + 1}` inserted after `rows[spotAfter]`, and the legend. On mount, it scrolls that row to the centre using the same code as `options-analytics-panel.tsx:340`." Use "spot line" throughout.

6. 🟡 **Major: lines 262-265 compared with Phases A-C. Some table rows have no phase step, and some paths are inexact.**
   - `options-analytics-panel.tsx` (render after "Gamma exposure and open interest") has no step.
   - `lab/fixtures/market.ts` has no step.
   - `options-analytics.ts` (line 258) has no Phase A step.
   - The phrase "and test" does not give exact paths, which the standard requires for a write allowlist.
   - "strike row type without `holderPayout`" (line 259) does not name the type, which is `StrikeOi`.

   **Fix:**
   - List the test files by exact path, e.g. apps/web/src/features/charts/strike-profiles.test.ts (draft path) and `.../strike-profiles-panel.test.tsx`.
   - Change line 259 to "`StrikeOi = Omit<ExposureSection["strikes"][number], "holderPayout">`".
   - Add Phase B steps for the panel insertion point and the fixture values.
   - Add a Phase A step for `flow.strikes = flowStrikes(events, spot)` that names the full `events` list from line 145, before the newest-100 cut.

7. 🟡 **Major: lines 275-278. The `exposure()` instruction gives one assignment, but the function returns `section` in two branches.**
   `section` is an object literal in two `return` statements: the branch without spot or model, and the GEX branch. `section.strikes = …` reads as a single mutation and invites changing only one branch.
   **Fix:** "In both return branches, set `strikes: displayStrikes(strikes, spot, oiRank).map((row) => ({ ...row, holderPayout: holderPayout(oiRows, row.strike) }))`."

8. 🟡 **Major: lines 310-311 compared with Goal 4 (line 85). The acceptance widths do not match the goals.**
   Goal 4 requires 375, 768, 1024 and 1440 px. Acceptance 3 checks only 375 and 1440. "The `/lab` charts entry" is also not an exact URL.
   **Fix:** Either list all four widths or narrow Goal 4. Give the URL, for example `/lab/charts?theme=dark`, after confirming it from `lab/entries`.

9. 🟡 **Major: lines 291-293. The view-model types are left unspecified.**
   - The type of `metric` is not given.
   - The types of `message`, `caption`, `spotLabel` and `columns` are not given.
   - "Their display texts" and "an accessible label" do not specify field names or formats.

   **Fix:** Write the type:

   ```ts
   type Metric = "oi" | "volume" | "netPremium" | "maxPain";
   type Row = {
     strike: number;
     left: number;
     right: number;
     leftText: string;
     rightText: string;
     label: string;
     maxPain: boolean;
   };
   ```

   Then point `caption`, `spotLabel` ("Spot 512.34") and `columns` to the exact strings in the UX section (lines 189-209).

10. 🟢 **Nit: line 270. "The sum in the Terms section" and "picks the row" are vague.**
    The reference is indirect, and `maxPain` returns a strike, not a row.
    **Fix:** "`holderPayout(rows: readonly OpenInterestRow[], price: number): number` computes the holder-payout formula in Terms. `maxPain` returns the strike with the lowest payout; on a tie, the first row in input order wins, as today."

11. 🟢 **Nit: line 280. "Size adds to `callVolume` or `putVolume`" does not name the field that decides which one.**
    **Fix:** "Add `size` to `callVolume` when `right` is `call`, otherwise to `putVolume`."

12. 🟢 **Nit: line 287 and lines 307-308. The commands do not say where to run them or how to measure coverage.**
    `bun run openapi:generate` behaves differently in the root and in `packages/api`. "Coverage … is 100 %" names no command that measures it.
    **Fix:**
    - "From the repository root: `bun run openapi:generate`."
    - "`pnpm exec vitest run --coverage <files>` reports 100 % lines, branches, functions and statements for every changed source file."

13. 🟢 **Nit: lines 312-313. "On the rig" is undefined, and "shows the section with QuantData data" cannot be checked.**
    The Rollout section calls the host "the QuantVPS".
    **Fix:** "Headless Chrome on the QuantVPS, agent viewer account: all four toggles render either a ladder with at least one strike row or the source section's message, and the Max pain profile marks the strike equal to the GEX section's max-pain value."

14. 🟢 **Nit: line 303. The changelog step gives no exact text.**
    **Fix:** Quote the line, e.g. "- Options analytics: Strike profiles section (OI, volume, net premium, max pain by strike)." State that it goes under `## [Unreleased]`.

15. 🟢 **Nit: lines 256-266. The "Change" column is too terse to act on.**
    Entries such as "regenerated", "view-model", "section component", "fixture fields" and "one line" name a topic, not a change.
    **Fix:** Use verb phrases, for example "add `buildStrikeProfile`", "add `StrikeProfilesPanel`", or "add `holderPayout` and `flow.strikes` to the snapshot fixture".
