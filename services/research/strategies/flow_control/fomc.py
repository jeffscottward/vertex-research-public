"""Scheduled FOMC decision days of 2025 and 2026 (the second day of each scheduled meeting).

The repository has no historical FOMC calendar for Python and the event_calendar feed keeps 30 days back only,
so the list is a constant, read from the source page on FOMC_READ_ON.
"""
from __future__ import annotations

FOMC_SOURCE = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
FOMC_READ_ON = "2026-11-15"
FOMC_YEARS = (2025, 2026)
FOMC_DECISION_DAYS: frozenset[str] = frozenset({
    "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10",
    "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
})


def is_fomc_day(day: str) -> bool:
    """True on a scheduled decision day; ValueError for a year outside FOMC_YEARS (the run stops)."""
    year = int(day[:4])
    if year not in FOMC_YEARS:
        raise ValueError(f"No FOMC calendar for {day}: the list covers {FOMC_YEARS[0]} to {FOMC_YEARS[-1]}")
    return day in FOMC_DECISION_DAYS
