# Code review, round 1 (fresh-context reviewer agent)

Resolution: all seven findings fixed in the next commit (A reclaim with its own proceeds, H brake at half risk per trade, F failed roll not an event, B fills with the previous close volatility, calendar check in study.load, reuse of qc_ports align/strike_step/expirations_after, typing and docstrings), each with a test.

I found two major and five minor problems. Most of the simulation code is sound. The two major bugs are in the test A reclaim rule and the test H brake, and fixing the first one changes a published verdict. The 63 tests pass, but none of them exercises either bug.

Other files were being edited while I reviewed (`csp.py`, `options.py`, `books.py` and `run.py` changed at 17:24, `report.py` at 17:29). The line numbers below match the files as they were at 17:30. The changes I re-read (the delta-band check in `csp.open_put`, the no-volatility handling in `csp.simulate` and `Underlying.quote`, and the stop-value p₀ in `books.atr_book`) look correct.

## Major

**1. Test A: the reclaim re-buy almost never fires for a single sold rung.** `shares.py:194-197`

- **Bug:** A sold rung is re-bought only if `q * close * (1 + COST) <= cash`. The only cash is that month's sale proceeds. The rung sold at or below its level, and the reclaim buys at a close at least 1% above it, so one rung's proceeds can never pay for the same quantity. It works only when other rungs' cash is lying around, which then starves those rungs in turn.
- **Measured on the rig data:** 9,163 of the 20,392 rungs that met the reclaim condition (3-level) and 9,065 of 31,273 (5-rung) were never re-bought; 8,862 and 8,655 of those were the only rung waiting. That stock sits in cash until the next monthly layout.
- **Effect when the rung's proceeds are re-bought instead:**

| Row | Δμ now | Δμ fixed | p₀ now | p₀ fixed |
| --- | --- | --- | --- | --- |
| 3-level ladder | −4.44% | −3.85% | 0.171 | 0.133 |
| 5-rung ladder | −4.23% | −3.84% | 0.143 | 0.119 |

- **Verdict flip:** On the 3-level plan row the drawdown cut falls from 11.2% to 8.6%, so "pass: paid insurance" becomes "fail".
- **Fix:** Buy back what the cash allows: `qq = min(q, cash / (s.close[i] * (1 + COST)))`, then `if qq > 0: cash -= qq * s.close[i] * (1 + COST); units += qq; continue`. Or store each rung's own proceeds in `sold` and reinvest exactly those. Add a test where one rung sells and the close then rises 1% above it.

**2. Test H: the brake halves the final weight, not the risk per trade.** `books.py:199-203` (sizing at 190)

- **Bug:** The docstring and the port claim `risk.trade_risk_pct`: 1% → 0.5% risk per trade. The code halves `normal`, which is computed after the 15% cap and after the scaling to 100% gross. In the live sizing (`stock_shares`: risk ÷ stop distance, capped at 15%), the cap usually binds. Measured at every month-end, 98% (trend) and 97% (rotation) of the wanted names are capped at full risk, and 72% and 66% are still capped at half risk.
- **Effect at brake level 1:** gross exposure is about 0.45 as simulated against about 0.88–0.91 under a real risk halving.
- **Re-run with risk-halved sizing:** trend Δμ goes from −0.54% to −0.04% a year. Rotation goes from −0.87% to +0.30% (the sign flips). The brake-start count also changes: 9 → 6 and 12 → 11.
- The result label stays "not enough data", but the published Δμ and drawdown describe a stronger rule than the one ported.
- **Fix:** On brake days, compute the weights with the reduced risk, `min(RISK * 0.5 / (SIZE_ATR * at / c), CAP)`, and their own scale. At level 1, keep each held name between that half-risk target and the normal one. Leave level 2 as it is (no new entries, no increases).

## Minor

**3. Test F: a failed roll counts as a stop event.** `csp.py:142-145`

- `events.append` runs before `_roll`. When no strike gives a credit, nothing is sold (the put is held to expiry), yet an event is recorded.
- On real data, 101 of the 307 roll "events" are failed rolls, so stop events and stop days are overstated by about 49% and the first-event step is skewed. The 100-event gate still passes on the 206 real rolls.
- **Fix:** Append the event only when `new is not None`. If needed, count holds to assignment separately.

**4. Tests B and D: ladder fills use the day's closing volatility.** `optiontests.py:53` and `88`

- A rung fills at an intraday underlying price, but `bid(t, i, spot)` prices the option with `atm(i)`. That is the realized volatility including day i's close for stocks, or the index close (VIX etc.) for ETFs, which is known only after the fill. On down days this inflates the rule leg's sale price, which favours the rule.
- **Fix:** For intraday fills, pass `atm=u.atm(i - 1, t)` (the prior close) through `bid` to `quote`.

**5. Calendar alignment is assumed, never checked.** `portfolio.py:58` and `81`, `study.py:96`

- Paths map path day j to calendar index `start + j`. This assumes every name's sessions after its first one are exactly SPY's sessions.
- The current data is aligned (I checked: all 128 names, no gaps or extra dates after 1993-01-29). But a missing row, or one dropped by `series_from`, would silently shift every later day of that path. A name file one day newer than `SPY.csv` would crash `aggregate` with an IndexError (`rf[first + k]`) or the `Legs` length check.
- **Fix:** In `study.load`, assert that each name's dates from its first calendar date onward are a contiguous slice of the calendar, and cut names at the calendar end.

**6. Duplicates existing repository helpers.**

- `options.py:108-114` re-implements `strategies.qc_ports.data.align(series, dates, max_fill=MAX_FILL_DAYS)`; same carry rule.
- `csp.py:89` re-implements `qc_ports.options.strike_step`.
- `options.monthly_expiries` and the month loop in `csp.entry_days` duplicate `qc_ports.calendar.expirations_after`.
- **Fix:** Call the existing functions.

**7. Typing and stale documentation.**

- `progress=None` has no annotation in `study.py:160, 224, 291, 309, 335, 364, 386, 434, 470`; use `Callable[[str], None] | None`.
- `paths(**kw)` at `study.py:404` is untyped.
- `rungs: list[list]` at `shares.py:161` holds mixed values; use a small dataclass.
- Many return types are a bare `dict`.
- The docstrings at `optiontests.py:6` ("mean change over the open trades") and `portfolio.py:1` ("Equal-weight portfolio") describe the old equal-weight aggregation, not the value weighting now used for option and put books.

## Checked and found correct

- **Look-ahead:** signals use support and resistance from before the day, and z-score and ATR at the decision close. A-ladder levels are laid at the close and fill from the next day. G and H decide at month-end closes.
- **Path offsets:** `PathReturns.stop` offsets match the `first_k(entry + 1)` starts; `_book_legs` and the H legs are aligned with the calendar.
- **Costs:** charged once per side in every leg, both entries and exits. Option debit is mid + cost, exits at the bid, puts sold at the bid and bought back at the ask.
- **Value-weighted aggregation and exposure mixing:** correct, including the scaling of the bootstrap interval for the 6%/25%/100% rows.
- **Statistics:** the bootstrap percentile indices (50 draws outside each end of 1,000), the halves, `verdict` and the threshold scales all match `design.md`. The G 10-month row uses 8/12 months, which is ±20%, as documented.
- **Repository rules:** no committed JSON data, no secrets, and `run.py` writes only outside the repository.
- **Ports:** `leaps.ladder_levels` and the trend-book loop match `market-watch-bot` at 57a1b3b.

The A, F, G and H numbers above come from runs on the rig data. I ran B, C and D only on a 13-symbol subset as a sanity check; no full option-book run was done.

Verdict: not correct yet. Findings 1 and 2 change published results (one verdict flips in A, and the sign of one Δμ in H).

**Confidence:** about 0.85.
