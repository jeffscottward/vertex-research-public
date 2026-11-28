"""Entry signals of the re-entry and wish-list engines, as daily-bar proxies (test B, C, D entries).

The live engines decide on 1-minute bars, options flow and volume-profile value areas; the data set has daily
bars only (no volume), so each signal is a labelled daily proxy of the live rule:

momentum entries
  * reclaim: a close below the support L (lowest low of the 20 days before it), then within 5 calendar days a
    close at least 1% above L (re-entry `reclaim`: price >= 1% above the sold rung's stop). Stop = L.
  * acceptance: the first close above the highest high of the prior 20 days (proxy of `acceptance-above-vah`).
    Stop = entry - 2 x ATR14 (wish-list stop when the prior value-area low is far below).
mean-reversion (dip) entries
  * zdip: the first close with a 20-day z-score <= -2 (re-entry `meanrev_z`). Stop = 3% below the entry.
  * failed_breakdown: the low breaks L but the close is back above it, at most 1 x ATR14 above L (proxy of
    `failed-auction-below` near support). Stop = max(L - 0.25 x ATR14, entry - 2 x ATR14).
Every stop then gets the 1 x ATR14 floor (stop <= entry - ATR14; market-watch-bot `stops`, 2026-10-12).
One signal per name and kind per COOLDOWN sessions.
"""
from __future__ import annotations

from dataclasses import dataclass
import random
from datetime import date

from .bars import Series, atr, rolling_extreme, zscore

MOMENTUM = ("reclaim", "acceptance")
DIP = ("zdip", "failed_breakdown")
KINDS = MOMENTUM + DIP
SUPPORT_DAYS = 20
RECLAIM_PCT = 1.0
RECLAIM_DAYS = 5
DIP_Z = -2.0
DIP_STOP_PCT = 3.0
STOP_MAX_ATR = 2.0
STOP_BELOW_VAL_ATR = 0.25
MIN_STOP_ATR = 1.0
COOLDOWN = 21


@dataclass(frozen=True)
class Entry:
    symbol: str
    i: int          # index in the name's series (entry at that close)
    kind: str
    price: float    # entry price (close)
    stop: float     # protective stop on the underlying
    atr: float

    @property
    def family(self) -> str:
        return "momentum" if self.kind in MOMENTUM else ("dip" if self.kind in DIP else self.kind)


def floor_stop(entry: float, stop: float, atr14: float) -> float:
    return min(stop, entry - MIN_STOP_ATR * atr14)


def signals(s: Series, *, lo: int = 0, hi: int | None = None) -> list[Entry]:
    """Every entry of the four kinds on days lo..hi-1, with the cooldown applied per kind."""
    hi = len(s.dates) if hi is None else hi
    a = atr(s.high, s.low, s.close, 14)
    support = rolling_extreme(s.low, SUPPORT_DAYS, lowest=True)
    resistance = rolling_extreme(s.high, SUPPORT_DAYS, lowest=False)
    z = zscore(s.close, 20)
    last: dict[str, int] = {}
    broken: list[tuple[int, float]] = []  # (day, support level) of recent closes below support
    out: list[Entry] = []

    def take(kind: str, i: int, stop: float) -> None:
        at = a[i]
        if at is None or i - last.get(kind, -10**9) < COOLDOWN:
            return
        st = floor_stop(s.close[i], stop, at)
        if st <= 0:
            return
        last[kind] = i
        out.append(Entry(s.symbol, i, kind, s.close[i], st, at))

    for i in range(max(lo, 1), hi):
        at, sup, res = a[i], support[i], resistance[i]
        c = s.close[i]
        if at is None or sup is None or res is None:
            continue
        today = date.fromisoformat(s.dates[i])
        broken = [(d, lv) for d, lv in broken if (today - date.fromisoformat(s.dates[d])).days <= RECLAIM_DAYS]
        for d, lv in broken:
            if d < i and c >= lv * (1 + RECLAIM_PCT / 100):
                take("reclaim", i, lv)
                broken = []
                break
        if c < sup:
            broken.append((i, sup))
        prev_res = resistance[i - 1]
        if c > res and (prev_res is None or s.close[i - 1] <= prev_res):
            take("acceptance", i, c - STOP_MAX_ATR * at)
        zi, zp = z[i], z[i - 1]
        if zi is not None and zi <= DIP_Z and (zp is None or zp > DIP_Z):
            take("zdip", i, c * (1 - DIP_STOP_PCT / 100))
        if s.low[i] < sup < c and c - sup <= at:
            take("failed_breakdown", i, max(sup - STOP_BELOW_VAL_ATR * at, c - STOP_MAX_ATR * at))
    return out


def random_entries(s: Series, real: list[Entry], seed: int) -> list[Entry]:
    """Control entries: as many as `real`, on random sessions (fixed seed) inside the span of the real entries,
    with the generic stop entry - 2 x ATR14 (kind "random"). If the verdict holds under random entries too,
    the daily entry proxies do not decide it."""
    if not real:
        return []
    a = atr(s.high, s.low, s.close, 14)
    lo, hi = min(e.i for e in real), max(e.i for e in real) + 1
    rng = random.Random(f"{seed}:{s.symbol}")
    days = sorted(rng.sample(range(lo, hi), min(len(real), hi - lo)))
    out = []
    for i in days:
        at = a[i]
        if at is None:
            continue
        stop = floor_stop(s.close[i], s.close[i] - STOP_MAX_ATR * at, at)
        if stop > 0:
            out.append(Entry(s.symbol, i, "random", s.close[i], stop, at))
    return out
