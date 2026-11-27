# Stage 6: Comprehension test (egm-comprehension)

## What this proposes

The document describes a finished research study. It backtests eight exit rules (tests A–H) used by the team's trading engines: share stop ladders, LEAPS rung ladders, a rule that closes losing options a few sessions before expiry, a 50% premium stop, closing a Crown trade when its stated level breaks, cash-secured-put stops and rolls, ATR stops on trend and rotation books, and a drawdown brake. Each test runs two "legs" on the same entries, one with the rule and one without. It measures the stopping premium Δμ, the annualized difference in mean daily return after costs. It then assigns one of five labels using fixed rules: not enough data, adds return, paid insurance, fail, or inconclusive. The study changes nothing live. A "fail" or "paid insurance" result on a live rule becomes one owner question with a chart. The Detailed Implementation Plan lists the Python modules under `services/research/strategies/stoploss_premium/`, the fixture test file, and the `uv run` command that writes `results.json`, the charts and `index.html`.

## How the existing system works, per this document

Live engines use the exit rules being tested. Live re-entry and wish-list engines decide on 1-minute bars, options flow and volume-profile value areas. A LEAPS bucket is capped at 25% (`MW_HIST_MAX_TOTAL`), with per-name caps of 6% and 2% of NLV. There is a `ladder_levels` function, a `compute_levels` function, and a live 5-rung share ladder. A "market-watch-bot" carries a backtest cost constant and income-sleeve IV and spread conventions. A qc-ports option model exists in `strategies.qc_ports.options`. Crown is a now-disabled strategy with stored desk notes and a blotter. The data available is daily bars, Cboe IV indexes and IRX on "the rig". There is no historical option-quote data, so option tests use Black-Scholes model prices.

## Findings

### 🟡 Major

#### 1. The parent report and its KB answers are cited but not linked (lines 8, 33, 113–120)

The pass/fail tests "come from the report" (line 33). Decisions cite "KB answer q5 of the parent report (In The Money Adam)" and "`kb-answers.md` q1-q5". The document gives no path or link for any of them. I found them outside the repository at `~/Documents/reports/web/stoploss-kaminski-lo/src/report.md` and `.../src/kb-answers.md`. The repository's only `kb-answers.md` belongs to an unrelated design (`docs/vertex-rebuild/designs/openbb-option-iv-second-source/`), so a reader who searches will find the wrong file. "KB" and "In The Money Adam" are never defined. A reviewer cannot check that the "fixed before any run" criteria match the source.

#### 2. Test E has no method a reader can follow (line 101; Known limits line 131)

The row says "Close when Crown's stated level breaks / Hold to the exit rule / none / Not needed". Several things are left open:

- What Crown is (lines 67, 101).
- Which "exit rule" the comparison leg holds to.
- How Δμ or a drawdown could be computed with no prices.

The code (`study.py:407–412`) only counts desk notes, closed trades and "close below" notes; it produces no Δμ and no curve. With 8 closed trades, rule 1 (fewer than 100 stop events) would label it "not enough data" anyway. The document should say plainly that test E is a descriptive count only and is outside the verdict rules.

#### 3. The role of the Kaminski–Lo equation and of p₀ is unclear (lines 21–24)

Δμ is defined as a measured difference between the two legs, then equated to p₀ × (rf − E[r | stopped out]). The document does not say whether the equation is used to compute anything. In the code it is solved backwards for an implied E[r | stopped out] (`premium.py:182–183`). The p₀ definition is hard to parse: "the average share of the account that the rule holds out of the strategy … while the leg without the rule is still in the position." It does not say which days the average covers: all days, or only days when the "without" leg is invested. "Annual mean daily return" is also ambiguous: annualized mean of daily returns, or a mean of annual returns?

#### 4. The sufficient condition is stated with no comparison and no purpose (lines 44–46)

"ρ … against its Sharpe ratio at that step" does not say what the test is. The code uses `met = rho >= sharpe` (`premium.py:123`). The document also does not say what the result is used for. It is not one of the pass/fail criteria, so a reader cannot tell whether it affects the verdict or is only reported.

#### 5. The "±25% threshold" criterion conflicts with the threshold column of the tests table (lines 36–37 vs 96–103)

Rule 2 requires "Δμ > 0 with the rule's threshold moved −25% and +25%". Several tests use other perturbations:

- C uses T−2 and T−4 sessions.
- F uses 1.75× and 2.25× credit.
- G uses 1.5×/2.5× ATR and 8/12 months.
- E has none.

The document should state that "±25%" means "the per-test perturbation in the table". It should also say how E (no check) is judged.

#### 6. Many project-specific terms are never defined or linked

Most could be fixed with one-line glosses or a link:

- "Card" (line 3)
- "arming flag" and "owner" (line 12)
- "the rig" and the "qc-ports / options-forms data directory" (line 63)
- "market-watch-bot backtest constant" and "income-sleeve conventions" (lines 72–73)
- "📅 LEAPS bucket" (line 79)
- "re-entry and wish-list engines" (line 82)
- "live harness" (line 128)
- "the trading research rule" (line 119)
- "the live 15:45 ET close" (line 77)
- "CI base suite" (line 151)
- In the tests table: "supports", "rung", "layout", "the live 5-rung form", "`compute_levels` port" (line 150), "live `ladder_levels`", "sector rotation (momentum part)"

For example, "momentum part" excludes a regime tilt, the Crown view and flow (`books.py:12`), but the document never says so.

#### 7. Entry proxies use an undefined level and do not say how the stop column is used (lines 85–93)

- "20-day support L" is the anchor of three of the four proxies, but the document never says how L is computed (lowest low? a pivot?).
- The "Underlying stop" column is never tied to the tests. Presumably B builds its ladder from it and C and D ignore it, but this is not stated.
- The 32,851 entries do not say which universe they come from: stocks only, or stocks plus ETFs.

#### 8. Parts of the option-model description cannot be parsed or reproduced (lines 73–78)

- "ATM IV = the Cboe index × its factor": which factor, and where is it defined?
- "else 1.15 × realized volatility, over 20 days below six months to expiry and 60 days from six months": this reads as a realized-volatility window rule, but the sentence is ambiguous.
- "linear skew in standardized moneyness": the slope is not given.
- "rates and dividends 0" in Black-Scholes sits next to the statement that proceeds earn rf from IRX. The document should say why the model rate is 0 while the cash return uses rf.

#### 9. Several sizing and outcome statements are ambiguous (lines 12–13, 79–80, 39)

- The document says which live rules exist, but not which tests cover a "live rule" for the owner-question trigger.
- The "6% and 2% of NLV" per-name caps are quoted, but the document does not say what each cap applies to or whether the backtest enforces them.
- "Maximum drawdown at least 10% smaller" does not say which series it is measured on. Presumably it is the account curve of each leg, including the 75% T-bill share for option books.

### 🟢 Nit

**10. "Both halves of the sample" (line 37) does not say how the sample is split.** Presumably it is two time halves.

**11. The code and the document count outcomes differently.** The document says "The report names no fifth outcome" (line 40) and "Outcome outside the four labels" (line 117). The `premium.py` docstring says "the plan defines no fourth outcome". The labels counted should match.

**12. The survivorship-bias direction is asserted without reasoning (lines 124–125).** "favours holding over stopping" needs a one-line justification: delisted names tend to fall, which stops would have caught.

**13. The universe size is unexplained (line 63).** The document says "97 SP100 stocks" but not why it is 97 rather than the full index list.

**14. Option fill prices on a stop touch are not specified (lines 98, 126–127).** "A rung sells when the day's low touches it", combined with "fill = lower of open and stop", does not say at what underlying price the model option price is taken when the stop fires.

**15. The Kaminski and Lo (2014) paper is cited by equation numbers (4, 17–18) without a reference or link.** A PDF sits in the parent report folder (`kaminski-lo-2014-mit-open-access.pdf`).

**16. The run command does not describe the data directory (lines 153–155).** It gives `--data <data dir>` but not the expected layout or file names (bar CSVs, the IV-index and IRX files, the Crown history). The output goes outside the repository (`~/Documents/reports/web/...`) with no note of where `results.json` lives for review.
