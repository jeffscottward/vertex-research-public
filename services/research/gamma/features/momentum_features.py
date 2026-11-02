"""Momentum feature extraction from real equity price rows."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime
from statistics import mean
from typing import Any

from gamma.schemas.base import NonNegativeFloat, SchemaModel, TickerSymbol

PriceRow = Mapping[str, Any]


class MomentumFeatureSnapshot(SchemaModel):
    ticker: TickerSymbol
    as_of: datetime
    relative_strength_vs_spy: float | None = None
    relative_strength_vs_qqq: float | None = None
    twenty_day_breakout: bool
    fifty_day_breakout: bool
    volume_expansion: bool
    gap_and_hold: bool
    trend_acceleration: float | None = None
    close: NonNegativeFloat
    raw: dict[str, Any]


class MomentumFeatures:
    """Compute stock-level momentum features from cached OHLCV rows."""

    def compute(
        self,
        *,
        ticker: str,
        rows: Sequence[PriceRow],
        spy_rows: Sequence[PriceRow] | None = None,
        qqq_rows: Sequence[PriceRow] | None = None,
    ) -> MomentumFeatureSnapshot:
        prices = _ordered_rows(rows)
        if len(prices) < 2:
            raise ValueError("MomentumFeatures requires at least two OHLCV rows")

        latest = prices[-1]
        close = _number(latest, "close")
        short_return = _window_return(prices[-20:])
        long_return = _window_return(prices[-50:])
        return MomentumFeatureSnapshot(
            ticker=ticker.upper(),
            as_of=_row_datetime(latest),
            relative_strength_vs_spy=_relative_strength(prices, spy_rows),
            relative_strength_vs_qqq=_relative_strength(prices, qqq_rows),
            twenty_day_breakout=_is_breakout(prices, 20),
            fifty_day_breakout=_is_breakout(prices, 50),
            volume_expansion=_volume_expansion(prices),
            gap_and_hold=_gap_and_hold(prices),
            trend_acceleration=(
                short_return - long_return
                if short_return is not None and long_return is not None
                else None
            ),
            close=close,
            raw={"rows": len(prices)},
        )


def _ordered_rows(rows: Sequence[PriceRow]) -> list[PriceRow]:
    return sorted(rows, key=_row_datetime)


def _row_datetime(row: PriceRow) -> datetime:
    value = row.get("datetime") or row.get("timestamp") or row.get("date")
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=UTC)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        # Provider epoch timestamps; >= 1e11 means milliseconds.
        seconds = float(value) / 1000 if abs(float(value)) >= 1e11 else float(value)
        return datetime.fromtimestamp(seconds, tz=UTC)
    if isinstance(value, str):
        if value.lstrip("-").isdigit():
            number = int(value)
            seconds = number / 1000 if abs(number) >= 1e11 else number
            return datetime.fromtimestamp(seconds, tz=UTC)
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    raise ValueError("OHLCV rows require date, timestamp, or datetime")


def _number(row: PriceRow, key: str) -> float:
    value = row.get(key)
    if value is None:
        raise ValueError(f"OHLCV row is missing {key}")
    return float(value)


def _window_return(rows: Sequence[PriceRow]) -> float | None:
    if len(rows) < 2:
        return None
    first = _number(rows[0], "close")
    if first <= 0:
        return None
    return (_number(rows[-1], "close") - first) / first


def _relative_strength(
    rows: Sequence[PriceRow],
    benchmark_rows: Sequence[PriceRow] | None,
) -> float | None:
    if not benchmark_rows:
        return None
    own_return = _window_return(rows)
    benchmark_return = _window_return(_ordered_rows(benchmark_rows)[-len(rows) :])
    if own_return is None or benchmark_return is None:
        return None
    return own_return - benchmark_return


def _is_breakout(rows: Sequence[PriceRow], window: int) -> bool:
    scoped = rows[-window:]
    if len(scoped) < 2:
        return False
    latest_close = _number(scoped[-1], "close")
    prior_high = max(_number(row, "high") for row in scoped[:-1])
    return latest_close > prior_high


def _volume_expansion(rows: Sequence[PriceRow]) -> bool:
    if len(rows) < 2:
        return False
    prior = rows[-21:-1] if len(rows) > 21 else rows[:-1]
    volumes = [row.get("volume") for row in prior]
    latest = rows[-1].get("volume")
    if latest is None or any(v is None for v in volumes):
        return False  # provider bars without volume cannot confirm expansion
    avg_volume = mean(float(v) for v in volumes)
    return avg_volume > 0 and float(latest) >= avg_volume * 1.5


def _gap_and_hold(rows: Sequence[PriceRow]) -> bool:
    if len(rows) < 2:
        return False
    prior_close = _number(rows[-2], "close")
    latest_open = _number(rows[-1], "open")
    latest_close = _number(rows[-1], "close")
    return latest_open > prior_close * 1.02 and latest_close >= latest_open


__all__ = ["MomentumFeatureSnapshot", "MomentumFeatures"]
