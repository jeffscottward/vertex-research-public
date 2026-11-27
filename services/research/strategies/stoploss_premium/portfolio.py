"""Equal-weight portfolio of position paths on one calendar.

A path is one position (a name held for a period, or one trade) as daily returns from the day after its
entry. Both legs of a path cover the same days: after the rule exits, the rule leg earns the safe asset until
the day the leg without the rule exits. On each calendar day the portfolio return is the mean over the paths
active that day (equal weight, rebalanced daily); a day without an active path earns the safe asset in both
legs.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from .premium import Legs


@dataclass
class PathReturns:
    start: int                      # calendar index of the first return day
    with_rule: list[float] = field(default_factory=list)
    without: list[float] = field(default_factory=list)
    out: list[float] = field(default_factory=list)  # share of this position's value the rule holds out
    stop_events: int = 0
    days_to_stop: int | None = None  # days from entry to the first stop event (None: never stopped)
    stop_offsets: list[int] = field(default_factory=list)  # path day of each stop event

    def stop(self, days_from_entry: int, count: int = 1) -> None:
        """Record `count` stop events on the day about to be added (call before `add` for that day)."""
        self.stop_events += count
        self.stop_offsets.append(len(self.without))
        if self.days_to_stop is None:
            self.days_to_stop = days_from_entry

    def add(self, with_rule: float, without: float, out: float) -> None:
        self.with_rule.append(with_rule)
        self.without.append(without)
        self.out.append(out)

    def __len__(self) -> int:
        return len(self.without)


def aggregate(calendar: Sequence[str], rf: Sequence[float], paths: Sequence[PathReturns], *,
              lo: int | None = None, hi: int | None = None, value_weighted: bool = False) -> Legs:
    """Legs over calendar[lo:hi] (default: the first to the last day any path is active).

    Equal weight (default): paths hold daily returns; the day's return is their mean (rebalanced daily).
    Value weighted: paths hold daily value changes of a position worth 1 at entry (a trade bought with one
    unit and never rebalanced); the day's return is the sum of the changes over the sum of the values at the
    previous close, per leg, so the book return can never fall below -100%. `with_exposure` then puts a share
    of the account in the book (the premium bucket of an option book)."""
    if len(calendar) != len(rf):
        raise ValueError("calendar and rf must have the same length")
    used = [p for p in paths if len(p)]
    if not used:
        raise ValueError("no path has a return day")
    first = min(p.start for p in used) if lo is None else lo
    last = max(p.start + len(p) for p in used) if hi is None else hi
    n = last - first
    sw, so, sout = [0.0] * n, [0.0] * n, [0.0] * n
    dw, do = [0.0] * n, [0.0] * n  # denominators: path count, or the sum of previous values per leg
    for p in used:
        vw = vo = 1.0
        for j in range(len(p)):
            k = p.start + j - first
            if 0 <= k < n:
                sw[k] += p.with_rule[j]
                so[k] += p.without[j]
                if value_weighted:
                    sout[k] += p.out[j] * vw
                    dw[k] += vw
                    do[k] += vo
                else:
                    sout[k] += p.out[j]
                    dw[k] += 1
                    do[k] += 1
            vw += p.with_rule[j]
            vo += p.without[j]
    w, o, out = [], [], []
    for k in range(n):
        f = rf[first + k]
        w.append(sw[k] / dw[k] if dw[k] > 0 else f)
        o.append(so[k] / do[k] if do[k] > 0 else f)
        out.append(sout[k] / dw[k] if dw[k] > 0 else 0.0)
    events = sum(p.stop_events for p in used)
    days = len({p.start + j for p in used for j in p.stop_offsets})
    return Legs(tuple(calendar[first:last]), tuple(w), tuple(o), tuple(rf[first:last]), tuple(out), events, days)


def with_exposure(legs: Legs, exposure: float) -> Legs:
    """The same book held at `exposure` of the account, the rest in the safe asset (rebalanced daily)."""
    if not 0 < exposure <= 1:
        raise ValueError("exposure must be in (0, 1]")

    def mix(xs: tuple[float, ...]) -> tuple[float, ...]:
        return tuple(exposure * x + (1 - exposure) * f for x, f in zip(xs, legs.rf))
    return Legs(legs.dates, mix(legs.with_rule), mix(legs.without), legs.rf,
                tuple(exposure * x for x in legs.out), legs.stop_events, legs.stop_days)


def trade_returns(paths: Sequence[PathReturns]) -> dict:
    """Per-trade cross-check for value paths: mean final value - 1 with and without the rule (share of the
    entry debit or capital) and the mean difference."""
    rows = [(sum(p.with_rule), sum(p.without)) for p in paths if len(p)]
    if not rows:
        return {"trades": 0, "meanWith": None, "meanWithout": None, "meanDiff": None, "shareBetter": None}
    n = len(rows)
    return {"trades": n, "meanWith": sum(a for a, _ in rows) / n, "meanWithout": sum(b for _, b in rows) / n,
            "meanDiff": sum(a - b for a, b in rows) / n, "shareBetter": sum(1 for a, b in rows if a > b) / n}


def stop_step(paths: Sequence[PathReturns], default: int = 21) -> int:
    """Median days from entry to the first stop event (the rule's time step), at least 1."""
    days = sorted(p.days_to_stop for p in paths if p.days_to_stop is not None)
    if not days:
        return default
    return max(1, days[len(days) // 2])
