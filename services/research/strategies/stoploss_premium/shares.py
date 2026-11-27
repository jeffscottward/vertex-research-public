"""Test A: the share stop ladder under long shares, and the paper's window stop, against holding.

Ladder levels port market-watch-bot `market_watch/reentry/harness.py` (`compute_levels`, `spaced_five`,
`min_atr_levels`) and `market_watch/stops.py` / `market_watch/auction/roundhandle.py` (`new_ladder`, `adjust`)
on daily bars: rung 1 = the highest of today's low and the 5-day low that is at least 1% below the last price
(else 1% below it); rung 2 = the 20-day low; rung 3 = the lower of the 50-day average and the last swing low (a
low under 2 bars on each side, 120 bars back), no deeper than 15% below the last price; then every rung is moved
to at least `mult` x ATR14 below the last price and the rungs to at least 0.25 x ATR14 apart, off round price
handles. The options put-OI levels of the live harness are left out (no OI history). Sizes: 14% / 29% / 57% (the
plan's 3-level ladder) or the live 5-rung form (rungs 2 and 4 at midpoints, 10/15/20/25/30%).

Simulation per name (daily bars, total-return prices): the ladder is laid on the first session of each month
from that close. A rung fills when the low touches it, at the lower of the open and the rung. A sold rung is
re-bought when a close within 5 calendar days is at least 1% above it (the live re-entry `reclaim`); other
sold shares are re-bought at the next monthly layout. Cash earns the T-bill rate. Costs per side 0.06%
(5 bps slippage + 1 bp commission, market-watch-bot research/backtests.py `COST`).
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

from .bars import Series, atr, rolling_mean
from .portfolio import PathReturns

COST = 0.0006
MIN_GAP_PCT = 1.0
MAX_DEPTH_PCT = 15.0
GAP_ATR = 0.25
SWING_LOOKBACK = 120
RECLAIM_PCT = 1.0
RECLAIM_DAYS = 5
SIZES3 = (0.14, 0.29, 0.57)
SIZES5 = (0.10, 0.15, 0.20, 0.25, 0.30)


def swing_low(lows: Sequence[float], below: float, lookback: int = SWING_LOOKBACK) -> float | None:
    """Most recent pivot low (lower than 2 bars on each side) under `below` in the last `lookback` lows."""
    bars = list(lows[-lookback:])
    for i in range(len(bars) - 3, 1, -1):
        lo = bars[i]
        if lo < below and all(lo < bars[j] for j in (i - 2, i - 1, i + 1, i + 2)):
            return lo
    return None


def compute_levels(last: float, *, today_low: float | None, low5: float | None, low20: float | None,
                   ma50: float | None, swing: float | None) -> list[float] | None:
    """[r1, r2, r3] or None when the levels collapse (harness.compute_levels without put-OI levels)."""
    gap = MIN_GAP_PCT / 100
    cap1 = last * (1 - gap)
    floor = last * (1 - MAX_DEPTH_PCT / 100)
    c1 = [v for v in (today_low, low5) if v and v <= cap1]
    r1 = max(c1) if c1 else cap1
    r2 = low20 if low20 and low20 < r1 else None
    c3 = [v for v in (ma50, swing) if v and v < r1]
    r3 = max(min(c3), floor) if c3 else floor
    if r3 > r1 * (1 - 2 * gap):
        r3 = r1 * (1 - 2 * gap)
    if r3 < floor * (1 - 1e-9):
        return None
    if not r2 or not (r3 * (1 + gap) <= r2 <= r1 * (1 - gap)):
        r2 = (r1 + r3) / 2
    levels = [round(r1, 2), round(r2, 2), round(r3, 2)]
    if not (levels[0] < last and levels[0] > levels[1] > levels[2] > 0):
        return None
    return levels


def five_levels(levels3: Sequence[float]) -> list[float]:
    r1, r3, r5 = levels3
    return [round(x, 2) for x in (r1, (r1 + r3) / 2, r3, (r3 + r5) / 2, r5)]


def spaced_five(levels3: Sequence[float], last: float) -> list[float] | None:
    """harness.spaced_five: 5 rungs from [r1, r3, r5]; if a neighbour gap is under 1%, widen rung 5 to
    r1 x (1 - 4 gaps) (no deeper than the max depth) and space all five evenly."""
    r1, _, r5 = levels3
    lv = five_levels(levels3)
    gap = MIN_GAP_PCT / 100
    if all(lv[i + 1] <= lv[i] * (1 - gap) + 0.005 for i in range(4)):
        return lv
    r5w = min(r5, r1 * (1 - 4 * gap) - 0.01)
    if r5w < last * (1 - MAX_DEPTH_PCT / 100):
        return None
    step = (r1 - r5w) / 4
    return [round(r1 - i * step, 2) for i in range(5)]


def _on_handle(price: float) -> bool:
    c = int(round(price * 100))
    return (price >= 100 and c % 500 == 0) or c % 50 == 0


def adjust_sell(price: float, atr14: float) -> float:
    """roundhandle.adjust for a SELL: a price on a round handle (.00, .50, or a $5 multiple from $100) moves
    below it by max($0.03, 0.1 x ATR14), and one more cent while it lands on .00 / .50."""
    p = round(price, 2)
    if not _on_handle(p):
        return p
    c = int(round(p * 100)) - int(round(max(0.03, round(atr14 * 0.1, 2)) * 100))
    while c % 50 == 0:
        c -= 1
    return c / 100


def min_atr(levels: Sequence[float], last: float, atr14: float, mult: float) -> list[float]:
    """stops.new_ladder for a long position: a rung closer than mult x ATR to last moves to the cap
    (floor(last - mult x ATR) to the cent, then off a round handle); then each rung at least GAP_ATR x ATR below
    the previous one (moved rungs off a round handle). Rungs only move away from the price."""
    eps = 1e-6
    cap = math.floor((last - mult * atr14) * 100 + eps) / 100
    out: list[float] = []
    for lv in levels:
        q = adjust_sell(cap, atr14) if lv > cap + eps else round(lv, 2)
        if out:
            lim = math.floor((out[-1] - GAP_ATR * atr14) * 100 + eps) / 100
            q = adjust_sell(lim, atr14) if q > lim + eps else q
        out.append(q)
    return out


def scale_levels(levels: Sequence[float], last: float, scale: float) -> list[float]:
    """Each rung's distance from last multiplied by `scale` (the +/-25% threshold check)."""
    return [last - scale * (last - lv) for lv in levels]


def ladder(s: Series, i: int, atr14: float, ma50: float | None, *, mult: float, five: bool,
           scale: float = 1.0) -> list[tuple[float, float]] | None:
    """[(level, share of the position)] laid at the close of day i, nearest rung first."""
    last = s.close[i]
    low5 = min(s.low[max(0, i - 4):i + 1])
    low20 = min(s.low[max(0, i - 19):i + 1])
    swing = swing_low(s.low[:i + 1], last * (1 - MIN_GAP_PCT / 100))
    lv = compute_levels(last, today_low=s.low[i], low5=low5, low20=low20, ma50=ma50, swing=swing)
    if lv is None:
        return None
    if five:
        lv = spaced_five(lv, last)
        if lv is None:
            return None
    lv = scale_levels(min_atr(lv, last, atr14, mult), last, scale)
    if lv[-1] <= 0:
        return None
    return list(zip(lv, SIZES5 if five else SIZES3))


@dataclass
class Rung:
    level: float
    qty: float           # units (shares per unit of starting capital)
    sold: bool = False


@dataclass(frozen=True)
class SoldRung:
    level: float
    qty: float
    day: str


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def ladder_path(s: Series, lo: int, hi: int, rf: Sequence[float], start: int, *, mult: float = 1.0,
                five: bool = False, scale: float = 1.0) -> PathReturns:
    """Name held over s days lo..hi-1 (returns from lo+1), with and without the ladder. rf is aligned with
    s.dates; `start` is the calendar index of day lo+1."""
    a = atr(s.high, s.low, s.close, 14)
    ma50 = rolling_mean(s.close, 50)
    path = PathReturns(start=start)
    units, cash = 1.0 / s.close[lo], 0.0
    rungs: list[Rung] = []
    sold: list[SoldRung] = []
    month = None

    def layout(i: int) -> None:
        nonlocal units, cash, rungs, sold, month
        month = s.dates[i][:7]
        if cash > 0:
            units += cash * (1 - COST) / s.close[i]
            cash = 0.0
        sold = []
        rungs = []
        if a[i] is None:
            return
        plan = ladder(s, i, a[i], ma50[i], mult=mult, five=five, scale=scale)
        if plan:
            rungs = [Rung(lv, units * w) for lv, w in plan]

    layout(lo)
    prev = units * s.close[lo] + cash
    for i in range(lo + 1, hi):
        cash *= 1 + rf[i]
        for r in rungs:
            if not r.sold and s.low[i] <= r.level:
                px = min(s.open[i], r.level)
                cash += r.qty * px * (1 - COST)
                units -= r.qty
                r.sold = True
                sold.append(SoldRung(r.level, r.qty, s.dates[i]))
                path.stop(i - lo)
        keep = []
        for sr in sold:
            age = _days(sr.day, s.dates[i])
            if sr.day != s.dates[i] and age <= RECLAIM_DAYS and s.close[i] >= sr.level * (1 + RECLAIM_PCT / 100):
                # re-buy the rung with the cash it raised (the reclaim price is above the sale price, so the
                # proceeds buy slightly fewer shares; the rest of the position is unchanged)
                qty = min(sr.qty, cash / (s.close[i] * (1 + COST)))
                if qty > 0:
                    cash -= qty * s.close[i] * (1 + COST)
                    units += qty
                    continue
            if age <= RECLAIM_DAYS:
                keep.append(sr)
        sold = keep
        if s.dates[i][:7] != month:
            layout(i)
        value = units * s.close[i] + cash
        path.add(value / prev - 1, s.close[i] / s.close[i - 1] - 1, cash / value if value > 0 else 0.0)
        prev = value
    return path


def window_stop_path(s: Series, lo: int, hi: int, rf: Sequence[float], start: int, *, window: int = 21,
                     gamma: float = 0.10, delta: float = 0.0) -> PathReturns:
    """The paper's rule: out when the return over the last `window` days is below -gamma, back in when it is
    at least delta (checked on each close; trades at the close, cost per side COST)."""
    path = PathReturns(start=start)
    inside = True
    for i in range(lo + 1, hi):
        r = s.close[i] / s.close[i - 1] - 1
        rw = r if inside else rf[i]
        past = s.close[i] / s.close[i - window] - 1 if i >= window else 0.0
        if inside and past < -gamma:
            inside = False
            rw = (1 + rw) * (1 - COST) - 1
            path.stop(i - lo)
        elif not inside and past >= delta and math.isfinite(past):
            inside = True
            rw = (1 + rw) * (1 - COST) - 1
        path.add(rw, r, 0.0 if inside else 1.0)
    return path
