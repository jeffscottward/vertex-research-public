# Long Calendar Spread, call or put (research definition and modeled backtest)

Status: research only. No live or paper orders. No broker changes. No engine is armed by this file.

## Source

- Instagram reel DfcycUDCjgD (Harry, "Spreads Trading", 75 s), sent by the owner on 2026-11-07 (card vertex-calendar-spread): "add this to our plays; if calendar spread is not one of our strategies, add it". An earlier reel from the same account, DfaV7HMCWJE, gave the SOXL 45C calendar (card potential-plays-board). The claims below are the creator's; they are checked, not trusted.
- Idea as stated: when bullish on a stock for 3 months to 2 years, do not buy a ~100-day call. Sell the ~100-day call and buy the same strike ~200 days out. Example: SOXL, strike 100, long leg to May 2027.
- Claimed: the spread costs about the same as the naked call (about USD 330), risk is the debit, maximum profit is "over USD 2,000 per spread", and while SOXL stays above break-even "every week and month that goes by" adds profit (time decay).

## Classification

Basis codes: S = stated by the creator; I = implied; A = Vertex default, fixed before the first full run.

## Rules

|#|Rule|Basis|
|---|---|---|
|1|Structure: sell one option (call or put) at the near expiry and buy one option of the same right and the same strike at the far expiry. Net debit.|S|
|2|Tenors: near leg about 1x the holding horizon, far leg about 2x (the reel: about 100 and 200 days to expiry).|S|
|3|Strike: at the price you expect at the near expiry (bullish use: above spot). Neutral use: at the money.|S / I|
|4|Term-structure check at entry: enter only if far-leg implied volatility is at most 1.10 x near-leg implied volatility (a much richer far leg makes the spread expensive and loses when the term structure flattens).|A|
|5|Exit: close both legs together at the profit target (spread value at least 1.5 x the debit) or at the near-leg expiry, whichever comes first. A new spread may then be opened (the roll).|A|
|6|Maximum loss: the debit plus costs. The long leg is always worth at least its intrinsic value (it can be exercised), so at the near expiry the spread is never worth less than zero.|S / A|
|7|Play rules (owner standing rules) for any real use: options only, defined maximum loss at most 2% of NLV, loss exit 3 trading days before the near expiry, profit exit 15:45 ET on the near expiry day.|owner|

## Payoff and Greeks

Priced with the Vertex Black-Scholes-Merton pricer `packages/api/src/options-chain-greeks.ts` (`blackScholes`, European, continuous dividend yield). Net Greeks are long-leg minus short-leg. At the money the spread is long vega and long theta (it earns time decay) and short gamma: it makes money when the underlying stays near the strike and loses when the price moves far from the strike in either direction, or when far-leg implied volatility falls. The value at the near expiry is the far leg's model value (at the implied volatility then) minus the near leg's intrinsic value; the peak is at the strike. Code: `scripts/research/calendar-spread.ts` (`calendarGreeks`, `payoffAtNearExpiry`).

## Backtest design (fixed 2026-11-08, before the first run)

There is no historical option chain or implied-volatility surface in Vertex (`research/backtests/151-strategies/harness-evaluation.md`: no approved vendor; IBKR serves no history for expired options). This backtest is therefore MODELED: every option price is a Black-Scholes price from an implied-volatility proxy. It cannot see bid/ask quotes, skew or the volatility risk premium in single-name chains. A PASS would only allow a test on real option data; it would not allow paper trading.

|#|Design choice|Basis|
|---|---|---|
|B1|Underlyings: SPY, QQQ (index ETFs) and TQQQ, SOXL (3x leveraged ETFs). Daily closes from Yahoo (split-adjusted, not dividend-adjusted), 2011-01-03 to the last close before the run.|A|
|B2|Implied volatility proxy. SPY: CBOE ^VIX (30 days) and ^VIX3M (93 days), interpolated linearly in total variance between 30 and 93 days and flat outside. QQQ: CBOE ^VXN for every tenor. TQQQ and SOXL: trailing 60-day realized volatility of daily log returns (x sqrt 252, floor 20%) for every tenor. A flat proxy makes rule 4 always pass; only SPY tests rule 4.|A|
|B3|Rate: ^IRX (13-week T-bill yield) on the day. Dividend yield: SPY 1.5%, QQQ 0.7%, TQQQ and SOXL 0.|A|
|B4|Expiries: near expiry = the first trading day at least N calendar days after entry (its close is observed); far expiry = the near expiry + N calendar days. Strikes are continuous (no listing grid). Both legs are valued at max(Black-Scholes price, intrinsic value), the floor an American option has.|A|
|B5|Configs: A = 30/60 days at the money; B = 100/200 days at the money (the reel's tenors); C = 100/200 days, strike where the near-leg call delta is 0.30 (the reel's bullish, out-of-the-money use). Calls only: under the model an at-the-money put calendar differs only by carry.|A|
|B6|Cycles: one spread at a time. Enter at the close of the first eligible day (rule 4). Exit by rule 5 at a close. Re-enter from the next trading day. One contract.|A|
|B7|Costs per leg per side: USD 0.65 commission per contract plus slippage of max(USD 0.01, s x option price) per share, s = 1% for SPY and QQQ, 3% for TQQQ and SOXL.|A|
|B8|Return per cycle: (exit value - exit costs - debit - entry costs) / (debit + entry costs).|A|
|B9|The reel's alternative: a long call at the same strike expiring at the near expiry, opened and closed on the same days with the same cost rule.|S|

## Pass/fail rule (fixed 2026-11-08, before the first run)

A config passes on an underlying only if ALL of these hold after costs:

1. at least 30 completed cycles;
2. mean return per cycle above 0 with a t-statistic of at least 2.0 (mean / (sd / sqrt n));
3. mean return per cycle above 0 in both halves of the cycles (split by count, in entry order);
4. a higher per-cycle Sharpe ratio (mean / sd) than the reel's alternative (B9) on the same cycles.

The calendar spread passes as a Vertex strategy only if at least one config passes on at least 3 of the 4 underlyings, including SPY or QQQ. Otherwise it is FAIL and stays in the catalog as research (status backtested, tag failed). Either way the result is modeled (see above).

## Code and tests

- Payoff, Greeks, simulation, pass rule and report: `scripts/research/calendar-spread.ts`; tests: `scripts/research/calendar-spread.test.ts` (100% coverage).
- Two-expiry structure on the qc-ports option book (Python, ledger and NautilusTrader): `services/research/strategies/qc_ports/book.py` (`parse_calendar`, `_price_calendar`), IV term `options.term_atm_iv`, form `forms_other.py` (`LONG_CALENDAR`); tests: `services/research/tests/test_qc_ports_two_expiry.py` and `test_synthetic_calendar_books_match` in `test_qc_ports_nautilus.py`.
- Fetch: `research/backtests/calendar-spread/fetch_data.py`; run: `bun run research:calendar-spread -- backtest --data <dir> --out research/backtests/calendar-spread/results.md`; full table: `research/backtests/calendar-spread/results.md`.
- Data: Yahoo SPY, QQQ, TQQQ, SOXL, ^VIX, ^VIX3M, ^VXN, ^IRX daily closes 2010-01-04 (TQQQ 2010-02-11, SOXL 2010-03-11) to 2026-11-06, plus split events, fetched 2026-11-08 on the rig. Not committed (Yahoo terms do not allow redistribution); `SHA256SUMS` sits next to the files. SHA-256 prefixes of the run's input: SPY.csv 13c60340f47eb014, QQQ.csv cad11a8add5faee0, TQQQ.csv 91116dda1c5313db, SOXL.csv b1838b78232803ca, VIX.csv c073dbae037cd307, VIX3M.csv 197a05e90cbad9af, VXN.csv 01ec4e5f1a332c88, IRX.csv ffaa93d2ee22a416, SPY.splits.csv d31f6770fe6f1d41, QQQ.splits.csv 8c193ab8763748ff, TQQQ.splits.csv 250ea72e8ca93cd1, SOXL.splits.csv 0719bbc7473022e6. The re-fetch for D1 (same source, same end date, plus split files) overwrote the first run's input files; the SPY and QQQ rows are identical in both runs.

## Deviations

- D0 (before the first run, same session): rule B4 was edited after the pre-registration commit and before the first run, in the commit that holds the first run. The far expiry became the near expiry + N days (it had been the first trading day 2N days out), and the intrinsic-value floor on both legs was added. Neither is a pass-rule change; removing the floor moves no table row by more than 0.2 points.
- Clarification of B2: for configs B and C both legs are at least 93 days out, so both get VIX3M and rule 4 never skips a day; only config A on SPY tests rule 4 (688 skipped days).
- D1 (found after the first run, before any rule change): Yahoo closes are split-adjusted, so TQQQ started near USD 0.22 and SOXL near USD 0.66 in those units, while the fixed per-share costs of B7 (USD 0.0065 commission, USD 0.01 minimum slippage) are in traded dollars. The first run (commit "first modeled run") charged them in adjusted dollars, which made early leveraged-ETF cycles look far worse than they were. Fix: prices stay split-adjusted (option contracts are adjusted at a split too); only the fixed costs are converted with the later split ratios (`costScale`). The pass rule and every other design choice are unchanged. SPY and QQQ have no split in the window, so their rows did not change. First run: verdict FAIL with the same passing set (config C on SPY and QQQ only).

## Results (2026-11-08, rig, after D1)

Per cycle, on the debit, after costs. t = t-statistic of the mean. Full table with the halves and every check: `research/backtests/calendar-spread/results.md`.

|Config|Underlying|Cycles|Mean|t|Win rate|Sharpe calendar / call|Pass|
|---|---|---|---|---|---|---|---|
|A 30/60 ATM|SPY|157|-11.7%|-2.73|46%|-0.22 / -0.06|fail|
|A 30/60 ATM|QQQ|198|-5.7%|-1.40|51%|-0.10 / 0.12|fail|
|A 30/60 ATM|TQQQ|197|-34.4%|-7.93|44%|-0.57 / 0.17|fail|
|A 30/60 ATM|SOXL|197|-30.3%|-6.73|48%|-0.48 / 0.11|fail|
|B 100/200 ATM (reel tenors)|SPY|73|11.4%|1.82|71%|0.21 / 0.11|fail (t < 2)|
|B 100/200 ATM (reel tenors)|QQQ|71|3.3%|0.48|62%|0.06 / 0.29|fail|
|B 100/200 ATM (reel tenors)|TQQQ|73|-27.0%|-3.83|56%|-0.45 / 0.33|fail|
|B 100/200 ATM (reel tenors)|SOXL|72|-28.5%|-3.93|53%|-0.46 / 0.22|fail|
|C 100/200, 0.30-delta strike (reel, bullish)|SPY|85|33.8%|11.25|89%|1.22 / -0.37|PASS|
|C 100/200, 0.30-delta strike (reel, bullish)|QQQ|79|27.8%|6.00|80%|0.67 / 0.04|PASS|
|C 100/200, 0.30-delta strike (reel, bullish)|TQQQ|87|4.2%|0.83|74%|0.09 / 0.20|fail|
|C 100/200, 0.30-delta strike (reel, bullish)|SOXL|96|4.5%|0.95|75%|0.10 / 0.12|fail|

Reading the table:

- Some single cycles lose more than the debit (worst about -250% on SOXL, config A). Both legs are floored at intrinsic value, so the spread itself is never worth less than zero; the extra loss is the B7 exit slippage charged on both deep-in-the-money legs after a large move. A combo order, or exercising the long leg against an assignment, would cost less. The maximum loss of the position is the debit plus costs (rule 6).
- Config C on SPY and QQQ is the only strong result, and it is the weakest part of the model: beyond 93 days both legs get the same flat implied volatility (VIX3M for SPY, VXN for QQQ), there is no call skew (out-of-the-money index calls trade below at-the-money volatility), and 2011-2026 was a strong bull market, so most of the edge is modeled upward drift toward an above-spot strike plus the implied-over-realized volatility premium in the index proxies. It needs real option-chain data before anyone relies on it.
- On the leveraged ETFs the losses come mostly from costs, not from the price moves: B7 charges 3% of the option price per leg per side, and these options are expensive (implied volatility 60-150%). Without costs, configs A and B are also positive on TQQQ and SOXL. The large-move risk of 3x daily-reset funds (card potential-plays-board) still shows in the worst cycles.
- Cost sensitivity (not part of the pre-set test, run after the verdict): with 2% slippage on TQQQ and SOXL instead of 3%, config C passes there too (TQQQ +11.1% per cycle, t 2.13; SOXL +10.9%, t 2.16), and so on 4 of 4 underlyings; with 1%, +18.4% (t 3.39) and +17.6% (t 3.29). At the money (A, B) stays negative at every level tested. The verdict therefore depends on the cost assumption for leveraged-ETF options; real quotes are needed to settle it (the reel's own SOXL quotes show a half-spread near 0.8% of the price on the near leg and near 7.7% on the far leg).

## Verdict: FAIL (modeled)

Config C passes on 2 of 4 underlyings (SPY, QQQ); the rule needs 3 of 4. No config passes on TQQQ or SOXL at the pre-set 3% slippage (see the cost sensitivity above: at 2% it would pass). The long calendar spread stays in the catalog as a research strategy (status backtested, tag failed). Next step if wanted: rerun config C on real historical option chains (vendor is an owner decision, `research/backtests/151-strategies/harness-evaluation.md`).

## Options forms study run (qc-ports option book and NautilusTrader, 2026-11-12)

The options forms study (`research/backtests/options-forms/README.md`) left this strategy out on 2026-11-11: the
qc-ports option book priced single-expiry verticals only. The book now prices the two-expiry structure
(`services/research/strategies/qc_ports/book.py`, `callCalendar` and `putCalendar`): each leg at the ATM IV of
its own days to expiry from the VIX (30 days) and VIX3M (93 days) term structure, linear in total variance, at
least its exercise value. The form `lib/long-calendar-spread` (`forms_other.py`) is config A on SPY with rule 4 at
entry and the study's owner exit rule instead of rule 5 (a winner is held to the near expiry, a loser closes 3
days before it); monthly listed expiries and the study's cost model (method in the study README). It runs on the
qc-ports reference ledger and on NautilusTrader 1.227.0; both agree (largest relative equity gap 3.4e-16).

Result (SPY, 2006-07-17 to 2026-11-10, 213 spreads): Sharpe -0.46 in the study model, -0.10 with the measured
SPY quotes model, +0.03 with commissions only. It fails the study gate and the owner's lower bar in all three.
Before costs a spread earns $2.24 on a mean debit of $280; the costs are $27.68. This agrees with the verdict
above: config A does not pass on SPY. Configs B and C are not run there (the data set has no IV index past 93
days).

## The reel's numbers (SOXL, quotes at the 2026-11-06 close)

A check of the reel's public example (strike 100, about 100 and 200 days, long leg in May 2027), priced on the public Yahoo chain. It is not a position or a play record; plays live only in the server's plays table (`docs/plays.md`).

Yahoo chain, SOXL 45.97: Feb-19-2027 100C (IV 134%), May-21-2027 100C (IV 126%). Far IV is below near IV, so rule 4 passes. Command (mid debit): `bun run research:calendar-spread -- play --asof 2026-11-06 --spot 45.97 --strike 100 --near 2027-02-19 --far 2027-05-21 --near-iv 1.34 --far-iv 1.259 --debit 3.23`.

- Cost: model price USD 334 per spread, about USD 323 at the mid. The naked Feb 100C costs about USD 330. The reel's "about the same as the naked call" holds.
- Maximum profit: about USD 2,180 per spread at the Feb-19 expiry if SOXL closes exactly at 100 (a 118% rise in SOXL) and May IV is still 126%. The reel's "over USD 2,000" holds only at that one point and that volatility.
- Break-evens at the Feb-19 expiry: about 51 and 273 (same IV). SOXL must rise about 11% just to break even; unchanged at 45.97 the spread loses about USD 102. The reel's "every week that goes by we make more money" is only true near the strike: today the spread has theta +0.82 USD per day but delta +12, so it mostly needs SOXL to rise.
- Greeks per spread today: delta +12.0, gamma -0.06, theta +0.82 USD/day, vega +4.94 USD per volatility point (a fall in SOXL implied volatility hurts).
