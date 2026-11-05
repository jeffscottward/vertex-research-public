"""Port for cross-asset series analytics (research only).

The port takes plain chronological ISO dates and finite numbers and returns
lists aligned to the input dates. ``None`` marks a warmup bar or an undefined
value. Implementations live in adapters (gs_quant_backend.py); report and
research code depend on this port only, never on a vendor package. Results are
research data and grant no trading authority.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol, runtime_checkable

Series = list[float | None]


@runtime_checkable
class SeriesAnalytics(Protocol):
    """Rolling risk and statistics functions over one price series (optionally against a benchmark)."""

    engine_id: str

    def realized_volatility(self, dates: Sequence[str], closes: Sequence[float], window: int) -> Series:
        """Annualized volatility of simple returns over ``window`` returns, in percent."""
        ...

    def exponential_volatility(self, dates: Sequence[str], closes: Sequence[float], beta: float) -> Series:
        """Annualized exponentially weighted volatility of simple returns, in percent (decay ``beta``)."""
        ...

    def zscore(self, dates: Sequence[str], values: Sequence[float], window: int) -> Series:
        """Rolling z-score of each value against the trailing ``window`` values (sample deviation)."""
        ...

    def beta(self, dates: Sequence[str], closes: Sequence[float], benchmark_dates: Sequence[str],
             benchmark_closes: Sequence[float], window: int) -> Series:
        """Rolling beta of simple returns against the benchmark on common dates."""
        ...

    def correlation(self, dates: Sequence[str], closes: Sequence[float], benchmark_dates: Sequence[str],
                    benchmark_closes: Sequence[float], window: int) -> Series:
        """Rolling correlation of simple returns with the benchmark on common dates."""
        ...

    def max_drawdown(self, dates: Sequence[str], closes: Sequence[float], window: int | None) -> Series:
        """Worst peak-to-trough fall (a fraction, 0 or negative) over a trailing window, or since the start."""
        ...
