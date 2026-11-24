# Comprehension review (Stage 6): `vertex-viz-strike-profiles/design.md`, lines 1–313

I read the document with no document standard and did not open the two figures. I checked a few claims against `options-analytics-engine.ts`, `options-analytics.ts` and `gex-context.ts`.

**Summary:** A newcomer can follow the proposal as a whole: one toggled bar ladder with four profiles, built from data the snapshot already fetches. Three things stop full understanding:

- **Undefined names.** Several product and infrastructure names are never defined: QuantData, Vertex, GEX, card, EGM, `/lab`, MOCK, QuantVPS, rig, MCP tool, flow collector.
- **Two edge cases with no stated behaviour:**
  - The max-pain strike falls outside the 80 display strikes.
  - There is no spot price. The caption's "55 nearest spot" rule then does not hold.
- **Two connections in the build plan are not explained:**
  - Why the engine keeps two strike lists (`ExposureEstimate.strikes` and `section.strikes`), which is why `gex-context.ts` changes.
  - How a section can be `ok` and still show a "first provider page" note, when the view-model `state` has only two values.

## Paraphrase: what the document proposes

The analytics panel on `/charts` and on the stock page's Analytics tab gets a new section, "Strike profiles". It is one vertical list of strikes ("strike ladder"), highest at the top. A horizontal "Spot" line sits between the two strikes that bracket the current price. Four toggle buttons switch the bars between four profiles:

- **Open interest:** puts as a bar to the left, calls to the right.
- **Volume:** contracts in the vendor's "flow prints" for the chosen time window, puts left, calls right.
- **Net premium:** bullish minus bearish premium, one signed bar.
- **Max pain:** the total payout to option holders if the price settles at each strike. The lowest bar is labelled "max pain".

All inputs already come from the panel's single snapshot request, so there are no new vendor calls. Each profile has a caption that states its source and limits (all expiries summed, flow prints are not exchange volume, at most 80 strikes). The section must work on phones, in light and dark mode, and with screen readers. It is a research view only: it has no trading actions.

## Paraphrase: how it will be built

The server's read path does not change. The engine module gets two new pure functions:

- **`holderPayout`.** It computes each display strike's payout over all OI rows and attaches it to the exposure section's strike rows. `maxPain` is rewritten to use the same function.
- **`flowStrikes`.** It groups every parsed flow print of the window by strike, before the list is cut to the newest 100 events. Per strike it sums call and put volume, bullish and bearish premium, net premium and trade count. It then keeps 80 strikes, using the same "nearest spot plus largest" rule with total premium as the size.

Supporting changes on the server side:

- `displayStrikes` and `inRangeStrikes` become generic so they accept a size function.
- The output contract gets `holderPayout`, a new `FlowStrikeSchema` and `flow.strikes`, and OpenAPI is regenerated.

On the web side:

- A pure view-model turns the snapshot into ladder rows for one profile. Each row has left and right bar fractions, a spot-line index and a max-pain flag.
- A new component draws the toggles, the caption and an accessible table in a scroll box centred on spot.
- The section is placed after the GEX section, and the `/lab` fixture gets mock values.

Acceptance requires unit tests at 100 % coverage, the prepush verification, headless-Chrome screenshots of `/lab`, and a live check after deploy.

## Findings

### 1. 🟡 Major: Project-specific systems are named but never defined

**Lines:** 1, 4, 7–8, 10, 30, 88, 142, 156, 239–241, 310, 313

**Problem:** These names are used as if the reader already knows them:

- Vertex
- QuantData (the vendor that every profile depends on)
- GEX (expanded only indirectly at line 154 as "Gamma exposure")
- "card", "research card", "owner card" and "gap report"
- EGM
- `/lab` and "MOCK"
- QuantVPS and `vertex-web`
- "trading unit"
- "the rig" and "agent viewer account"
- "the MCP tool (`mcp.ts`)" and "the flow collector"

A newcomer cannot tell what QuantData is, what reads the API besides the panel, or where acceptance step 4 runs.

**Fix:** Add a short "Context" entry for each name to the Terms section (line 43ff). Examples:

- "QuantData: third-party options data vendor; Vertex calls its REST API with a shared quota."
- "GEX: gamma exposure; the existing 'Gamma exposure and open interest' section."
- "`/lab`: a page that renders panels against fixture (MOCK) data."
- "MCP tool: the agent-facing tool that returns snapshot fields."
- "Flow collector: the job that stores prints in `flow_option_prints`."

Explain "rig", "agent viewer account" and "trading unit", or link to them.

### 2. 🟡 Major: No stated behaviour when the max-pain strike is outside the 80 display strikes

**Lines:** 101–102, 121–123, 293

**Problem:**

- Line 123 admits that the lowest displayed payout matches `maxPain` only "whenever the max-pain strike is a display strike".
- Journey 4 (line 101) nevertheless promises that the shortest bar is marked "max pain" and equals the GEX number.
- The view-model's `maxPain` boolean (line 293) does not say where it comes from: the lowest displayed payout, or equality with `snapshot.maxPain`.

A reader cannot tell what appears when the true max-pain strike is filtered out. The display pool is limited to 50–150 % of spot, so this can happen.

**Fix:**

- State that the marker is set only on the row whose `strike === exposure.maxPain`.
- When no displayed row matches, show a caption note such as "Max pain strike X is outside the displayed strikes".
- Add a test for this case.
- Alternatively, always include the max-pain strike in the display set.

### 3. 🟡 Major: The "55 nearest spot" rule and the spot-missing case contradict each other

**Lines:** 118–120, 131–134, 174, 181–182, 285

**Problem:** The caption under every profile says "the 55 nearest spot and the 25 largest". Line 182, however, allows spot to be missing.

The current `displayStrikes` does not apply a "nearest" rule without spot. It takes the first 40 rows plus the top 25. For `flowStrikes`, the "first 40" are in `Map` insertion order, which is effectively arbitrary.

In addition, "the 25 largest" are chosen only from strikes within 50–150 % of spot, and the caption does not say "largest what". The answer is OI for two profiles and total premium for the other two.

**Fix:**

- Define the selection rule completely, including the no-spot case. For example, sort the flow rows by strike before taking any, or use the 80 largest when spot is missing.
- Make each profile's caption state the rule it actually uses, for example "the 25 largest by open interest" or "the 25 largest by premium".
- Mention the 50–150 % range.

### 4. 🟡 Major: The view-model's two-value `state` cannot show the "first provider page" note that Risk 1 promises

**Lines:** 161–163, 188–191, 291

**Problem:** The UX section says a profile shows its message *instead of* the ladder when the section is not `ok`. Risk 1 says the "first provider page" message also shows on Volume and Net premium.

In the code, that message is set while the flow status is `ok`. A partial first page is not an error state. `buildStrikeProfile` returns `state: "ok" | "message"`, so the reader cannot tell how "ladder plus warning note" is represented.

The status values themselves (`ok`, `empty`, `unavailable`) are also never listed.

**Fix:**

- List the section statuses.
- Specify two separate cases:
  - Status `ok` with a non-null message: draw the ladder and show the message as a note under the caption.
  - Any other status: show only the message.
- Add a `note` field to the view-model, and a test for this case.

### 5. 🟡 Major: The reason for two strike lists and the `gex-context.ts` change is not explained

**Lines:** 259, 274–277

**Problem:** Phase A step 3 introduces two lists without saying why both exist:

- `ExposureEstimate.strikes` holds the in-range strikes and feeds GEX context.
- `section.strikes` holds the display strikes and goes to the output.

It also introduces a new type `StrikeGex = Omit<…, "holderPayout">`. The file table (line 259) says only "strike row type without `holderPayout`". A newcomer cannot see why `gex-context.ts` must change or what would break otherwise.

**Fix:** Add one or two sentences to "Server additions":

- The exposure engine produces the in-range rows (used for GEX totals, walls and the flip in `gex-context.ts`) and a capped display subset (sent to the browser).
- Only the display subset gets `holderPayout`, so the GEX-context row type is narrowed to omit the field.

### 6. 🟢 Nit: The bar-scale rule is ambiguous for two-sided and signed profiles

**Lines:** 148–149, 176–178, 292–293

**Problem:** "Fractions of the largest value in the profile" does not say whether the call and put sides share one maximum. For Net premium, it does not say whether the scale uses the largest absolute value, or that one of `left`/`right` is always 0.

**Fix:** State the rules:

- Two-sided profiles use one scale, the maximum over both sides.
- Net premium scales by the maximum of |net| and fills only one side.
- Max pain scales by the maximum payout.

### 7. 🟢 Nit: The accessible table's columns per profile are unclear

**Line:** 184–185

**Problem:** "`Strike`, `Puts` or `Negative`, `Calls` or `Positive`, or `Payout`" packs three layouts into one phrase.

**Fix:** Give a small table with one row per profile:

- Open interest and Volume: Strike / Puts / Calls.
- Net premium: Strike / Negative / Positive.
- Max pain: Strike / Payout.

### 8. 🟢 Nit: Figure 2's caption says "two derived lists", but the text describes one field and one list

**Line:** 108

**Problem:** `holderPayout` is a field added to existing rows. Only `flow.strikes` is a new list.

**Fix:** Reword to "adds payout per strike and a per-strike flow list".

### 9. 🟢 Nit: Some terms are used before they are defined, or are left implicit

**Lines:** 30, 50–51, 73, 97, 104

**Problems:**

- "first provider page" (line 73) is explained only later, at line 190.
- "sweep or block" and "right" (line 51) are trading jargon that a non-options reader may not know.
- "exposure section" and "flow section" are parts of the snapshot output but are not in Terms.
- "sets the flow window to 6 h" (line 97) assumes a window control that the document does not locate.
- `optionsAnalytics.snapshot` is not identified as an API procedure, and its framework is not named.

**Fixes:**

- Add "Exposure section" and "Flow section" to Terms.
- Gloss "sweep" and "block" in a few words each.
- Explain "first provider page" when Goals first mentions it.
- Say where the existing window selector is.
- Name the API framework the procedure uses.

### 10. 🟢 Nit: Small `flowStrikes` behaviours are not stated

**Lines:** 131–135, 281–283

**Problem:** The document does not say:

- whether `trades` counts neutral prints;
- what happens when a print's strike lies exactly on spot;
- why `strike <= 0` events are skipped (bad data?).

**Fix:** Add a short sentence for each:

- "`trades` counts all prints, including neutral."
- "When spot equals a strike, the line is drawn below that row."
- "Prints with a strike of 0 or less are vendor rows without a strike and are dropped."

### 11. 🟢 Nit: The rollout restart window is not explained

**Lines:** 239–241

**Problem:** The document does not say why `vertex-web` may restart only outside 08:30–16:00 ET, or who runs `restart-when-idle.sh`.

**Fix:** Add "(outside US market hours, so live users and trading processes on the same host are not disrupted; run by the deployer)", or link to the runbook.
