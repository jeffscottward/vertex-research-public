"""Bar columns and input errors for the Nautilus backtest port.

Port of the BarColumns type and the input checks of packages/api/src/instant-backtest-engine.ts.
Messages match the TypeScript InstantBacktestInputError messages. Research only.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any


class InputError(ValueError):
    """Bad backtest input. Same messages as the TypeScript InstantBacktestInputError."""


class SectorQuadrantDataError(InputError):
    """A definition has a sector filter, but its series was not given."""

    def __init__(self, sector: str, timeframe: str) -> None:
        super().__init__(
            f"Sector quadrant data is not available for {sector} ({timeframe})"
        )


class SeriesDataError(InputError):
    """A definition has a filter on a series that was not given (TS StrategySeriesDataError)."""

    def __init__(self, series: str) -> None:
        super().__init__(f"Series data is not available for {series}")


def _column(values: Sequence[Any]) -> tuple[float, ...]:
    # JSON null means NaN (the golden fixtures write NaN as null).
    return tuple(math.nan if value is None else float(value) for value in values)


@dataclass(frozen=True)
class Bars:
    """Columnar bars. `t` is epoch ms, ascending. `v` is optional volume."""

    t: tuple[float, ...]
    o: tuple[float, ...]
    h: tuple[float, ...]
    l: tuple[float, ...]  # noqa: E741 - same column name as TypeScript
    c: tuple[float, ...]
    v: tuple[float, ...] | None = None

    @staticmethod
    def from_columns(cols: Mapping[str, Any]) -> Bars:
        """Builds bars from {"t": [...], "o": ..., "h": ..., "l": ..., "c": ..., "v": optional}."""
        volume = cols.get("v")
        return Bars(
            t=_column(cols["t"]),
            o=_column(cols["o"]),
            h=_column(cols["h"]),
            l=_column(cols["l"]),
            c=_column(cols["c"]),
            v=None if volume is None else _column(volume),
        )

    def __len__(self) -> int:
        return len(self.c)

    def window(self, first: int, end: int) -> Bars:
        """The bars first..end-1 (a run's own date range inside a shared batch series)."""
        if not (0 <= first < end <= len(self.c)):
            raise InputError(f"slice {first}..{end} is outside the {len(self.c)} bars")
        return Bars(
            t=self.t[first:end],
            o=self.o[first:end],
            h=self.h[first:end],
            l=self.l[first:end],
            c=self.c[first:end],
            v=None if self.v is None else self.v[first:end],
        )


def is_finite_number(value: Any) -> bool:
    """JS Number.isFinite: a real number that is not NaN or infinite (bool is not a number)."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def is_integer(value: Any) -> bool:
    """JS Number.isInteger."""
    return is_finite_number(value) and float(value).is_integer()


def assert_columns(bars: Bars) -> int:
    """TS assertColumns: equal column lengths and at least 2 bars. Returns the bar count."""
    size = len(bars.c)
    if (
        len(bars.t) != size
        or len(bars.o) != size
        or len(bars.h) != size
        or len(bars.l) != size
    ):
        raise InputError("Bar columns must have equal length")
    if size < 2:
        raise InputError("At least 2 bars needed")
    return size


def assert_window(name: str, value: Any, maximum: int) -> None:
    """TS assertWindow: an integer from 1 to `maximum`."""
    if not is_integer(value) or value < 1 or value > maximum:
        raise InputError(f"{name} must be an integer from 1 to {maximum}")


def _format_number(value: float) -> str:
    # JS prints 10_000 as "10000"; Python ints print the same way.
    return str(int(value)) if float(value).is_integer() else repr(value)


def assert_params(
    stop_loss_pct: Any,
    take_profit_pct: Any,
    cost_bps: Any,
    costs: Mapping[str, Any] | None,
) -> None:
    """TS assertParams: stop, target and cost ranges, and a positive capital."""

    def percent(name: str, value: Any, maximum: float) -> None:
        if not is_finite_number(value) or value < 0 or value > maximum:
            raise InputError(f"{name} must be from 0 to {_format_number(maximum)}")

    percent("stopLossPct", stop_loss_pct, 99)
    percent("takeProfitPct", take_profit_pct, 10_000)
    percent("costBps", cost_bps, 500)
    if costs is not None:
        capital = costs.get("capital")
        if not is_finite_number(capital) or capital <= 0:
            raise InputError("capital must be above 0")


def assert_signal_options(
    size: int,
    signals: Sequence[int],
    *,
    cost_bps: Any,
    stop_loss_pct: Any,
    take_profit_pct: Any,
    costs: Mapping[str, Any] | None,
    risk_pct: Any = None,
    max_hold_bars: Any = None,
) -> None:
    """TS assertSignalOptions."""
    if len(signals) != size:
        raise InputError("Signals must match the bar count")
    assert_params(stop_loss_pct, take_profit_pct, cost_bps, costs)
    if risk_pct is not None and not (
        is_finite_number(risk_pct) and 0 < risk_pct <= 100
    ):
        raise InputError("riskPct must be above 0 and at most 100")
    if max_hold_bars is not None and not (
        is_integer(max_hold_bars) and max_hold_bars >= 1
    ):
        raise InputError("maxHoldBars must be a whole number of at least 1")
