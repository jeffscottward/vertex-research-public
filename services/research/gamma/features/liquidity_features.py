"""Liquidity feature extraction from stock rows and QuantData option chains."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime
from statistics import mean, median
from typing import Any

from gamma.schemas.base import NonNegativeFloat, SchemaModel, TickerSymbol

MarketRow = Mapping[str, Any]
OptionRow = Mapping[str, Any]


class LiquidityFeatureSnapshot(SchemaModel):
    ticker: TickerSymbol
    as_of: datetime
    stock_avg_volume: NonNegativeFloat | None = None
    stock_relative_volume: float | None = None
    option_contract_count: int
    option_total_open_interest: NonNegativeFloat
    option_total_volume: NonNegativeFloat
    median_bid_ask_spread_pct: float | None = None
    minimum_viable_contract_count: int
    passes_minimum_contract_filters: bool
    raw: dict[str, Any]


class LiquidityFeatures:
    """Compute stock and option-chain liquidity features."""

    def __init__(
        self,
        *,
        min_open_interest: int = 100,
        min_option_volume: int = 10,
        max_spread_pct: float = 0.2,
    ) -> None:
        self._min_open_interest = min_open_interest
        self._min_option_volume = min_option_volume
        self._max_spread_pct = max_spread_pct

    def compute(
        self,
        *,
        ticker: str,
        stock_rows: Sequence[MarketRow] | None = None,
        option_chain: Sequence[OptionRow] | None = None,
        as_of: datetime | None = None,
        option_totals: Mapping[str, float] | None = None,
    ) -> LiquidityFeatureSnapshot:
        """``option_totals`` ({"volume": .., "open_interest": ..}) supplies
        ticker-level totals from dedicated provider endpoints when chain rows
        do not carry per-contract volume/OI; they take precedence over row
        sums when the row sums are zero."""

        stock = _stock_liquidity(stock_rows or ())
        option = _option_liquidity(
            option_chain or (),
            min_open_interest=self._min_open_interest,
            min_option_volume=self._min_option_volume,
            max_spread_pct=self._max_spread_pct,
        )
        if option_totals:
            if not option["volume"] and option_totals.get("volume"):
                option["volume"] = float(option_totals["volume"])
            if not option["open_interest"] and option_totals.get("open_interest"):
                option["open_interest"] = float(option_totals["open_interest"])
        return LiquidityFeatureSnapshot(
            ticker=ticker.upper(),
            as_of=_resolve_as_of(
                explicit=as_of,
                stock_as_of=stock["as_of"],
                option_as_of=option["as_of"],
            ),
            stock_avg_volume=stock["avg_volume"],
            stock_relative_volume=stock["relative_volume"],
            option_contract_count=option["contract_count"],
            option_total_open_interest=option["open_interest"],
            option_total_volume=option["volume"],
            median_bid_ask_spread_pct=option["median_spread_pct"],
            minimum_viable_contract_count=option["viable_count"],
            passes_minimum_contract_filters=option["viable_count"] > 0,
            raw={
                "min_open_interest": self._min_open_interest,
                "min_option_volume": self._min_option_volume,
                "max_spread_pct": self._max_spread_pct,
            },
        )


def _stock_liquidity(rows: Sequence[MarketRow]) -> dict[str, Any]:
    ordered = sorted(rows, key=_row_datetime)
    if not ordered:
        return {"as_of": None, "avg_volume": None, "relative_volume": None}
    volumes = [
        v for row in ordered if (v := row.get("volume")) is not None
    ]
    avg_volume = mean(float(v) for v in volumes) if volumes else None
    return {
        "as_of": _row_datetime(ordered[-1]),
        "avg_volume": avg_volume,
        "relative_volume": (
            float(volumes[-1]) / avg_volume if volumes and avg_volume else None
        ),
    }


def _option_liquidity(
    rows: Sequence[OptionRow],
    *,
    min_open_interest: int,
    min_option_volume: int,
    max_spread_pct: float,
) -> dict[str, Any]:
    spreads = [
        spread
        for row in rows
        if (spread := _spread_pct(row)) is not None
    ]
    # Unknown values pass their threshold (matching the long-standing spread
    # convention): providers that omit per-contract volume/bid/ask should not
    # zero out viability when the data they DO provide clears the bar.
    viable_count = sum(
        _at_least(row, ("open_interest", "openInterest", "oi"), min_open_interest)
        and _at_least(row, ("volume", "option_volume"), min_option_volume)
        and (_spread_pct(row) is None or _spread_pct(row) <= max_spread_pct)
        for row in rows
    )
    return {
        "as_of": _latest_row_datetime(rows),
        "contract_count": len(rows),
        "open_interest": sum(
            _number_or_zero(row, "open_interest", "openInterest", "oi")
            for row in rows
        ),
        "volume": sum(_number_or_zero(row, "volume", "option_volume") for row in rows),
        "median_spread_pct": median(spreads) if spreads else None,
        "viable_count": viable_count,
    }


def _resolve_as_of(
    *,
    explicit: datetime | None,
    stock_as_of: datetime | None,
    option_as_of: datetime | None,
) -> datetime:
    if explicit is not None:
        return explicit if explicit.tzinfo else explicit.replace(tzinfo=UTC)
    if stock_as_of is not None:
        return stock_as_of
    if option_as_of is not None:
        return option_as_of
    raise ValueError(
        "Liquidity features require stock row timestamps, option-chain timestamps, "
        "or explicit as_of"
    )


def _latest_row_datetime(rows: Sequence[Mapping[str, Any]]) -> datetime | None:
    timestamps = []
    for row in rows:
        if any(key in row for key in ("datetime", "timestamp", "date")):
            timestamps.append(_row_datetime(row))
    return max(timestamps) if timestamps else None


def _row_datetime(row: MarketRow) -> datetime:
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
    raise ValueError("Market rows require date, timestamp, or datetime")


def _at_least(row: Mapping[str, Any], keys: Sequence[str], minimum: float) -> bool:
    """True when the first present key clears ``minimum``; unknown passes."""

    for key in keys:
        value = row.get(key)
        if value is not None:
            return float(value) >= minimum
    return True


def _number(row: Mapping[str, Any], key: str) -> float:
    value = row.get(key)
    if value is None:
        raise ValueError(f"row is missing {key}")
    return float(value)


def _number_or_zero(row: Mapping[str, Any], *keys: str) -> float:
    for key in keys:
        value = row.get(key)
        if value is None:
            continue
        try:
            return max(float(value), 0.0)
        except (TypeError, ValueError):
            continue
    return 0.0


def _spread_pct(row: OptionRow) -> float | None:
    bid = _number_or_zero(row, "bid", "bid_price")
    ask = _number_or_zero(row, "ask", "ask_price")
    if bid <= 0 or ask <= 0:
        return None
    mid = (bid + ask) / 2
    return (ask - bid) / mid if mid else None


__all__ = ["LiquidityFeatureSnapshot", "LiquidityFeatures"]
