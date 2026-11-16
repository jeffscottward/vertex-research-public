"""The Trend Trio DSL definitions (strategies/trend_trio/dsl.py) decide like the frozen rules, variant V1.

The long and short definitions run through nautilus_backtest.signals.plan_run (with intradayIndicators support) on
a synthetic multi-session 1-minute series; a small walk over the compiled signals with the engine's decision order
(entry when flat, exit on a signal or exit-mask bar, market on close at the last regular bar) gives the decision
bars, which must equal those of strategies.trend_trio.rules.trades with Params(entry="reentry").

Known difference outside these sessions: on an early-close day V1 stops entries 10 minutes before the early
close, while the DSL entryTo is a fixed 15:50 New York (the DSL can enter up to the bar before the early close).
"""

from __future__ import annotations

import math
import random
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from nautilus_backtest import signals as sig
from nautilus_backtest.bars import (
    STRATEGY_INTRADAY_INDICATORS_UNSUPPORTED,
    Bars,
    StrategyUnsupportedError,
)
from strategies.trend_trio import rules
from strategies.trend_trio.dsl import definition
from strategies.trend_trio.rules import MINUTE_MS, Minutes, Params

NY = ZoneInfo("America/New_York")
OPEN = 9 * 60 + 30
SUPPORT = {"intradayIndicators": True}


def _ms(day: date, minute: int) -> int:
    hour, rest = divmod(OPEN + minute, 60)
    return int(datetime(day.year, day.month, day.day, hour, rest, tzinfo=NY).timestamp() * 1000)


def _sessions(start: date, count: int) -> list[date]:
    out: list[date] = []
    day = start
    while len(out) < count:
        if day.weekday() < 5:
            out.append(day)
        day = date.fromordinal(day.toordinal() + 1)
    return out


def _minutes(days: list[date], seed: int, missing: frozenset[tuple[int, int]] = frozenset()) -> Minutes:
    """Regular-session 1-minute bars (09:30-16:00 New York) with a random walk, a slow swing and volume."""
    rng = random.Random(seed)
    t, o, h, low, c, v, session, minute = [], [], [], [], [], [], [], []
    price = 100.0
    k = 0
    for s, day in enumerate(days):
        for m in range(390):
            close_price = price + rng.gauss(0.0, 0.25) + 0.08 * math.sin(k / 45)
            if (s, m) not in missing:
                t.append(_ms(day, m))
                o.append(price)
                c.append(close_price)
                h.append(max(price, close_price) + rng.random() * 0.1)
                low.append(min(price, close_price) - rng.random() * 0.1)
                v.append(100.0 + rng.randrange(400))
                session.append(s)
                minute.append(m)
            price = close_price
            k += 1
    return Minutes(t, o, h, low, c, v, MINUTE_MS, session, minute, [390] * len(days), [1.0] * len(days),
                   [day.isoformat() for day in days])


def _bars(m: Minutes) -> Bars:
    return Bars.from_columns({"t": m.t, "o": m.o, "h": m.h, "l": m.l, "c": m.c, "v": m.v})


def _dsl_decisions(m: Minutes, side: str, timeframe: str) -> tuple[list[int], list[int], list[int]]:
    """(entry decision bars, signal exit decision bars, market-on-close bars) of one DSL definition, in the
    decision order of nautilus_backtest.engine (a decision at bar i fills at the open of bar i + 1)."""
    spec = {"rule": {"kind": "dsl", "definition": definition(side, timeframe)}, "costBps": 0}
    compiled, options = sig.plan_run(_bars(m), spec, SUPPORT)
    assert options.side == ("short" if side == "short" else None)
    assert compiled.close_at is not None and compiled.exits is not None
    size = len(m.t)
    entries: list[int] = []
    exits: list[int] = []
    closes: list[int] = []
    held = False
    pending = 0
    for i in range(size):
        if pending:
            held, pending = pending == 1, 0
        closing = compiled.close_at[i] == 1
        if closing and held:
            closes.append(i)
            held = False
        if i < size - 1:
            signal = compiled.signals[i]
            if signal == 1 and not held and not closing:
                entries.append(i)
                pending = 1
            if held and (signal == -1 or compiled.exits[i] == 1):
                exits.append(i)
                pending = -1
    assert not held, "every session ends flat"
    return entries, exits, closes


def _rule_decisions(trades: list[rules.Trade], side: int) -> tuple[list[int], list[int], list[int]]:
    mine = [x for x in trades if x.side == side]
    return ([x.entry_bar - 1 for x in mine],
            [x.exit_bar - 1 for x in mine if x.exit_reason != "close"],
            [x.exit_bar for x in mine if x.exit_reason == "close"])


CASES = [
    # (timeframe, signal minutes, first session, sessions, seed, missing (session, minute) bars)
    ("5m", 5, date(2024, 3, 6), 7, 3, frozenset({(2, 31), (4, 200)})),  # crosses the March DST change
    ("15m", 15, date(2024, 1, 2), 12, 8, frozenset({(5, 91)})),
]


@pytest.mark.parametrize(("timeframe", "minutes", "start", "count", "seed", "missing"), CASES,
                         ids=[case[0] for case in CASES])
def test_dsl_definitions_decide_like_v1(timeframe: str, minutes: int, start: date, count: int, seed: int,
                                        missing: frozenset[tuple[int, int]]) -> None:
    m = _minutes(_sessions(start, count), seed, missing)
    trades = rules.trades(m, Params(signal_minutes=minutes, entry="reentry"))
    for side, sign in (("long", 1), ("short", -1)):
        expected = _rule_decisions(trades, sign)
        assert len(expected[0]) >= 3, f"{timeframe} {side}: the series needs trades on both sides"
        assert _dsl_decisions(m, side, timeframe) == expected, f"{timeframe} {side}"


def test_dsl_definitions_need_intraday_indicator_support() -> None:
    m = _minutes(_sessions(date(2024, 1, 2), 2), 1)
    spec = {"rule": {"kind": "dsl", "definition": definition("long")}, "costBps": 0}
    with pytest.raises(StrategyUnsupportedError) as raised:
        sig.plan_run(_bars(m), spec)
    assert raised.value.code == STRATEGY_INTRADAY_INDICATORS_UNSUPPORTED
