"""Test D: one-year windows by the year of the US election cycle (rules D2 to D9)."""
from __future__ import annotations

import bisect
import calendar
import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

MIDTERM = 2  # year mod 4 of a midterm election year


@dataclass(frozen=True, slots=True)
class Window:
    year: int  # the start year
    start: date
    end: date
    change: float
    drawdown: float  # largest peak-to-trough fall of the close inside the window (0 or negative)


@dataclass(frozen=True, slots=True)
class Cell:
    month: int
    phase: int  # start year mod 4
    n: int
    positives: int
    mean: float


def anchor(days: Sequence[date], year: int, month: int) -> int | None:
    """Index of the last bar on or before the last day of the month (rule D2).

    None when the series has no bar in that month, or no later bar (the month may not be complete).
    """
    last_day = date(year, month, calendar.monthrange(year, month)[1])
    index = bisect.bisect_right(days, last_day) - 1
    if index < 0 or index + 1 >= len(days) or (days[index].year, days[index].month) != (year, month):
        return None
    return index


def window(days: Sequence[date], closes: Sequence[float], year: int, month: int) -> Window | None:
    """The one-year window that starts at the anchor of ``year``; None while it is not complete."""
    first, last = anchor(days, year, month), anchor(days, year + 1, month)
    if first is None or last is None:
        return None
    peak, worst = closes[first], 0.0
    for close in closes[first : last + 1]:
        peak = max(peak, close)
        worst = min(worst, close / peak - 1.0)
    return Window(year=year, start=days[first], end=days[last], change=closes[last] / closes[first] - 1.0,
                  drawdown=worst)


def windows(days: Sequence[date], closes: Sequence[float], years: Sequence[int], month: int) -> list[Window]:
    found = (window(days, closes, year, month) for year in years)
    return [item for item in found if item is not None]


def scan(days: Sequence[date], closes: Sequence[float], first_year: int, last_year: int) -> list[Cell]:
    """Rule D6: every start month and election-cycle year, complete windows only."""
    cells: list[Cell] = []
    for month in range(1, 13):
        for phase in range(4):
            years = [year for year in range(first_year, last_year + 1) if year % 4 == phase]
            changes = [item.change for item in windows(days, closes, years, month)]
            if changes:
                cells.append(Cell(month=month, phase=phase, n=len(changes),
                                  positives=sum(1 for change in changes if change > 0.0),
                                  mean=statistics.fmean(changes)))
    return cells
