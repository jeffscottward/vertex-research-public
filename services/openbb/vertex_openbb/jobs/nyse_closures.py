"""NYSE full-day market closures (no trading session at all; early closes are not listed).

Source: https://www.nyse.com/markets/hours-calendars (checked 2026-11-08; the page lists 2026-2028).
2025 is no longer on that page; its dates are NYSE's published 2025 calendar plus the closure on
2025-01-09 (national day of mourning for President Carter). Extend the list when NYSE publishes a
new year; the Reg SHO job warns when its window reaches a year not covered here.
"""

from __future__ import annotations

from datetime import date

CLOSURES: frozenset[date] = frozenset(
    date.fromisoformat(day)
    for day in (
        # 2025
        "2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
        "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
        # 2026
        "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
        "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
        # 2027
        "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
        "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
        # 2028 (New Year's Day falls on a Saturday: not observed)
        "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04",
        "2028-09-04", "2028-11-23", "2028-12-25",
    )
)
YEARS: frozenset[int] = frozenset(range(2025, 2029))


def is_closed(day: date) -> bool:
    """True for a listed full-day NYSE closure."""
    return day in CLOSURES
