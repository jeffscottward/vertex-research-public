"""Options flow and strategy schema contracts."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal, get_args

from pydantic import Field, model_validator

from gamma.schemas.base import (
    Confidence,
    NonNegativeFloat,
    NonNegativeIntValue,
    PositiveFloat,
    PositiveIntValue,
    SchemaModel,
    TickerSymbol,
)

StrategyType = Literal[
    "long_call",
    "long_put",
    "call_debit_spread",
    "put_debit_spread",
    "call_credit_spread",
    "put_credit_spread",
    "calendar",
    "diagonal",
    "straddle",
    "strangle",
    "short_strangle",
    "iron_condor",
    "custom",
]
VALID_STRATEGY_TYPES = set(get_args(StrategyType))
QuoteTrustClass = Literal[
    "provider_backed",
    "synthetic",
    "offline",
    "untrusted",
    "missing",
]
QuoteReadiness = Literal["review_ready", "not_ready"]


class QuoteProvenance(SchemaModel):
    source: str
    observed_at: datetime | None = None
    fetched_at: datetime | None = None
    age_seconds: float | None = None
    provider_endpoint: str | None = None
    trace_id: str | None = None
    trust_class: QuoteTrustClass
    readiness: QuoteReadiness




class OptionContractFlow(SchemaModel):
    underlying: TickerSymbol
    expiry: date
    strike: PositiveFloat
    right: Literal["call", "put"]
    side: Literal["ask", "bid", "mid", "unknown"]
    premium: NonNegativeFloat
    volume: NonNegativeIntValue
    open_interest: NonNegativeIntValue | None = None
    implied_volatility: float | None = None
    delta: float | None = None
    gamma: float | None = None
    theta: float | None = None
    vega: float | None = None
    trade_condition: str | None = None
    raw: dict[str, Any] | None = None


class OptionFlowSnapshot(SchemaModel):
    ticker: TickerSymbol
    as_of: datetime
    total_call_premium: float | None = None
    total_put_premium: float | None = None
    call_put_premium_ratio: float | None = None
    unusual_call_volume: float | None = None
    unusual_put_volume: float | None = None
    sweep_count: int | None = None
    block_count: int | None = None
    ask_side_call_premium: float | None = None
    bid_side_put_premium: float | None = None
    open_interest_change: float | None = None
    notable_contracts: list[OptionContractFlow]
    raw: dict[str, Any]


class OptionLeg(SchemaModel):
    side: Literal["buy", "sell"]
    right: Literal["call", "put"]
    expiry: date
    strike: PositiveFloat
    quantity: PositiveIntValue
    limit_price: NonNegativeFloat | None = None


class OptionsStrategyIntent(SchemaModel):
    intent_id: str
    ticker: TickerSymbol
    strategy_type: StrategyType
    direction: Literal[
        "bullish",
        "bearish",
        "neutral",
        "vol_expansion",
        "vol_contraction",
    ]
    legs: list[OptionLeg] = Field(min_length=1)
    max_loss: NonNegativeFloat
    max_profit: NonNegativeFloat | None = None
    net_debit_or_credit: float
    breakevens: list[float]
    target_profit_pct: float
    stop_loss_pct: float
    dte: PositiveIntValue
    greeks: dict[str, Any]
    liquidity_checks: dict[str, Any]
    thesis: str
    invalidation: str
    confidence: Confidence

    @model_validator(mode="after")
    def validate_strategy_legs(self) -> OptionsStrategyIntent:
        _validate_strategy_legs(self.strategy_type, self.legs)
        return self


def _validate_strategy_legs(strategy_type: StrategyType, legs: list[OptionLeg]) -> None:
    if strategy_type == "custom":
        return

    if strategy_type == "long_call":
        _require(
            len(legs) == 1 and legs[0].side == "buy" and legs[0].right == "call",
            strategy_type,
        )
        return
    if strategy_type == "long_put":
        _require(
            len(legs) == 1 and legs[0].side == "buy" and legs[0].right == "put",
            strategy_type,
        )
        return

    if strategy_type in {
        "call_debit_spread",
        "put_debit_spread",
        "call_credit_spread",
        "put_credit_spread",
    }:
        _validate_vertical_spread(strategy_type, legs)
        return

    if strategy_type == "calendar":
        _validate_calendar(legs)
        return
    if strategy_type == "diagonal":
        _validate_diagonal(legs)
        return
    if strategy_type == "straddle":
        _validate_straddle(legs)
        return
    if strategy_type == "short_strangle":
        _validate_short_strangle(legs)
        return
    if strategy_type == "strangle":
        _validate_strangle(legs)
        return
    if strategy_type == "iron_condor":
        _validate_iron_condor(legs)


def _validate_vertical_spread(
    strategy_type: StrategyType,
    legs: list[OptionLeg],
) -> None:
    _require(len(legs) == 2, strategy_type)
    first, second = legs
    right = "call" if strategy_type.startswith("call_") else "put"
    _require(all(leg.right == right for leg in legs), strategy_type)
    _require(first.expiry == second.expiry, strategy_type)
    _require(first.quantity == second.quantity, strategy_type)
    _require({first.side, second.side} == {"buy", "sell"}, strategy_type)

    buy = next(leg for leg in legs if leg.side == "buy")
    sell = next(leg for leg in legs if leg.side == "sell")
    if strategy_type == "call_debit_spread":
        _require(buy.strike < sell.strike, strategy_type)
    elif strategy_type == "call_credit_spread":
        _require(sell.strike < buy.strike, strategy_type)
    elif strategy_type == "put_debit_spread":
        _require(sell.strike < buy.strike, strategy_type)
    elif strategy_type == "put_credit_spread":
        _require(buy.strike < sell.strike, strategy_type)


def _validate_calendar(legs: list[OptionLeg]) -> None:
    _require(len(legs) == 2, "calendar")
    near, far = sorted(legs, key=lambda leg: leg.expiry)
    _require({leg.side for leg in legs} == {"buy", "sell"}, "calendar")
    _require(near.expiry != far.expiry, "calendar")
    _require(near.right == far.right, "calendar")
    _require(near.strike == far.strike, "calendar")
    _require(near.quantity == far.quantity, "calendar")
    _require(near.side == "sell" and far.side == "buy", "calendar")


def _validate_diagonal(legs: list[OptionLeg]) -> None:
    _require(len(legs) == 2, "diagonal")
    near, far = sorted(legs, key=lambda leg: leg.expiry)
    _require({leg.side for leg in legs} == {"buy", "sell"}, "diagonal")
    _require(near.expiry != far.expiry, "diagonal")
    _require(near.right == far.right, "diagonal")
    _require(near.strike != far.strike, "diagonal")
    _require(near.quantity == far.quantity, "diagonal")
    _require(near.side == "sell" and far.side == "buy", "diagonal")


def _validate_straddle(legs: list[OptionLeg]) -> None:
    _require(len(legs) == 2, "straddle")
    _require(all(leg.side == "buy" for leg in legs), "straddle")
    _require({leg.right for leg in legs} == {"call", "put"}, "straddle")
    _require(_same_expiry(legs), "straddle")
    _require(_same_quantity(legs), "straddle")
    _require(legs[0].strike == legs[1].strike, "straddle")


def _validate_strangle(legs: list[OptionLeg]) -> None:
    _require(len(legs) == 2, "strangle")
    _require(all(leg.side == "buy" for leg in legs), "strangle")
    _require({leg.right for leg in legs} == {"call", "put"}, "strangle")
    _require(_same_expiry(legs), "strangle")
    _require(_same_quantity(legs), "strangle")
    _require(legs[0].strike != legs[1].strike, "strangle")


def _validate_short_strangle(legs: list[OptionLeg]) -> None:
    """Short strangle: sell one put and one call, same expiry and quantity.

    The put strike must sit strictly below the call strike. Distinct from the
    long ``strangle`` (both legs bought), whose validation is unchanged.
    """

    _require(len(legs) == 2, "short_strangle")
    _require(all(leg.side == "sell" for leg in legs), "short_strangle")
    _require({leg.right for leg in legs} == {"call", "put"}, "short_strangle")
    _require(_same_expiry(legs), "short_strangle")
    _require(_same_quantity(legs), "short_strangle")
    put = next(leg for leg in legs if leg.right == "put")
    call = next(leg for leg in legs if leg.right == "call")
    _require(put.strike < call.strike, "short_strangle")


def _validate_iron_condor(legs: list[OptionLeg]) -> None:
    _require(len(legs) == 4, "iron_condor")
    _require(_same_expiry(legs), "iron_condor")
    _require(_same_quantity(legs), "iron_condor")
    _require(sum(leg.right == "call" for leg in legs) == 2, "iron_condor")
    _require(sum(leg.right == "put" for leg in legs) == 2, "iron_condor")
    _require(sum(leg.side == "buy" for leg in legs) == 2, "iron_condor")
    _require(sum(leg.side == "sell" for leg in legs) == 2, "iron_condor")

    puts = sorted(
        (leg for leg in legs if leg.right == "put"),
        key=lambda leg: leg.strike,
    )
    calls = sorted(
        (leg for leg in legs if leg.right == "call"),
        key=lambda leg: leg.strike,
    )
    _require(puts[0].side == "buy" and puts[1].side == "sell", "iron_condor")
    _require(calls[0].side == "sell" and calls[1].side == "buy", "iron_condor")


def _same_expiry(legs: list[OptionLeg]) -> bool:
    return len({leg.expiry for leg in legs}) == 1


def _same_quantity(legs: list[OptionLeg]) -> bool:
    return len({leg.quantity for leg in legs}) == 1


def _require(condition: bool, strategy_type: str) -> None:
    if not condition:
        raise ValueError(f"{strategy_type} legs are internally inconsistent")
