# Stage 7: Critic review

## egm-design

## Critic review of `research/backtests/stoploss-premium/design.md`, lines 1–132, against `feature-spec-standard.md`

**Result: the document does not meet the standard.** The main reason is the Alternatives Rule. There are also several method gaps that could produce misleading verdicts or verdicts known before the run, and the document does not say so.

I checked the document against the code it names (`services/research/strategies/stoploss_premium/*.py`, `run.py`). I also checked it against the parent report, which is outside the repository at `~/Documents/reports/web/stoploss-kaminski-lo/src/report.md`.

---

## 🔴 Blocker

### 1. Alternatives Rule not met (lines 110–120, 54–56)

- **Rows without real alternatives:** "Decisions and their sources" records one choice per row, mostly with a source. Only one row compares against an alternative and gives a technical reason: 25% vs 100% premium book. These rows have no rejected alternative with concrete trade-offs:
  - model conventions;
  - proxies vs engine entry logs;
  - CSP roll;
  - bootstrap design;
  - book sizing without per-name caps.
- **Alternatives never mentioned:**
  - **(a) Reuse the existing CSP backtest for test F.** The parent plan names `market_watch/income/backtest.py` as F's data source. The design rebuilds F in `csp.py` on model prices and never says why.
  - **(b) Calibrate or validate the IV model.** Options include the option-chain store from 2026-11-11, a small paid vendor sample, or VIX-beta for stocks. Uncalibrated 1.15 × realized volatility is used instead.
  - **(c) Run test H on engine equity curves.** The parent plan says "engine backtest equity curves". The design narrows H to the G books without explanation.
  - **(d) Choose the bootstrap block length.** Alternatives include a stationary bootstrap or longer blocks for one-year LEAPS holds.
  - **(e) Apply the live 6% / 2% per-name caps.** Line 74 mentions them but they are not applied.
- **Rejections attributed to the owner without a link:**
  - Lines 54–56 reject paid vendors as "an owner cost decision" with no linked issue, card or decision record. The standard forbids this explicitly.
  - Line 117 cites "KB answer q5 of the parent report (In The Money Adam)". The parent report is outside the repository, and no path is given.
- **Recommendation:** add an "Alternatives considered" section. Give each alternative listed above a concrete rejection reason (cost, data availability, runtime, scope), and link the owner decision on vendor data.

---

## 🟡 Major

### 2. Tests E and H can only end as "not enough data", and E is not a backtest (lines 102, 105, 129)

- **Test E:** line 102 presents E as a two-leg test with "Prices: Not needed", and line 129 notes "8 closed trades".
  - In the code, `study.test_e` simulates nothing. It counts Crown desk notes and hard-codes `verdict: NOT_ENOUGH`.
  - The "stop event" count is the number of notes containing a "close below" level, not stop events.
  - The parent plan lists option prices as data E needs.
- **Test H:** about a dozen brake starts, against the fixed 100-event floor (line 33). Its verdict is therefore known before the run.
- **Recommendation:**
  - State in the test table that E is count-only, not a backtest, with no Δμ.
  - State that H's verdict is fixed by rule 1 and its numbers are descriptive only.
  - Alternatively, justify running them at all, or replace them with tests that can reach a verdict.

### 3. Comparison rows can earn "adds return" without the threshold check (line 100, fixed test 2 at line 34)

- In `study.evaluate`, a row with no threshold variants calls `verdict(s, [s["premium"]])`. The row's own Δμ is used as its threshold check, so the ±25% robustness condition passes automatically whenever Δμ > 0.
- This affects the test C rows "Also T−1 and T−5" (three structures × two rows = 6 variants). It also affects any future row without threshold variants.
- The design calls these "comparison rows, no threshold check" and does not say they can still receive a pass verdict.
- **Recommendation:** specify that these rows get no pass/fail verdict (or "inconclusive" at best), and align the code.

### 4. No control for multiple testing or researcher choices (lines 32–42, 95–106)

- About 30 verdicts come from one run: A 4, B 6 (overlapping groups: families plus each kind), C 9, D 3, F 2, G 3, H 2, E 1.
- Each verdict uses a central 90% interval. Its lower bound is in effect a one-sided 5% test.
- Several method choices were made after the parent plan was fixed and are not covered by "fixed before any run": proxies, the 25% bucket, sample windows, T−2/T−4 instead of ±25%, the added 5-rung variant.
- **Recommendation:**
  - State the number of verdicts and the expected number of false "adds return" results.
  - Choose a correction (for example Holm, or a family-wise rule per test), or explicitly declare the verdicts exploratory.
  - Record which method choices were made after the plan.

### 5. The 100-event minimum counts correlated events (lines 29, 33)

- A "stop event" is one ladder rung, and every sale increments the counter (`optiontests.path`, `p.stop_events += 1`).
- One drawdown can therefore produce 5 events on a test B LEAPS ladder (3 on the test A ladder).
- Stops across names cluster on the same days (2008, 2020).
- The result is that 100 "events" can mean about 20 independent episodes, which weakens the sample guard.
- **Recommendation:** count independent episodes (first rung per trade per drawdown, or distinct stop dates), or justify per-rung counting.

### 6. The "paid insurance" verdict has no uncertainty measure (lines 35–36)

- The verdict rests on a single-path maximum drawdown with a relative cut of at least 10%.
- Δμ gets a bootstrap interval and halves checks. Maximum drawdown gets neither, although it is the noisier statistic and can depend on one crisis.
- This verdict goes to the owner (line 13), so it is the one that most needs evidence.
- **Recommendation:** bootstrap the maximum drawdown reduction (or compare it per half), or require it to hold under the ±25% threshold variants as well.

### 7. Model-price risk is understated; the IV-index convention applies to no tested instrument (lines 52, 64–67, 123–124)

- **Cboe IV indexes unused:**
  - B, C and D trade stocks only (`data.stocks()`).
  - F's ETFs (XLF, XLE, XLU) have no entry in `IV_INDEX`.
  - So every option price is 1.15 × realized volatility, never calibrated against an observed IV.
  - The indexes listed as inputs at line 52 affect no result.
- **Pricing inconsistencies:**
  - Rates and dividends are set to 0 in Black-Scholes.
  - The underlying is the raw (not dividend-adjusted) close (`bars.py` docstring). This contradicts the shared rule at line 62 ("total-return prices"), and the design does not mention it.
  - At 4–5% IRX, zero-rate pricing of a one-year delta-0.75 call misprices on the order of 10% of premium.
  - Meanwhile stopped proceeds earn IRX. This interacts directly with Δμ = p₀(rf − E[r | stopped]).
- **Recommendation:**
  - Document that options are priced on the raw price with r = q = 0, and why.
  - Quantify the bias, or add a sensitivity run with r = IRX and dividend yield.
  - Validate against the option-chain store for the overlap period.
  - Remove or footnote the unused IV-index convention.

### 8. Samples and universes are missing from the specification (lines 49–58, 95–106)

- **Dates:** line 51 says data runs "1990 to 2026-11-10". In the code, the calendar is SPY's dates (1993 onward), and each test starts on its own date:
  - A: 2000-01-03;
  - G and H: 1999-12-31;
  - B, C, D: entries from 2005-01-03;
  - F: 2011-01-03.
- **Universes:**
  - F uses 15 fixed names (F, BAC, PFE, …).
  - Rotation runs without SOXX.
  - B, C and D use stocks only.
- These choices drive the "both halves of the sample" check and comparability across tests, yet none is in the design.
- **Recommendation:** add the sample window and universe to each row of the test table, with a reason for each.

### 9. The 10-month rule's unit of analysis is wrong in the text (line 104)

- The text says "the 10-month rule on each of 15 ETFs", which suggests 15 verdicts.
- The code produces one equal-weight aggregate of 15 ETFs against equal-weight buy-and-hold.
- **Recommendation:** state the aggregation. If per-ETF verdicts are intended, state that per-ETF exit counts will mostly fall below 100.

### 10. The decision policy for model-price and non-live results is undefined (lines 12–14, 57–58)

- Line 13 routes "fail" and "paid insurance" results on live rules to the owner.
- The document does not say:
  - which tested rules are live (the parent says D has no live code, F is not armed, G and H are dry-run);
  - whether a model-price verdict (B, C, D, F) is enough to raise an owner question.
- **Recommendation:** add a column marking live or not live, and a rule for model-price results, for example "advisory only until validated on quotes".

### 11. The risks section lists limits but no mitigations (lines 121–131)

- The standard requires failure modes and how they are mitigated. Each known limit is stated without a mitigation or an estimate of its effect.
- **Survivorship (line 123):**
  - No mitigation is offered, such as historical SP100 membership or a delisted-name sensitivity.
  - The direction claim ("favours holding") has no evidence.
  - It also ignores that survivor dip proxies bias B, C and D against stops on dip entries.
- **Risks missing entirely:**
  - findings 4, 5, 6 and 7;
  - 21-day blocks against roughly one-year LEAPS dependence (line 39), with no justification;
  - no per-name caps in the option books (line 74 states the caps exist but they are not applied).
- **Recommendation:** add a mitigation or a quantified bias direction for each risk.

---

## 🟢 Nit

 1. **Lines 40–42:** "ρ … against its Sharpe ratio" does not give the inequality. The parent report and the code use ρ ≥ Sharpe. Say so, and note that around 80 non-overlapping periods give a noisy ρ, with no interval reported.
 2. **Lines 34–37:** with Δμ > 0 that is not significant and a drawdown cut of at least 10%, the result is "inconclusive", although it is better than "paid insurance". State this ordering explicitly.
 3. **Line 39:** say that the 90% interval is central (two-sided).
 4. **Line 98:** "3 rungs (14/29/57%) from supports" is ambiguous. The percentages are position sizes (`SIZES3`), not distances. The same applies to B's "10/15/20/25/30%".
 5. **Line 125:** the intraday-fill limit does not apply to test D. The premium stop is checked on the close only (`optiontests.premium_stop_rule`), and test C acts at the close. State this per test.
 6. **Line 67:** expiry value is intrinsic at the 16:00 daily close, not the live 15:45 ET close.
 7. **Line 101:** "−37.5% and −62.5%" are loss levels relative to the 50% stop. Write them as "stop at 37.5% / 62.5% loss of debit" to avoid a sign misreading.
 8. **Lines 8, 117:** give the path to the parent report (`~/Documents/reports/web/stoploss-kaminski-lo/src/report.md`, `kb-answers.md`). Neither is in the repository.
 9. **Test H, Δμ inputs:** p₀ for H is the share of days the brake is active (`brake_flags`), not a share of capital as defined at line 25. Note this definitional difference.
10. **Security:** no security section. Risk is low (Crown data is read-only and counts only; raw price data is not committed). Still, add one line saying what the published `results.json` and charts expose, since the report directory is served.

## egm-structural

## Stage 7 critic review: Structural Goldfish

**Target:** `research/backtests/stoploss-premium/design.md`, FeatureRange lines 1–132
**Standard:** `feature-spec-standard.md` (Core Principle, Alternatives Rule, Risks & Limits, Requirements list)
**Mode:** REVIEW

**Verdict: fails.** One blocker (no alternatives section) and five majors. The document is well-formed Markdown, but it is organized as a method record, not as the feature specification the standard requires. Most of the material exists; the main need is to reorganize it under the required headings.

## Structure map

The heading levels are clean: one H1 (line 1), H2s only, no skipped levels. The H2 order is:

- Goal (6)
- Terms (16)
- Fixed pass/fail tests (30)
- Data (48)
- Shared simulation rules (59)
- Entries for tests B, C and D (80)
- The tests (95)
- Decisions and their sources (108)
- Known limits (122)
- Detailed Implementation Plan (133, outside the range)

How these map to the standard's required sections:

| Standard section | Present in 1–132? |
| --- | --- |
| Problem Statement | Partly, inside "Goal" (lines 8–11) |
| Goals & Non-Goals | Goals yes. Non-goals only as unlabeled prose (lines 12–13) |
| Proposed Architecture | Absent. File layout appears only in the Detailed range |
| Alternatives Considered | Absent |
| Risks & Mitigations | Risks listed under "Known limits" (122–131). No mitigations |

## Findings

### 🔴 Blocker 1: no evaluation of alternatives (Alternatives Rule)

- **Scope:** the whole FeatureRange, closest material in "Decisions and their sources" (108–120).
- **Discrepancy:** the standard fails a spec that proposes one path without showing which other viable designs were rejected and why. There is no "Alternatives Considered" section.
- **What the decisions table does instead:** it records the chosen option and a source, not the rejected options. Only two rows name a rejected option with a concrete trade-off:
  - Line 114: a 100%-premium book was rejected because drawdowns near −100% would make the drawdown test meaningless.
  - Line 112: paid quote vendors were deferred (pending an owner cost decision).
- **Rows with no alternative and no rejection rationale:**
  - Line 113: reuse the qc-ports model. An independent model or another IV convention is not discussed.
  - Line 115: daily proxies. Other proxy definitions are not discussed.
  - Line 116: CSP roll rule. Other roll policies are not discussed.
  - Line 117: the "inconclusive" label.
- **Missing study-design alternatives:** none are discussed, for example:
  - circular-block versus stationary bootstrap;
  - a 21-day block versus other block lengths;
  - fixed ±25% threshold shifts versus a parameter sweep;
  - an equal-weight versus a value-weighted share book.

### 🟡 Major 1: rejections attributed to people without a link

- **Scope:** lines 112, 116, 119–120.
- **Discrepancy:** the standard forbids attributing a rejection to a maintainer without linking the issue, discussion or PR. The document breaks this in three places:
  - Line 116 attributes the CSP roll decision to "KB answer q5 of the parent report (In The Money Adam)", a named person, with no link.
  - Line 112 makes the vendor option depend on "an owner cost decision", with no issue or discussion link.
  - Lines 119–120 cite `kb-answers.md` q1–q5 as the authority for every method decision.
- **Repository check:** no `kb-answers.md` belongs to this study anywhere in the repository. The only hits are mentions in an unrelated design record, `docs/vertex-rebuild/designs/openbb-option-iv-second-source/kb-decision-record.md`. The parent report (line 8) is cited by title and date only and is not found in the repository either. Both cited sources cannot be resolved by a fresh reader.

### 🟡 Major 2: "Proposed Architecture" is missing from the range

- **Scope:** lines 1–132.
- **Discrepancy:** the range has no section on component layout, data flow or integration. The pipeline is only implied across "Data", "Shared simulation rules" and "The tests":
  - input files → bar loading and scaling → entry proxies → two-leg simulation → Δμ, bootstrap and verdict → report.
- **Where the content actually is:** the component layout appears only in the Detailed Implementation Plan (lines 133–155). That section belongs to a different review gate, so the range cannot pass the standard alone.
- **Integration points that need explicit boundaries in the range:**
  - repository code: `strategies.qc_ports.options`;
  - another code base: `MW_HIST_MAX_TOTAL`;
  - the rig data directory;
  - the publish target in `~/Documents/reports/web`.

### 🟡 Major 3: risks are listed without mitigations

- **Scope:** "Known limits" (lines 122–131).
- **Discrepancy:** the standard requires failure modes, security implications and scalability limits, and how each will be mitigated. Each of the five bullets states a limit, and only some state a direction of bias. None states a mitigation:
  - Survivorship (124–125): no adjustment or sensitivity check.
  - IV dynamics (126–127): no mitigation.
  - Intraday fills (128): no mitigation.
  - Share-ladder re-entry (129–130): no mitigation.
  - Small samples (131): no statement that these tests fall into "not enough data".
- **Missing categories:**
  - Security and licensing: the data-terms constraint is at lines 51–52 under "Data", not under risks.
  - Scalability and runtime: covered only at line 155, in the Detailed range.
  - Failure modes such as missing or corrupt input files, a changed hash, or a seed dependency.
- **Mismatched heading:** the section is titled "Known limits", not "Risks & Mitigations".

### 🟡 Major 4: tests are used before they are defined

- **Scope:** lines 30–93 against line 95.
- **Discrepancy:** the eight tests are defined in "The tests" at line 95. Earlier sections already rely on the letters:
  - "Data" (55–57) assigns model prices to tests B, C, D and F, and Crown history to test E.
  - "Shared simulation rules" (70–77) assigns books to tests A, B, C, D, F, G and H.
  - "Entries for tests B, C and D" (80) defines inputs for tests not yet introduced.
- **Effect:** a fresh reader meets "test E" and "test G 10-month rule" with no definition. The Core Principle asks for understanding without prior context.
- **Fix:** move "The tests" directly after "Goal" or "Terms".

### 🟡 Major 5: non-goals are not separated

- **Scope:** "Goal" (lines 6–14).
- **Discrepancy:** the standard asks for Goals and Non-Goals. The non-goals ("changes no live rule, order, arming flag, size, cap…", lines 12–13) are prose inside "Goal", with no label or list.
- **Missing scope exclusions** a reviewer would expect:
  - no paid data purchase;
  - no intraday or quote-level simulation;
  - no live-rule proposal from tests with fewer than 100 events.
- **Problem statement mixed into goals:** the motivating question (lines 8–11) sits in the same section. It is not stated as the business problem, namely whether live exit rules cost or earn return.
- **Framing at line 3:** "Status: implemented; this document is the method that the code follows" presents the document as a retrospective record. This standard is a pre-implementation gate, and that framing is never reconciled with it.

### 🟢 Nit 1: abbreviations used but not in "Terms"

- **Scope:** "Terms" (16–28) against later lines.
- **Undefined in "Terms":**
  - ATR14 (lines 87–90, 100–106)
  - IV (66)
  - NLV (74)
  - T−n session notation (102; defined only inline in a table cell)
  - SP100 (50)
  - CSP (116; spelled out only in test F at 104)
  - Crown (56, 103)
  - L (87; defined inside a table cell)

### 🟢 Nit 2: unheaded subtopics in "Fixed pass/fail tests"

- **Scope:** lines 44–46.
- **Discrepancy:** "Bootstrap" and "Sufficient condition" are separate method topics run on as paragraphs after the numbered list. They have no H3 subheadings.
- **Unclear role:** the paragraph never says whether the sufficient condition (ρ against the Sharpe ratio) affects the verdict or is only reported.

### 🟢 Nit 3: test E cannot meet the stated pass criteria

- **Scope:** line 103 against line 38 and line 131.
- **Discrepancy:**
  - Test E's threshold check is "none", but "Adds return" (38) requires the ±25% threshold shifts.
  - Test E has 8 trades (131), so it falls under "not enough data" (34).
- **Fix:** state this outcome explicitly in the tests table, or mark test E as descriptive only.

### 🟢 Nit 4: inconsistent value vocabulary in "The tests"

- **Scope:** lines 99–106, "Prices" column.
- **Discrepancy:** the column uses "Real", "Model" and "Not needed". The rest of the document uses "model price" and "total-return prices".
- **Readability:** the row A cell lists the main rule and three variants in one cell, which is hard to scan. A separate "Variants" column, or one row per variant, would fit the table's symmetry.

### 🟢 Nit 5: inconsistent typography

- **Scope:** lines 54, 73, 101, 103–104, 114.
- **Emphasis:** "**none exist**" (54) is the only bold in body prose. Elsewhere bold marks term labels only (18–28).
- **Emoji:** an emoji calendar icon appears before "LEAPS" in technical text (73, 101, 103, 114).
- **Dashes:** the Unicode minus (−25%, T−3) is mixed with ASCII hyphens used for ranges (A-H, 30-45 days, 17-18).

### 🟢 Nit 6: no links

- **Scope:** lines 3 and 8.
- **Discrepancy:** neither the card `stoploss-stopping-premium-backtests` (3) nor the parent report (8) is linked. The FeatureRange contains no hyperlinks or relative paths to any cited source, including Kaminski and Lo (2014).

## Clean areas

- Heading levels: no skips, a single H1, H2s used consistently.
- All three tables (lines 85, 97, 110) have a consistent number of columns and well-formed separator rows.
- Nested lists (69–77) are indented consistently.
- There are no unclosed code spans or code blocks in the range.

## egm-style

## Style review: `design.md`, FeatureRange lines 1–132 (Mode: REVIEW)

The document is mostly dry, factual and short, with very little marketing language or filler. Most findings are about precision and claim calibration, not tone. I found no Blockers, 7 Major findings and 10 Nits.

### 🟡 Major

#### M1. The Goal lists three outcomes; the fixed tests define five (lines 9–10 vs 34–40)

- The Goal says each test answers whether the rule "adds return", is "paid insurance", or is a "fail".
- The fixed tests (lines 34–40) also define "not enough data" and "inconclusive".
- A reader of the Goal alone expects every test to end in one of three labels.
- Action: **CALIBRATE** the Goal to "one of five outcomes", or name the two extra labels there.

#### M2. Δμ has two definitions, and one of them is unclear (lines 21–22)

- "The annual mean daily return of the leg with the rule minus the leg without it" can be read two ways:
  - the annualised mean of daily returns, or
  - the mean daily return measured over one year.
- The same bullet also gives the paper's decomposition, Δμ = p₀ × (rf − E[r | stopped out]), in the same breath.
- The reader cannot tell which quantity the code computes: the difference of the legs (premium.py) or the decomposition.
- Action: **CALIBRATE**. State "annualised (× 252?) mean of the daily return difference, after costs". Label the equation as the paper's interpretation, not the measured value.

#### M3. The "Sufficient condition" sentence has no verb and no consequence (lines 43–45)

- "…the lag-1 serial correlation ρ … against its Sharpe ratio at that step" does not say what the test is.
- premium.py:123 shows the test: met when ρ ≥ Sharpe.
- The sentence also does not say what the result is used for. `verdict` (premium.py:194) does not appear to use it, so it reads as a report-only diagnostic.
- Without that, the reader cannot tell whether the condition can change a pass/fail label.
- Action: **CALIBRATE** to "met when ρ ≥ Sharpe; reported only, does not change the verdict" (if that is the case).

#### M4. The stop-fill limit is stated for all tests but is not true for test G (line 129)

- Line 129 says "intraday stop fills are approximated by the lower of the open and the stop level".
- That matches the code for tests A and B: shares.py:142 and optiontests.py:53, both `min(open, level)`.
- For test G, books.py:6 and books.py:164 check the stop on each close and fill at the close.
- Action: **CALIBRATE** to name the tests each fill rule applies to.

#### M5. The small-sample caveat stops before its consequence (lines 132–133)

- "Test H has a small number of brake starts (a dozen in 27 years); test E has 8 closed trades."
- "small number" and "a dozen" are imprecise.
- The line does not draw the conclusion that follows from fixed test 1 (fewer than 100 stop events). Both tests fall under that rule, so their result is fixed in advance as "not enough data".
- "27 years" is not tied to a stated start date (the data runs from 1990).
- Action: **CALIBRATE**. Give the exact count with its source (`results.json`). State that tests E and H can only return "not enough data".

#### M6. The test E comparison is ambiguous (line 104, row E)

- The comparison column reads "Hold to the exit rule".
- It does not say which exit rule: Crown's own planned exit, expiry, or something else.
- The same table says each leg is defined "without" the rule, so this wording reads as self-contradictory.
- Action: **CALIBRATE**. Name the comparison exit explicitly.

#### M7. The live per-name caps appear with no stated effect (line 72)

- "the live per-name caps are 6% and 2% of NLV" is stated with no conclusion.
- The reader cannot tell whether the simulation applies these caps.
- NLV is not defined.
- Action: **CALIBRATE** to "not applied in the simulation (reason)", or **DROP**.

### 🟢 Nit

#### N1. Lines 3–4: filler and an untested conformance claim

- "written for review" adds nothing.
- "this document is the method that the code follows" claims the code matches the document, and nothing here checks that. M4 shows one point where the two differ.
- Action: **CALIBRATE** to "describes the method implemented in `services/research/strategies/stoploss_premium/`".

#### N2. Line 10: redundant wording

- "one table with numbers and charts" — "with numbers" adds nothing to "table".
- The Detailed section (line 155) gives the exact output: one premium chart and one curve chart per test. Use that wording.

#### N3. Line 23: awkward phrasing in the p₀ definition

- "the average share of the account that the rule holds out of the strategy (in the safe asset)" is hard to parse.
- Suggested: "the average share of the account the rule leg holds in T-bills while the leg without the rule is still invested".

#### N4. Internal names are used without explanation

- "the rig" (line 49)
- "qc-ports / options-forms" (line 49)
- "Crown" (lines 55, 104)
- "NLV" (line 72)
- "In The Money Adam" (line 121)
- "the trading research rule" (line 125)
- Each should get a one-line gloss in Terms, or a pointer to its source.

#### N5. Lines 62–63: the volatility-window clause is ambiguous

- "over 20 days below six months to expiry and 60 days from six months" can be misread.
- Suggested: "realized volatility over 20 days for expiries under six months, over 60 days otherwise".
- "× its factor" is undefined.
- "(the live 15:45 ET close)" is a cryptic aside; say what it means for the simulation.

#### N6. Emoji in a technical document (lines 70, 101, 103, 119)

- "📅 LEAPS" may be a live product label, but in a method document plain "LEAPS bucket" is clearer and searchable.
- If the emoji is a literal identifier, wrap it in code formatting.

#### N7. Line 76: "After the rule exits"

- A rule does not exit; a position does.
- Suggested: "After the rule closes a position, the proceeds earn rf until…".

#### N8. Line 87: the entry count has no source

- "(32,851 entries)" is a run result, stated as if it were part of the design.
- Cite `results.json`, or move it to the results.

#### N9. Line 120: subjective word

- "make the drawdown test meaningless" — "meaningless" is an evaluation.
- Suggested: "leave no room for a 10% relative drawdown reduction".

#### N10. Lines 128–129: the bias direction is stated as certain

- "this favours holding over stopping in tests A to D" is plausible but not measured.
- Action: **CALIBRATE** to "likely favours…", or say that the size of the effect is not measured.

### Items checked and kept

- The scope statement (lines 12–13) is concrete and decision-relevant: owner question with a chart.
- The model-price label rule (line 54) is concrete.
- The bootstrap parameters (line 42) match premium.py: seed 7, block length and interval level.
- The 0.06% cost and the 1.15 × realized-volatility factor match the code (`COST = 0.0006`; `RV_FACTOR = 1.15`).
- The drawdown brake levels in row H match the books.py docstring.
