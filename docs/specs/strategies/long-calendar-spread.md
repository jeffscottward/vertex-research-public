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
|B4|Expiries: near expiry = the first trading day at least N calendar days after entry; far expiry = the first trading day at least 2N days after entry. Strikes are continuous (no listing grid).|A|
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
