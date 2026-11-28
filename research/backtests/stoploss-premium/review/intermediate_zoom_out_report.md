# Stage 8: Intermediate Zoom Out review (egm-zoom-out)

## Stage 8 intermediate zoom-out review of `research/backtests/stoploss-premium/design.md` (revised, 274 lines)

**Result:** no 🔴 Blockers, four 🟡 Majors and five 🟢 Nits.

The revision fixed most of the stage 5–7 structure findings. Where the document says the code reuses existing modules, I checked the code and it does. The four Majors are things the revision added or left unfinished:

- Many result rows were added, but none is named as the row that can send a question to the owner.
- One option-pricing simplification is defended with an argument that does not hold, and the fix would be one argument in an existing call.
- The ported live rules are still checked only against hand-computed values, not against the live code's output.
- The line saying the review is finished points to a report file that does not exist.

## What the revision resolved (checked against the code)

- **Reuse (old zoom-out Major 3):** the study now uses the existing shared code instead of its own copies.
  - `bars.py` imports `indicators.core` and `qc_ports.data.load_bars` / `load_series`.
  - `options.py` uses `monthly_expiration`, `smile_iv`, `strike_step`, `MIN_HALF_SPREAD` and `MAX_FILL_DAYS`.
  - `premium.py` uses `qc_ports.metrics.max_drawdown`.
- **Comparison rows (critic Major 3):** a row with no threshold check can no longer pass. `premium.verdict(s, None)` sets `robust` to False, which matches line 82.
- **Input hashes:** the Crown inputs and `intro.html` are now hashed (`run.manifest`).
- **Structure:** the document now has a Live? column, Problem, Goals and non-goals, an Alternatives table with reasons, and a Risks-and-mitigations table.
- **Ported rules:** a ported-rules table with a pinned commit (`PORTED_FROM` in `results.json`).
- **Run command:** the `uv run --no-project … --with` form matches the other `research/backtests/*` runners.
- **Contested items:** the reasons for keeping test H on the G books and for adding no "inconclusive" reason codes are sound. I do not reopen them.

## 🟡 Major

### 1. Which result row sends a question to the owner? (lines 20–21, 63–65, 98–104)

- Line 20 promises "one of five results" per test. The revised run now gives each test many rows:
  - **A** has 4 rows. One is "paper window stop", which is not a live rule.
  - **B** has 8 rows. Two family rows and four kind rows overlap, and there is no row that pools all entries. B also has the random-entry control and the ETF row.
  - **C** has 15 rows.
  - Each option row also carries results at 6%, 25% and 100% premium share (`byExposure`). That makes roughly 100 results, not "about 50" (line 98).
- Owner questions are triggered per test, not per row:
  - `study.py` sets `live: True` on the whole of A, B and C.
  - `report.test_section` prints "Live rule: a 'fail' or 'paid insurance' result goes to the owner" over every row of those tests.
  - So a "fail" or "paid insurance" on the random-entry control, the paper window stop, the T−1/T−5 comparison rows, the half-spread row or the 100% share is presented as a live-rule question.
- Line 98 already says a few rows will cross the 90% interval by chance. Without a named headline row, owner questions are partly decided by chance.
- The random-entry control has no stated reading rule. The document does not say what it means if the control and the proxy rows disagree, so the control cannot change any conclusion.
- **Simplest fix, before the next run (it does not touch the fixed tests):**
  - Name one headline row per live test, at the 25% share: A = the 5-rung live harness; B = all proxy entries pooled (a new row); C = the T−3 row for each structure.
  - Only headline rows can raise an owner question. Label every other row diagnostic.
  - Change Goals line 20 to match.
  - Optionally, raise a "paid insurance" question only when the drawdown cut holds in both halves. This is a routing rule, not a fixed test, so it can still be added without breaking the pre-registration.

### 2. The option model sets the interest rate to 0, and the stated mitigation does not hold (lines 127, 214; not in the Alternatives table)

- Line 214 says the rate error does not matter because "both legs share the error".
- That is not true in this design:
  - The leg without the rule ends on the expiry session at intrinsic value, which needs no model.
  - The leg with the rule leaves at the model mid when the stop fires.
  - So the pricing error enters only one leg's exit.
  - For calls (tests B, C, D), a zero rate gives a model price below the market price. The stopped leg therefore sells at too low a price.
  - That biases B–D against the rule, the same direction as the survivorship bias. For F's puts the bias runs the other way.
- The zero rate was carried over from the income-sleeve convention, which covers 30–45-day puts. It is now applied to one-year LEAPS calls, where the rate matters most.
- The fix is a single argument:
  - `qc_ports.options.bs_price(right, spot, strike, t, r, q, sigma)` already takes `r`.
  - `options.py:133` passes `0.0`.
  - The IRX series is already loaded as `data.rf`.
- **Fix:** price with r = the day's IRX rate. If the zero rate stays, add an Alternatives row with the reason, and state the bias direction next to the survivorship note: B–D "fail" and "paid insurance" are upper bounds on the cost of the rule.

### 3. The ported rules are checked only against hand-computed values (lines 218, 237–238; old zoom-out Major 2, third request still open)

- Tests A, B and C exist to judge the live rules. The ports also differ from the source on purpose: `compute_levels` drops the 2-decimal rounding, the put open-interest levels and the round-number adjustment.
- Hand-computed fixtures only test the port against the author's reading of the source.
- The stated reason, "the study cannot import across repositories", does not rule out golden values:
  - Run `ladder_levels`, `compute_levels`, `loser_close_rule`, the trend and rotation selectors and the brake once in market-watch-bot at commit `57a1b3b`.
  - Store their inputs and outputs as JSON fixtures in this repository.
  - Assert the ports against those values, adjusted for the documented omissions.
- This needs no import, and it catches transcription errors in the very rules whose results can reach the owner.

### 4. The document claims a finished review that cannot be traced (lines 4–5)

- Line 5 cites `review/consolidated_review_report.md`. That file does not exist; the resolution file is `review/goldfish_review_report.md`.
- That resolution file lists `intermediate_zoom_out_report.md` (this stage 8) as an input already resolved, and says every fix was applied. It was written before stage 8 ran.
- A fresh reader is told the review is closed and the code matches it, while stages 8 and 9 are still open.
- **Fix:** point to the real file, and say "under EGM review" until the final resolution is written.

## 🟢 Nit

- **Test E is a code path for a result known before the run (lines 67, 72–74).**
  - The table still gives E a "Rule" and a "Comparison" column, as if it were a backtest.
  - `run.py` keeps the `--crown-dir` option, reads the Crown desk notes and blotter, and hashes them (`run.py:52–66`, `191`, `195`), all to print "not enough data".
  - This is a YAGNI case: one sentence in "The tests" ("8 closed trades, Crown is switched off, outside the verdict rules") would remove the code path and the reads of private Crown files.
- **Results at other premium shares (lines 140, 197):**
  - The document reports results at 6%, 25% and 100% but never says which share decides the result.
  - The code decides at 25%, which line 140 only implies.
  - State "the result is the 25% row; 6% and 100% are descriptive" before the run. Otherwise disagreement between shares becomes a choice made after the run.
- **Third copy of the method text (`report.METHOD_HTML`):**
  - The report page carries its own method text. That text already contradicted the document once (stage 9 Blocker 1).
  - It still uses the volatility-window wording "20 days below six months to expiry, 60 days from six months" that the document has since fixed at lines 129–130.
  - Cut it to a pointer to `design.md` and the result labels, or build it from the document.
- **No data-flow overview (critic structural Major 2 still open):**
  - The pipeline is spread across Data, Shared simulation rules, Entries, Test details and the Plan.
  - Three lines would let a new reader see it before the parameters: load bars → proxy entries → paired legs → Δμ, bootstrap and result → `results.json` and `index.html`.
- **Row count (line 98):** state the real number of results, including the results at other shares (see Major 1), so that "exploratory" is measured against the right count.

## Accepted as fine

- **Parameter detail in "Test details" (lines 162–189):** for a backtest, the parameters are the method, and recording them answers stage 9 Blocker 3. The cost is that they repeat the code docstrings; a table with each value and its source file would reduce drift.
- **Test H kept:** it is cheap because it reuses the G books, and line 73 says its result is expected in advance.
- **Survivorship handling:** reading "fail" and "paid insurance" in A–D as upper bounds on the rule's cost is the right minimal response.
- **Per-study `report.py`:** this follows the repository's existing pattern (`flow_control/report.py`, `trend_trio/report.py`, `triple_rsi/report.py`).
