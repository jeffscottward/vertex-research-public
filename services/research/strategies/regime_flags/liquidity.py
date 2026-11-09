"""Test C: the Fed net liquidity drain flag and its timing rule (rules C1 to C9)."""
from __future__ import annotations

import bisect
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta

from ..sma_timing import Stats, stats, strategy_returns

WEEKS = 4
DELAY = 3  # trading days after the Wednesday until the week is known at a close (rule C3)
RRP_LOOKBACK = 6  # calendar days
COST = 0.0005
THRESHOLDS = (0.0, -0.005, -0.01, -0.02)  # the first is the primary rule: any drain


@dataclass(frozen=True, slots=True)
class Week:
    day: date  # the Wednesday of the Fed balance sheet
    net: float  # USD millions
    change: float | None  # against the level four observations earlier; None for the first four


def net_liquidity(walcl: Mapping[date, float], tga: Mapping[date, float],
                  rrp: Mapping[date, float]) -> tuple[list[Week], list[date]]:
    """Weekly net liquidity (rules C1 and C2) and the dropped weeks.

    ``walcl`` and ``tga`` are in USD millions. ``rrp`` is in USD billions and holds only the days
    with a value.
    """
    weeks: list[Week] = []
    dropped: list[date] = []
    for day in sorted(walcl):
        if day not in tga:
            dropped.append(day)
            continue
        recent = [rrp[day - timedelta(days=back)] for back in range(RRP_LOOKBACK + 1)
                  if day - timedelta(days=back) in rrp]
        net = walcl[day] - tga[day] - (recent[0] * 1000.0 if recent else 0.0)
        earlier = weeks[-WEEKS].net if len(weeks) >= WEEKS else None
        weeks.append(Week(day=day, net=net, change=None if earlier is None else net / earlier - 1.0))
    return weeks, dropped


def drain(week: Week, threshold: float = 0.0) -> bool | None:
    """Rule C4: any fall for threshold 0, else a fall of at least the threshold. None without a change."""
    if week.change is None:
        return None
    return week.change < 0.0 if threshold == 0.0 else week.change <= threshold


def known_at(days: Sequence[date], week: date, delay: int = DELAY) -> int | None:
    """Index of the trading day at whose close the week is known; None when it is after the data."""
    index = bisect.bisect_right(days, week) + delay - 1
    return index if index < len(days) else None


def daily_states(days: Sequence[date], weeks: Sequence[Week], threshold: float = 0.0,
                 delay: int = DELAY) -> list[bool | None]:
    """The flag at each close: that of the latest known week (rule C3). None before the first."""
    starts: dict[int, bool] = {}
    for week in weeks:  # in time order: a later week replaces an earlier one known on the same day
        flag = drain(week, threshold)
        start = known_at(days, week.day, delay)
        if flag is not None and start is not None:
            starts[start] = flag
    states: list[bool | None] = []
    state: bool | None = None
    for index in range(len(days)):
        state = starts.get(index, state)
        states.append(state)
    return states


def held_positions(states: Sequence[bool | None]) -> tuple[int, list[int]]:
    """Rule C5: the first day of the window and the position (1 = asset, 0 = cash) over each day
    from there. The position over day d comes from the state at the close of day d - 1."""
    first = next((i for i, state in enumerate(states) if state is not None), None)
    if first is None or first + 1 >= len(states):
        raise ValueError("no day with a known state before the last day")
    return first + 1, [0 if states[d - 1] else 1 for d in range(first + 1, len(states))]


def timed(asset: Sequence[float], cash: Sequence[float], held: Sequence[int], cost: float = COST,
          start: int = 0, end: int | None = None) -> tuple[Stats, Stats]:
    """Timing rule and buy-and-hold statistics over days [start, end) of the window (rule C9).

    The position entering the period is the one of the day before; the window starts invested.
    """
    end = len(asset) if end is None else end
    previous = held[start - 1] if start > 0 else 1
    returns, trades = strategy_returns(asset[start:end], cash[start:end], held[start:end], cost, previous)
    window_cash = list(cash[start:end])
    return (stats(returns, window_cash, trades, held[start:end]), stats(list(asset[start:end]), window_cash))
