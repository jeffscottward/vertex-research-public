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
    "DATA_ENV", "DEFAULT_ROOT", "ETF_SYMBOLS", "FUTURES", "INDEX_TENOR_DAYS", "INDICES", "IV_INDEX", "IV_TERM",
    "MAX_FILL_DAYS", "SERIES_IDS", "Bars", "Market", "align", "data_root", "ey_tnx_ratio", "load_bars", "load_context",
    "load_market", "load_series", "load_shiller", "term_columns",
]

DATA_ENV = "VERTEX_QC_PORTS_DATA"
DEFAULT_ROOT = Path.home() / "Documents" / "reports" / "vertex-qc-ports" / "data"
MAX_FILL_DAYS = 5
ETF_SYMBOLS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
FUTURES = ("ES=F", "NQ=F", "YM=F", "RTY=F", "GC=F", "SI=F", "CL=F")
INDICES = ("VIX", "VIX3M", "VXN", "VXD", "RVX", "GVZ", "OVX", "VXSLV", "IRX", "TNX")
DERIVED = ("EY_TNX_RATIO",)
SERIES_IDS = ETF_SYMBOLS + FUTURES + INDICES + DERIVED
# Implied-volatility index of each traded symbol. Each of them is a 30-day index (INDEX_TENOR_DAYS).
IV_INDEX = {"SPY": "VIX", "QQQ": "VXN", "DIA": "VXD", "IWM": "RVX", "GLD": "GVZ", "SLV": "VXSLV", "USO": "OVX"}
INDEX_TENOR_DAYS = 30
# IV term structure: longer-tenor IV indices of a traded symbol and their tenor in calendar days (Cboe VIX3M:
# 93 days, from the qc-ports fetch; Cboe VIX6M: 182 days, from research/backtests/options-forms/fetch_data.py).
# Only SPY has one in the data set; the other symbols have their 30-day index alone.
IV_TERM: dict[str, dict[str, int]] = {"SPY": {"VIX3M": 93, "VIX6M": 182}}
# Months between the Shiller month and its use (earnings are published late).
EARNINGS_LAG_MONTHS = 6


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
    MAX_FILL_DAYS trading days. `iv_term` holds the longer-tenor IV indices of
    the symbol (IV_TERM) as (index id, levels in percent, None the same way),
    empty when the symbol has no term structure.
    """

    symbol: str
    dates: tuple[str, ...]
    close: tuple[float, ...]
    iv_index: tuple[float | None, ...]
    rate: tuple[float | None, ...]
    iv_term: tuple[tuple[str, tuple[float | None, ...]], ...] = ()

    def __post_init__(self) -> None:
        size = len(self.dates)
        if not (len(self.close) == len(self.iv_index) == len(self.rate) == size):
            raise ValueError("Market columns must have the same length")
        if any(later <= earlier for earlier, later in zip(self.dates, self.dates[1:])):
            raise ValueError("Market dates must be strictly increasing")
        if not all(_finite(value) and value > 0 for value in self.close):
            raise ValueError("Market closes must be finite and above 0")
        if not all(value is None or (_finite(value) and value > 0) for value in self.iv_index):
            raise ValueError("Market IV index values must be None or finite and above 0")
        if not all(value is None or (_finite(value) and value >= 0) for value in self.rate):
            raise ValueError("Market rates must be None or finite and not negative")
        ids = [index_id for index_id, _ in self.iv_term]
        if len(set(ids)) != len(ids) or not set(ids) <= set(IV_TERM.get(self.symbol, {})):
            raise ValueError(f"Market IV term of {self.symbol} must hold each index of data.IV_TERM at most once")
        for index_id, levels in self.iv_term:
            if len(levels) != size:
                raise ValueError(f"Market IV term {index_id} must have one value per date")
            if not all(value is None or (_finite(value) and value > 0) for value in levels):
                raise ValueError(f"Market IV term {index_id} values must be None or finite and above 0")

    def __len__(self) -> int:
        return len(self.dates)


def _finite(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


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
    """Reads `<symbol>.csv` (OHLC + adj_close). Rows with a missing or non-positive close, or a missing
    open, high, low or adj_close, are dropped (never filled)."""
    columns: dict[str, list] = {key: [] for key in ("date", "open", "high", "low", "close", "adj_close")}
    for row in _rows(data_root(root) / f"{symbol}.csv"):
        close = _number(row["close"])
        if close is None or close <= 0:
            continue
        values = {key: _number(row[key]) for key in ("open", "high", "low", "adj_close")}
        if any(value is None for value in values.values()):
            continue
        columns["date"].append(row["date"])
        columns["close"].append(close)
        for key, value in values.items():
            columns[key].append(value)
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
    """Fed model ratio per TNX date: 100 * E/P of the Shiller month 6 months back, over the TNX yield (percent)."""
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


def term_columns(symbol: str, series: Mapping[str, Mapping[str, float]], dates: Sequence[str],
                 max_fill: int = MAX_FILL_DAYS) -> tuple[tuple[str, tuple[float | None, ...]], ...]:
    """`Market.iv_term` of `symbol`: each term index of IV_TERM that `series` holds, aligned to `dates`."""
    return tuple((index_id, tuple(align(series[index_id], dates, max_fill)))
                 for index_id in IV_TERM.get(symbol, {}) if index_id in series)


def load_market(symbol: str, root: str | os.PathLike | None = None, *, max_fill: int = MAX_FILL_DAYS) -> Market:
    """Bars of `symbol` with its IV index, the T-bill rate (IRX, percent -> fraction) and its IV term aligned to them.
    A term index without a file is left out (a calendar on the symbol then opens no trade: "no IV term")."""
    if symbol not in IV_INDEX:
        raise ValueError(f"No IV index for {symbol}")
    bars = load_bars(symbol, root)
    iv = align(load_series(IV_INDEX[symbol], root), bars.dates, max_fill)
    rate = [None if value is None else value / 100
            for value in align(load_series("IRX", root), bars.dates, max_fill)]
    term = term_columns(symbol, {index_id: load_series(index_id, root) for index_id in IV_TERM.get(symbol, {})
                                 if (data_root(root) / f"{index_id}.csv").exists()}, bars.dates, max_fill)
    return Market(symbol, bars.dates, bars.close, tuple(iv), tuple(rate), term)
