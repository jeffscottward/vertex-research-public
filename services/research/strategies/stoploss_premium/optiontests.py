"""Exit rules on long option structures (tests B, C and D), on model prices (see options.py).

Each trade is simulated twice on the same entry: without the rule it is held to its planned exit and sold at
the model bid; with the rule it sells all or part earlier at the model bid, and the proceeds earn the T-bill
rate until the planned exit. A path holds the daily change of the trade value per unit of capital committed at
entry (value 1 = the entry debit), so the portfolio return of a day is the mean change over the open trades.

Rules
  * B, 📅 LEAPS exit ladder (market-watch-bot `market_watch/reentry/leaps.py`): 5 rungs on the underlying, the
    nearest at least 1 x ATR14 below the entry and at least half-way to the stop, the deepest at the stop,
    10/15/20/25/30% of the contracts; a rung sells when the day's low touches it, at the model bid with the
    underlying at the lower of the open and the rung. Without the ladder: time exit only, 2 sessions before
    the expiry session (LAST_CHANCE_DAYS).
  * C, loser close (`market_watch/exit_rule.py`): N sessions before the expiry session, a position whose model
    mid is below its entry debit closes; otherwise, and without the rule, it is held to the expiry session
    (15:45 ET, intrinsic value).
  * D, premium stop: close when the model mid falls to (1 - x) of the entry debit, checked on each close.
"""
from __future__ import annotations

import math
from collections.abc import Callable, Sequence

from .options import Trade, bid
from .portfolio import PathReturns

LADDER_WEIGHTS = (0.10, 0.15, 0.20, 0.25, 0.30)
LAST_CHANCE_DAYS = 2

# A rule sees (trade, day, share still held) and returns the sales of that day: [(share of the original
# position, underlying price of the fill or None for the close)].
Rule = Callable[[Trade, int, float], list[tuple[float, float | None]]]


def ladder_levels(und_limit: float, stop: float, atr14: float | None, min_atr: float = 1.0) -> list[float]:
    """Port of leaps.ladder_levels: 5 levels, nearest first; the deepest is the stop."""
    d = und_limit - stop
    r1 = math.floor((und_limit - max(min_atr * atr14 if atr14 else 0.0, d / 2)) * 100) / 100
    if r1 <= stop + 0.01:
        return [round(stop, 2)] * 5
    step = (r1 - stop) / 4
    return [math.floor((r1 - i * step) * 100 + 1e-9) / 100 for i in range(4)] + [round(stop, 2)]


def ladder_rule(levels: Sequence[float]) -> Rule:
    sold = [False] * len(levels)

    def rule(t: Trade, i: int, held: float) -> list[tuple[float, float | None]]:
        out = []
        for k, lv in enumerate(levels):
            if not sold[k] and t.u.low[i] <= lv:
                sold[k] = True
                out.append((LADDER_WEIGHTS[k], min(t.u.open[i], lv)))
        return out
    return rule


def loser_close_rule(sessions_before: int) -> Rule:
    def rule(t: Trade, i: int, held: float) -> list[tuple[float, float | None]]:
        if held > 0 and i == t.expiry_i - sessions_before and t.mid(i) < t.debit:
            return [(held, None)]
        return []
    return rule


def premium_stop_rule(loss: float) -> Rule:
    def rule(t: Trade, i: int, held: float) -> list[tuple[float, float | None]]:
        if held > 0 and i < t.exit_i and t.mid(i) <= (1 - loss) * t.debit:
            return [(held, None)]
        return []
    return rule


def path(t: Trade, rule: Rule, rf: Sequence[float], start: int) -> PathReturns:
    """Both legs of one trade. rf is aligned with the name's sessions; start is the calendar index of the
    first day after entry."""
    p = PathReturns(start=start)
    units = 1.0 / t.debit
    held, cash = 1.0, 0.0
    prev_w = prev_o = 1.0
    for i in range(t.entry_i + 1, t.exit_i + 1):
        cash *= 1 + rf[i]
        if i < t.exit_i:
            for share, spot in rule(t, i, held):
                share = min(share, held)
                if share <= 0:
                    continue
                cash += share * units * bid(t, i, spot)
                held -= share
                p.stop(i - t.entry_i)
        if i == t.exit_i:
            last = bid(t, i)
            v_w = cash + held * units * last
            v_o = units * last
        else:
            v_w = cash + held * units * t.mid(i)
            v_o = units * t.mid(i)
        p.add(v_w - prev_w, v_o - prev_o, (cash / v_w if v_w > 0 else 1.0) if i < t.exit_i else 0.0)
        prev_w, prev_o = v_w, v_o
    return p
