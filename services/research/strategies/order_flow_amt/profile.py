"""Prior-session volume profile of the order flow / AMT study (pure functions, research only).

Port of the live AMT auction job (market-watch-bot `market_watch/auction/profile.py`) to 5-minute bars:
each bar's volume is spread evenly over the price bins between its low and high (no tick or bid/ask data),
bin = max($0.01, 0.02 x ATR14 rounded to the cent), value area = 70% of the volume, expanded from the POC by
the larger adjacent bin (tie: the upper one). ATR14 = simple average true range of the 14 completed sessions
before the session, from the sessions' own regular-hours high, low and close.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from strategies.noise_band import Bar, Session

VALUE_AREA = 0.70
BIN_ATR = 0.02
ATR_SESSIONS = 14


@dataclass(frozen=True)
class Levels:
    """Prior session's auction levels in dollars; `bin` is the profile bin."""

    poc: float
    vah: float
    val: float
    bin: float


def _cents(price: float) -> int:
    return int(round(price * 100))


def atr14(sessions: Sequence[Session], index: int) -> float | None:
    """ATR14 of the 14 sessions before sessions[index]; None with fewer than 15 earlier sessions."""
    if index < ATR_SESSIONS + 1:
        return None
    days = sessions[index - ATR_SESSIONS - 1:index]
    ranges = []
    for prev, cur in zip(days[:-1], days[1:]):
        high = max(bar.high for bar in cur.bars)
        low = min(bar.low for bar in cur.bars)
        close = prev.bars[-1].close
        ranges.append(max(high - low, abs(high - close), abs(low - close)))
    return round(sum(ranges) / len(ranges), 4)


def bin_size(atr: float | None, price: float | None) -> float:
    """max($0.01, 0.02 x ATR14 rounded to the cent); without an ATR, 0.1% of the price."""
    if atr and atr > 0:
        return max(0.01, round(BIN_ATR * atr, 2))
    if price and price > 0:
        return max(0.01, round(price * 0.001, 2))
    return 0.01


def volume_profile(bars: Sequence[Bar], bin_usd: float) -> dict[int, float]:
    """{bin index: volume}; bin i covers [i * bin, (i + 1) * bin)."""
    step = max(1, _cents(bin_usd))
    profile: dict[int, float] = {}
    for bar in bars:
        high, low, volume = _cents(bar.high) // step, _cents(bar.low) // step, float(bar.volume)
        if volume <= 0 or high < low:
            continue
        share = volume / (high - low + 1)
        for i in range(low, high + 1):
            profile[i] = profile.get(i, 0.0) + share
    return profile


def poc_index(profile: dict[int, float]) -> int | None:
    """Max-volume bin; a tie goes to the bin nearest the middle of the range, then the upper one."""
    if not profile:
        return None
    middle = (min(profile) + max(profile)) / 2
    top = max(profile.values())
    return min((i for i, v in profile.items() if v == top), key=lambda i: (abs(i - middle), -i))


def value_area(profile: dict[int, float], pct: float = VALUE_AREA) -> tuple[int, int, int] | None:
    """(poc, low, high) bin indexes holding at least `pct` of the volume."""
    poc = poc_index(profile)
    if poc is None:
        return None
    lowest, highest = min(profile), max(profile)
    total = sum(profile.values())
    low = high = poc
    inside = profile[poc]
    while inside < pct * total - 1e-9:
        up = profile.get(high + 1, 0.0) if high < highest else None
        down = profile.get(low - 1, 0.0) if low > lowest else None
        if up is None and down is None:
            break
        if down is None or (up is not None and up >= down):
            high += 1
            inside += up
        else:
            low -= 1
            inside += down
    return poc, low, high


def bin_price(index: int, bin_usd: float, where: str) -> float:
    """Dollar price of a bin's low edge, middle or high edge."""
    step = max(1, _cents(bin_usd))
    offset = {"low": 0.0, "mid": step / 2, "high": float(step)}[where]
    return round((index * step + offset) / 100, 2)


def session_levels(bars: Sequence[Bar], bin_usd: float) -> Levels | None:
    """POC (bin middle), VAH (top edge) and VAL (bottom edge) of one session's bars."""
    area = value_area(volume_profile(bars, bin_usd))
    if area is None:
        return None
    poc, low, high = area
    return Levels(poc=bin_price(poc, bin_usd, "mid"), vah=bin_price(high, bin_usd, "high"),
                  val=bin_price(low, bin_usd, "low"), bin=round(max(1, _cents(bin_usd)) / 100, 2))


def prior_levels(sessions: Sequence[Session], index: int) -> Levels | None:
    """Levels of sessions[index - 1] with the bin of sessions[index]'s ATR14 (no look-ahead); None without ATR14."""
    if index < 1:
        return None
    atr = atr14(sessions, index)
    if atr is None or atr <= 0:
        return None
    return session_levels(sessions[index - 1].bars, bin_size(atr, None))
