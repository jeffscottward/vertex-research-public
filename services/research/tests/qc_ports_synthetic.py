"""Synthetic markets for the qc-ports tests (no files, no network)."""
from __future__ import annotations

from datetime import date, timedelta

from strategies.qc_ports.calendar import is_nyse_holiday
from strategies.qc_ports.data import Market

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


def flat_model(monkeypatch, symbol="SPY"):
    """No skew and no dividend yield, so prices follow plain Black-Scholes."""
    from strategies.qc_ports import options

    monkeypatch.setitem(options.SKEW, symbol, 0.0)
    monkeypatch.setitem(options.DIVIDEND_YIELD, symbol, 0.0)
