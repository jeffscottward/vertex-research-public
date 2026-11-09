"""Test B: the nearest analog of a past market top (rules B2 to B8)."""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from .events import HORIZON

PATH = 63  # closes in a path, about three months
REVERSAL = 0.10
MAX_OFFSET = 10  # an analog day is at most this many trading days after its top
STEP = 30  # trading days between two sample days
MIN_TOPS = 5
MIN_HISTORY = 20  # earlier sample days a day needs before it is classified
TOP_LIKE = 0.20


@dataclass(frozen=True, slots=True)
class Top:
    index: int  # the day of the highest close
    confirmed: int  # the first day the close is at least the reversal below it


@dataclass(frozen=True, slots=True)
class Analog:
    day: int  # the past day whose path is compared
    top: int
    offset: int  # day - top
    distance: float


def zigzag_tops(closes: Sequence[float], reversal: float = REVERSAL) -> list[Top]:
    """Tops of a zigzag on closes (rule B2). ``direction`` is 0 before the first pivot, 1 after a
    confirmed bottom (a top is open) and -1 after a confirmed top (a bottom is open)."""
    tops: list[Top] = []
    high = low = direction = 0
    for t in range(1, len(closes)):
        close = closes[t]
        if direction >= 0 and close > closes[high]:
            high = t
        if direction <= 0 and close < closes[low]:
            low = t
        if direction >= 0 and close <= closes[high] * (1.0 - reversal):
            tops.append(Top(index=high, confirmed=t))
            direction, low = -1, t
        elif direction <= 0 and close >= closes[low] * (1.0 + reversal):
            direction, high = 1, t
    return tops


def path(closes: Sequence[float], t: int, length: int = PATH) -> list[float]:
    """Log closes of the last ``length`` days against the close of day ``t`` (rule B3)."""
    if t < length - 1:
        raise ValueError("not enough closes before day t")
    last = closes[t]
    return [math.log(closes[i] / last) for i in range(t - length + 1, t + 1)]


def distance(a: Sequence[float], b: Sequence[float]) -> float:
    """Root mean square difference of two paths (rule B4)."""
    return math.sqrt(math.fsum((x - y) ** 2 for x, y in zip(a, b, strict=True)) / len(a))


def candidates(tops: Sequence[Top], t: int, length: int = PATH, max_offset: int = MAX_OFFSET,
               horizon: int = HORIZON) -> list[tuple[int, Top]]:
    """The analog days a query on day ``t`` may use (rule B5)."""
    return [(top.index + k, top)
            for top in tops if top.confirmed <= t
            for k in range(max_offset + 1)
            if top.index + k + horizon <= t and top.index + k >= length - 1]


def ranked(closes: Sequence[float], t: int, tops: Sequence[Top], length: int = PATH,
           max_offset: int = MAX_OFFSET, horizon: int = HORIZON) -> list[Analog]:
    """All candidates of day ``t``, nearest first; the latest day wins a tie (rule B6)."""
    own = path(closes, t, length)
    found = [Analog(day=day, top=top.index, offset=day - top.index, distance=distance(own, path(closes, day, length)))
             for day, top in candidates(tops, t, length, max_offset, horizon)]
    return sorted(found, key=lambda item: (item.distance, -item.day))


def sample_days(n: int, tops: Sequence[Top], length: int = PATH, max_offset: int = MAX_OFFSET,
                horizon: int = HORIZON, step: int = STEP, min_tops: int = MIN_TOPS) -> list[int]:
    """Rule B7: the first day on which ``min_tops`` tops have a candidate, then every ``step`` days."""
    ready = sorted(max(top.confirmed, max(top.index, length - 1) + horizon)
                   for top in tops if top.index + max_offset >= length - 1)
    if len(ready) < min_tops:
        return []
    return list(range(ready[min_tops - 1], n, step))


def top_like(distances: Sequence[float], min_history: int = MIN_HISTORY, share: float = TOP_LIKE) -> list[bool | None]:
    """Rule B8, one entry per sample day in time order: None while a day has too little history."""
    out: list[bool | None] = []
    for i, value in enumerate(distances):
        if i < min_history:
            out.append(None)
        else:
            out.append(sum(1 for earlier in distances[:i] if earlier < value) < share * i)
    return out
