# Stopping-premium backtests of our exit rules (tests A-H): method

Card: `stoploss-stopping-premium-backtests`. Research only. This document describes the method implemented in
`services/research/strategies/stoploss_premium/` and `research/backtests/stoploss-premium/run.py`. It went through
the 🐘🐟 EGM consolidated review (stage reports and the resolution in `review/`, summary in
`review/consolidated_review_report.md`); the code was changed with the document.

Data flow: load daily bars and indexes → build entries (proxies, random control) or books → simulate the two legs
of every trade or name → aggregate the legs on the SPY calendar → Δμ, bootstrap, halves, threshold checks, result →
`results.json`, charts and `index.html`.

## Problem

Our engines use exit rules: stop ladders under shares and 📅 LEAPS, a loss close before option expiry, ATR stops in
the dry-run books and a drawdown brake. Kaminski and Lo (2014, "When do stop-loss rules stop losses?", Journal of
Financial Markets 18, 234-254; open-access copy next to the parent report) show that a stop adds return only when
losses continue after the stop (momentum or a change of regime). Under a random walk or mean reversion it costs
return, and it can still lower volatility. We do not know which case applies to our rules. The parent report
(`~/Documents/reports/web/stoploss-kaminski-lo/src/report.md`, section "Backtest plan", on the rig) planned eight
tests, A to H, with fixed pass/fail tests.

## Goals and non-goals

Goals:

- For each test, run the same entries with the exit rule and without it, and give each result row one of five
  results: "not enough data", "pass: adds return", "pass: paid insurance", "fail" or "inconclusive", with the numbers
  and charts. Each live test (A, B, C) has one or two headline rows (★): A = the live 5-rung ladder; B = all proxy
  entries pooled; C = the T−3 row of each structure. All other rows are diagnostics.
- Publish one report page (`~/Documents/reports/web/stoploss-premium-backtests/`, tailnet only) with one table per
  test.

Non-goals:

- No change to a live order, arming flag, size, cap, gate or other risk setting. A research result never changes a
  live rule.
- No purchase of option quote data (a paid vendor is an owner cost decision; see
  `research/backtests/151-strategies/harness-evaluation.md`, "Historical option chains").
- No intraday or quote-level simulation.
- No proposal from a result with fewer than 100 stop events.

## Terms

- **Exit rule**: a rule that sells a position before its planned end.
- **Leg**: one simulation of a strategy. Each test has two legs on the same entries: with the rule and without it.
- **Stopping premium Δμ**: the annualized mean (× 252) of the daily return difference between the two legs, after
  costs. The paper writes the same quantity as Δμ = p₀ × (rf − E[r | stopped out]) (equation 4); the study solves
  this for E[r | stopped out] and reports it, and does not use it for the result.
- **p₀**: the average share of the account that the rule holds in T-bills while the leg without the rule is still in
  the position. For test H, p₀ is the share of days on which the brake is active.
- **rf**: the daily return of the 13-week US Treasury bill (Cboe IRX index).
- **Stop event**: one sale caused by the rule (one ladder rung, one stop, one loss close, one roll, one brake start).
  **Stop days** count distinct calendar days with at least one stop event (one drawdown that sells five rungs on
  many names is one day).
- **Model price**: an option price from the Black-Scholes model, not an observed quote.
- **ATR14 / ATR20**: the simple 14- or 20-day mean of the true range. **IV**: implied volatility. **NLV**: net
  liquidation value of the account. **CSP**: cash-secured put. **T−n**: the session n sessions before the expiry
  session. **L**: the lowest low of the 20 sessions before the day (the support level).
- **Live rule**: a rule that the engines apply to real orders when armed (tests A, B and C). Tests D to H test
  candidates, dry-run rules or switched-off rules.
- **market-watch-bot**: the repository (`jeffscottward/market-watch-bot`) that holds the live rules; the study
  ports them (see "Ported rules").
- **Crown**: an external trade-letter service whose trades the copier engine copied; it is switched off.
- **KB**: the trading knowledge bases on the rig (the owner's research machine). The parent report's KB answers are in
  `~/Documents/reports/web/stoploss-kaminski-lo/src/kb-answers.md` (q1-q5; q5 is from the KB of the options educator
  "In The Money Adam").

## The tests

| Test | Live? | Rule (with) | Comparison (without) | Threshold check | Sample and universe | Prices |
| --- | --- | --- | --- | --- | --- | --- |
| A | yes | Share stop ladder under held shares (see "Test A") | Hold the name | Rung distances × 0.75 / × 1.25; window stop at −7.5% / −12.5% | 97 SP100 stocks held from 2000-01-03 | real |
| B | yes | 📅 LEAPS exit ladder: delta-0.75 call, first monthly expiry ≥ 365 days; 5 rungs (10/15/20/25/30% of the contracts) on the underlying from the live `ladder_levels`; a rung sells when the day's low touches it | Time exit only, 2 sessions before the expiry session | Stop distance and ATR × 0.75 / × 1.25 | Stock entries 2005-01-03 to 400 days before the data end; rows per entry family, per kind, a random-entry control and an IV-index ETF row | model |
| C | yes | Loser close at T−3: a position whose model mid is below its entry debit closes; also T−1 and T−5 as comparison rows; T−3 at half the model spread; T−3 on IV-index ETFs | Hold to the expiry session | T−2 / T−4 (whole sessions) | Same entries as B; 45-day call (delta 0.50) and 45-day call debit spread (0.50 / 0.30 delta) | model |
| D | no (candidate) | Premium stop: close when the mid falls to 50% of the entry debit, checked on each close | No stop (45-day structures: held to the expiry session; 📅 LEAPS: held to the time exit at T−2) | Stop at a 37.5% / 62.5% loss | Same entries; 📅 LEAPS call, 45-day call, 45-day debit spread; stocks and IV-index ETFs | model |
| E | no (Crown off) | Close when Crown's stated level breaks | Hold to the copier's exit rule | none | Stored Crown desk notes and blotter: a data count only, no simulation | none |
| F | no (not armed) | Today's CSP design plus a stop at 2 × credit; separately, a roll down and out for a net credit instead of the loss close | Today's CSP design | Stop at 1.75 × / 2.25 ×; roll at T−2 / T−4 | 13 names of the income list present in the data (CSX and KR missing), from 2011-01-03 | model |
| G | no (dry run) | Trend book with its 2 × ATR stop; rotation book with its 2 × ATR stop; the 10-month rule | No stop; no stop; buy and hold | 1.5 × / 2.5 × ATR; 8 / 12 months | Trend: 15 ETFs; rotation: 16 ETFs (no SOXX in the data); 10-month rule: one equal-weight book of the 15 trend ETFs; decisions from 1999-12-31 | real |
| H | no (dry run) | Drawdown brake on the G trend and rotation books | No brake | Brake levels × 0.75 / × 1.25 | As G | real |

The threshold check is the per-test column above; "±25%" in the fixed tests means that column. Test E can only
report "not enough data" (8 closed trades) and test H is expected to (about a dozen brake starts in 27 years); their
numbers are descriptive.

## Fixed pass/fail tests

From the parent report, fixed before any run:

1. Fewer than 100 stop events: "not enough data".
2. "Pass: adds return": Δμ > 0, the central (two-sided) 90% block-bootstrap interval of Δμ above 0, Δμ > 0 in both
   time halves of the sample, and Δμ > 0 in both threshold-check variants. A comparison row without a threshold
   check cannot pass.
3. "Pass: paid insurance": Δμ ≤ 0 and the maximum drawdown of the account curve at least 10% smaller (relative).
   The page states the return given up per percentage point of drawdown removed.
4. "Fail": Δμ < 0 with the interval below 0, and the drawdown not 10% smaller.
5. Any other case: "inconclusive" (the plan names no outcome for it). A positive but not significant Δμ with a
   drawdown cut is therefore "inconclusive", although it is better than "paid insurance"; the page shows the numbers.

Bootstrap: circular blocks of 21 trading days, 1,000 draws, seed 7, on the daily difference of the legs.

Reported for interpretation only (they never change a result): the sufficient condition of equations 17-18 (met when
the lag-1 serial correlation ρ of the leg without the rule, on non-overlapping returns at the stop's time step, is at
least its Sharpe ratio at that step; the step is the median number of days from entry to the first stop event for
the option, put and G books, and a fixed 21 days for the monthly rules A, the 10-month rule and H); p₀; E[r | stopped out]; stop days; the drawdown cut in each half; for option books, the
result at a premium share of 6%, 25% and 100%; the per-trade means.

About 37 result rows come from one run (plus the descriptive results at other premium shares). At a 90% interval a
few rows are expected to cross by chance, so the rows are exploratory evidence, and no multiple-testing correction is
applied. The headline rows are named before the run for this reason. For option books the result is the 25% row;
the 6% and 100% results are descriptive.

## Owner questions

A "fail" or "paid insurance" result on a headline row of a live rule (A, B, C) goes to the owner as one question
with a chart (one question for all such results). On model prices (B, C) the result is an evidence gap (the rule may
cost or protect at real quotes), not a proof. Diagnostic rows (controls, comparison rows, sensitivity rows, other
premium shares) never raise a question. The question never changes a rule by itself; any change is a separate owner
decision.

## Data

- Daily bars (date, open, high, low, close, adj_close; `close` split-adjusted, `adj_close` also dividend-adjusted)
  of 97 SP100 stocks and 31 ETFs, from the existing qc-ports / options-forms directory on the rig
  (`~/Documents/reports/web/vertex-calendar-spread-nautilus/data`, Yahoo and IBKR; not committed, the data terms
  forbid it). The universe is today's SP100 list (97 of 100 symbols have files). Index files (`date,close`): VIX,
  VXN, RVX, VXD, GVZ, OVX, VXSLV, IRX (VIX3M, VIX6M and TNX files are skipped as names and not used). `results.json` records the SHA-256 of every input file.
- Loading (a name whose sessions are not a contiguous slice of the SPY calendar stops the run): every `<SYMBOL>.csv`
  with more than 260 rows (a name also starts a test only after its first 260 sessions,
  so a short history starts later than the test's start date), except index files, `SHILLER`, names with `=` and
  `*.splits.csv`. A name is a stock unless it is in the study's ETF list. The calendar is SPY's dates (1993-01-29
  on). `SPY.csv` is required.
- Historical option prices with bid and ask: none exist in our data (the option-chain store starts on 2026-11-11).
- Test E: `~/.local/share/crown-cli/desk-notes.json` and the last line of `blotter.jsonl` (read only). Its "stop
  events" are the desk notes that state a "close below/under" level (regex `close[sd]? (?:below|under)`), shown next
  to the closed-trade count; the result is fixed to "not enough data" (8 closed trades, Crown switched off). A
  missing Crown folder gives zero counts.

## Shared simulation rules

- Shares and ETFs: total-return prices (open, high, low and close × adj_close / close); 0.06% cost per side (5 bps
  slippage and 1 bp commission, the market-watch-bot backtest constant).
- Fills: test A and B rungs fill at the lower of the day's open and the level (a gap fills at the open); a B rung
  prices the option with the volatility known at the previous close. Test G stops,
  the window stop, the 10-month rule, the C loss close, the D premium stop and the F exits act at the close.
- Option model (repository `strategies.qc_ports.options` with the market-watch-bot income-sleeve conventions):
  Black-Scholes with the day's 13-week T-bill yield (IRX) as the rate and dividends 0, on the split-adjusted close
  (the price that strikes follow); linear skew
  in standardized moneyness (`SKEW` table, else slope −0.20). ATM IV: for SPY, QQQ, IWM, DIA, GLD, USO and SLV the
  Cboe index × its `ATM_FACTOR` (carried over at most 5 sessions), else 1.15 × realized volatility over 20 days for
  expiries under six months and over 60 days otherwise. Half-spread per leg: the `HALF_SPREAD_PCT` table, else 3%
  of the leg value for stocks and 2% for other ETFs, at least 1 cent; $0.65 per contract per leg. Monthly expiries
  from `qc_ports.calendar.monthly_expiration` (NYSE holidays handled). On the expiry session a position is worth
  its intrinsic value at the daily close (the live rule closes at 15:45 ET); a sale there still pays the half-spread.
  Strikes are on the qc-ports grid (0.5 below $25, else 1). ATM IV is floored at 8%. "45-day" means the monthly
  expiry nearest 45 days inside 30-60 days; a spread whose 0.30-delta strike is not above the 0.50-delta strike is
  skipped. A trade is dropped when its expiry is after the data end, when a session up to its exit has no model
  volatility, or when its entry mid is not positive.
- rf: IRX / 100 / 252 per session, carried forward over gaps without a limit, 0 before the first IRX value.
- Books:
  - Share books (A, the 10-month rule): one path per name; the day's return is the equal-weight mean.
  - Option books (B, C, D): each trade starts worth 1 at its entry debit and is not rebalanced; the day's return is
    the sum of the value changes over the sum of the values at the previous close, per leg. The account holds 25%
    in this book (the live 📅 LEAPS bucket, `MW_HIST_MAX_TOTAL`) and 75% in T-bills, rebalanced daily. The live
    per-name caps (6% of NLV for 📅 LEAPS, 2% for shorter options) are not simulated; the 6% and 100% shares are
    reported instead.
  - Put book (F): the same value weighting; capital = strike (cash-secured), 100% of the account.
  - ETF books (G, H): one account each.
- After the rule closes a position, the proceeds earn rf until the leg without the rule exits.

## Entries for tests B, C and D

The live re-entry and wish-list engines decide on 1-minute bars, options flow and volume-profile value areas. The
data has daily bars without volume, so each entry is a labelled daily proxy:

| Proxy | Family | Signal | Underlying stop (used by the B ladder) |
| --- | --- | --- | --- |
| reclaim | momentum | a close below L, then within 5 calendar days a close ≥ 1% above L | L |
| acceptance | momentum | first close above the highest high of the prior 20 sessions | entry − 2 × ATR14 |
| zdip | dip | first close with a 20-day z-score ≤ −2 | 3% below entry |
| failed_breakdown | dip | low below L, close back above L and at most 1 × ATR14 above it | max(L − 0.25 × ATR14, entry − 2 × ATR14) |
| random (control) | none | random sessions (seed 11) inside the span of the name's real entries, as many as the real ones | entry − 2 × ATR14 |

Every stop then gets the 1 × ATR14 floor (stop ≤ entry − ATR14). One signal per name and kind per 21 sessions. C and
D do not use the stop column.

## Test details

- **A.** Ladder levels port `compute_levels`: rung 1 = the higher of today's low and the 5-day low, among those at
  least 1% below the close (else 1% below it); rung 2 = the 20-day low; rung 3 = the lower of the 50-day average and the
  last pivot low (lower than 2 bars on each side, 120 bars back), no deeper than 15% and at most r1 × 0.98; rung 2
  falls back to the midpoint of rungs 1 and 3 when the 20-day low is not at least 1% from both; then each rung at least
  1 × ATR14 below the close and the rungs at least 0.25 × ATR14 apart. Sizes 14/29/57% of the shares (the plan's
  3-level form) or the live 5-rung form (midpoints, 10/15/20/25/30%). The ladder is laid on the first session of each
  month. A sold rung is re-bought on a close at least 1% above it within 5 calendar days (the live reclaim);
  otherwise at the next monthly layout (our assumption; the live harness waits for its next placement or the
  owner). A reclaim re-buys as many of the sold shares as the cash buys (the reclaim price is above the sale price) and
  never happens on the day of the sale. A month whose levels
  collapse (or before ATR14 exists) gets no ladder, and the name is held. The live put open-interest levels are left
  out (no history); the 5-rung form follows `spaced_five`.
  Variants: 2 × ATR minimum, the 5-rung form, the paper's window stop (out when the 21-day return is below −10%,
  back when it is at least 0%).
- **F.** One put per monthly expiry, opened on the session whose days to expiry are nearest 38 inside 30-45, at the
  strike whose model |delta| is nearest 0.25 inside 0.15-0.30, credit at least $0.10; sell at the model bid, buy
  back at the model ask; take profit at 50% of the credit; loss close at T−3 when the mid is above the credit; else
  close on the expiry session. A strike whose model |delta| falls outside 0.15-0.30 on the grid is not traded. A
  session without model volatility holds the put and marks it at the last mid. Roll: buy back and sell the next
  monthly expiry at the lowest strike at or below the current one (down to half of it) whose bid covers the buy-back
  ask; no credit roll = hold to expiry (assignment at intrinsic, no trade and no rule event); each roll with a credit
  counts as a rule event; after 3 rolls the loss close applies. In both variants the leg that ends first earns rf until the other ends. Monthly entries keep the entries the same in both legs (the income backtest instead re-enters on the next
  session).
- **G/H.** Port of the market-watch-bot `trend` backtest: at each month-end close the selector names the wanted
  ETFs; weight = 1% / (2 × ATR / close), at most 15%, all scaled to at most 100%; names no longer wanted are sold; the
  exit stop (close − k × ATR) is checked on each close; a stopped name stays flat to the next decision; a held name
  keeps the higher of its old and new stop. Trend: month-end close above the 10-month average of month-end closes,
  ATR20. Rotation (momentum part only; the regime tilt, Crown view, flow and news inputs have no history): not
  eligible below a falling 200-day average (lower than 10 sessions ago); score = mean percentile rank of the 3- and
  6-month return relative to SPY; top 8; ATR14. Brake: at a month-end drawdown of the book of at least 10% from its
  peak the risk per trade halves (1% → 0.5%: weights recomputed at half risk, cap and scaling included; a held name
  keeps its size up to the normal target), at least 15% allows no new entries and no increases; held names are
  never cut. Sizing always uses 2 × ATR (the threshold runs move only the exit stop). Held names are resized to
  their target at each decision; a change below 1% of equity is skipped; purchases are limited to the cash on hand;
  a name's close and ATR are carried over its missing sessions. Rotation: 3- and 6-month returns are 63 and 126
  sessions, SPY is the benchmark only, ties break alphabetically. p₀ of a book is the value sold by stops since the
  last decision over the book value. Unlike the source backtest, cash earns rf. For H, stop days equal brake
  starts.

## Alternatives considered

| Question | Chosen | Rejected and why |
| --- | --- | --- |
| Option prices | Model price, labelled | Paid quote history (Cboe DataShop, ORATS, ThetaData, Databento OPRA): an owner cost decision. The option-chain store (since 2026-11-11): about two weeks, no history for past entries. |
| IV for stocks | 1.15 × realized volatility (income-sleeve convention) | VIX beta per stock: a new convention without validation. A calibration on the option-chain store: too short and ETF-only. The IV-index ETF rows show results with real IV dynamics. |
| Book size | 25% premium, results also at 6% and 100% | 100% premium only: drawdowns near −100% in both legs leave no room for a 10% relative cut. 6% only: the live per-name cap, not a book share. |
| Book aggregation | Value weighted, no rebalancing | Equal-weight mean of per-trade changes: wrong compounding (an earlier version gave impossible means below −100% a year). |
| Option model rate | The day's IRX yield | A rate of 0 (income-sleeve convention for 30-45-day puts): misprices one-year calls, and only the stopped leg exits at a model price. |
| Test E | A data count of the stored Crown history | Dropping the Crown reads: the count is the evidence that the sample is too small; the reads are read only. |
| Entries | Daily proxies plus a random-entry control | Engine entry logs: the re-entry log holds 22 buys (17 dry run, 5 submitted) from 2026-10-09 to 2026-11-27, far below 100 stop events. |
| Test F | Rebuilt in `csp.py` on the income-sleeve rules | Reuse `market_watch/income/backtest.py`: in another repository (no import across repositories) and it re-enters on the next session, so the legs would not share entries. |
| Test H data | The G books | Engine equity curves: no live engine has a long history. Pooling many single-ETF curves to pass 100 events: their brake starts fall in the same crises (2000-02, 2008, 2020), so the events are not independent. |
| Bootstrap | Circular blocks of 21 days | Longer blocks for one-year LEAPS holds: kept the plan's monthly block; the halves and threshold checks guard against luck. Stationary bootstrap: no gain for this use. |
| Break-even spread | One run at half the model spread for test C | Solving for the spread at which Δμ = 0 for every row: doubles the option runtime; the half-spread row answers the owner-relevant question for the live rule. |
| Outcome outside the labels | "inconclusive" | Forcing a pass or fail: not supported by the fixed tests. |
| Reason codes for "inconclusive" | Not added; the row shows the numbers | Codes defined after the run would be post-hoc. |

## Risks and mitigations

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Survivorship bias (today's SP100 list) | Names that left the index (often after falls a stop would catch) are missing, which likely favours holding in A-D | Each A-D page section carries a bias note; "fail" and "paid insurance" there are read as upper bounds on the cost of the rule |
| Model prices (B, C, D, F) | Spread and IV assumptions can set the sign of Δμ | "model price" label on every row; half-spread sensitivity row for C; IV-index ETF rows; owner questions on model prices are evidence gaps |
| Stock IV has no implied-volatility dynamics | A premium stop that fires on an IV fall is not modelled | ETF rows with index IV in B, C and D |
| Dividends 0 in the option model | Calls on dividend payers are priced a little high; the stopped leg sells at the model price and the other leg at intrinsic value, so the error enters one leg | Stated; the rate uses IRX (an earlier rate of 0 biased B-D against the rule) |
| Daily-bar proxies for live entries | The result may depend on the entry process | Random-entry control row in B; per-family and per-kind rows |
| Correlated stop events | 100 events can be few independent episodes | Stop days reported next to stop events |
| Drawdown is one path statistic | "Paid insurance" can rest on one crisis | Drawdown cut reported per half |
| Ports drift from the live code | A result describes an old rule | Source paths and commit in `study.PORTED_FROM` and `results.json` |
| Missing or changed input files | Wrong or unreproducible results | `study.load` fails on a missing SPY; SHA-256 of every input in `results.json`; `run.py` refuses uncommitted study code |

## Ported rules

Source: `jeffscottward/market-watch-bot` at commit `57a1b3b` (the ported files are identical at `a8df702b`).

| Study code | Source |
| --- | --- |
| `shares.compute_levels`, `shares.min_atr` | `market_watch/reentry/harness.py`, `market_watch/stops.py` |
| `optiontests.ladder_levels`, `LADDER_WEIGHTS`, `LAST_CHANCE_DAYS` | `market_watch/reentry/leaps.py` |
| `optiontests.loser_close_rule` | `market_watch/exit_rule.py` |
| `entries` reclaim, zdip and their stops | `market_watch/reentry/config.py`, `market_watch/reentry/gates.py` |
| `entries` acceptance, failed_breakdown and their stops | `market_watch/auction/rules.py` |
| `csp` | `market_watch/income/rules.py`, `model.py`, `backtest.py` |
| `books.atr_book`, `books.trend_selector` | `market_watch/research/backtests.py`, `market_watch/copyrot/trend.py` |
| `books.rotation_selector` | `market_watch/copyrot/rotation.py` |
| brake in `books.atr_book` | `market_watch/risk/__init__.py` |

The ports are checked against golden values: outputs of the live functions (`harness.compute_levels`,
`stops.new_ladder` with the round-handle rule, `leaps.ladder_levels`, `risk.trade_risk_pct`, `rotation._pct_rank`)
computed once at commit `57a1b3b` and copied into the tests, because the study cannot import across repositories.
The trend book, the reclaim/acceptance proxies, the loss close and the CSP management are checked with hand-computed
fixtures. The ports keep the live 2-decimal rounding, level-order check and round-handle rule; only the put open-
interest levels are left out.

## Detailed Implementation Plan

Status: implemented in this order; each phase leaves the tests green.

| Phase | Files (all created unless marked) | Tests (`services/research/tests/test_stoploss_premium.py`) |
| --- | --- | --- |
| 1 Measures | `services/research/strategies/stoploss_premium/__init__.py`, `premium.py`, `bars.py` | drawdown, compounding, autocorrelation, premium, bootstrap reproducible, implied E[r \| stopped], every verdict branch, comparison rows, insurance cost, total-return scaling, loaders, rf carried forward, ATR, extremes, z-score, month ends, realized volatility |
| 2 Books and test A | `portfolio.py`, `shares.py` | equal-weight and value-weighted aggregation (1 → 0.1 → 0.2 gives −90% then +100%), exposure mix, per-trade check, stop days, stop step, ladder levels, min ATR, pivot low, ladder on a fall and a rise, window stop |
| 3 Options, B-D | `entries.py`, `options.py`, `optiontests.py` | breakout and z-score entries, reclaim, failed breakdown, ATR floor, random control, expiries (Good Friday 2025), strike for delta, intrinsic on the expiry session, IV-index carry limit, spread scale, `ladder_levels` port, premium stop, ladder and loser close on a falling name |
| 4 Test F | `csp.py` | take profit on a quiet name; stop and roll on a crash; two-leg pairing |
| 5 Tests G, H | `books.py` | trend book with and without the stop; brake starts; rotation ranking; 10-month rule exit |
| 6 Run and report | `study.py`, `report.py`, `research/backtests/stoploss-premium/run.py`, `services/research/tests/ci-suites.txt` (modified: one line), this document and `review/` | report page with one table per test; overview rows |

Types: `premium.Legs` (dates, with_rule, without, rf, out, stop_events, stop_days), `portfolio.PathReturns` (start,
daily with/without/out, stop events, stop offsets, days to stop), `entries.Entry`, `options.Underlying`, `options.Trade`,
`books.BookResult`. Each test function in `study.py` returns `{id, title, prices: "real" | "model price" | "none",
live, bias?, universe, variants: [{name, note, summary, thresholds, verdict, insuranceCost, drawdownCut, perTrade,
exposure, byExposure?, curve}]}`.

Run (rig; the package itself needs no new dependency; `pydantic` is the import dependency of `services/research`
and `matplotlib` draws the charts in `run.py` only):

```sh
uv run --no-project --python 3.12 --with pydantic==2.13.4 --with matplotlib==3.10.7 python \
    research/backtests/stoploss-premium/run.py \
    --data ~/Documents/reports/web/vertex-calendar-spread-nautilus/data \
    --out ~/Documents/reports/web/stoploss-premium-backtests
```sh

Options: `--tests` (default `B,A,C,D,G,H,F,E`, the plan's order), `--crown-dir` (default
`~/.local/share/crown-cli`), `--allow-dirty` (diagnostic). Watched code: the study package, `strategies/qc_ports`,
`indicators` and this folder. Exit 2 when the watched code is uncommitted (without
`--allow-dirty`) or `--out` is inside the repository. Output in `--out`: `results.json` (`generatedAt`, `code
{commit, dirty}`, `dataDir`, `dataEnd`, `portedFrom`, `inputs {file: sha256}`, `seconds`, `tests {id: result}`),
`summary.png`, `test-<id>-premium.png` and `test-<id>-curves.png` (first 6 variants; none for E), `index.html`
(an optional hand-written `intro.html` in `--out` is placed above the overview).
