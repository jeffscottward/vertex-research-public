"""Market-structure feature extraction from real OHLCV rows."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime
from statistics import mean
from typing import Any, Literal

from gamma.schemas import MarketStructureSnapshot

PriceRow = Mapping[str, Any]
BreakoutStatus = Literal[
    "pre_breakout",
    "breakout",
    "failed_breakout",
    "retest",
    "none",
]


class MarketStructureFeatures:
    """Compute provider-neutral structure features from cached OHLCV rows."""

    def __init__(self, *, lookback: int = 20) -> None:
        if lookback < 2:
            raise ValueError("lookback must be at least 2")
        self._lookback = lookback

    def compute(
        self,
        *,
        ticker: str,
        rows: Sequence[PriceRow],
        timeframe: str = "1d",
    ) -> MarketStructureSnapshot:
        prices = _ordered_rows(rows)[-self._lookback :]
        if len(prices) < 2:
            raise ValueError("MarketStructureFeatures requires at least two OHLCV rows")

        latest = prices[-1]
        prior = prices[:-1]
        close = _number(latest, "close")
        high = _number(latest, "high")
        low = _number(latest, "low")
        volume = _number_or_none(latest, "volume")
        prior_high = max(_number(row, "high") for row in prior)
        prior_low = min(_number(row, "low") for row in prior)
        prior_volumes = [
            v for row in prior if (v := _number_or_none(row, "volume")) is not None
        ]
        avg_prior_volume = mean(prior_volumes) if prior_volumes else None
        value_low, value_high = _value_area_approximation(prices)

        return MarketStructureSnapshot(
            ticker=ticker.upper(),
            as_of=_row_datetime(latest),
            timeframe=timeframe,
            trend_label=_trend_label(prices),
            vwap_relation=_vwap_relation(latest, close),
            value_area_relation=_value_area_relation(close, value_low, value_high),
            breakout_status=_breakout_status(
                close=close,
                high=high,
                prior_high=prior_high,
                prior_low=prior_low,
            ),
            relative_volume=(
                volume / avg_prior_volume
                if volume is not None and avg_prior_volume
                else None
            ),
            atr_percent=_atr_percent(prices),
            support_levels=sorted({prior_low, low}),
            resistance_levels=sorted({prior_high, high}),
            notes=(
                "Value area is an OHLCV close-distribution approximation; true "
                "volume profile was not supplied."
            ),
            raw={
                "latest_close": close,
                "prior_high": prior_high,
                "prior_low": prior_low,
                "value_area_method": "ohlcv_close_distribution_approximation",
                "value_area_low": value_low,
                "value_area_high": value_high,
            },
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


def _number_or_none(row: Mapping[str, Any], key: str) -> float | None:
    value = row.get(key)
    return None if value is None else float(value)


def _number(row: PriceRow, key: str) -> float:
    value = row.get(key)
    if value is None:
        raise ValueError(f"OHLCV row is missing {key}")
    return float(value)


def _trend_label(
    rows: Sequence[PriceRow],
) -> Literal["uptrend", "downtrend", "range", "transition", "unknown"]:
    first_close = _number(rows[0], "close")
    last_close = _number(rows[-1], "close")
    if first_close <= 0:
        return "unknown"
    change = (last_close - first_close) / first_close
    if change >= 0.03:
        return "uptrend"
    if change <= -0.03:
        return "downtrend"
    return "range"


def _vwap_relation(
    row: PriceRow,
    close: float,
) -> Literal[
    "above_vwap",
    "below_vwap",
    "reclaiming_vwap",
    "rejecting_vwap",
    "unknown",
]:
    vwap = row.get("vwap")
    if vwap is None:
        return "unknown"
    return "above_vwap" if close >= float(vwap) else "below_vwap"


def _value_area_approximation(rows: Sequence[PriceRow]) -> tuple[float, float]:
    closes = sorted(_number(row, "close") for row in rows)
    low_index = max(0, round((len(closes) - 1) * 0.3))
    high_index = min(len(closes) - 1, round((len(closes) - 1) * 0.7))
    return closes[low_index], closes[high_index]


def _value_area_relation(
    close: float,
    value_low: float,
    value_high: float,
) -> Literal[
    "inside_value",
    "above_value",
    "below_value",
    "accepting_above",
    "rejecting_above",
    "accepting_below",
    "rejecting_below",
    "unknown",
]:
    if close > value_high:
        return "accepting_above"
    if close < value_low:
        return "accepting_below"
    return "inside_value"


def _breakout_status(
    *,
    close: float,
    high: float,
    prior_high: float,
    prior_low: float,
) -> BreakoutStatus:
    if close > prior_high:
        return "breakout"
    if high > prior_high and close <= prior_high:
        return "failed_breakout"
    if close < prior_low:
        return "failed_breakout"
    return "none"


def _atr_percent(rows: Sequence[PriceRow]) -> float | None:
    ranges = [_number(row, "high") - _number(row, "low") for row in rows]
    close = _number(rows[-1], "close")
    if close <= 0:
        return None
    return mean(ranges) / close * 100


__all__ = ["MarketStructureFeatures"]
