"""Daily bars and rolling helpers for the stopping-premium study (pure Python, no network).

Loading reuses `strategies.qc_ports.data` (`load_bars`, `load_series`: the qc-ports / options-forms CSV
format) and the indicators reuse `indicators.core` (simple-mean ATR, SMA, z-score, realized volatility).
Share and ETF tests use total-return prices: open, high, low and close scaled by adj_close / close. Option
tests price on the split-adjusted close without dividends (`raw_close`), the price that strikes follow.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from indicators import core
from strategies.qc_ports.data import Bars, load_bars as qc_load_bars, load_series

TRADING_DAYS = 252


@dataclass(frozen=True)
class Series:
    symbol: str
    dates: tuple[str, ...]
    open: tuple[float, ...]
    high: tuple[float, ...]
    low: tuple[float, ...]
    close: tuple[float, ...]
    raw_close: tuple[float, ...]

    def __post_init__(self) -> None:
        n = len(self.dates)
        if any(len(x) != n for x in (self.open, self.high, self.low, self.close, self.raw_close)):
            raise ValueError(f"{self.symbol}: every column needs one value per date")
        if list(self.dates) != sorted(set(self.dates)):
            raise ValueError(f"{self.symbol}: dates must be unique and ascending")

    def index(self) -> dict[str, int]:
        return {d: i for i, d in enumerate(self.dates)}


def series_from(b: Bars) -> Series:
    """Total-return series of qc-ports bars; rows with a non-positive value are skipped."""
    dates, o, h, lo, c, raw = [], [], [], [], [], []
    for d, op, hi, low, close, adj in zip(b.dates, b.open, b.high, b.low, b.close, b.adj_close):
        if min(op, hi, low, close, adj) <= 0:
            continue
        f = adj / close
        dates.append(str(d)[:10])
        o.append(op * f)
        h.append(max(hi, op, close) * f)
        lo.append(min(low, op, close) * f)
        c.append(close * f)  # == adj; computed like high and low so that low <= close <= high holds exactly
        raw.append(close)
    return Series(b.symbol, tuple(dates), tuple(o), tuple(h), tuple(lo), tuple(c), tuple(raw))


def load_bars(path: Path, symbol: str | None = None) -> Series:
    return series_from(qc_load_bars(symbol or path.stem, path.parent))


def load_index(path: Path) -> dict[str, float]:
    """`date,close` file -> {date: close} (qc_ports.data.load_series)."""
    return load_series(path.stem, path.parent)


def daily_rf(irx: dict[str, float], dates: Sequence[str]) -> list[float]:
    """Daily safe-asset return from the 13-week T-bill yield (IRX, percent), carried forward over gaps;
    0 before the first IRX value."""
    out, last = [], 0.0
    for d in dates:
        if d in irx:
            last = irx[d] / 100 / TRADING_DAYS
        out.append(last)
    return out


def rolling_mean(xs: Sequence[float], n: int) -> list[float | None]:
    """Simple mean of the last n values including today (None until n values exist)."""
    return core.sma(xs, n)


def atr(high: Sequence[float], low: Sequence[float], close: Sequence[float], n: int) -> list[float | None]:
    """Simple n-day mean of the true range (market-watch-bot research/backtests.py `atr`)."""
    return core.atr(high, low, close, n, method="sma")


def rolling_extreme(xs: Sequence[float], n: int, *, lowest: bool, include_today: bool = False) -> list[float | None]:
    """Lowest (or highest) of the last n values, before today unless include_today."""
    out: list[float | None] = []
    for i in range(len(xs)):
        hi = i + 1 if include_today else i
        lo = hi - n
        if lo < 0:
            out.append(None)
            continue
        window = xs[lo:hi]
        out.append(min(window) if lowest else max(window))
    return out


def zscore(xs: Sequence[float], n: int) -> list[float | None]:
    """(today - mean of the last n incl. today) / their sample standard deviation (None when flat)."""
    return core.zscore(xs, n)


def realized_vol(close: Sequence[float], n: int) -> list[float | None]:
    """Annualized sample standard deviation of the last n daily simple returns, as a fraction."""
    return [None if v is None else v / 100 for v in core.realized_volatility(close, n)]


def month_ends(dates: Sequence[str]) -> set[int]:
    """Indices of the last date of each calendar month. The last date of the data is never a month end,
    because the data does not show whether its month continues."""
    return {i for i in range(len(dates) - 1) if dates[i][:7] != dates[i + 1][:7]}
