"""US equity-options calendar helpers for the qc-ports (research only).

Trading days come from the bar dates where they exist and from NYSE holiday
rules after them (the last month of the data and expiries after the data end).
Monthly expiration = 3rd Friday of the month, or the prior trading day when the
Friday is a holiday (Good Friday, Juneteenth).

A bar key is a day ("2024-03-15": a daily bar, which stands for its close) or a bar time
("2024-03-15T10:35": the New York time at which an intraday bar closes; `bar_time` makes one).
`parse` gives the day of both; `day_left` gives the part of a day between a bar time and the
16:00 close. Bar keys of one kind sort in time order as text.

Also the calendar windows of the DSL `calendarWindow` filter:
- turn of month: trading-day offsets, -1 = last trading day of the month,
  1 = first trading day of the month;
- opex week: from the last trading day before the Monday-Friday week holding the
  monthly expiration through the expiration day;
- months: calendar months.
"""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import date, timedelta

__all__ = [
    "SESSION_CLOSE", "TradingCalendar", "bar_time", "day_left", "easter", "expirations_after", "in_months",
    "is_bar_time", "is_nyse_holiday", "month_offsets", "monthly_expiration", "opex_window", "parse", "turn_of_month",
]

# Minutes after midnight (New York time) at which the options of a day stop trading.
SESSION_CLOSE = 16 * 60
MINUTES_PER_DAY = 24 * 60
_DAY_LENGTH = len("2024-03-15")
_BAR_TIME_LENGTH = len("2024-03-15T10:35")


def bar_time(day: str | date, minutes: int) -> str:
    """The bar key of the bar that closes `minutes` after midnight (New York time) on `day`."""
    if isinstance(minutes, bool) or not isinstance(minutes, int) or not 0 <= minutes <= SESSION_CLOSE:
        raise ValueError(f"A bar closes 0 to {SESSION_CLOSE} minutes after midnight, not {minutes!r}")
    return f"{parse(day).isoformat()}T{minutes // 60:02d}:{minutes % 60:02d}"


def is_bar_time(value: str | date) -> bool:
    """True for a bar time, False for a date or a day key."""
    return isinstance(value, str) and len(value) == _BAR_TIME_LENGTH and value[_DAY_LENGTH] == "T"


def parse(value: str | date) -> date:
    """The day of a date, of a day key or of a bar time."""
    if isinstance(value, date):
        return value
    return date.fromisoformat(value[:_DAY_LENGTH] if is_bar_time(value) else value)


def day_left(value: str | date) -> float:
    """Part of a day between a bar time and the 16:00 close of its day; 0 for a date or a day key."""
    if not is_bar_time(value):
        return 0.0
    hours, colon, minutes = value[11:13], value[13], value[14:16]
    if colon != ":" or not (hours.isdigit() and minutes.isdigit()) or int(minutes) > 59:
        raise ValueError(f"Not a bar time: {value!r}")
    close = int(hours) * 60 + int(minutes)
    if close > SESSION_CLOSE:
        raise ValueError(f"Bar time {value} is after the 16:00 close")
    return (SESSION_CLOSE - close) / MINUTES_PER_DAY


def easter(year: int) -> date:
    """Gregorian Easter Sunday (anonymous Gregorian algorithm)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7  # noqa: E741 (name of the published algorithm)
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = (h + l - 7 * m + 114) % 31 + 1
    return date(year, month, day)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    last = (date(year + month // 12, month % 12 + 1, 1)) - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def _observed(day: date) -> date:
    if day.weekday() == 5:
        return day - timedelta(days=1)
    if day.weekday() == 6:
        return day + timedelta(days=1)
    return day


def is_nyse_holiday(day: date) -> bool:
    """Regular NYSE full-day holidays (rules since 1998; special closures are not modeled)."""
    year = day.year
    holidays = {
        _nth_weekday(year, 1, 0, 3),  # Martin Luther King Jr. Day
        _nth_weekday(year, 2, 0, 3),  # Washington's Birthday
        easter(year) - timedelta(days=2),  # Good Friday
        _last_weekday(year, 5, 0),  # Memorial Day
        _observed(date(year, 7, 4)),
        _nth_weekday(year, 9, 0, 1),  # Labor Day
        _nth_weekday(year, 11, 3, 4),  # Thanksgiving
        _observed(date(year, 12, 25)),
    }
    new_year = date(year, 1, 1)
    if new_year.weekday() != 5:  # NYSE does not observe a Saturday New Year on Dec 31
        holidays.add(_observed(new_year))
    if year >= 2022:
        holidays.add(_observed(date(year, 6, 19)))
    return day in holidays


class TradingCalendar:
    """Trading days: the given bar dates, extended after the last one by the NYSE rules."""

    def __init__(self, dates: Iterable[str | date]) -> None:
        days = sorted({parse(value) for value in dates})
        if not days:
            raise ValueError("TradingCalendar needs at least one date")
        self._days = frozenset(days)
        self.first, self.last = days[0], days[-1]

    def is_trading_day(self, day: date) -> bool:
        if self.first <= day <= self.last:
            return day in self._days
        return day.weekday() < 5 and not is_nyse_holiday(day)

    def previous_trading_day(self, day: date) -> date:
        day -= timedelta(days=1)
        while not self.is_trading_day(day):
            day -= timedelta(days=1)
        return day


def monthly_expiration(year: int, month: int, calendar: TradingCalendar | None = None) -> date:
    """3rd Friday, or the prior trading day when the 3rd Friday is not a trading day."""
    friday = _nth_weekday(year, month, 4, 3)
    if calendar is None:
        while friday.weekday() >= 5 or is_nyse_holiday(friday):
            friday -= timedelta(days=1)
        return friday
    return friday if calendar.is_trading_day(friday) else calendar.previous_trading_day(friday)


def expirations_after(day: str | date, months: int, calendar: TradingCalendar | None = None) -> list[date]:
    """Monthly expirations on or after `day`, scanning `months` calendar months from its month."""
    start = parse(day)
    out = []
    for offset in range(months + 1):
        serial = start.year * 12 + start.month - 1 + offset
        expiry = monthly_expiration(serial // 12, serial % 12 + 1, calendar)
        if expiry >= start:
            out.append(expiry)
    return out


def month_offsets(dates: Sequence[str | date], calendar: TradingCalendar | None = None) -> list[tuple[int, int]]:
    """(k, -m) per date: k-th trading day of its month and m-th trading day from the month end.

    Months cut by the start or the end of `dates` are completed with the calendar
    (by default the NYSE rules outside `dates`).
    """
    days = [parse(value) for value in dates]
    if not days:
        return []
    calendar = calendar or TradingCalendar(days)
    out = []
    for index, day in enumerate(days):
        k = 1
        back = index - 1
        while back >= 0 and (days[back].year, days[back].month) == (day.year, day.month):
            k += 1
            back -= 1
        if back < 0:
            cursor = date(day.year, day.month, 1)
            while cursor < days[0]:
                k += calendar.is_trading_day(cursor)
                cursor += timedelta(days=1)
        m = 1
        ahead = index + 1
        while ahead < len(days) and (days[ahead].year, days[ahead].month) == (day.year, day.month):
            m += 1
            ahead += 1
        if ahead == len(days):
            cursor = days[-1] + timedelta(days=1)
            while (cursor.year, cursor.month) == (day.year, day.month):
                m += calendar.is_trading_day(cursor)
                cursor += timedelta(days=1)
        out.append((k, -m))
    return out


def turn_of_month(dates: Sequence[str | date], from_day: int, to_day: int,
                  calendar: TradingCalendar | None = None) -> list[bool]:
    """True on bars inside [from_day, to_day]: the last -from_day or the first to_day trading days of a month."""
    if not (-10 <= from_day <= -1 and 1 <= to_day <= 10):
        raise ValueError("turnOfMonth needs fromDay in -10..-1 and toDay in 1..10")
    return [k <= to_day or neg >= from_day for k, neg in month_offsets(dates, calendar)]


def opex_window(dates: Sequence[str | date], calendar: TradingCalendar | None = None) -> list[bool]:
    """True from the last trading day before the opex week (Mon-Fri) through the monthly expiration.

    The 3rd Friday falls on day 15..21, so the whole window lies in the month of the expiration.
    """
    days = [parse(value) for value in dates]
    if not days:
        return []
    calendar = calendar or TradingCalendar(days)
    windows: dict[tuple[int, int], tuple[date, date]] = {}
    out = []
    for day in days:
        key = (day.year, day.month)
        if key not in windows:
            expiry = monthly_expiration(day.year, day.month, calendar)
            monday = expiry - timedelta(days=expiry.weekday())
            windows[key] = (calendar.previous_trading_day(monday), expiry)
        start, end = windows[key]
        out.append(start <= day <= end)
    return out


def in_months(dates: Sequence[str | date], months: Iterable[int]) -> list[bool]:
    allowed = set(months)
    if not allowed or any(not (1 <= month <= 12) for month in allowed):
        raise ValueError("months must be within 1..12")
    return [parse(value).month in allowed for value in dates]
