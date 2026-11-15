"""Test A: the "stretched + calm" signal (rules A2 to A7 and the grid A9)."""
from __future__ import annotations

import math
import statistics
from collections.abc import Sequence
from dataclasses import dataclass

from .events import HORIZON

RUN_DAYS = 126  # six months
SMA_DAYS = 200
VOL_DAYS = 21
YEAR = 252
NEAR = 4  # a high at most this many trading days ago counts as "at a high"


@dataclass(frozen=True, slots=True)
class Definition:
    run: float = 0.20  # least six-month return
    stretch: float = 0.10  # least distance above the 200-day average
    vol: float = 0.15  # most annualized 21-day realized volatility
    high_days: int | None = None  # None = record close of the series; else the N-day closing high


@dataclass(frozen=True, slots=True)
class Features:
    """One value per day; NaN while a feature is not defined (a NaN never meets a threshold)."""

    run: tuple[float, ...]
    stretch: tuple[float, ...]
    vol: tuple[float, ...]
    since_high: tuple[float, ...]

    def valid(self, t: int) -> bool:
        return not any(math.isnan(v) for v in (self.run[t], self.stretch[t], self.vol[t], self.since_high[t]))


PRIMARY = Definition()
GRID: tuple[Definition, ...] = tuple(
    Definition(run=run, stretch=stretch, vol=vol, high_days=high_days)
    for high_days in (None, YEAR)
    for run in (0.15, 0.20, 0.25)
    for stretch in (0.08, 0.10, 0.12)
    for vol in (0.12, 0.15, 0.18)
)


def trailing_return(closes: Sequence[float], lag: int = RUN_DAYS) -> list[float]:
    return [closes[t] / closes[t - lag] - 1.0 if t >= lag else math.nan for t in range(len(closes))]


def sma_gap(closes: Sequence[float], window: int = SMA_DAYS) -> list[float]:
    """Close against the mean of the last ``window`` closes, the day itself included."""
    out: list[float] = []
    running = 0.0
    for t, close in enumerate(closes):
        running += close
        if t >= window:
            running -= closes[t - window]
        out.append(close / (running / window) - 1.0 if t >= window - 1 else math.nan)
    return out


def realized_vol(closes: Sequence[float], window: int = VOL_DAYS, per_year: int = YEAR) -> list[float]:
    """Annualized sample standard deviation of the last ``window`` daily log returns."""
    logs = [math.log(closes[t] / closes[t - 1]) for t in range(1, len(closes))]
    out = [math.nan] * min(window, len(closes))
    for t in range(window, len(closes)):
        out.append(statistics.stdev(logs[t - window : t]) * math.sqrt(per_year))
    return out


def days_since_high(closes: Sequence[float], window: int | None = None) -> list[float]:
    """Trading days since the last closing high: the record close, or the high of the last ``window`` closes.

    A close equal to the earlier high counts as a high. With a window, the first ``window - 1`` days
    are not defined.
    """
    out: list[float] = []
    last: int | None = None
    record = -math.inf
    for t, close in enumerate(closes):
        if window is None:
            is_high = close >= record
            record = max(record, close)
        else:
            is_high = t >= window - 1 and close >= max(closes[t - window + 1 : t + 1])
        if is_high:
            last = t
        out.append(float(t - last) if last is not None else math.nan)
    return out


def features(closes: Sequence[float], high_days: int | None = None) -> Features:
    return Features(run=tuple(trailing_return(closes)), stretch=tuple(sma_gap(closes)),
                    vol=tuple(realized_vol(closes)), since_high=tuple(days_since_high(closes, high_days)))


def near_high_days(found: Features, near: int = NEAR) -> list[int]:
    """Days with every feature defined and a high at most ``near`` days ago (base rate ii of rule A8)."""
    return [t for t in range(len(found.run)) if found.valid(t) and found.since_high[t] <= near]


def signal_days(found: Features, definition: Definition = PRIMARY, near: int = NEAR) -> list[int]:
    """Rule A6. ``found`` must come from ``features`` with the definition's ``high_days``."""
    return [t for t in near_high_days(found, near)
            if found.run[t] >= definition.run and found.stretch[t] >= definition.stretch
            and found.vol[t] <= definition.vol]


def episode_starts(signals: Sequence[int], gap: int = HORIZON) -> list[int]:
    """Rule A7: the first signal day, then each signal day at least ``gap`` days after the last start."""
    starts: list[int] = []
    for t in signals:
        if not starts or t - starts[-1] >= gap:
            starts.append(t)
    return starts
