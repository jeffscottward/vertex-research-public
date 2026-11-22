# Stage 7: Critic Review

Target: design.md lines 1-167 (FeatureRange of the draft). Reviewers: egm-design, egm-structural (feature-spec-standard), egm-style (direct dispatch). All completed.

## egm-design

### Critic review (Stage 7): `design.md`, Feature Range lines 1–167

I checked the design against `feature-spec-standard.md`, the mock SVG, and the repository (read-only). The document does most of what the standard asks: it has a problem statement, goals, non-goals, an architecture and contract, and a risk table. It falls short on the Alternatives Rule and on several risks it does not state. The findings below are ordered by severity.

#### 🔴 Blocker

None. The change is read-only research tooling with no trading path, so no finding stops progress on its own. F1 and F2 should still be fixed before implementation.

#### 🟡 Major

F1. Incomplete sessions from the collector's gap backfill are not modelled

- **Lines:** 13, 59, 87–92 (rules 6 and 7), 114–115 (header line), 143 (`storedUntil`), 151–159 (risks).
- **Discrepancy:** The QuantData collector caps each run at `FLOW_OPTION_PAGES_MAX = 6` pages. It records skipped time ranges in `flow_option_gaps` and fills them later, newest first (`packages/api/src/server/flow-collect.ts` ~lines 145 and 950–974; `flowOptionGaps` in `packages/db/src/schema/flow.ts`).
  - So a session can have holes in the middle while its newest print is current.
  - The design treats "newest counted print" as the only completeness signal (`storedUntil`, "as of").
  - It never reads `optionGaps(symbol)`.
- **Rationale:** The line is a running sum. A hole shifts every later point, and when the backfill arrives the earlier line changes after the fact. The header would still say the data is fresh and up to date.
- **Fix:**
  - Add a rule that reads the open gaps that overlap the session (the `optionGaps` repository method already exists).
  - Expose them in the contract, for example `gaps: [{start, end}]` and `complete: boolean`.
  - Mark gap spans on the chart and say "incomplete" in the header.
  - Add a risk row: "collector page cap leaves unread ranges → line understated until backfill".
  - Line 13 also says "stores every option print". Correct it, because the $10,000 floor and the page-cap gaps both contradict it.

F2. The meaning of the line is overstated: it ignores re-hedging as price moves (gamma)

- **Lines:** 27–31, 15–16, 151–159.
- **Discrepancy:** The definition says the hedge notional is what the dealer "must buy or sell to stay delta-neutral after the print". The running sum uses each print's delta at trade time and never recomputes it. A dealer's real hedge need for earlier prints changes as spot and time move. So the line measures "signed delta of the flow at trade time", not dealer hedging pressure. The Problem section (lines 15–16) says it answers whether the prints "push dealers to buy or to sell … and when".
- **Rationale:** This is a hidden modelling assumption that changes how a reader interprets the chart, which the standard requires a spec to state. It matters most on 0DTE-heavy SPX days, where gamma is largest.
- **Fix:**
  - Reword the definition to "delta notional at print time".
  - Add a risk row: "no re-hedging for spot or time moves; earlier prints' delta is frozen".
  - Add one sentence to the rule text on screen.
  - Optionally list "re-mark open-session prints' delta at each minute" as a rejected alternative, with its cost: about 25k prints × 975 minutes.

F3. The Alternatives Rule is met only for the delta source

- **Lines:** 94–100; the whole architecture.
- **Discrepancy:** The only alternatives table is for delta. Several other design choices are a single path with no rejected options:
  - Compute on read every 60 s versus building per-minute aggregates at collection time, or caching closed sessions (past sessions never change).
  - Server-side fold versus an SQL aggregate versus the client.
  - The sign rule (side-based) versus the stored vendor `sentiment` column. Mid prints are dropped rather than half-weighted, or signed by `price` against the stored `bid`/`ask`.
  - A calendar-date session versus a trading session (see F5).
- **Rationale:** The standard says a spec "fails this standard if it proposes a single path without proving that other viable designs were considered and rejected". Each rejection needs a concrete trade-off.
- **Fix:** Add an "Alternatives considered" section that covers at least compute strategy, sign rule and session definition. Give each rejection a specific reason, for example "materialized table needs a migration, against goal 2" or "`sentiment` is vendor-opaque".

F4. The deep in-the-money claim for the IV placeholder has no evidence, and the fallback could be badly wrong near the money

- **Lines:** 62, 79–82, 98, 158.
- **Discrepancy:**
  - The text asserts the 0.0477 placeholder appears "on deep in-the-money options", so a volatility of 0.01 gives the correct delta of about ±1.
  - No moneyness breakdown supports this, although the table stores `moneyness` and `moneyness_pct`.
  - This is 6,309 ES prints, about 5% of ES rows.
  - At volatility 0.01, any near-the-money or out-of-the-money print gets a delta that jumps to 0 or 1. On ATM prints that is a large notional error, and the line would still show it as "IV limited".
- **Fix:**
  - Add the moneyness distribution of the placeholder prints to the Data facts table.
  - If any are not ITM, change rule 3: count non-ITM placeholder prints as "not priced", or use an alternative volatility such as that session's median IV for the expiry.
  - Update the risk row to match.

F5. A calendar-date session does not match the ES trading session, and squeezes regular hours on the chart

- **Lines:** 65, 70–71, 116–117, 146.
- **Discrepancy:**
  - ES (SPX) prints run from 00:00 ET. SPX global trading hours actually open at 20:15 ET on the previous evening, so line 65 either shows a collector or vendor day boundary, or evening prints exist that would be added after 16:15 to the wrong session.
  - The x-axis spans the first to the last print minute, so ES covers 00:00 to 16:15. Regular hours then take only about 40% of the chart width, on top of a sparse overnight build-up.
  - SPY and ES therefore show different time ranges for the same S&P group.
- **Fix:**
  - State the overnight behaviour: either verify there are no evening prints, or define the session as the trading session.
  - Choose an axis policy: regular hours by default with overnight shown as an opening value, or both shown with a marked 09:30 boundary.
  - Add a fixture for this case.

F6. Using rate 0 and dividend yield 0 has no stated reason and conflicts with the repo's own convention

- **Lines:** 76–78, 141.
- **Discrepancy:**
  - The options chain uses `OPTIONS_CHAIN_RISK_FREE_RATE = 0.04` and per-symbol `dividendYield` (`packages/api/src/options-chain-merge.ts:62, 263–264`).
  - The design hard-codes 0 for both and gives no reason.
  - For long-dated SPY or SPX prints, which can be large collars and LEAPS, a 4% rate moves d1 by about 0.2 at IV 20% and one year. That shifts delta by roughly 0.05–0.08.
- **Fix:** Either reuse the chain's rate and dividend facts, or justify the zeros (0DTE dominance with a measured delta error) and add a risk row.

F7. A risk mitigation refers to fields the spec does not define

- **Lines:** 121–127 versus 145 versus 156.
- **Discrepancy:**
  - The multi-leg risk row says "the aria label and the totals name the largest minute".
  - The Totals line (121–123) and the `totals` contract field (145) contain no largest-minute value.
  - The aria label says "largest rise and fall of the net line". That could mean the largest one-minute change or the largest peak-to-trough move.
- **Fix:**
  - Add `largestRise` and `largestFall` (minute, minuteNet) to `totals` and to the Totals line.
  - Define them as one-minute `minuteNet` extremes, the definition the detailed plan already implies.

#### 🟢 Nit

F8. A single bad row can fail the whole panel (lines 76–85).

- `bsDelta` throws on non-finite input (`requireFinite` and `check` in `pricing.ts`).
- PostgreSQL `double precision` can store NaN or Infinity.
- The clamp `min(max(NaN, 0.01), 5)` evaluates to NaN.
- Fix: extend rule 4 so that any non-finite IV, spot, strike or time, or any thrown delta, counts as "not priced".

**F9. Read cost is measured as database execution only (lines 66 and 159).** The 15 ms figure excludes transferring and deserializing about 25.7k rows, plus 25.7k Black-Scholes calls, for every open page and every agent each 60 s.

- Fix: report end-to-end handler latency.
- Note that past sessions (`date` < today) never change and can be cached by `(symbol, session, newest print id)`.

F10. ES units and basis (lines 14, 120, 141).

- For ES the line is SPX index notional and Chart 2 shows the SPX price.
- `FLOW_INSTRUMENTS.ES.note` says other ES context shifts SPX levels by the ES − SPX basis.
- Fix: label the chart "SPX options · SPX price (not ES)", or apply the basis, so it is not read next to ES-priced panels without comment.

**F11. Line colours carry the wrong meaning (lines 116–118).** Calls use the success colour and puts the destructive colour. A put line can be positive (dealers buying) and a call line negative, so green and red mislead. Fix: use neutral palette tokens and keep the dash and dot patterns.

**F12. The 1,440-point cap does not fit the DST fall-back day (lines 70 and 146).** A New York calendar date with a DST change has 1,500 minutes. In practice the change falls on a Sunday with no prints, so this cannot happen today. Fix: say so, or derive the cap from the session bounds.

**F13. Vendor greeks are asserted without evidence (line 50 versus line 99).** Non-goal line 50 says QuantData sends greeks in flow rows. Option B (line 99) says the field name and units are not verified. Fix: cite a sample payload or soften the claim.

**F14. "Gross" is ambiguous (line 121).** It could be the sum of the absolute end values or the sum of absolute per-print notional. Fix: define it explicitly.

**F15. The `date` input has no use in the UI (lines 135 and 148).** Version 1 has no multi-session view, so `date` is only for agents or the API. Fix: state that, or drop it from the version 1 input.

## egm-structural

I audited lines 1–167 (FeatureRange) against `feature-spec-standard.md` and found 2 🔴 Blockers, 5 🟡 Majors and 7 🟢 Nits. I also compared the section layout with three sibling designs in the same folder (`vertex-viz-tape-speed`, `flow-control-signals`, `smart-money`). All three use the same house section template; this document does not. The design folder holds only `design.md` and `before-after-mock.svg`; there is no `concepts_brief.md`.

**Heading map of lines 1–167.** One H1 (L1), then eleven H2s: Problem (L11), Terms (L19), Goals (L35), Non-goals (L45), Data facts (L54), Rules (L68), Delta source (L94), User experience (L102), Contract (L131), Risks (L151) and Rollout (L161). There are no H3s, so no heading level is skipped. All five tables have consistent column counts and no broken borders. Every code fence is closed. FeatureRange ends on the blank line just before `## Detailed Implementation Plan` at L168.

---

### 🔴 Blockers

S-01 — No "Alternatives Considered" section for the feature as a whole

- **Lines:** 94–100 (the only alternatives content).
- **Discrepancy:** The standard's Alternatives Rule requires the spec to show that other workable designs were considered and rejected. The only comparison here is three ways to get delta (A/B/C) under `## Delta source`. Nothing compares the overall design, for example:
  - computing on each read versus storing per-minute sums written by the collector;
  - adding a new procedure versus adding keys to `flow.snapshot` (sibling tape-speed Alternative G covers exactly this);
  - computing on the server versus in the browser;
  - refreshing every 60 s versus streaming or caching;
  - showing one combined dealer-flow line versus separate call and put lines.
- **Also in the table:** Option B's decision cell says "Later…", which is a deferral, not a rejection. Option C's decision cell says only "Rejected"; the reason has to be read out of the "Against" column.
- **Rationale:** The standard fails any spec that proposes a single path without documented, specific rejections. All sibling designs have `## Alternatives Considered` with an `### Alternative X: …` heading for each option.
- **Fix:**
  - Add `## Alternatives Considered` with one `### Alternative X: <title>` per option. Each should state the option, the concrete trade-off and the reason it was rejected.
  - Move the three delta options in as alternatives (or keep the table and add a pointer to it).
  - Change B and C so the decision cell carries the rejection reason, for example "Rejected for v1: needs a migration, and the 14 stored days have no vendor delta."

S-02 — No "Proposed Architecture" or data-flow section

- **Lines:** whole range; the pieces are scattered across L68–92, L102–129 and L131–149.
- **Discrepancy:** The standard asks for component layout, data flows and how the feature fits the existing system. The document gives the rules, the screen behaviour and the API contract, but never says which modules take part or how data moves between them. A reader cannot tell:
  - which server module and which DB read function query `flow_option_prints`;
  - where `bsDelta` is called;
  - which web component and view-model render the panel;
  - how the panel's own call fits the 60 s refresh of `/flow`.

  That information appears only in the Detailed Implementation Plan (L168 onward), which is outside FeatureRange. Sibling designs use `## Technical Plan (Architecture)` plus a `data-flow.svg` figure.
- **Rationale:** A Goldfish reader limited to the feature range cannot see how the parts connect.
- **Fix:** Add `## Technical Plan (Architecture)` before Contract with H3s such as "Read path", "Computation (pure rules)", "Procedure" and "Page". Add a data-flow figure: `flow_option_prints` → server read (with the read cap) → rules module (`bsDelta`) → `flow-hedging-pressure.v1` → `/flow` panel. Move the existing Rules and Contract sections in as H3s.

---

#### 🟡 Majors

S-03 — Risks section lacks security, failure-mode and scalability coverage, and the heading differs from the standard

- **Lines:** 151–159.
- **Discrepancy:** The heading is `## Risks`; the standard and every sibling design use "Risks and Mitigations" (or "Risks & Mitigations"). The table covers modelling and estimate risks plus read cost. The standard also asks for the following, none of which is in the table:
  - **Security:** a new GET endpoint is open to the "agent read key", and the `date` input needs validating.
  - **Failure modes:**
    - collector stopped, or the options source stale or "never", so the line silently shows an old session;
    - a database timeout;
    - a truncated session being mistaken for a complete one.
  - **Scalability limits:** load grows with the number of open pages times one read every 60 s; the worst case is a 200,000-row read; each response holds up to 1,440 points.
- **Fix:** Rename the heading to `## Risks and Mitigations` and add rows for each item above, each with a mitigation.

S-04 — Departs from the house design template that every sibling uses

- **Lines:** whole range.
- **Discrepancy:** These sections, present in all three siblings, are missing:
  - `## Overview`;
  - `## Open Questions` — for example, Option B's "field name and units not verified" at L99 is an open item left inside a table;
  - `## Critical User Journeys (CUJs)` — the screen states at L108–110 read like CUJs but are not structured as journeys;
  - `## Non-Functional Requirements` — these are spread across Goal 4 (L42–43) and Accessibility (L123–125);
  - `## Additional Resources`;
  - `## Future Improvements` — the version-1 exclusions at L52 belong here.
- **Rationale:** Reviewers and tooling expect the same section skeleton in every design folder; this breaks that symmetry.
- **Fix:** Restructure to the sibling order: Overview (with Terms as an H3) → The Problem → Goals → Non-Goals → Open Questions → CUJs → Technical Plan (Architecture) → Risks and Mitigations → Alternatives Considered → Non-Functional Requirements → Additional Resources → Future Improvements → Detailed Implementation Plan.

S-05 — The source link points at a private host and cannot be followed

- **Line:** 5.
- **Discrepancy:** The gap report link goes to `<internal report link, private tailnet>`, a private tailnet host. The repository is named `vertex-research-public`, so a fresh reader cannot open it. The research card `vertex-flow-viz-gap` and chart O28 are named but not linked.
- **Fix:** Link a copy committed to the repo (relative path), or quote the relevant row of the gap report. Under Additional Resources, mark the tailnet URL as internal-only.

S-06 — The mock and the text disagree

- **Source:** GoldfishContext `before-after-mock.svg` against L106–122.
- **Discrepancy:**
  - L113 specifies "Three **stepped** lines". The mock draws all three as straight-segment polylines, not steps.
  - L111 specifies a header line with "as of" time and source freshness; the mock shows only "SPX options · 2026-11-20".
  - L115 specifies signed compact dollar y-axis labels (for example "+$1.2B"); the mock has no axis labels.
  - L118–122 specify a totals line and a rule-text paragraph; the mock has only a one-line caption.
  - Goal 4 (L42–43) names light theme and 375 px width; there is a single dark mock at 960 px.
  - The image is embedded at L9 with alt text "Before and after (MOCK)". It is never referenced from the body and does not follow the sibling caption form `Figure N. …`.
- **Fix:**
  - Make the mock match the spec: stepped lines, the header line, y-axis labels and the totals line.
  - Alternatively, state under User experience which elements the mock leaves out.
  - Rename the alt text to "Figure 1. Before and after: …" and refer to "figure 1" from the User experience section.
  - Optionally add a narrow, light-theme figure.

S-07 — Section order puts implementation detail before the design

- **Lines:** 54–100 come before 102–149.
- **Discrepancy:** Data facts (raw measurements) and the Rules (computation spec) come before the User experience and Contract sections. The delta alternatives (L94) sit between the Rules and the UX. A reader meets formulas before learning what the feature shows.
- **Fix:**
  - Move Data facts under Technical Plan as `### Measurements`, as `flow-control-signals` has a "Measurements" section.
  - Move Rules under Technical Plan.
  - Move Delta source into Alternatives Considered.
  - Put the UX/CUJs immediately after Goals and Non-Goals.

---

##### 🟢 Nits

**S-08 — Metadata block (L1–7):** Status, date and author are one inline sentence (L3), and there is no baseline commit. Siblings use a bulleted Author/Status/Date/Baseline commit block. Fix: switch to that block and add the baseline commit and branch.

**S-09 — Heading names (L11, L45):** `## Problem` and `## Non-goals` should be `## The Problem` and `## Non-Goals`, as in the siblings. Fix: rename both.

**S-10 — Goals and Non-goals use different list styles (L37–52):** Goals is a numbered list; Non-goals uses bullets. Fix: use the same list style in both.

**S-11 — Broken cross-reference (L50):** The Non-goal says the collector drops greeks and the stored days have none, "(section 'Delta source')". The Delta source section never says the collector drops greeks; Option B says only "stored days stay empty". Fix: state the collector fact in Delta source, or point to the right section.

**S-12 — Terms used but not defined (L47, L52, L54, L65, L100, L133):** "confluence vote", "0DTE", "QuantVPS", "ET", "GEX" and "agent read key" are used without definition. Fix: add them to Terms, or link where they are defined.

**S-13 — Inconsistent line wrapping (L32):** This prose line is 148 characters long; the rest of the prose wraps at about 100. Fix: rewrap.

S-14 — Contract input/output asymmetry and inexact number (L133–149, L87–88):

- The input is described in prose while the output gets a table. Errors (L148–149) are a trailing paragraph rather than their own subsection.
- Rule 7 says the 200,000 read cap is "eight times the busiest stored day". In fact 8 × 25,688 = 205,504.

Fix: add an input table (field, type, required) and a `### Errors` subsection. Correct the multiple to "about 7.8 times", or drop it.

## egm-style

The FeatureRange (lines 1–167) has 6 Major and 9 Nit findings. Most are claims that go further than the cited evidence, and the worst ones would reach the screen as user-facing text. I checked each claim against the repository read-only before flagging it.

### 🔴 Blocker (egm-style)

None.

#### 🟡 Major (egm-style)

**S1. "Stores every option print" contradicts the vendor premium floor** — lines 13–14 (against lines 60, 157)

- **Discrepancy:** Line 13 says Vertex stores "every option print of SPY options and SPX options". Line 60 says only prints of $10,000 or more arrive. Line 157 says "the vendor floor of $10,000 drops small prints".
- **Rationale:** The Problem statement opens with a claim the document itself refutes. A fresh reader would assume the line covers all option volume.
- **Fix (CALIBRATE):** "Vertex stores the SPY and SPX option prints that QuantData returns (premium $10,000 or more) in `flow_option_prints`, …"

**S2. The "vendor premium floor" is an inference, but the screen states it as a fact** — lines 40–41 (Goal 3), 60, 124, 157

- **Discrepancy:** The only evidence is that the smallest stored premium is $10,000 for both symbols over the stored days. `packages/api/src/flow-options.ts` parses `order-flow/consolidated` rows. Nothing in that file or the collector shows a vendor-documented floor. The Rule text (line 124) will show users "the $10,000 vendor floor" as established vendor behavior.
- **Rationale:** An observed minimum over 12 calendar days does not prove a vendor contract. The text goes out on the screen, so the unverified claim reaches users.
- **Fix (CALIBRATE):**
  - Line 60: "$10,000 for both symbols (smallest stored premium; consistent with a QuantData minimum, not confirmed in vendor documentation)".
  - Lines 40, 124 and 157: "the $10,000 minimum premium of the stored prints", or cite the vendor document if one exists.

**S3. "Must hedge" is stated as a fact although rule 2 calls it an assumption** — lines 14–15, 17–18, 27–29

- **Discrepancy:** Line 15 says "the stock or futures trading that option dealers must do to hedge those prints". Line 28 says "the dollar value of underlying that the dealer must buy … or sell … to stay delta-neutral". Line 17 asks "did the option prints push dealers to buy or to sell". Rule 2 (lines 75–76) says the dealer side "is an assumption, not a fact of the data". The Risks table (line 155) says the line can have the wrong sign.
- **Rationale:** The definitions assert dealer obligation and causation that the rules then disclaim. The calibrated statement belongs at the definition, not only in a later rule.
- **Fix (CALIBRATE):**
  - Line 15: "an estimate of the underlying trading dealers would do to delta-hedge those prints".
  - Line 28: "the estimated dollar value of underlying the dealer would buy (positive) or sell (negative) to stay delta-neutral, assuming the dealer took the other side (rule 2)".
  - Line 17: "estimates one thing: during this session, did the signed option prints imply dealer buying or selling of the underlying, and when?"

**S4. The Risks mitigation names a "largest minute" that no specified element shows** — line 156 (against lines 121–123, 125–126, 141)

- **Discrepancy:** The mitigation says "The aria label and the totals name the largest minute". Line 126 specifies the aria label naming "the largest rise and fall of the net line", not the largest minute. The Totals line (lines 121–123) and the `totals` contract field (line 141) contain no largest-minute value.
- **Rationale:** The mitigation describes behavior the design does not specify, so the risk is recorded as mitigated when it is not. "Moves the line a lot" and "dominate" are also unmeasured. The example "133,500 SPY puts at 16:03 ET" has no date, so it cannot be checked.
- **Fix (CALIBRATE):** Choose one:
  - Add `largestMinute` (minute, minuteNet) to `totals` and to the Totals line.
  - Or change the mitigation to "The aria label names the largest rise and fall of the net line".

  Then replace "moves the line a lot" with a measured figure, for example "one minute's net was N% of the session gross on 2026-11-DD", and add the date to the collar example.

**S5. "14 stored days" is a retention window, not a count of stored data** — lines 47, 98

- **Discrepancy:** Line 47 says "the 14 stored days have none". Line 98 says "works on all 14 stored days". The Data facts table (line 58) gives the stored range as 2026-11-09 to 2026-11-20, which is 12 calendar days and about 10 sessions, and calls 14 days the retention.
- **Rationale:** The prose overstates the evidence the delta decision rests on.
- **Fix (CALIBRATE):**
  - Line 47: "the stored rows (2026-11-09 to 2026-11-20) have none".
  - Line 98: "works on every stored print".

**S6. Goal 4 claims are not matched by any specification or check** — lines 43–44 (against lines 125–127, 165–166)

- **Discrepancy:** Goal 4 promises system theme support, four widths (375, 768, 1024, 1440 px) and keyboard access. The User experience section describes no keyboard behavior; the charts are `role="img"` with nothing focusable. Line 127 says "Text meets contrast in light and dark themes" and omits the system theme. The post-deploy check (line 166) covers only 375 and 1440 px, dark and light.
- **Rationale:** The goal states coverage that neither the design nor the stated verification supports. "Meets contrast" names no threshold.
- **Fix (CALIBRATE):**
  - Line 127: "Text meets WCAG AA 4.5:1 (MASTER.md theme tokens); chart strokes meet 3:1 against the card in every theme".
  - Add one keyboard sentence, for example "the panel has no interactive control; the retry needs none", or name the focusable element.
  - Either widen the line 166 check to all four widths and the system theme, or say that 768 px, 1024 px and system theme are covered by tests in the Detailed plan.

#### 🟢 Nit (egm-style)

**S7. "Which is the delta of such an option" is too strong** — lines 80–81

- The low volatility only approximates the delta of a deep in-the-money option.
- Line 61 does not show that every print with IV below 1% is deep in the money: 6,309 ES and 988 SPY prints are attributed to the placeholder without a moneyness check.
- **Fix (CALIBRATE):** "…gets volatility 0.01 and so a delta near 1 or −1, close to the delta of a deep in-the-money option."

**S8. "Eight times" is rounded up** — line 90

- 200,000 ÷ 25,688 = 7.8.
- **Fix:** "about 7.8 times the busiest stored day".

**S9. The 15 ms figure is database execution only** — line 159

- The Risks row says "15 ms measured for the busiest day". Line 64 measured database execution only, not the full procedure (Black-Scholes on 25,688 rows plus serialization).
- **Fix (CALIBRATE):** "15 ms database execution measured for the busiest day; compute time not measured".

**S10. "Large prints only" is undefined** — line 157

- **Fix:** "The line counts prints with premium of $10,000 or more only."

**S11. "Labeled an estimate" has no defined place** — line 155

- The Rule text (lines 123–124) does not list the word "estimate". Only the mock's axis caption contains it.
- **Fix:** Add "estimate" to the Rule text list or the Chart 1 axis label specification.

**S12. "The ES index group" is unexplained internal jargon** — line 13

- The term comes from the `FLOW_GROUPS` "index group" in `flow-features.ts`.
- **Fix:** "SPX options, which Vertex uses as the options context for ES".

**S13. "With the retry time" is ambiguous** — line 112

- No retry mechanism is defined other than the 60 s page refresh.
- **Fix:** "with the time of the next refresh".

**S14. The weekend rule omits holidays** — line 71

- The same rule also covers market holidays and days with no stored prints.
- **Fix:** "so a weekend or holiday shows the last session with prints".

S15. Two Rollout points are missing

- **Lines 163–164 (RELOCATE):** `infra/quantvps/README.md` has an owner rule of 2026-11-16: `restart-when-idle.sh` refuses to run in US market hours (exit 14). The deploy step should say so, because that is where the operator picks a time.
- **Line 117 (Chart 1):** "Thicker" names no stroke width; give the px values.

#### Checked and left alone

- Line 5 (research-only disclaimer) and line 33 (HIRO disclaimer) are scope statements with a clear reader decision.
- Lines 46–47: the claim that the collector drops greeks is backed by `flow-options.ts:30`.
- The code references hold:
  - `bsDelta` exists at `pricing.ts:130`.
  - `FLOW_INSTRUMENTS` gives QQQ and NQ no `options` source.
  - `FLOW_API_ERRORS`, `FlowTapeSpeedPanel`, `design-system/darkfactory/MASTER.md` and `restart-when-idle.sh` all exist.
- The mock (`before-after-mock.svg`) is labeled MOCK and uses the same terms as the text.
