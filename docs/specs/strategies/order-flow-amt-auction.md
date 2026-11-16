# Order flow / AMT auction rules (failed auction, acceptance): pre-registered study

Status: research only. No live or paper orders. No broker changes. NautilusTrader stays disarmed. Everything above
the "Results" heading (terms, data, levels, rules, fills, option forms, trials, split and pass/fail rule) is frozen
by the commit that first sets `SPEC_SHA256` in
`services/research/strategies/order_flow_amt/rules.py` to the SHA-256 of this file above the "Results" heading. The
study runner refuses to run when that part changes. Before the freeze, one code check printed whole-sample gross
results of an earlier code version (it includes the later out-of-sample period); the printed numbers and what
changed after them are in the job report `vertex-orderflow-amt/exploratory-prints.md`. No entry, exit, level or
threshold of the two rules changed after that print.

Name: the owner asked for "order flow (with AMT inside)" as a strategy of the options bucket (card
`vertex-orderflow-amt-strategy`, 2026-11-11). The historical test uses Auction Market Theory (AMT) levels only.
True order flow (delta) has about one week of sampled history, so it is only described at new signals (see "Order
flow"). The library row says so.

## Terms

- Value area: the price range that holds 70% of a regular session's volume. VAH and VAL are its top and bottom
  edges. POC (point of control) is the price bin with the most volume.
- Developing POC: the POC of the current session's bars up to the signal bar, with the bin of the prior levels.
- Probe: a bar that trades beyond the prior value area (low strictly below VAL, or high strictly above VAH).
- Failed auction: a probe, then closes back inside value. Acceptance: closes beyond value, counted in the session,
  while the session's own POC moves beyond value.
- Delta: buy volume minus sell volume, signed by the quote rule (the `/flow` pipeline, table `flow_minutes`).
- House option model: Black-Scholes with the skew smile of `services/research/strategies/qc_ports/options.py`,
  implied volatility from the previous close of VIX (SPY) or VXN (QQQ), the 13-week T-bill rate, and the daily rows in
  the qc-ports data folder (`strategies/qc_ports/data.py`).
- Consult Qn: question n of the knowledge-base consult (job report `vertex-orderflow-amt/kb-consult/`).

## Source

Method choices: knowledge-base consult of 2026-11-16 (11 knowledge bases asked, 10 answered; owner rule 2026-11-14:
trading research method questions go to the knowledge bases, not to an owner menu). Decisions with sources: job
report `vertex-orderflow-amt/kb-consult/decision-record.md`. Numbers taken from the live AMT auction job
(market-watch-bot `market_watch/auction/profile.py`, commit 90b750e6): 70% value area, bin 0.02 x ATR14, value-area
expansion, 2 closes back inside value for a failed auction, 30 minutes of closes beyond value for acceptance.
Design review: EGM concepts brief, design draft and review reports in the same job report.

Differences from the live AMT job: 5-minute bars in place of 1-minute bars; ATR14 from the regular-session 5-minute
bars in place of daily bars; acceptance counts 6 five-minute closes in place of 30 one-minute closes and also needs
the developing POC beyond value (consult Q1, Fabio Valentini source); the live job only gates other entries and
never trades its states.

## Data

- SPY: 1-minute regular-session bars 2008-01-22 to 2021-05-06 (the file of the noise-band study), aggregated to
  5 minutes, used only before the first IBKR session (2020-02-18); IBKR 5-minute regular-session bars from then on.
  The 1-minute loader drops a day with any missing minute (2 days dropped); the count is reported.
- QQQ: IBKR 5-minute regular-session bars from 2007-10-22.
- History ends on the last IBKR session, which must be 2026-11-06 (the runner refuses other data). Yahoo 5-minute
  bars of 2026-11-09 to 2026-11-13 are the forward window only.
- A 5-minute session is complete when it has the 09:30 bar and a regular last bar (15:55, or 12:55 on a 13:00 half
  day); a missing bar inside it is filled with the previous close and zero volume and counts as a close (0 filled
  bars in the current data; the count is reported). Incomplete sessions are dropped and counted.
- Ex-dividend dates of SPY and QQQ (Yahoo): those sessions are not traded, because the opening drop by the dividend
  would look like a probe below value. They still give levels and ATR for later sessions. The runner refuses to run
  without both files.
- Vendor data stay outside the repository.

## Levels

Session d is not traded when it is a half day. Its levels come from session d-1, which must be the previous NYSE
trading day; when d-1 is missing, a half day or not loaded, session d is not traded.

1. ATR14 = mean true range of the 14 loaded sessions before d (regular-session high and low, and the previous
   loaded session's last close), rounded to 4 decimals; half days and ex-dividend days count. Without 15 earlier
   sessions there is no ATR14 and session d is not traded.
2. Bin = max($0.01, 0.02 x ATR14 rounded to the cent).
3. Bins are on a grid from $0 in whole cents: bin i covers [i x bin, (i + 1) x bin). Each 5-minute bar of d-1
   spreads its volume evenly over the bins from its low to its high.
4. POC = the bin with the most volume (tie: nearest the middle of the range, then the upper bin). Value area: start
   at the POC and add the larger adjacent bin (tie: the upper one) until at least 70% of the volume is inside.
5. VAH = top edge of the highest value-area bin, VAL = bottom edge of the lowest, POC = middle of the POC bin, each
   rounded to the cent.

## Rules

Bar k starts at 09:30 + 5k minutes New York and closes 5 minutes later. A signal is the close of bar k = 0 (closing
09:35) to k = 65 (closing 15:00). Each rule takes the first signal of the session; the rules are separate ledgers
and do not block each other. Rule letters follow consult Q1; option B there was the 80% rule, which is not tested.

Rule A, failed auction:

1. Probe below: a bar with low < VAL; probe above: a bar with high > VAH. The open counts: a session that opens
   beyond value has a probe in bar 0. Each side keeps its own most recent probe bar.
2. Signal at the close of bar k when k - (most recent probe bar of a side) >= 2 and every close from the bar after
   that probe to bar k is inside value (VAL <= close <= VAH). When both sides qualify, the side with the later probe
   wins; when one bar probed both sides, the long side wins (as in the live job).
3. Long after a probe below, short after a probe above. Target = prior POC. Stop = one cent beyond the session's
   lowest low (long) or highest high (short) up to the signal bar.
4. No signal at a bar whose close is at or beyond the target, or at or beyond the stop; the scan continues.

Rule C, acceptance:

1. Signal at the close of bar k when at least 6 closes of the session up to k are above VAH (below VAL), not
   necessarily in a row, bar k's close is above VAH (below VAL), and the developing POC (middle of its bin) is above
   VAH (below VAL).
2. Long above value, short below. Target = VAH + (VAH - VAL) (long), VAL - (VAH - VAL) (short). Stop = VAH - $0.01
   (long), VAL + $0.01 (short).
3. No signal at a bar whose close is at or beyond the target; the scan continues.

The 80% rule (open outside value, two 30-minute periods back inside, target the far edge) is not a rule here
(consult Q1). Rule A covers part of its setup (an open beyond value is a probe) with a different target.

## Fills (the NautilusTrader engine's rules)

- Entry: market order at the open of bar k + 1.
- Stop and target are distances measured at the signal close (|close - level|, rounded to 6 decimals) and applied
  from the entry fill. Prices are rounded to 9 decimals, the engine's precision.
- In each bar from the entry bar on: stop first (a bar whose low (long) or high (short) reaches the stop exits at the
  stop, or at the open when the open is already beyond it); then the target, which fills on touch (at the target,
  or at the open when the open is already beyond it).
- Time exit: at the close of bar 74 (15:45 New York; owner exit rule 2026-11-03 for options on expiry day).
- Underlying ledger: $100,000 notional per trade (fractional shares); costs per side $0.0035 per share and 1 basis
  point. Stress: these costs x2.

## Order flow

True delta exists from 2026-11-06 for SPY and ES (sampled ticks, 15% to 40% of each session's seconds) and from
2026-11-16 for NQ; QQQ has no tick source. It is not a filter in the historical test (consult Q2: 10 of 10). For
each SPY signal in the forward window (2026-11-09 to 2026-11-13; `flow_minutes` exported 2026-11-16), the study
reports the SPY and ES delta of the 30 one-minute rows before the signal close: the sum of delta, coverage = covered
seconds / 1,800, and whether the sign of the sum agrees with the trade side (no value when the sum is 0 or no row
exists). QQQ signals get no delta in this window. This is an anecdotal description, not a gate input.

The forward description runs only when a `flow_minutes` export is given; it is not part of the verdict inputs. A
delta filter is tested only after at least 60 regular sessions of streaming ES and NQ delta exist (the streaming tape
of card vertex-flow-control-signals); follow-up card `vertex-orderflow-delta-filter`.

## Option forms

- 0DTE (consult Q3): same-expiry-day debit vertical on the traded ETF: a call vertical for a long signal, a put
  vertical for a short one. Strike grid: `qc_ports.options.strike_step` ($1 at a price of $25 or more); a strike is
  the nearest grid strike (round half to even). Long strike: nearest the entry fill. Short strike: nearest the
  trade's target as applied from the entry fill, at least one grid step beyond the long strike. Only sessions from
  2022-11-28 (every weekday has an SPY and QQQ expiry from that week; Cboe circular C2022111000).
- Weekly (report only, not a trial): the intraday-momentum debit vertical
  (`strategies/imom/options.py` `price_at`: nearest Friday weekly with at least one trading day left, long leg near
  0.50 delta, short leg one sigma further out), sessions from 2010-06-04 (Cboe ETF Weeklys launch).
- Both: entry at the open of the entry bar; exit at the end of the exit bar at the trade's exit price; time to
  expiry measured to 16:00 New York; house option model; $0.65 per contract and half the modelled spread per leg
  (`qc_ports.options.leg_cost`); exit cost capped at the worst case for the width (`qc_ports.book.worst_exit_cost`);
  contracts so that the maximum loss (debit plus costs) is at most 2% of the account ($100,000, compounding);
  booked by NautilusTrader (`strategies/flow_control/options.py` `book_form`, which also books the qc-ports ledger
  and reports the largest gap). Stress row: the spread part of the costs x2.
- A trade gets no option position (counted by reason) when: the session is before the form's first day, no previous
  IV and rate row exists, that row is more than 5 calendar days older than the session ("stale IV"), the IV or rate
  value is missing, the modelled debit is not positive ("no premium"), or (weekly form) no strike pair exists.
- These prices are modelled; the 0DTE condition in the gate is a modelled cost hurdle, not real option profit and
  loss. Vertex has no historical option quotes, and the same-day readiness gates Z03 (real quotes) and Z07 (replay
  through expiry) in `services/research/strategies/zero_dte.py` stay open; they apply to paper or live use, which
  this study does not grant.

## Trials and split

- Sessions: every NYSE trading day to 2026-11-06 with a complete full-day session for SPY or QQQ (ex-dividend days
  included); a session without a trade counts as $0 profit and loss.
- Split: those sessions in time order; with n sessions, train = the first floor(0.6 x (n - 10)), then 5 left out,
  validation = the next floor(0.2 x (n - 10)), then 5 left out, test = the rest. Out of sample = validation + test.
  Nothing is tuned on train; it gives in-sample statistics only.
- Trials (N = 4, as in the flow-control study the trials are the rows that can carry a verdict): U-A, U-C
  (underlying), 0DTE-A, 0DTE-C. SPY and QQQ are pooled per row (sum per session); each symbol's own out-of-sample
  result is reported. The weekly rows are reported, not trials.
- Results by time of day (hour of the signal close) are reported after the run; they are not trials (consult Q5).

## Pass/fail rule

Deflated Sharpe: Bailey and Lopez de Prado (2014), on the per-session profit and loss of the U row's out-of-sample
sessions, with N = 4 and the variance of the four trial rows' per-session Sharpes (each over its own out-of-sample
sessions: 0DTE rows from 2022-11-28). A value that cannot be computed counts as a fail.

Per rule (A and C), in this order:

1. needs-more-data: fewer than 100 out-of-sample trades in the U row.
2. no-edge: U row out-of-sample net after base costs <= 0, or deflated Sharpe probability < 0.95.
3. needs-more-data: fewer than 30 out-of-sample trades in the 0DTE row.
4. no-edge: 0DTE row out-of-sample net <= 0.
5. no-edge: the NautilusTrader replay did not give the same trades (or did not run).
6. edge: otherwise.

NautilusTrader replay: each symbol x rule x side runs once in the engine (8 runs, only the sessions with a trade of
that side, no costs). It agrees when every trade has the same day, entry bar, exit bar, and entry and exit prices
within 1e-6 (absolute). The replay checks fills, not the signals. The runner needs NautilusTrader 1.227.0.

Library result tag: `passed` when at least one rule has an edge, `needs-more-data` when both rules need more data,
else `failed`. A verdict gives no trading authority.

## Known limits

- Bars only: the volume profile is an approximation (volume spread evenly over each bar's range).
- SPY changes source in 2020-02 (1-minute file to IBKR 5-minute bars).
- SPY and QQQ move together; pooled trades are not independent. The deflated Sharpe uses per-session profit and loss.
- Option prices are modelled from previous-close implied volatility.

## Code and tests

- `services/research/strategies/order_flow_amt/` (profile, rules, data, options, study), runner
  `research/backtests/order-flow-amt/run.py`.
- Tests: `services/research/tests/test_order_flow_amt_*.py` (synthetic; the NautilusTrader tests run in the
  nautilus suite).

## Results

### Library row

Table `strategies`, slug `order-flow-amt-auction`, section "Entry timing", status `backtested`, kind `python`,
params `[]`, source this spec. Name states the limits: AMT auction rules on SPY and QQQ, order flow not yet tested,
modelled options. Tags: `research-only`, `amt`, `intraday`, `spy`, `qqq`, `debit-vertical` and the result tag. No
`backtest-study` tag: no study document is imported into `research_studies`, and that tag means one exists. The
migration only inserts (`ON CONFLICT DO NOTHING`); a later result ships as a migration that updates the row by slug.

### Run of 2026-11-16

First run on commit `6157a8b5` (the freeze commit; after the rebase onto the base branch it is `0fcfc0f3`, with the
same study code, spec and shared modules). Rerun on commit `fbf7d59b` after a reporting fix (option records mapped
to their spreads by id; review finding): every number below is the same, except one weekly-A trade moved from the
train part to the validation part. Spec SHA-256 `1b3f4610ab8bcac6`, data hash `27b180e3244259f5` (bars, ex-dividend
dates and option-model rows), NautilusTrader 1.227.0, 131 s on the rig. Research only; no trading authority.

**Verdict: failed. Rule A: no-edge. Rule C: no-edge.**

- Sessions 2007-10-22 to 2026-11-06 (4,754). Train 2007-10-22 to 2019-03-15 (2,846), validation 2019-03-25 to
  2023-01-05 (948), test 2023-01-13 to 2026-11-06 (950). Data: SPY 1-minute file 2 days dropped; QQQ 5 incomplete
  sessions dropped; 0 filled bars.
- Deflated Sharpe (N = 4, 1,898 out-of-sample sessions): rule A probability 0.000 (per-session Sharpe -0.060), rule C
  0.000 (-0.102).
- NautilusTrader replay: 10,975 of 10,975 trades the same (8 runs). Option booking: NautilusTrader and the qc-ports
  ledger agree to $3e-11.

| Row | Part | Trades | Net USD | Sharpe (annual) | Win rate | Profit factor |
| --- | --- | --- | --- | --- | --- | --- |
| U-A | train | 2,755 | -58,507 | -0.84 | 0.585 | 0.80 |
| U-A | out of sample | 1,839 | -39,296 | -0.96 | 0.580 | 0.80 |
| U-C | train | 3,792 | -117,898 | -1.41 | 0.434 | 0.76 |
| U-C | out of sample | 2,564 | -84,218 | -1.61 | 0.438 | 0.73 |
| 0DTE-A | out of sample (from 2022-11-28) | 933 | -83,950 | -2.11 | 0.36 | |
| 0DTE-C | out of sample (from 2022-11-28) | 1,218 | -93,007 | -2.66 | 0.27 | |

- Underlying out of sample by symbol: rule A SPY 912 trades $-18,375, QQQ 927 trades $-20,921; rule C SPY 1,298
  trades $-33,901, QQQ 1,266 trades $-50,317. Stress costs (x2): rule A $-79,472, rule C $-140,195.
- Rule A exits (whole sample): target 3,144, stop 998, time 460. It wins 58% of trades, but the average loss is
  larger than the average win (profit factor 0.80 after costs). Rule C exits: target 2,971, stop 3,052, time 350.
- By hour of the signal (rule A, out of sample): every hour loses; the most loss is in the first hour (09:35-10:00,
  265 trades, $-12,606). Rule C: 1,908 of 2,564 signals come in the 10:00 hour ($-63,524).
- 0DTE form: 1,331 rule C spreads were priced, but only 1,226 were booked, because the account fell too low for one
  contract within the 2% maximum-loss sizing. Spread stress x2: rule A $-92,753, rule C $-94,215 out of sample.
- Weekly form (report only, from 2010-06-04): both rules lost about 98% of the account within the train part
  (whole sample: rule A 1,544 trades $-97,570, of them 1,542 in train and 1 in validation; rule C 1,585 trades
  $-98,299) and opened almost no position after that.
- Forward order-flow description (SPY, 2026-11-09 to 2026-11-13; `flow_minutes` export of 2026-11-16): 10 signals
  (5 SPY, 5 QQQ). For the 5 SPY signals, the 30-minute delta sign agreed with the trade side in 4 of 10 source
  readings (SPY and ES), with 9% to 16% coverage. Anecdotal; not a gate input.

Reading: the AMT levels alone, traded as two mechanical rules with structural stops, do not cover costs on SPY or
QQQ over 2007-2026, and the modelled same-day verticals lose more. The order-flow part stays untested
(`vertex-orderflow-delta-filter`).
