"""Loads the public daily data of the QuantConnect idea ports (research only).

The files come from the qc-ports fetch (default root
~/Documents/reports/vertex-qc-ports/data, override with VERTEX_QC_PORTS_DATA):
- `<SYM>.csv` (ETFs and futures): date,open,high,low,close,adj_close
- `<IDX>.csv` (volatility and rate indices): date,close
- `SHILLER.csv`: month,price,earnings (Shiller monthly S&P composite)

Pure Python, no network. Series are maps date (ISO `YYYY-MM-DD`) -> value. A
series is aligned to a bar calendar by carrying the last value forward for at
most `max_fill` trading days (VXSLV has gaps); past that the value is missing
(None) and the options runner does not open a trade on that day.
"""
from __future__ import annotations

import csv
import math
import os
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

__all__ = [
    "DATA_ENV", "DEFAULT_ROOT", "ETF_SYMBOLS", "FUTURES", "INDICES", "IV_INDEX", "MAX_FILL_DAYS", "SERIES_IDS",
    "Bars", "Market", "align", "data_root", "ey_tnx_ratio", "load_bars", "load_context", "load_market",
    "load_series", "load_shiller",
]

DATA_ENV = "VERTEX_QC_PORTS_DATA"
DEFAULT_ROOT = Path.home() / "Documents" / "reports" / "vertex-qc-ports" / "data"
MAX_FILL_DAYS = 5
ETF_SYMBOLS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
FUTURES = ("ES=F", "NQ=F", "YM=F", "RTY=F", "GC=F", "SI=F", "CL=F")
INDICES = ("VIX", "VIX3M", "VXN", "VXD", "RVX", "GVZ", "OVX", "VXSLV", "IRX", "TNX")
DERIVED = ("EY_TNX_RATIO",)
SERIES_IDS = ETF_SYMBOLS + FUTURES + INDICES + DERIVED
# Implied-volatility index of each traded symbol.
IV_INDEX = {"SPY": "VIX", "QQQ": "VXN", "DIA": "VXD", "IWM": "RVX", "GLD": "GVZ", "SLV": "VXSLV", "USO": "OVX"}
# Months between the Shiller month and its use (earnings are published late).
EARNINGS_LAG_MONTHS = 3


def data_root(root: str | os.PathLike | None = None) -> Path:
    if root is not None:
        return Path(root)
    env = os.environ.get(DATA_ENV)
    return Path(env) if env else DEFAULT_ROOT


@dataclass(frozen=True)
class Bars:
    """Daily bars of one symbol in date order. `close` is the traded (unadjusted) close."""

    symbol: str
    dates: tuple[str, ...]
    open: tuple[float, ...]
    high: tuple[float, ...]
    low: tuple[float, ...]
    close: tuple[float, ...]
    adj_close: tuple[float, ...]

    def __len__(self) -> int:
        return len(self.dates)


@dataclass(frozen=True)
class Market:
    """What the options book needs for one traded symbol, aligned to its bar dates.

    `iv_index` holds the IV index level (percent) and `rate` the annual risk-free
    rate as a fraction; both are None where the source has no value within
    MAX_FILL_DAYS trading days.
    """

    symbol: str
    dates: tuple[str, ...]
    close: tuple[float, ...]
    iv_index: tuple[float | None, ...]
    rate: tuple[float | None, ...]

    def __post_init__(self) -> None:
        size = len(self.dates)
        if not (len(self.close) == len(self.iv_index) == len(self.rate) == size):
            raise ValueError("Market columns must have the same length")
        if any(later <= earlier for earlier, later in zip(self.dates, self.dates[1:])):
            raise ValueError("Market dates must be strictly increasing")

    def __len__(self) -> int:
        return len(self.dates)


def _number(text: str) -> float | None:
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _rows(path: Path) -> Iterable[dict[str, str]]:
    with path.open(newline="") as handle:
        yield from csv.DictReader(handle)


def load_bars(symbol: str, root: str | os.PathLike | None = None) -> Bars:
    """Reads `<symbol>.csv` (OHLC + adj_close). Rows with a missing or non-positive close are dropped."""
    columns: dict[str, list] = {key: [] for key in ("date", "open", "high", "low", "close", "adj_close")}
    for row in _rows(data_root(root) / f"{symbol}.csv"):
        close = _number(row["close"])
        if close is None or close <= 0:
            continue
        values = {key: _number(row[key]) for key in ("open", "high", "low", "adj_close")}
        columns["date"].append(row["date"])
        columns["close"].append(close)
        for key, value in values.items():
            columns[key].append(close if value is None else value)
    bars = Bars(symbol, *(tuple(columns[key]) for key in ("date", "open", "high", "low", "close", "adj_close")))
    if any(later <= earlier for earlier, later in zip(bars.dates, bars.dates[1:])):
        raise ValueError(f"{symbol}: dates must be strictly increasing")
    return bars


def load_series(series_id: str, root: str | os.PathLike | None = None) -> dict[str, float]:
    """date -> close of an index or price file; EY_TNX_RATIO is derived from SHILLER and TNX."""
    if series_id == "EY_TNX_RATIO":
        return ey_tnx_ratio(load_shiller(root), load_series("TNX", root))
    series: dict[str, float] = {}
    for row in _rows(data_root(root) / f"{series_id}.csv"):
        value = _number(row["close"])
        if value is not None:
            series[row["date"]] = value
    return series


def load_shiller(root: str | os.PathLike | None = None) -> dict[str, tuple[float, float]]:
    """month (`YYYY-MM`) -> (price, earnings)."""
    table: dict[str, tuple[float, float]] = {}
    for row in _rows(data_root(root) / "SHILLER.csv"):
        price, earnings = _number(row["price"]), _number(row["earnings"])
        if price is not None and earnings is not None and price > 0:
            table[row["month"]] = (price, earnings)
    return table


def _shift_month(month: str, delta: int) -> str:
    year, number = int(month[:4]), int(month[5:7])
    serial = year * 12 + number - 1 + delta
    return f"{serial // 12:04d}-{serial % 12 + 1:02d}"


def ey_tnx_ratio(shiller: Mapping[str, tuple[float, float]], tnx: Mapping[str, float]) -> dict[str, float]:
    """Fed model ratio per TNX date: 100 * E/P of the Shiller month 3 months back, over the TNX yield (percent)."""
    ratio: dict[str, float] = {}
    for date, yield_pct in tnx.items():
        row = shiller.get(_shift_month(date[:7], -EARNINGS_LAG_MONTHS))
        if row is None or yield_pct <= 0:
            continue
        price, earnings = row
        ratio[date] = 100 * earnings / price / yield_pct
    return ratio


def load_context(ids: Sequence[str] = SERIES_IDS, root: str | os.PathLike | None = None) -> dict[str, dict[str, float]]:
    """series id -> {date: value}, the `context` the DSL series filters read."""
    unknown = [series_id for series_id in ids if series_id not in SERIES_IDS]
    if unknown:
        raise ValueError(f"Unknown series id: {', '.join(unknown)}")
    return {series_id: load_series(series_id, root) for series_id in ids}


def align(series: Mapping[str, float], dates: Sequence[str], max_fill: int = MAX_FILL_DAYS) -> list[float | None]:
    """Value of `series` on each date, carrying the last value for at most `max_fill` later dates.

    The carry counts entries of `dates` (trading days of the bar calendar). A
    source value dated between two bar dates is used from the next bar date on.
    """
    if max_fill < 0:
        raise ValueError("max_fill must be >= 0")
    keys = sorted(series)
    out: list[float | None] = []
    cursor = 0
    last: float | None = None
    age = 0
    for date in dates:
        fresh = False
        while cursor < len(keys) and keys[cursor] <= date:
            last = series[keys[cursor]]
            fresh = True
            cursor += 1
        if fresh:
            age = 0
        elif last is not None:
            age += 1
        out.append(last if last is not None and age <= max_fill else None)
    return out


def load_market(symbol: str, root: str | os.PathLike | None = None, *, max_fill: int = MAX_FILL_DAYS) -> Market:
    """Bars of `symbol` with its IV index and the T-bill rate (IRX, percent -> fraction) aligned to them."""
    if symbol not in IV_INDEX:
        raise ValueError(f"No IV index for {symbol}")
    bars = load_bars(symbol, root)
    iv = align(load_series(IV_INDEX[symbol], root), bars.dates, max_fill)
    rate = [None if value is None else value / 100
            for value in align(load_series("IRX", root), bars.dates, max_fill)]
    return Market(symbol, bars.dates, bars.close, tuple(iv), tuple(rate))
