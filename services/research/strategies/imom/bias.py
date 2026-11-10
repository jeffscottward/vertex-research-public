"""The reel's 8-factor bias tracker, reconstructed as a research-only daily direction signal.

The reel shows the panel (Initial Move, VWAP, Daily Candle, Initial Hour HL, Session Delta, Value Area
Shift, ORB, Gap; each Long / Neutral / Short) and `BIAS: 50.00` for 5 Long and 1 Short, which fits
score = 100 x (#Long - #Short) / 8. The factor definitions are not shown; ours are the defaults in
rules.py (GAPS). Every factor is evaluated at the close of the decision bar (the 5-minute bar whose
close is the decision time, 15:30 by default) from that session's bars up to and including it, and the
previous session for Gap and Value Area Shift. Long when score >= threshold, short when score <=
-threshold. The study executes the signal through Nautilus with the GHLZ clock (definition.py): entry
at the next bar open, flat at 16:00 market-on-close.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .data import OPEN_MINUTE, SessionBars, local_times

FACTORS = ("Initial Move", "VWAP", "Daily Candle", "Initial Hour HL", "Session Delta", "Value Area Shift", "ORB",
           "Gap")
GAP_BAND = 0.001
VALUE_AREA_SHARE = 0.70
VALUE_AREA_BAND = 0.001
BAR_MINUTES = 5


def hhmm(text: str) -> int:
    hours, minutes = text.split(":")
    return int(hours) * 60 + int(minutes)


def sign(value: float, band: float = 0.0) -> int:
    if value > band:
        return 1
    if value < -band:
        return -1
    return 0


def above_below(price: float, high: float, low: float) -> int:
    if price > high:
        return 1
    if price < low:
        return -1
    return 0


@dataclass(frozen=True)
class Session:
    day: str
    start: int  # first bar index
    end: int  # one past the last bar index
    close_minutes: tuple[int, ...]  # bar close time (minute of day) of each bar


def sessions_of(bars: SessionBars) -> list[Session]:
    local = local_times(bars.t)
    out: list[Session] = []
    start = 0
    for i in range(1, len(local) + 1):
        if i == len(local) or local[i][0] != local[start][0]:
            out.append(Session(local[start][0], start, i,
                               tuple(minute + BAR_MINUTES for _, minute in local[start:i])))
            start = i
    return out


def value_area_mid(prices: Sequence[float], volumes: Sequence[float]) -> float | None:
    """Midpoint of the value area: from the bar price with the most volume (point of control), add the
    neighbouring price with more volume until VALUE_AREA_SHARE of the volume is inside (bar-level profile)."""
    if not prices:
        return None
    if sum(volumes) <= 0:
        volumes = [1.0] * len(prices)
    order = sorted(range(len(prices)), key=lambda i: (prices[i], i))
    p = [prices[i] for i in order]
    v = [volumes[i] for i in order]
    total = sum(v)
    poc = max(range(len(v)), key=lambda i: (v[i], -i))
    lo = hi = poc
    inside = v[poc]
    while inside < VALUE_AREA_SHARE * total:
        below = v[lo - 1] if lo > 0 else -1.0
        above = v[hi + 1] if hi + 1 < len(v) else -1.0
        if above >= below:
            hi += 1
            inside += above
        else:
            lo -= 1
            inside += below
    return (p[lo] + p[hi]) / 2


def factor_votes(bars: SessionBars, session: Session, k: int, prev: Session | None) -> dict[str, int]:
    """The eight votes (+1 Long, 0 Neutral, -1 Short) at the close of bar k of `session`."""
    o, h, low, c, v = bars.o, bars.h, bars.l, bars.c, bars.v
    first = session.start
    day_open = o[first]
    price = c[k]
    closes = session.close_minutes
    upto = range(first, k + 1)

    def close_at(minute: int) -> float | None:
        for i in upto:
            if closes[i - first] == minute:
                return c[i]
        return None

    def range_until(minute: int) -> tuple[float, float] | None:
        idx = [i for i in upto if closes[i - first] <= minute]
        if not idx:
            return None
        return max(h[i] for i in idx), min(low[i] for i in idx)

    votes: dict[str, int] = {}
    ten = close_at(OPEN_MINUTE + 30)
    votes["Initial Move"] = sign(ten / day_open - 1) if ten is not None and day_open > 0 else 0
    typical = [(h[i] + low[i] + c[i]) / 3 for i in upto]
    vol = [v[i] for i in upto]
    total = sum(vol)
    vwap = sum(t * w for t, w in zip(typical, vol)) / total if total > 0 else sum(typical) / len(typical)
    votes["VWAP"] = sign(price - vwap)
    votes["Daily Candle"] = sign(price - day_open)
    hour = range_until(OPEN_MINUTE + 60) if closes[k - first] >= OPEN_MINUTE + 60 else None
    votes["Initial Hour HL"] = above_below(price, *hour) if hour else 0
    votes["Session Delta"] = sign(sum(v[i] * sign(c[i] - o[i]) for i in upto))
    today_va = value_area_mid(typical, vol)
    prev_va = None
    if prev is not None:
        prange = range(prev.start, prev.end)
        prev_va = value_area_mid([(h[i] + low[i] + c[i]) / 3 for i in prange], [v[i] for i in prange])
    votes["Value Area Shift"] = (sign(today_va / prev_va - 1, VALUE_AREA_BAND)
                                 if today_va is not None and prev_va else 0)
    orb = range_until(OPEN_MINUTE + 30) if closes[k - first] >= OPEN_MINUTE + 30 else None
    votes["ORB"] = above_below(price, *orb) if orb else 0
    prev_close = c[prev.end - 1] if prev is not None else None
    votes["Gap"] = sign(day_open / prev_close - 1, GAP_BAND) if prev_close else 0
    return votes


def score(votes: dict[str, int]) -> float:
    return 100 * (sum(1 for x in votes.values() if x > 0) - sum(1 for x in votes.values() if x < 0)) / len(FACTORS)


def daily_scores(bars: SessionBars, decision: str) -> dict[int, tuple[str, float, dict[str, int]]]:
    """Bar index of each session's decision bar -> (day, score, votes); sessions without that bar are absent."""
    target = hhmm(decision)
    out: dict[int, tuple[str, float, dict[str, int]]] = {}
    prev: Session | None = None
    for session in sessions_of(bars):
        for offset, minute in enumerate(session.close_minutes):
            if minute == target:
                k = session.start + offset
                votes = factor_votes(bars, session, k, prev)
                out[k] = (session.day, score(votes), votes)
                break
        prev = session
    return out


def signals(bars: SessionBars, decision: str, threshold: float, side: str,
            scores: dict[int, tuple[str, float, dict[str, int]]] | None = None) -> tuple[int, ...]:
    """1 on the decision bar of each day whose score clears the threshold for `side`, else 0."""
    scores = daily_scores(bars, decision) if scores is None else scores
    out = [0] * len(bars)
    for k, (_, value, _) in scores.items():
        if (side == "long" and value >= threshold) or (side == "short" and value <= -threshold):
            out[k] = 1
    return tuple(out)
