"""wait_off_hours in research/backtests/imom/fetch_ibkr.py: pause only during weekday US market hours."""

import importlib.util
from datetime import UTC, datetime
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "research" / "backtests" / "imom" / "fetch_ibkr.py"
_spec = importlib.util.spec_from_file_location("imom_fetch_ibkr", SCRIPT)
fetch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fetch)


def run(*clock: datetime) -> list[float]:
    """Waits with a clock returning `clock` in turn; returns the requested sleeps."""
    times, sleeps = iter(clock), []
    fetch.wait_off_hours(now=lambda: next(times), sleep=sleeps.append)
    return sleeps


@pytest.mark.parametrize("open_utc, after_utc", [
    (datetime(2026, 7, 8, 14, 0, tzinfo=UTC), datetime(2026, 7, 8, 20, 6, tzinfo=UTC)),    # EDT: 10:00 New York
    (datetime(2026, 1, 7, 15, 0, tzinfo=UTC), datetime(2026, 1, 7, 21, 6, tzinfo=UTC)),    # EST: 10:00 New York
])
def test_weekday_market_hours_sleep_until_after_the_close(open_utc: datetime, after_utc: datetime) -> None:
    assert run(open_utc, after_utc) == [(16 * 60 + 5 - 10 * 60) * 60 + 5]


@pytest.mark.parametrize("when", [
    datetime(2026, 7, 11, 14, 0, tzinfo=UTC),  # Saturday 10:00 EDT
    datetime(2026, 7, 12, 14, 0, tzinfo=UTC),  # Sunday 10:00 EDT
    datetime(2026, 7, 8, 13, 24, tzinfo=UTC),  # 09:24 EDT, before 09:25
    datetime(2026, 1, 7, 14, 24, tzinfo=UTC),  # 09:24 EST
    datetime(2026, 7, 8, 20, 5, tzinfo=UTC),   # 16:05 EDT, the quiet window has ended
    datetime(2026, 1, 7, 21, 30, tzinfo=UTC),  # 16:30 EST
])
def test_off_hours_return_at_once(when: datetime) -> None:
    assert run(when) == []


def test_window_edges() -> None:
    assert run(datetime(2026, 7, 8, 13, 25, tzinfo=UTC), datetime(2026, 7, 8, 21, 0, tzinfo=UTC)) == [(16 * 60 + 5 - 9 * 60 - 25) * 60 + 5]
    assert run(datetime(2026, 7, 8, 20, 4, tzinfo=UTC), datetime(2026, 7, 8, 21, 0, tzinfo=UTC)) == [65]
