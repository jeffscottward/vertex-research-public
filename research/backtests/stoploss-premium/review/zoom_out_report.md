# Stage 5: Initial Zoom Out review

## egm-zoom-out

## Stage 5 zoom-out review: `research/backtests/stoploss-premium/design.md`

The document gives enough context to review: the goal (lines 6–14), the terms (16–28) and the fixed tests (30–46) are all stated, and it says it records a study that is already implemented. It also fits the project rule that research is read-only (`AGENTS.md`: a completed backtest cannot authorize a trade). There are no blockers. Below are four Major findings and five Nits. I checked each reuse claim against the code under `services/research/`.

## 🟡 Major

### 1. The results that send a question to the owner are the least protected (lines 13–14, 34–41, 54–56, 82–83, 124–127)

Lines 13–14 send every "fail" or "paid insurance" result on a live rule to the owner. Those two results are the most exposed to the study's known biases:

- **Survivorship bias.** Lines 124–125 say the bias favours holding over stopping in tests A–D. That pushes the stop rules toward "fail", the exact result that triggers an owner question.
- **Model prices.** Tests B, C, D and F use model prices (54–56), and the model has no implied-volatility changes (126–127). So test D's premium stop is in effect a stop on the underlying price, and the test cannot measure what a premium stop is for.
- **Proxy entries.** Tests B–D use daily stand-ins for live intraday entries (82–83).
- **Uneven checks.** "Adds return" must pass the bootstrap interval, both halves and the ±25% threshold moves (35–36). "Fail" needs only an interval below 0 (39). "Paid insurance" needs only one max-drawdown comparison, with no interval, halves or threshold check (37).
- **Many verdicts.** Test A has variants, D has three structures, F has two variants, and G includes the 10-month rule on each of 15 ETFs. All are judged at 90% with no correction for the number of tests (43).

The labels are there, but the routing rule ignores them.

Simplest fix: one sentence in the Goal saying which tests can produce an owner question (real prices, no bias in the direction of the result). Model-price or biased results would go to the owner only as "evidence gaps". Alternatively, apply the same halves and ±25% checks to "fail" and "paid insurance". No new machinery is needed.

### 2. Live-rule ports are copies with no pinned source (lines 8–9, 99–106, 113; code: `shares.py`, `optiontests.py`, `books.py`)

The study claims to test "the exit rules that our engines use". Five live rules are re-implemented from the external market-watch-bot repository:

- `compute_levels` (re-entry harness)
- `leaps.ladder_levels`
- the trend backtest
- the rotation rule
- the drawdown brake in `market_watch/risk`

The document never says they are copies, from which files, or from which commit. `run.py` records only this repository's commit (`git_state`). The tests in `test_stoploss_premium.py` are hand-computed, not checked against the live code's output.

When the live rules change, every verdict silently describes a rule that no longer exists. Keeping the copies is correct, because importing across the repository boundary is barred. The design should add three things:

- a "Ported live rules" table listing source path and commit;
- the same pin in `results.json`;
- at least one test comparing each port against values from the live code.

### 3. Existing utilities are rebuilt despite "no second convention" (line 113, plan lines 141 and 145)

Line 113 says "Reuse … existing code; no second convention", but the plan rebuilds several things that already exist:

| New code | Already exists |
| --- | --- |
| `bars.py`: CSV loader and IRX index loader | `strategies/qc_ports/data.py` `load_bars` / `load_series`, which read the same qc-ports CSV format and directory |
| `bars.py`: `true_range`, `atr` (simple mean), `rolling_mean`, `zscore`, `realized_vol` | `indicators/core.py` `true_range`, `atr(method="sma")`, `sma`, `zscore`, `realized_volatility` |
| `options.py` `third_friday` / `monthly_expiries` | `qc_ports/calendar.py` `monthly_expiration` / `expirations_after`, which handle NYSE holidays (the document's "session before when the exchange is closed") |
| `options.smile` ("Same skew as qc_ports.options.smile_iv") | `qc_ports.options.smile_iv` |
| `premium.max_drawdown` | `qc_ports/metrics.py` `max_drawdown`, plus about six other copies in the codebase |

Either reuse these or state why not. The possible reasons are None-aware series and percent units in `realized_volatility`, which a thin adapter would handle. Related: the document never says which ATR it uses (simple mean or Wilder), though that matters for matching the ported live stops.

### 4. Tests E and H cannot reach a verdict, and the table hides this (lines 34, 103, 106, 131)

Line 34 requires at least 100 stop events. Line 131 says test H has about a dozen brake starts and test E has 8 trades, so both will report "not enough data" before any run.

- **Test E:** line 103 presents it as a two-leg test ("Close when Crown's stated level breaks | Hold to the exit rule"). In the code, `study.test_e` only counts stored notes and trades, and Crown is switched off, so no live rule depends on it. The minimal code is right, but the table should say "data check only; result fixed by the stop-event floor; no live rule".
- **Test H:** the brake simulation runs although its verdict is already known. It is cheap, since it reuses the G books, so stating the fixed outcome is enough. Dropping it is also defensible.

## 🟢 Nit

- **Lines 8 and 119–120:** the parent report ("Stop-loss rules: what Kaminski and Lo (2014) means…") and `kb-answers.md` q1–q5 are named but not linked, and neither is in this repository. Give the location or an archived copy, so a new reader can check that the fixed tests "come from the report" (line 32).
- **Lines 24–25 and 44–46:** p₀ and the sufficient condition (equations 17–18) are defined and computed, but no verdict uses them (`premium.verdict`). Say they are reported for interpretation only.
- **Lines 61–78 and 100:** the feature section includes code identifiers (`MW_HIST_MAX_TOTAL`, `ladder_levels`, `strategies.qc_ports.options`) and fine cost details ($0.65, 1-cent minimum). The parameters belong in a method document, but the identifiers fit better in the Detailed Plan or the ported-rules table proposed in finding 2.
- **Placement:** other study specs (sector rotation, sma30 timing, bearish put spread) live in `docs/specs/strategies/`. This one sits beside its runner in `research/backtests/stoploss-premium/`. Either is defensible; note the choice or follow the existing pattern.
- **Line 135 vs line 153:** "no new dependency" is true for the package, but the run needs matplotlib, which `services/research/pyproject.toml` does not declare. Say the chart dependency is added only for the run.

## What is fine

- **Scope:** the study changes nothing live (13–14).
- **Option model:** the qc-ports option model is reused for Black–Scholes pricing, delta, skew constants and half-spreads.
- **Bootstrap:** the circular block bootstrap is justified. The existing `bearish_put_study.bootstrap_difference` works on trades and `event_stats.bootstrap_ci` treats events as independent; neither resamples daily differences.
- **Fifth label:** adding "inconclusive" is a minimal, honest addition.
- **25%/75% book:** splitting the option account into 25% premium and 75% T-bills is justified (line 114).
- **Layout:** the module split is reasonable at this size (about 2,100 lines across 11 files).

## egm-inventive-catalyst

Five false compromises found: four 🟡 Major and three 🟢 Nit, no 🔴 Blocker. The data-and-reproducibility setup (data hashes recorded in `results.json`, data not committed) and the 5-minute single-process run are balanced choices, so I flag nothing there. I checked the code where the document makes claims about it.

---

### Finding 1: The verdict depends on an arbitrary allocation size (🟡 Major)

- **Affected Scope:** "Shared simulation rules → Position books" (lines 71–75), "Decisions and their sources" row "Size of the option book" (line 114), "Fixed pass/fail tests" items 3–4 (lines 37–39).
- **False Compromise:**
  - The option books are held at 25% of the account, with 75% in T-bills rebalanced daily. The stated reason is that a 100% book "has drawdowns near −100% that make the drawdown test meaningless". The exposure is chosen to make the metric behave, not to match the live risk; the live per-name caps are 6% and 2% (line 74).
  - In code (`study.py:31-32`, `portfolio.py:78-80`), the exposure scales the book's return linearly. So the sign of Δμ and the sign of its bootstrap interval do not change with exposure.
  - The drawdown test in `premium.py:188-191` is a relative maximum-drawdown cut, which is not linear in exposure. With the T-bill cushion, path drawdowns shrink and change shape differently for the two legs.
  - So whether a rule lands in "paid insurance", "fail" or "inconclusive" depends on choosing 25% rather than 6%, 2% or 100%. The study trades fidelity of the drawdown test against a measurable drawdown, when it can have both.
- **Proposed Resolution:** Segmentation / Extraction. Take the risk test out of the account allocation.
  - (a) Compute the drawdown criterion on a measure that does not depend on exposure. The per-trade check already returns trade results as a share of the entry debit (line 74–75). Use a tail-loss measure there, such as CVaR at 5% of trade return, with and without the rule.
  - (b) Or run each option test over an exposure sweep {2%, 6%, 25%, 100%}. Give the verdict as "stable" only when the label is the same at every exposure; otherwise give it as "depends on exposure".
- **Secondary Liabilities:**
  - (a) A per-trade tail measure is not the same as the "maximum drawdown" in the parent report's fixed test. It must be labelled as an added diagnostic, not a replacement, so the pre-registration stays intact.
  - (b) The option tests take about 4× the runtime and the report gets more columns.
  - A rule is also needed for labels that disagree across the sweep. It must be fixed before the run, or it becomes a new degree of freedom.

### Finding 2: The unknown bid-ask spread is a fixed input when it could be an output (🟡 Major)

- **Affected Scope:** "Data" (lines 54–56), "Shared simulation rules → Option model" (lines 63–68), "Decisions" rows 1–2 (lines 112–113); `options.py:36-37,140`.
- **False Compromise:**
  - With no quote history and no vendor spend, tests B, C, D and F use an assumed half-spread: 3% per leg for stocks, 2% for other ETFs.
  - The leg with the rule trades more often (stop exits, rolls, ladder rungs), so spread errors do not cancel in Δμ. Spread cost is often the term that sets the sign of the result.
  - The design accepts "model price, labelled" as the end state: realism needs paid data, and with no data the result rests on an assumption.
- **Proposed Resolution:**
  - *Inversion:* instead of assuming a spread and reporting Δμ, solve for the break-even half-spread s*at which Δμ = 0. Cost is close to linear in the half-spread (one cost per fill), so two runs per variant at two spread values and an interpolation are enough. Report s* next to each model-price verdict.
  - *Preliminary Action:* compare s* with the real bid and ask spreads already in the option-chain store since 2026-11-11 (line 55). That needs no vendor cost.
  - The owner question then becomes "do real spreads sit above or below s*?" rather than "do we trust 3%?".
- **Secondary Liabilities:**
  - One extra run per option variant (runtime roughly doubles for B, C, D and F).
  - Linearity fails partly where positions settle at intrinsic value on the expiry session, with no spread paid. A coarse check at a third spread value guards against this.
  - The chain-store window is about two weeks and reflects one market regime. Spreads in stress periods are wider, so the comparison is a lower bound.

### Finding 3: Test H is fixed in advance to "not enough data" by its choice of unit (🟡 Major)

- **Affected Scope:** Test H row (line 106), "Known limits" line 131, "Fixed pass/fail tests" item 1 (line 34); `study.py:393-394`, `books.py:174-177`.
- **False Compromise:**
  - H counts brake starts on the two live G books, about a dozen over 27 years (line 131). `verdict` returns "not enough data" below 100 events (`premium.py:196`), so H can only give that result.
  - The design runs a test whose outcome is decided by its observation unit. It treats "the brake is a book-level rule" as meaning "only these two books can supply events".
  - Test E is a different case. Its 8 Crown trades with Crown switched off are an **immutable sample bound** (`test_e` hard-codes the "not enough data" result, `study.py:405-411`). That is a genuine invariant, not a false compromise, and I propose no change for it.
- **Proposed Resolution:** Segmentation.
  - Apply the same brake logic to many independent equity curves: each of the 15 single-ETF 10-month books already built for G, the share paths of test A, and the trend and rotation books started in staggered months. Pool the brake starts above 100 and bootstrap the pooled daily difference.
  - Keep the two live books as the headline row, labelled "not enough data".
- **Secondary Liabilities:**
  - The pooled books are not the live books, so the result speaks for the brake *rule*, not the live *instance*.
  - Brake starts cluster in the same crashes (2000–02, 2008, 2020). 100 pooled events overstate the independent information, and the circular-block bootstrap only partly corrects for this.
  - More code in `books.py`.
  - The alternative is to state plainly that H and E are known "not enough data" outcomes, so they are not counted as answered tests.

### Finding 4: The pre-registered labels can rank a better rule below a worse one (🟡 Major)

- **Affected Scope:** "Fixed pass/fail tests" items 2–5 (lines 35–41); `premium.py:194-206`.
- **False Compromise:**
  - "Paid insurance" requires Δμ ≤ 0 together with a drawdown cut of at least 10%.
  - Rule X has a point Δμ above 0 whose interval includes 0, plus a 10% or larger drawdown cut. It falls to "inconclusive".
  - Rule Y has the same drawdown cut and a *negative* Δμ. It earns "paid insurance".
  - X is better than Y on both measures yet gets the weaker label, and its owner question is lost.
  - The design treats pre-registration as forcing a single opaque label. Its added "inconclusive" label (line 40–41) absorbs every case outside the four, including those that are close to a pass.
- **Proposed Resolution:** Intermediary.
  - Keep the fixed labels unchanged.
  - Attach a pre-declared reason code to every "inconclusive" result, for example:
    - "positive Δμ, not significant, with drawdown cut"
    - "fails half-sample"
    - "fragile to the threshold change"
    - "negative Δμ, interval spans 0, no drawdown cut"
  - Send any dominance case, where Δμ is at least as good as in some "paid insurance" result and the drawdown cut is at least 10%, to the owner like a paid-insurance result.
- **Secondary Liabilities:**
  - More labels to explain on the report page.
  - A reason code could be misread as a pass.
  - The codes must be fixed before the next run, or they become post-hoc analysis.

### Finding 5: The verdict on the live rule rests on substitute entries, with no control for entry dependence (🟡 Major)

- **Affected Scope:** "Entries for tests B, C and D" (lines 80–93), "Decisions" row "Entry signals" (line 115).
- **False Compromise:**
  - Kaminski and Lo's stopping premium depends on how returns behave after the stop condition fires (the serial-correlation condition in lines 44–46). That behaviour is set by the entry process.
  - The live engines enter on 1-minute bars, options flow and volume-profile value areas. The study uses four daily substitute entries.
  - The design accepts "data limit, so substitute entries" without measuring how much the result depends on entry choice. A sign flip between substitute and live entries cannot be ruled out.
- **Proposed Resolution:** Cheap Dispensables, as a control leg.
  - For each of B, C and D, add a random-entry leg: same names, same calendar spread of entries, random entry days with a fixed seed, the same rule.
  - If the verdict is the same under random and substitute entries, entry fidelity does not decide it.
  - If it differs, label the verdict "entry-conditional" and report it per family (momentum vs dip). The paper predicts that stops help momentum, where serial correlation is positive, and hurt mean reversion.
- **Secondary Liabilities:**
  - Roughly doubles option-test runtime.
  - A random-entry leg needs its own bootstrap and seed, which adds a source of variance.
  - It adds rows to each test table, and a careless reader could take the control leg for a live-rule result.

### Finding 6: Survivorship bias is noted but not used to qualify the verdicts (🟢 Nit)

- **Affected Scope:** "Known limits" lines 124–125.
- **False Compromise:** The bias runs against stopping. That makes "adds return" a conservative result, but makes "fail" and "paid insurance" for A–D *more* likely than the truth. The document records the bias but does not carry its direction into the labels.
- **Proposed Resolution:** Blessing in Disguise.
  - Attach a "survivorship-biased against the rule" note to every "fail" or "paid insurance" result in A–D, and none to "adds return" results.
  - Optionally cross-check test A on the 31-ETF universe, where survivorship from index removal does not apply.
- **Secondary Liabilities:**
  - The ETF universe has its own, weaker survivorship (funds that closed) and different volatility.
  - An extra label on the page.

### Finding 7: Test D's premium stop cannot fire on implied-volatility moves for stocks (🟢 Nit)

- **Affected Scope:** Option model (lines 64–66), test D (line 102), "Known limits" lines 126–127; `options.py:33,98-99`.
- **False Compromise:**
  - A 50% premium stop is driven largely by moves in implied volatility.
  - For stocks, the model's implied volatility is 1.15 × lagged realized volatility, so an IV-crush stop is impossible by construction. Only ETFs with a Cboe IV index have real IV dynamics.
  - The design pools both under one verdict.
- **Proposed Resolution:** Segmentation.
  - Give D's headline verdict on ETFs with an IV index.
  - Report stocks as a separate row labelled "no IV dynamics".
  - Or scale stock IV by the day's VIX against its moving average, as a market-IV beta.
- **Secondary Liabilities:**
  - The ETF-only segment may fall below 100 stop events.
  - The VIX-beta model is one more modelling convention, which the design's own "no second convention" rule (line 113) argues against.

### Finding 8: The 100-event threshold counts correlated events (🟢 Nit)

- **Affected Scope:** Line 27 (definition of a stop event), line 34.
- **False Compromise:** Each ladder rung, and each name stopped on the same crash day, counts as a separate event. For A and B, the 100-event bar can be met by a handful of market-wide days.
- **Proposed Resolution:** Self-Service, as a diagnostic.
  - Also report the number of distinct stop *days*, or of 21-day blocks holding at least one stop, beside the event count.
  - Keep the fixed threshold on events, as pre-registered.
- **Secondary Liabilities:** One more number per variant, and possible disagreement with the fixed threshold that has to be explained.
