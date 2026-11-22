# Leveraged-ETF share test: S1 on SOXX, TSLA and NVDA

Status: design, EGM review resolved (2026-11-22). Card `vertex-leveraged-etf-shares-test`. Research only: no order, no arming, no risk setting, no engine code.

## Terms

|Term|Meaning|
|---|---|
|Study|The leveraged-ETF short-window study: `research/backtests/leveraged-etf/README.md`, code in `services/research/strategies/leveraged_etf/`. 7 pre-registered pairs, 40 form rows, result of 2026-11-12: 0 of 40 rows pass.|
|S1|Signal `session-open-momentum`: the first entry of the noise-band kernel in a session of the underlying, on IBKR 5-minute bars (`signals.session_open_momentum`).|
|Underlying (U)|SOXX, TSLA or NVDA.|
|Long fund, inverse fund|The fund that targets +L times (or -L times) the daily move of U. L is the multiple.|
|Window|`24h` = exit at the close of the session after the entry session; `48h` = the second session after it (`signals.WINDOWS`).|
|Regime|`all` keeps every signal; `calm` keeps a signal whose side matches the calm-and-trend reading of the last close before it (VIX, VIX3M and the 200-day trend of U; `signals.calm_days`).|
|Form|How a signal is traded. `lev-shares` (existing): the long fund on a long signal, the inverse fund on a short signal. `etf-shares` (new): shares of U on a long signal; on a short signal a daily-reset -1x synthetic of U (it has no borrow; the study trades no short shares). U's dividends with an ex-date after the entry day are received by the long trade and paid by the synthetic. `always-long` (new): the control, see below.|
|Book|One pair from its start day, booked alone. A row = book x S1 x regime x window x form.|
|Gate|The study's checks G3 to G7 (`allocation.gate_checks`): at least 30 trades, Sharpe and out-of-sample Sharpe at least 0.5, deflated Sharpe at least 0.95, Monte Carlo P(profit) at least 0.80 and drawdown p5 at least -35%, max drawdown at most 25%, and Sharpe above the baseline row.|
|Deflated Sharpe|The probability that the Sharpe is above the best of N random trials (`backtesting.optimizer.deflated_sharpe_ratio`). N = trials.|
|Core 7|The 7 ETFs of the study with IBKR 5-minute bars: SPY, QQQ, IWM, DIA, GLD, SLV, USO.|

## Problem

The owner asked for a test of the study's short-window signal on SOXX, TSLA and NVDA, traded as shares of SOXL, TSLL and NVDL for 24 or 48 hours. The trading knowledge bases decided on 2026-11-14 to test shares first and to build option pricing only when shares show an edge. The study code cannot run these names today: their pair is not in the pre-registered table, they have no IV index, no Dukascopy index for S2, and no IBKR 5-minute bars in the study's folder.

## Goals and non-goals

Goals:

- A verdict `pass`, `fail` or `underpowered` per tested row, and one verdict per underlying, with the failed gate checks.
- A data proof and a minimum detectable Sharpe per book, written in the study README before the first result.
- A pre-registered rule for "shares show an edge" (below).
- The 7-pair study keeps its table, its 40 rows, `N_TRIALS` 40 and its results.

Non-goals: option rows for the new pairs, S2 for the new pairs, the option gate, a pooled verdict, the earlier 1.5x fund period, a long-history test of S1 on U alone (see Alternatives).

## Method decisions

The agent decided each method question from the answers of the trading knowledge bases (owner rule of 2026-11-14), in two rounds on 2026-11-22. 7 of 8 kb-chat agents answered; quantstackai refused with HTTP 403. Most answers are labelled reasoning, not sourced. The record (questions, answers, picks) is in the card's report folder on the rig, `vertex-leveraged-etf-shares-test/kb-consult/`.

|Question|Decision|Votes|
|---|---|---|
|Baseline of a `lev-shares` row|The `etf-shares` row of the primary book of the same underlying, signal, regime and window. It is also the twin of "leverage helps".|7/7|
|Baseline of an `etf-shares` row|The `always-long` control of the same book, regime and window.|7/7|
|Pooling|One verdict per underlying, no pooled verdict.|7/7|
|Trials|The study's 40 rows plus every tested share row.|7/7|
|Inverse fund|Primary: the most liquid -2x fund for the whole primary period (TSDD, NVD). Supporting: the fund with the longest -2x history (TSLZ, NVDQ).|5/7 both, 2/7 liquid only|
|Earlier 1.5x period|Dropped: the -2x inverse funds started in late 2023, so it adds 3 to 5 months only.|7/7|
|Short sample|A verdict `underpowered` with a minimum detectable Sharpe written before the run.|7/7|

The study keeps 40 trials because its result is already published; the share test counts every row tested on S1 so far (40 + 32 = 72), because each new row is one more chance to find a pass by luck.

## Share-test table

`services/research/strategies/leveraged_etf/share_test.py`, separate from `pairs.PAIRS`. `ShareBook(name, pair, start, forms, primary)`; `pair.iv_index` is `""`.

|Book|U|Long fund|Inverse fund|L|Start (first signal day)|Forms|
|---|---|---|---|---|---|---|
|SOXX|SOXX|SOXL|SOXS|3|2010-03-12|etf-shares, lev-shares|
|TSLA|TSLA|TSLL|TSDD|2|2024-04-02|etf-shares, lev-shares|
|NVDA|NVDA|NVDL|NVD|2|2024-01-24|etf-shares, lev-shares|
|TSLA-TSLZ (supporting)|TSLA|TSLL|TSLZ|2|2024-04-02|lev-shares|
|NVDA-NVDQ (supporting)|NVDA|NVDL|NVDQ|2|2024-01-24|lev-shares|

Start rule: the first session at which both funds have their current multiple; SOXX uses the session after the funds' first day (2010-03-11), because a signal needs the previous fund close. The start day itself can carry a signal. Leverage reading (quarterly regression beta of the daily fund return on the U return, Yahoo, measured 2026-11-22): SOXL +3 and SOXS -3 since 2010-03-11 (beta 2.74 to 3.15); TSLL +1.5 until 2024-03-28 and +2 from 2024-04-02 (Direxion notice of 2024-02-02); TSDD -2 from 2024-01-22; TSLZ -2 since 2023-10-19; NVDL +2 and NVD -2 from 2024-01-24; NVDQ -2 since 2023-10-19.

The supporting books cover the same days as their primary books. They compare inverse funds; they never decide a verdict of an underlying.

## Rows, keys and trials

- Row key: `<book>:<signal>/<regime>/<window>/<form>`, for example `TSLA:session-open-momentum/calm/48h/lev-shares`. The part after `:` is the study's row key.
- Tested rows: primary books 2 regimes x 2 windows x 2 forms = 8 each (24); supporting books 4 each (8); 32 in all. `N_TRIALS` = 72.
- Control rows: `always-long` for each primary book, regime and window (12). They are baselines, not tested rows, and do not count as trials.

## Control

One long trade in U at every session from the book start: entry at 09:35 New York (the close of the first 5-minute bar) at the day's open price from the daily file, exit by the row's window. The `calm` control keeps the days on which the calm reading allows a long. The control goes through the same `signals.take` rule as S1: a new trade does not open while the previous one is open, so the 24h control trades about every second session and the 48h control about every third. This is the gate's "always-on baseline under the same exit rule" (G7). It is exposed to U for about the same share of sessions as a busy S1 row, so it removes most of the drift a long-leaning signal earns on a rising U, though not all of it.

## Statistics and verdicts

- Booking: each row alone in the qc_ports ledger, confirmed by NautilusTrader with parity (the study's standard). A ledger-only run is a diagnostic.
- Deflated Sharpe: computed with two trial variances, and the lower value is used: (1) the variance of the per-day Sharpes of the 40 study rows (from the 2026-11-12 `results.json`, its sha256 recorded; their variance reproduces the study's 0.001631) and the 32 tested rows; (2) the Sharpe variance of the row's own estimate, (1 - skew·SR + (kurtosis - 1)/4·SR²) / (days - 1), with the row's measured skew and kurtosis (`qc_ports.metrics._deflated` without a trial variance). The tested rows are correlated, which can make (1) small; (2) guards against that.
- Minimum detectable Sharpe (MDS) per book: the smallest annual Sharpe whose deflated Sharpe reaches 0.95 with the book's session count, 72 trials, no skew, kurtosis 3 and variance (2) for those moments, (1 + SR²/2) / (days - 1). It is a 50%-power threshold: a true Sharpe at the MDS passes G5 about half of the time.
- Row verdict:
  - `pass`: every gate check holds.
  - `underpowered`: the gate fails, every failed check is G3 (trades), G4 out-of-sample Sharpe or G5 (deflated Sharpe), the Sharpe is above 0, above its baseline Sharpe (G7 holds) and below the book's MDS.
  - `fail`: every other row.
- Underlying verdict (primary book only): `pass` when any row passes; else `underpowered` when any row is underpowered; else `fail`.
- "Leverage helps": the `lev-shares` Sharpe is above its `etf-shares` twin (reported, not a gate check).
- The owner's lower bar (`funded_pie.lower_bar`) is reported per row, as in the study; it is not part of the verdict.
- Control rows carry the S1 signal name in their key (`<book>:session-open-momentum/<regime>/<window>/always-long`), so that each control sits next to the rows it is the baseline of.

## Rule for "shares show an edge" (pre-registered)

- An `etf-shares` row of an underlying passes: the signal has an edge on U. Next step: option pricing for that underlying (a new card).
- Only `lev-shares` rows pass: the result depends on the fund cost model; check it with the cost sensitivity before any next step.
- The underlying is `underpowered`: no conclusion; repeat when the book has enough sessions for its MDS to fall to about 1.0.
- The underlying fails: close the question for that underlying.

## Cost sensitivity

The result uses the study's share cost of 0.10% of the price per side (`forms.SHARE_COST_RATE`) for U and the funds. The run is repeated at 0.25% and 0.50% per side (`--share-cost-rate`); those runs are marked partial and are reported next to the result, never in its place. A flat cost favors the fund that trades less, so a `lev-shares` pass that disappears at 0.25% is not an edge.

## Data

- IBKR 5-minute TRADES bars, regular hours, through the read-only QuantVPS history service. The service answers schema `vertex-history-bars-v1` (volume in lots), the same format as the Core 7 files of the study. `research/backtests/imom/fetch_ibkr.py` gets the opt-in `IMOM_IBKR_SCHEMA=v1`: it writes `ibkr5m/<SYMBOL>.csv.gz`, takes only named symbols, and refuses the Core 7 and `--spreads`. `IMOM_IBKR_EARLIEST` limits the backfill: NVDA and TSLA from 2023-06-01, SOXX from 2009-10-01. S1 reads volume only in one session's VWAP of one symbol, where a constant lot size cancels.
- Daily bars and splits (Yahoo): `fetch_data.py --share-test --out ~/Documents/reports/vertex-leveraged-etf-shares/data`, a folder of its own; the script refuses the 7-pair folder (it holds `TQQQ.csv`), so that folder and its checksums stay untouched. U's daily file is in the same folder and format as the funds.
- Split basis: the IBKR bars are split-adjusted like the daily closes (NVDA: IBKR 46.51 and Yahoo 46.507 on 2023-08-01, before the 10:1 split of 2024-06-10). SOXX splits 3:1 on 2024-03-07 and 2026-11-05. A window across a split of U or of its fund is skipped (existing rule).
- Coverage: the entry point stops when a book's IBKR bars start later than 30 days before its start day (S1 reads earlier sessions) or end before the last daily bar.
- Data proof (symbols, first and last bar, row counts) goes in the study README before the first result.
- Plumbing check (2026-11-22, before review resolution): one ledger-only run of the NVDA books checked that the entry point loads, prices and books. Only its log counts (signals taken, priced, booked) were read; its statistics and verdicts were never opened, and its output was deleted. The result run comes after this design and the README pre-registration are committed.

## Code changes

1. `share_test.py` (strategies): table, row keys, `N_TRIALS`, baseline and twin rules, fund leverage of the table.
2. `forms`: `SHARE_FORMS` (`etf-shares`, `always-long`) outside `FORM_KEYS`, allowed only for a pair without an IV index; `_underlying_shares` (long U, or the -1x synthetic from the signal price); `_shares` takes the form name; `load_share_pair` (IV-free market from the share folder); `first_day` skips the IV check for a share-test pair.
3. `runner.load_pair_signals(..., with_s2=False)`: S2 not run and no index file read.
4. `imom.data`: `IBKR_EXTRA_KEYS` (SOXX, TSLA, NVDA) join `IBKR_BY_KEY`; `IBKR_INSTRUMENTS` (the imom study list) is unchanged.
5. `metrics.verdicts(..., baseline_of=, twin_of=)`: keyword-only, defaults are the study's rule. A missing baseline or twin row raises.
6. `fetch_ibkr.py`: `IMOM_IBKR_SCHEMA=v1`, `IMOM_IBKR_EARLIEST`, the v1 guard.
7. `fetch_data.py --share-test`.
8. `research/backtests/leveraged-etf/share_test.py` (entry point): schema `leveraged-etf-share-test-v1`; flags `--data`, `--out`, `--qc-data`, `--prior-results`, `--capital`, `--no-nautilus`, `--books` (a supporting book brings its primary book), `--share-cost-rate`; coverage check; per-book booking; verdicts over all books in one pass; MDS; tracking error per fund (`prices.tracking_error` with the table's leverage); provenance (commit, dirty flag, data hash); `results.md` (book table and one line per row) next to the JSON; tracking error from each book start only. `complete` is true only with NautilusTrader, committed code, every book and the 0.10% cost.

Tests: `services/research/tests/test_leveraged_etf_share_test.py` (Nautilus lane) and `test_imom_fetch_ibkr.py`. The study's own tests pass unchanged.

## Alternatives

|Alternative|Decision and reason|
|---|---|
|Add the pairs to `pairs.PAIRS`|Rejected: it changes the pre-registered table, the trial count and the published result.|
|Baseline Sharpe 0 for `etf-shares`|Rejected by the knowledge bases: drift on the 2024 to 2026 rally can pass it.|
|Continuous buy-and-hold control|Rejected: G7 compares with an always-on baseline under the same exit rule; a buy-and-hold control has a different exposure and exit.|
|Pooled book|Rejected by the knowledge bases: one verdict per underlying keeps a strong SOXX result from hiding a weak TSLA result, and the reverse.|
|Long-history S1 rows on U alone (TSLA from 2010, NVDA from 2004)|Deferred: it answers a different question (edge of S1 on U, not on the funds) and needs another 6 to 8 hours of gateway fetch. Listed as missing evidence.|
|Per-symbol measured costs (IBKR BID_ASK samples)|Deferred: the cost sensitivity at 0.25% and 0.50% covers the question at no extra gateway load.|
|Deploy vertex-history 1.6.0 for v2 bars|Out of scope: a QuantVPS service deploy.|

## Risks and limits

|Risk|Mitigation|
|---|---|
|TSLA and NVDA have about 2.6 to 2.8 years at 2x; their MDS is about 2.4 to 2.5.|`underpowered` verdict and the MDS are reported; no conclusion from them.|
|The names were chosen after a strong rally.|The control limits the drift effect; the result says so.|
|A shared-code change alters the 7-pair study.|Share forms refuse study pairs; verdict defaults are the study's rule; the study's tests pass; a ledger-only rerun of the 7-pair study at base and head must give the same rows and verdicts.|
|The synthetic fund entry price differs from the real fund price.|Tracking error per fund in the results.|
|Flat costs.|Cost sensitivity.|
|Earnings gaps of TSLA and NVDA.|An entry more than 30% from the previous close is skipped (`MAX_ENTRY_GAP`); other gaps stay in the result, as in a real trade.|
|SOXX index change (2021) and fund closure.|Reported as limits; the funds still trade on 2026-11-20.|
|The IBKR fetch shares the gateway with trading.|One symbol at a time, 30 s between requests, paused during market hours (the script's rule).|

## Implementation stages

1. Data: IBKR bars, daily files, data proof and MDS in the README (before any result).
2. Code changes with tests; the 7-pair check.
3. Run: the result run, then the two cost-sensitivity runs.
4. Report: per-row and per-underlying verdicts, failed checks, control Sharpe, tracking error, cost sensitivity, a dark chart; the next step from the edge rule; what is still missing to prove a strategy.
