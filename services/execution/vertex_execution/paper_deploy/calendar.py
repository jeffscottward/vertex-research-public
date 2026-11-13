"""NYSE session calendar from rules. No data file, no network, no wall clock.

Every date is a New York calendar date. Supported from the year 2000 on (the
holiday set was different before); an earlier date raises ``ValueError``.

Full closures:

- Saturday and Sunday.
- New Year's Day (January 1). On a Sunday the Monday is closed. On a Saturday
  nothing is closed (the exchange does not close on the last session of a year).
- Martin Luther King Jr. Day (third Monday of January).
- Washington's Birthday (third Monday of February).
- Good Friday (the Friday before Easter Sunday, Gregorian computus).
- Memorial Day (last Monday of May).
- Juneteenth (June 19), from 2022.
- Independence Day (July 4).
- Labor Day (first Monday of September).
- Thanksgiving Day (fourth Thursday of November).
- Christmas Day (December 25).
- Juneteenth, Independence Day and Christmas Day on a Saturday close the Friday
  before; on a Sunday they close the Monday after.
- The dates in ``SPECIAL_CLOSURES`` (days of mourning, the 2001 attacks, the 2012
  storm). A future special closure is not known to a rule: add it to that table,
  or pass ``NyseCalendar(special_closures=...)``.

Early closes at 13:00 New York time (regular close: 16:00), each only when the
date is itself a session:

- July 3 (the day before Independence Day).
- The Friday after Thanksgiving Day.
- December 24 (Christmas Eve).

So no early close exists when July 3 or December 24 is the observed holiday or
a weekend day (2026-07-03 is closed and 2026-07-02 is a full session;
2027-12-24 is closed and 2027-12-23 is a full session). These rules agree with
the calendar the exchange published for 2026 to 2028 (read on 2026-11-11) and
with the sessions of 2024 and 2025. Early closes of earlier years were not
checked.

Options of some index and ETF products trade 15 minutes after these closes.
This calendar gives the equity close, which is the earlier and the safer one.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo

NEW_YORK = ZoneInfo("America/New_York")
OPEN_TIME = time(9, 30)
REGULAR_CLOSE = time(16, 0)
EARLY_CLOSE = time(13, 0)
FIRST_SUPPORTED_YEAR = 2000
JUNETEENTH_FIRST_YEAR = 2022

_MONDAY, _THURSDAY, _FRIDAY, _SATURDAY, _SUNDAY = 0, 3, 4, 5, 6
_ONE_DAY = timedelta(days=1)

# Weekday closures that no rule gives.
SPECIAL_CLOSURES: frozenset[date] = frozenset(
    {
        date(2001, 9, 11),  # attacks of September 11
        date(2001, 9, 12),
        date(2001, 9, 13),
        date(2001, 9, 14),
        date(2004, 6, 11),  # day of mourning, President Reagan
        date(2007, 1, 2),  # day of mourning, President Ford
        date(2012, 10, 29),  # storm Sandy
        date(2012, 10, 30),
        date(2018, 12, 5),  # day of mourning, President G. H. W. Bush
        date(2025, 1, 9),  # day of mourning, President Carter
    }
)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    last = date(year + (month == 12), month % 12 + 1, 1) - _ONE_DAY
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def _easter_sunday(year: int) -> date:
    """Gregorian Easter Sunday (anonymous Gregorian algorithm)."""

    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    g = (8 * b + 13) // 25
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 19 * l) // 433
    month = (h + l - 7 * m + 90) // 25
    day = (h + l - 7 * m + 33 * month + 19) % 32
    return date(year, month, day)


def _observed(day: date) -> date:
    """Saturday closes the Friday before, Sunday closes the Monday after."""

    if day.weekday() == _SATURDAY:
        return day - _ONE_DAY
    if day.weekday() == _SUNDAY:
        return day + _ONE_DAY
    return day


def thanksgiving(year: int) -> date:
    return _nth_weekday(year, 11, _THURSDAY, 4)


def good_friday(year: int) -> date:
    return _easter_sunday(year) - timedelta(days=2)


@lru_cache(maxsize=256)
def rule_holidays(year: int) -> frozenset[date]:
    """The closures of ``year`` that follow from the rules (no special closure)."""

    days = {
        _nth_weekday(year, 1, _MONDAY, 3),
        _nth_weekday(year, 2, _MONDAY, 3),
        good_friday(year),
        _last_weekday(year, 5, _MONDAY),
        _observed(date(year, 7, 4)),
        _nth_weekday(year, 9, _MONDAY, 1),
        thanksgiving(year),
        _observed(date(year, 12, 25)),
    }
    new_year = date(year, 1, 1)
    if new_year.weekday() == _SUNDAY:
        days.add(new_year + _ONE_DAY)
    elif new_year.weekday() != _SATURDAY:
        days.add(new_year)
    if year >= JUNETEENTH_FIRST_YEAR:
        days.add(_observed(date(year, 6, 19)))
    return frozenset(days)


def _checked(day: date) -> date:
    if not isinstance(day, date) or isinstance(day, datetime):
        raise TypeError("a New York calendar date is required (datetime.date, not datetime)")
    if day.year < FIRST_SUPPORTED_YEAR:
        raise ValueError(f"the session rules are not valid before {FIRST_SUPPORTED_YEAR}")
    return day


@dataclass(frozen=True)
class NyseCalendar:
    """The rules above with a table of special closures."""

    special_closures: frozenset[date] = SPECIAL_CLOSURES

    def __post_init__(self) -> None:
        closures = self.special_closures
        if not isinstance(closures, frozenset) or not all(
            isinstance(day, date) and not isinstance(day, datetime) for day in closures
        ):
            raise TypeError("special_closures must be a frozenset of dates")

    def is_session(self, day: date) -> bool:
        _checked(day)
        if day.weekday() >= _SATURDAY:
            return False
        return day not in rule_holidays(day.year) and day not in self.special_closures

    def is_early_close(self, day: date) -> bool:
        if not self.is_session(day):
            return False
        return (
            (day.month, day.day) in ((7, 3), (12, 24))
            or day == thanksgiving(day.year) + _ONE_DAY
        )

    def close_time(self, day: date) -> time:
        if not self.is_session(day):
            raise ValueError(f"{day.isoformat()} is not a session")
        return EARLY_CLOSE if self.is_early_close(day) else REGULAR_CLOSE

    def session_open(self, day: date) -> datetime:
        if not self.is_session(day):
            raise ValueError(f"{day.isoformat()} is not a session")
        return datetime.combine(day, OPEN_TIME, tzinfo=NEW_YORK)

    def session_close(self, day: date) -> datetime:
        return datetime.combine(day, self.close_time(day), tzinfo=NEW_YORK)

    def is_open_at(self, moment: datetime) -> bool:
        """The regular session is open at ``moment`` (open included, close excluded)."""

        if not isinstance(moment, datetime) or moment.utcoffset() is None:
            raise TypeError("a datetime with a time zone is required")
        local = moment.astimezone(NEW_YORK)
        day = local.date()
        return self.is_session(day) and self.session_open(day) <= local < self.session_close(day)

    def last_session_on_or_before(self, day: date) -> date:
        _checked(day)
        while not self.is_session(day):
            day -= _ONE_DAY
        return day

    def previous_session(self, day: date) -> date:
        return self.last_session_on_or_before(_checked(day) - _ONE_DAY)

    def next_session(self, day: date) -> date:
        day = _checked(day) + _ONE_DAY
        while not self.is_session(day):
            day += _ONE_DAY
        return day

    def sessions_before(self, day: date, n: int) -> date:
        """The session ``n`` sessions before ``day`` (``n`` = 1: the previous session)."""

        if type(n) is not int or n < 1:
            raise ValueError("n must be a whole number of sessions, at least 1")
        for _ in range(n):
            day = self.previous_session(day)
        return day


NYSE = NyseCalendar()


def is_session(day: date) -> bool:
    return NYSE.is_session(day)


def is_early_close(day: date) -> bool:
    return NYSE.is_early_close(day)


def close_time(day: date) -> time:
    """16:00, or 13:00 on an early-close day (New York time). Not a session: ``ValueError``."""

    return NYSE.close_time(day)


def previous_session(day: date) -> date:
    return NYSE.previous_session(day)


def sessions_before(day: date, n: int) -> date:
    return NYSE.sessions_before(day, n)


def last_session_on_or_before(day: date) -> date:
    return NYSE.last_session_on_or_before(day)
