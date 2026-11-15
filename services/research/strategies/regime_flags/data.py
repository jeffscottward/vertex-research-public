"""The fetched CSV files of the regime flag tests (rules G1 to G4). Reads local files only."""
from __future__ import annotations

import bisect
import csv
import math
from dataclasses import dataclass
from datetime import date
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Bars:
    days: list[date]
    closes: list[float]  # split-adjusted, without dividends
    adjusted: list[float]  # with dividends
    dropped: int  # bars left out by rule G4

    def at(self, day: date) -> int:
        """Index of the last bar on or before ``day``; -1 when there is none."""
        return bisect.bisect_right(self.days, day) - 1


def load_bars(path: Path, positive: bool = True) -> Bars:
    """Bars of a file with the header date,close,adj_close.

    Rule G4: a bar with a missing value is dropped and counted. With ``positive`` (a price series) a
    bar with a value of 0 or below is dropped too; a yield series keeps it.
    """
    days, closes, adjusted, dropped = [], [], [], 0
    with path.open() as fh:
        for row in csv.DictReader(fh):
            close, adj = (float(row[key]) if row[key] else math.nan for key in ("close", "adj_close"))
            if not (math.isfinite(close) and math.isfinite(adj)) or (positive and min(close, adj) <= 0.0):
                dropped += 1
                continue
            days.append(date.fromisoformat(row["date"]))
            closes.append(close)
            adjusted.append(adj)
    return Bars(days, closes, adjusted, dropped)


def load_series(path: Path) -> dict[date, float]:
    """The days with a value of a file with the header date,value (a FRED series)."""
    with path.open() as fh:
        return {date.fromisoformat(row["date"]): float(row["value"]) for row in csv.DictReader(fh) if row["value"]}
