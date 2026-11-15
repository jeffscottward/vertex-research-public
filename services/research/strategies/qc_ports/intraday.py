"""Intraday bars for the option book (research only).

book.py prices a spread at every bar of a `Market`. The bars can be intraday bars: the key of a bar
is then the New York time at which it closes ("2024-03-15T10:35", calendar.bar_time), and the book
adds the part of the day left until 16:00 to the days to expiry. This module makes such bars and
markets from regular-session minute bars, and gives the daily closes of a run on bar times.

- `session_bars`: sessions of 1-minute or 5-minute bars (strategies.noise_band: a session has a
  `day` and `bars`, a bar has `minute` = minutes from 09:30 to its start, and open, high, low and
  close) as bars of `minutes` length. A bar starts a multiple of `minutes` after 09:30. The last
  bar of a session ends with the session, so the hourly bars of a full day close at 10:30, 11:30,
  ..., 15:30 and 16:00. The prices are the traded prices: `adj_close` is the close.
- `known_at`: a daily series (an IV index, the rate) on bar keys without a value from the future.
  The last bar of a day has the value of that day, as a daily bar has (data.load_market). Every
  earlier bar of the day has the last value before that day. The data set has no intraday IV
  index, so the level does not move inside a day. The carry is data.align on the days of the bars.
- `intraday_market`: what the option book needs for one symbol on such bars.
- `daily_result`: the last equity of each day of a run on bar times, for the daily statistics.
- `max_open_risk`: portfolio.max_open_risk over the bars of a run, in one pass.
"""
from __future__ import annotations

import dataclasses
from collections.abc import Iterable, Mapping, Sequence
from datetime import date, timedelta
from typing import Protocol

from .book import PricedTrade
from .calendar import SESSION_CLOSE, bar_time, monthly_expiration
from .data import MAX_FILL_DAYS, Bars, Market, align
from .ledger import LedgerResult

__all__ = ["SESSION_MINUTES", "SESSION_OPEN", "bars_per_day", "daily_result", "day_of", "intraday_market", "known_at",
           "max_open_risk", "missing_expiries", "session_bars"]

# Minutes after midnight (New York time) at which the regular session opens, and its length.
SESSION_OPEN = 9 * 60 + 30
SESSION_MINUTES = SESSION_CLOSE - SESSION_OPEN
_DAY_LENGTH = len("2024-03-15")


class MinuteBar(Protocol):
    minute: int
    open: float
    high: float
    low: float
    close: float


class Session(Protocol):
    day: date
    bars: Sequence[MinuteBar]


def day_of(key: str) -> str:
    """The day of a bar key (a day or a bar time), as text."""
    return key[:_DAY_LENGTH]


def bars_per_day(minutes: int) -> int:
    """Bars of `minutes` length in a full session; the last one is shorter when `minutes` does not divide it."""
    if isinstance(minutes, bool) or not isinstance(minutes, int) or minutes < 1:
        raise ValueError("The bar length must be a whole number of minutes, at least 1")
    return -(-SESSION_MINUTES // minutes)


def missing_expiries(days: Iterable[date]) -> list[date]:
    """The monthly expiry days (NYSE rules) from the first to the last of `days` that are not in `days`.

    The option book takes its trading days from the bars (book.build_book): with the session of an expiry
    Friday left out, a spread would expire on the Thursday before. A run stops when this is not empty.
    """
    found = set(days)
    if not found:
        return []
    first, last = min(found), max(found)
    missing = []
    for serial in range(first.year * 12 + first.month - 1, last.year * 12 + last.month):
        expiry = monthly_expiration(serial // 12, serial % 12 + 1)
        if first <= expiry <= last and expiry not in found:
            missing.append(expiry)
    return missing


def session_bars(symbol: str, sessions: Iterable[Session], source_minutes: int, minutes: int) -> Bars:
    """`sessions` of `source_minutes` bars as bars of `minutes` length, keyed by the time each bar closes."""
    bars_per_day(minutes)
    if isinstance(source_minutes, bool) or not isinstance(source_minutes, int) or source_minutes < 1:
        raise ValueError("The source bar length must be a whole number of minutes, at least 1")
    if minutes % source_minutes:
        raise ValueError(f"{minutes}-minute bars cannot be made from {source_minutes}-minute bars")
    keys: list[str] = []
    columns: tuple[list[float], ...] = ([], [], [], [])
    opens, highs, lows, closes = columns
    last_day: date | None = None
    for session in sessions:
        if last_day is not None and session.day <= last_day:
            raise ValueError(f"{symbol}: the sessions must be in day order ({session.day} after {last_day})")
        last_day = session.day
        if not session.bars:
            raise ValueError(f"{symbol}: the session of {session.day} has no bar")
        session_end = SESSION_OPEN + session.bars[-1].minute + source_minutes
        bucket = previous = -1
        for bar in session.bars:
            if bar.minute <= previous or bar.minute % source_minutes:
                raise ValueError(f"{symbol} {session.day}: bar minute {bar.minute} is out of order or off the grid")
            previous = bar.minute
            start = bar.minute // minutes * minutes
            if start != bucket:
                bucket = start
                keys.append(bar_time(session.day, min(SESSION_OPEN + start + minutes, session_end)))
                for column, value in zip(columns, (bar.open, bar.high, bar.low, bar.close)):
                    column.append(float(value))
            else:
                highs[-1] = max(highs[-1], float(bar.high))
                lows[-1] = min(lows[-1], float(bar.low))
                closes[-1] = float(bar.close)
    return Bars(symbol, tuple(keys), tuple(opens), tuple(highs), tuple(lows), tuple(closes), tuple(closes))


def known_at(series: Mapping[str, float], keys: Sequence[str], max_fill: int = MAX_FILL_DAYS) -> list[float | None]:
    """The value of a daily `series` known at each bar key: of the bar's day at the last bar of that day,
    the last value before that day at every earlier bar. A value is carried for at most `max_fill`
    days of the bars (data.align)."""
    days = sorted({day_of(key) for key in keys})
    at_close = dict(zip(days, align(series, days, max_fill)))
    eves = [(date.fromisoformat(day) - timedelta(days=1)).isoformat() for day in days]
    before = dict(zip(days, align(series, eves, max_fill)))
    out: list[float | None] = []
    for index, key in enumerate(keys):
        day = day_of(key)
        last_of_day = index + 1 == len(keys) or day_of(keys[index + 1]) != day
        out.append(at_close[day] if last_of_day else before[day])
    return out


def intraday_market(bars: Bars, index: Mapping[str, float], irx: Mapping[str, float]) -> Market:
    """The option book's view of intraday `bars`: the IV index `index` (percent) and the T-bill rate `irx`
    (percent) as they are known at each bar (`known_at`)."""
    rate = [None if value is None else value / 100 for value in known_at(irx, bars.dates)]
    return Market(bars.symbol, bars.dates, bars.close, tuple(known_at(index, bars.dates)), tuple(rate))


def daily_result(result: LedgerResult) -> LedgerResult:
    """A run on bar times as a run on days: the equity after the last bar of each day, and the largest
    number of open spreads at a bar of that day. The trade records keep their bar times."""
    days: list[str] = []
    equity: list[float] = []
    positions: list[int] = []
    for key, value, count in zip(result.dates, result.equity, result.open_positions, strict=True):
        day = day_of(key)
        if days and days[-1] == day:
            equity[-1] = value
            positions[-1] = max(positions[-1], count)
        else:
            days.append(day)
            equity.append(value)
            positions.append(count)
    return dataclasses.replace(result, dates=tuple(days), equity=tuple(equity), open_positions=tuple(positions))


def max_open_risk(result: LedgerResult, priced: Sequence[PricedTrade]) -> float:
    """Largest share of equity at risk in open spreads at the close of a bar: the value of
    portfolio.max_open_risk on a run on bar times. That function compares every run day with every
    trade; a run on bar times has too many of both, so this is one pass over the bars (they ascend)."""
    max_loss = {trade.trade_id: trade.max_loss for trade in priced}
    records = result.trades
    amounts = [record["contracts"] * max_loss[record["id"]] for record in records]
    entering = sorted(range(len(records)), key=lambda number: records[number]["entryDate"])
    leaving = sorted(range(len(records)), key=lambda number: records[number]["exitDate"])
    held: set[int] = set()
    entered = left = 0
    worst = 0.0
    for key, equity in zip(result.dates, result.equity):
        while entered < len(entering) and records[entering[entered]]["entryDate"] <= key:
            held.add(entering[entered])
            entered += 1
        while left < len(leaving) and records[leaving[left]]["exitDate"] <= key:
            held.discard(leaving[left])
            left += 1
        risk = sum(amounts[number] for number in sorted(held))
        if risk and equity > 0:
            worst = max(worst, risk / equity)
    return worst
