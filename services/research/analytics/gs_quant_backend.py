"""gs-quant adapter for the SeriesAnalytics port (research only, offline).

This module is the only place outside tests that imports ``gs_quant``. It uses
the offline part of ``gs_quant.timeseries`` (functions marked ``@plot_function``
upstream) on data that the caller supplies. It never creates a ``GsSession``,
never calls the Goldman Sachs Marquee API and refuses to run when a session is
already set in the process, so no Marquee request can start from here.

Pin: gs-quant==2.2.4 (Apache-2.0, Goldman Sachs). It is a lazy import: the
analytics package imports without it, and every call raises
``GsQuantUnavailable`` with an install hint when it is missing or a different
version. Install it from services/research/requirements-gsquant-linux-py312.lock.

Conventions (gs-quant 2.2.4):
- Volatility is the sample standard deviation (ddof 1) of simple returns,
  annualized with the factor gs-quant infers from the date spacing (252 for
  daily data) and multiplied by 100.
- Exponential volatility uses gs-quant's exponentially weighted standard
  deviation of simple returns with decay ``beta`` (weight of the past).
- Beta and correlation use simple returns on the dates both series share.
- Values over partial windows are returned by gs-quant; this adapter replaces
  them with ``None`` so every value uses a full window.
"""
from __future__ import annotations

import importlib
import math
from collections.abc import Callable, Sequence
from datetime import date

from .ports import Series

GS_QUANT_VERSION = "2.2.4"
ENGINE_ID = f"gs-quant-{GS_QUANT_VERSION}"
INSTALL_HINT = ("install the pinned lock: python -m pip install --no-deps --require-hashes --only-binary=:all: "
                "-r services/research/requirements-gsquant-linux-py312.lock")
MAX_ROWS = 200_000
MAX_WINDOW = 2_000


class GsQuantUnavailable(RuntimeError):
    """gs-quant is missing or not the pinned version."""


class GsQuantSessionActive(RuntimeError):
    """A gs-quant (Marquee) session is set in this process; the offline adapter refuses to run."""


def require() -> None:
    """Raise GsQuantUnavailable unless the pinned gs-quant is importable."""
    try:
        gs_quant = importlib.import_module("gs_quant")
    except ImportError as error:
        raise GsQuantUnavailable(f"gs-quant=={GS_QUANT_VERSION} is not installed; {INSTALL_HINT}") from error
    version = getattr(gs_quant, "__version__", "unknown")
    if version != GS_QUANT_VERSION:
        raise GsQuantUnavailable(f"gs-quant {version} found, {GS_QUANT_VERSION} is pinned; {INSTALL_HINT}")


def _modules() -> dict:
    require()
    session = importlib.import_module("gs_quant.session")
    if session.GsSession.current_is_set:
        raise GsQuantSessionActive("a GsSession is set; the offline gs-quant adapter never uses Marquee")
    return {
        "pd": importlib.import_module("pandas"),
        "Window": importlib.import_module("gs_quant.timeseries.helper").Window,
        "econometrics": importlib.import_module("gs_quant.timeseries.econometrics"),
        "statistics": importlib.import_module("gs_quant.timeseries.statistics"),
        "technicals": importlib.import_module("gs_quant.timeseries.technicals"),
    }


def _dates(name: str, dates: Sequence[str]) -> list[date]:
    if isinstance(dates, (str, bytes)) or not isinstance(dates, Sequence):
        raise TypeError(f"{name} must be a sequence of ISO dates")
    if len(dates) > MAX_ROWS:
        raise ValueError(f"{name} has more than {MAX_ROWS} rows")
    parsed = [date.fromisoformat(day) for day in dates]
    if any(later <= earlier for earlier, later in zip(parsed, parsed[1:])):
        raise ValueError(f"{name} must be strictly increasing")
    return parsed


def _numbers(name: str, values: Sequence[float], length: int, *, positive: bool) -> list[float]:
    if isinstance(values, (str, bytes)) or not isinstance(values, Sequence):
        raise TypeError(f"{name} must be a sequence of numbers")
    if len(values) != length:
        raise ValueError(f"{name} must have one value per date")
    out = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{name} must contain only finite numbers")
        if positive and value <= 0:
            raise ValueError(f"{name} must contain only positive prices")
        out.append(float(value))
    return out


def _window(window: int) -> int:
    if isinstance(window, bool) or not isinstance(window, int) or not 2 <= window <= MAX_WINDOW:
        raise ValueError(f"window must be an integer 2..{MAX_WINDOW}")
    return window


def _series(m: dict, days: list[date], values: list[float]):
    return m["pd"].Series(values, index=m["pd"].DatetimeIndex(days), dtype=float)


def _aligned(result, days: list[date], first_full: int) -> Series:
    """Map a gs-quant result back to ``days``; positions before ``first_full`` and NaN become None."""
    by_day = {stamp.date(): float(value) for stamp, value in result.items()}
    out: Series = []
    for index, day in enumerate(days):
        value = by_day.get(day)
        out.append(None if index < first_full or value is None or not math.isfinite(value) else value)
    return out


def _pair(m: dict, dates, closes, benchmark_dates, benchmark_closes):
    days = _dates("dates", dates)
    values = _numbers("closes", closes, len(days), positive=True)
    bench_days = _dates("benchmark_dates", benchmark_dates)
    bench = dict(zip(bench_days, _numbers("benchmark_closes", benchmark_closes, len(bench_days), positive=True)))
    common = [(day, value) for day, value in zip(days, values) if day in bench]
    common_days = [day for day, _ in common]
    return (days, _series(m, common_days, [value for _, value in common]),
            _series(m, common_days, [bench[day] for day in common_days]), common_days)


class GsQuantAnalytics:
    """SeriesAnalytics implemented with gs_quant.timeseries 2.2.4 (offline functions only)."""

    engine_id = ENGINE_ID

    def realized_volatility(self, dates: Sequence[str], closes: Sequence[float], window: int) -> Series:
        m, w = _modules(), _window(window)
        days = _dates("dates", dates)
        x = _series(m, days, _numbers("closes", closes, len(days), positive=True))
        return _aligned(m["econometrics"].volatility(x, m["Window"](w, 0)), days, w)

    def exponential_volatility(self, dates: Sequence[str], closes: Sequence[float], beta: float) -> Series:
        if isinstance(beta, bool) or not isinstance(beta, (int, float)) or not 0 <= beta < 1:
            raise ValueError("beta must be a number in [0, 1)")
        m = _modules()
        days = _dates("dates", dates)
        x = _series(m, days, _numbers("closes", closes, len(days), positive=True))
        return _aligned(m["technicals"].exponential_volatility(x, float(beta)), days, 2)

    def zscore(self, dates: Sequence[str], values: Sequence[float], window: int) -> Series:
        m, w = _modules(), _window(window)
        days = _dates("dates", dates)
        x = _series(m, days, _numbers("values", values, len(days), positive=False))
        return _aligned(m["statistics"].zscores(x, m["Window"](w, 0)), days, w - 1)

    def _relative(self, name: str, dates, closes, benchmark_dates, benchmark_closes, window: int) -> Series:
        m, w = _modules(), _window(window)
        days, x, b, common = _pair(m, dates, closes, benchmark_dates, benchmark_closes)
        if len(common) <= w:
            return [None] * len(days)
        function: Callable = getattr(m["econometrics"], name)
        result = _aligned(function(x, b, m["Window"](w, 0)), common, w)
        by_day = dict(zip(common, result))
        return [by_day.get(day) for day in days]

    def beta(self, dates: Sequence[str], closes: Sequence[float], benchmark_dates: Sequence[str],
             benchmark_closes: Sequence[float], window: int) -> Series:
        return self._relative("beta", dates, closes, benchmark_dates, benchmark_closes, window)

    def correlation(self, dates: Sequence[str], closes: Sequence[float], benchmark_dates: Sequence[str],
                    benchmark_closes: Sequence[float], window: int) -> Series:
        return self._relative("correlation", dates, closes, benchmark_dates, benchmark_closes, window)

    def max_drawdown(self, dates: Sequence[str], closes: Sequence[float], window: int | None) -> Series:
        m = _modules()
        days = _dates("dates", dates)
        x = _series(m, days, _numbers("closes", closes, len(days), positive=True))
        if window is None:
            return _aligned(m["econometrics"].max_drawdown(x), days, 0)
        w = _window(window)
        return _aligned(m["econometrics"].max_drawdown(x, m["Window"](w, 0)), days, w - 1)
