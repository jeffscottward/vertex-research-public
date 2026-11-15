"""Synthetic markets for the qc-ports tests (no files, no network)."""
from __future__ import annotations

import random
from datetime import date, timedelta

from strategies.qc_ports.calendar import SESSION_CLOSE, bar_time, is_nyse_holiday
from strategies.qc_ports.data import Bars, Market

SESSION_OPEN = 9 * 60 + 30

# VIX level giving an ATM IV of exactly 0.2 (factor 0.9).
VIX_FOR_20 = 200 / 9


def trading_days(start: str, count: int) -> tuple[str, ...]:
    day = date.fromisoformat(start)
    out = []
    while len(out) < count:
        if day.weekday() < 5 and not is_nyse_holiday(day):
            out.append(day.isoformat())
        day += timedelta(days=1)
    return tuple(out)


def market(closes, *, symbol="SPY", start="2024-01-02", iv=VIX_FOR_20, rate=0.0, ivs=None) -> Market:
    dates = trading_days(start, len(closes))
    iv_column = tuple(ivs) if ivs is not None else (iv,) * len(closes)
    return Market(symbol, dates, tuple(float(c) for c in closes), iv_column, (rate,) * len(closes))


def bar_times(start: str, days: int, minutes: int) -> tuple[str, ...]:
    """The keys of the `minutes`-minute bars of `days` full sessions (`minutes` divides the 390 of a session)."""
    return tuple(bar_time(day, close) for day in trading_days(start, days)
                 for close in range(SESSION_OPEN + minutes, SESSION_CLOSE + 1, minutes))


def intraday_market(closes, minutes, *, symbol="SPY", start="2024-01-02", iv=VIX_FOR_20, rate=0.0) -> Market:
    """A market on `minutes`-minute bars: one close per bar, a constant IV index and rate."""
    per_day = (SESSION_CLOSE - SESSION_OPEN) // minutes
    keys = bar_times(start, -(-len(closes) // per_day), minutes)[:len(closes)]
    return Market(symbol, keys, tuple(float(c) for c in closes), (iv,) * len(closes), (rate,) * len(closes))


def flat_model(monkeypatch, symbol="SPY"):
    """No skew and no dividend yield, so prices follow plain Black-Scholes."""
    from strategies.qc_ports import options

    monkeypatch.setitem(options.SKEW, symbol, 0.0)
    monkeypatch.setitem(options.DIVIDEND_YIELD, symbol, 0.0)


def random_walk_bars(seed: int, count: int, vol: float, symbol: str = "SPY") -> Bars:
    """Bars of a seeded random walk, prices in cents (the order-rule reference of make_quantjourney_orders_reference.py)."""
    rng = random.Random(seed)
    price = 100.0
    opens, highs, lows, closes = [], [], [], []
    for _ in range(count):
        open_ = price * (1 + rng.gauss(0, vol / 3))
        close = open_ * (1 + rng.gauss(0, vol))
        high = max(open_, close) * (1 + abs(rng.gauss(0, vol / 2)))
        low = min(open_, close) * (1 - abs(rng.gauss(0, vol / 2)))
        opens.append(round(open_, 2))
        highs.append(round(high, 2))
        lows.append(round(low, 2))
        closes.append(round(close, 2))
        price = close
    keys = tuple(f"k{index:06d}" for index in range(count))
    return Bars(symbol, keys, tuple(opens), tuple(highs), tuple(lows), tuple(closes), tuple(closes))
