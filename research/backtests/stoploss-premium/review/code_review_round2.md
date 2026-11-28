# Code review, round 2 (fresh-context reviewer agent, commit 0a2deaa0, rebased as ae055959)

Resolution: no open finding. Nit 1 (comment) fixed; nits 2-3 accepted (rare fallback; tests kept).

I found no open findings: all seven round-1 findings are fixed correctly, and commit 0a2deaa0 adds no new look-ahead, accounting, off-by-one, scaling or test bug. The test suite passes: `services/research/tests/test_stoploss_premium.py` gives 68 passed. I also checked the 1990–1993 history and ran one simulation on the rig data, described below.

## Round-1 findings, one by one

1. **A reclaim: fixed.** At `shares.py:207-215` the re-buy is now `qty = min(sr.qty, cash / (close·(1+COST)))`. A rung the cash can't fully buy back is re-bought in part. Cash is still accounted correctly (the cost is subtracted exactly), and `design.md` now describes this rule. The new test fails under the old rule and passes now.
2. **H brake: fixed.** `books.weights` (lines 125-130) recomputes weights at 0.5% risk, with the cap and scaling applied to that set. At level 1 the target is `min(normal, max(cur, braked·eq))`, which matches the round-1 suggestion. Level 2's `min(cur, normal)` is the same as the old `factor = 0.0` branch. Sells for names no longer picked and the stop update are unchanged.
3. **F failed roll: fixed.** At `csp.py:142-149` the event is appended only when `_roll` returns a position. The new test checks that a roll for a credit records exactly one event, and the old test now checks that a failed roll records none.
4. **B fill volatility: fixed.** In `options.bid` (lines 221-227), an intraday fill (`spot` given) now uses `atm(i-1, …)`. Close-priced exits (`spot=None`, the D rules and the final mark) still use the day's volatility, as they should. On the expiry session t = 0, so the price is intrinsic and the volatility source doesn't matter.
5. **Calendar check: fixed.** `study.on_calendar` (lines 103-116) raises on a gap or extra session and cuts each name to the calendar's span.
   - This also drops each name's history before SPY's first date: 72 files go back to 1990, mostly with 779 sessions before 1993-01-29.
   - Results don't change. Every test starts in 1999 or later, the 260-session warm-up still ends in 1994, and ATR is a simple average.
   - `swing_low` looks back a bounded number of days, and `random_entries` draws the same relative positions from `rng.sample(range(lo, hi))` when the indices shift.
6. **Reused helpers: done, same behaviour.**
   - `expirations_after(d, 2)` scans months 0 to 2 on or after d, the same window as the old loop in `entry_days`.
   - `leaps_expiry` and `target_expiry` (30–60 days) pick the same expiry even though the new scan looks one month further.
   - `align` carries values the same way as before.
   - `strike_step` gives the same answer.
7. **Typing and docstrings: mostly done.** `Progress`, the `Rung`/`SoldRung` dataclasses, the typed F `paths` and both docstrings are in. Many functions still return a bare `dict`; that is a nit.

## Nits (none is blocking or needed for correctness)

- **`shares.py:210-211`:** the comment says "re-buy the rung with the cash it raised", but the code spends all available cash. That can include another rung's proceeds from the same day. In a simulation where rung 2 sold on the same day rung 1 reclaimed, rung 1 used about 1–2% of its own value from rung 2's sale. `design.md` ("as many of the sold shares as the cash buys") matches the code, so only the comment is wrong. Fix: reword the comment, or store each rung's own proceeds on `SoldRung` and cap the re-buy at them.
- **`options.py:224-227`:** if `atm(i-1)` is `None` but `atm(i)` exists, `quote` falls back to the day's volatility. This is rare: an index gap longer than five sessions, or the first day realized volatility is defined. Fix: when `spot` is given and the previous-close volatility is `None`, value the fill the way a day with no volatility is handled now.
- **Tests:**
  - The H test covers only `weights()`, not the level-1 target logic inside `atr_book`.
  - The intraday-fill test repeats `bid`'s own formula, so it would not catch a wrong `i - 1`.

Verdict: correct. Confidence about 0.85.
