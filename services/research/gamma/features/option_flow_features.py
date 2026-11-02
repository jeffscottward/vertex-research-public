"""Option flow feature extraction from normalized QuantData snapshots."""

from __future__ import annotations

from collections import Counter
from datetime import date
from typing import Any, Literal

from gamma.schemas import OptionContractFlow, OptionFlowSnapshot
from gamma.schemas.base import (
    NonNegativeFloat,
    NonNegativeIntValue,
    SchemaModel,
    TickerSymbol,
)

FlowLabel = Literal["bullish", "bearish", "neutral", "volatility"]


class OptionFlowFeatureSnapshot(SchemaModel):
    ticker: TickerSymbol
    as_of: date
    call_premium: NonNegativeFloat
    put_premium: NonNegativeFloat
    call_put_premium_ratio: float | None = None
    ask_side_call_premium: NonNegativeFloat
    bid_side_put_premium: NonNegativeFloat
    unusual_call_volume: float | None = None
    unusual_put_volume: float | None = None
    sweep_count: NonNegativeIntValue
    block_count: NonNegativeIntValue
    open_interest_change: float | None = None
    open_interest_validated: bool
    contracts_with_open_interest: NonNegativeIntValue
    contracts_missing_open_interest: NonNegativeIntValue
    volume_exceeds_open_interest_count: NonNegativeIntValue
    repeated_strikes: list[float]
    repeated_expiries: list[date]
    short_dated_premium: NonNegativeFloat
    long_dated_premium: NonNegativeFloat
    short_dated_premium_pct: float | None = None
    long_dated_premium_pct: float | None = None
    short_dated_max_dte: NonNegativeIntValue
    source_contract_count: NonNegativeIntValue
    flow_label: FlowLabel
    raw: dict[str, Any]


class OptionFlowFeatures:
    """Compute option-flow features from cached normalized QuantData payloads."""

    def __init__(self, *, short_dated_max_dte: int = 45) -> None:
        if short_dated_max_dte < 0:
            raise ValueError("short_dated_max_dte must be non-negative")
        self._short_dated_max_dte = short_dated_max_dte

    def compute(self, snapshot: OptionFlowSnapshot) -> OptionFlowFeatureSnapshot:
        contracts = snapshot.notable_contracts
        call_premium = _provider_or_contract_premium(snapshot, "call")
        put_premium = _provider_or_contract_premium(snapshot, "put")
        ratio = snapshot.call_put_premium_ratio
        if ratio is None:
            ratio = _ratio_or_none(call_premium, put_premium)

        ask_side_call_premium = snapshot.ask_side_call_premium
        if ask_side_call_premium is None:
            ask_side_call_premium = _side_premium(contracts, right="call", side="ask")

        bid_side_put_premium = snapshot.bid_side_put_premium
        if bid_side_put_premium is None:
            bid_side_put_premium = _side_premium(contracts, right="put", side="bid")

        sweep_count = snapshot.sweep_count
        if sweep_count is None:
            sweep_count = _condition_count(contracts, "sweep")

        block_count = snapshot.block_count
        if block_count is None:
            block_count = _condition_count(contracts, "block")

        oi = _open_interest_counts(contracts)
        expiry_premiums = _duration_premiums(
            contracts,
            as_of=snapshot.as_of.date(),
            short_dated_max_dte=self._short_dated_max_dte,
        )

        return OptionFlowFeatureSnapshot(
            ticker=snapshot.ticker,
            as_of=snapshot.as_of.date(),
            call_premium=call_premium,
            put_premium=put_premium,
            call_put_premium_ratio=ratio,
            ask_side_call_premium=ask_side_call_premium,
            bid_side_put_premium=bid_side_put_premium,
            unusual_call_volume=snapshot.unusual_call_volume,
            unusual_put_volume=snapshot.unusual_put_volume,
            sweep_count=sweep_count,
            block_count=block_count,
            open_interest_change=snapshot.open_interest_change,
            open_interest_validated=(
                oi["with_open_interest"] == len(contracts)
                and oi["volume_exceeds_open_interest"] == 0
                and len(contracts) > 0
            ),
            contracts_with_open_interest=oi["with_open_interest"],
            contracts_missing_open_interest=oi["missing_open_interest"],
            volume_exceeds_open_interest_count=oi["volume_exceeds_open_interest"],
            repeated_strikes=_repeated_strikes(contracts),
            repeated_expiries=_repeated_expiries(contracts),
            short_dated_premium=expiry_premiums["short"],
            long_dated_premium=expiry_premiums["long"],
            short_dated_premium_pct=expiry_premiums["short_pct"],
            long_dated_premium_pct=expiry_premiums["long_pct"],
            short_dated_max_dte=self._short_dated_max_dte,
            source_contract_count=len(contracts),
            flow_label=_flow_label(
                call_premium=call_premium,
                put_premium=put_premium,
                ask_side_call_premium=ask_side_call_premium,
                bid_side_put_premium=bid_side_put_premium,
                unusual_call_volume=snapshot.unusual_call_volume,
                unusual_put_volume=snapshot.unusual_put_volume,
            ),
            raw=snapshot.raw,
        )


def _provider_or_contract_premium(
    snapshot: OptionFlowSnapshot,
    right: Literal["call", "put"],
) -> float:
    provider_value = (
        snapshot.total_call_premium if right == "call" else snapshot.total_put_premium
    )
    if provider_value is not None:
        return provider_value
    return sum(
        contract.premium
        for contract in snapshot.notable_contracts
        if contract.right == right
    )


def _side_premium(
    contracts: list[OptionContractFlow],
    *,
    right: Literal["call", "put"],
    side: Literal["ask", "bid"],
) -> float:
    return sum(
        contract.premium
        for contract in contracts
        if contract.right == right and contract.side == side
    )


def _ratio_or_none(call_premium: float, put_premium: float) -> float | None:
    if put_premium == 0:
        return None
    return call_premium / put_premium


def _condition_count(contracts: list[OptionContractFlow], needle: str) -> int:
    return sum(needle in _condition_text(contract) for contract in contracts)


def _condition_text(contract: OptionContractFlow) -> str:
    raw_condition = ""
    if isinstance(contract.raw, dict):
        raw_condition = " ".join(
            str(contract.raw.get(key) or "")
            for key in ("condition", "tradeCondition", "type")
        )
    return f"{contract.trade_condition or ''} {raw_condition}".casefold()


def _open_interest_counts(contracts: list[OptionContractFlow]) -> dict[str, int]:
    with_open_interest = 0
    missing_open_interest = 0
    volume_exceeds_open_interest = 0
    for contract in contracts:
        if contract.open_interest is None:
            missing_open_interest += 1
            continue
        with_open_interest += 1
        if contract.volume > contract.open_interest:
            volume_exceeds_open_interest += 1
    return {
        "with_open_interest": with_open_interest,
        "missing_open_interest": missing_open_interest,
        "volume_exceeds_open_interest": volume_exceeds_open_interest,
    }


def _duration_premiums(
    contracts: list[OptionContractFlow],
    *,
    as_of: date,
    short_dated_max_dte: int,
) -> dict[str, float | None]:
    short_premium = 0.0
    long_premium = 0.0
    for contract in contracts:
        dte = (contract.expiry - as_of).days
        if dte <= short_dated_max_dte:
            short_premium += contract.premium
        else:
            long_premium += contract.premium

    total = short_premium + long_premium
    return {
        "short": short_premium,
        "long": long_premium,
        "short_pct": short_premium / total if total else None,
        "long_pct": long_premium / total if total else None,
    }


def _repeated_strikes(contracts: list[OptionContractFlow]) -> list[float]:
    counts = Counter(contract.strike for contract in contracts)
    return sorted(strike for strike, count in counts.items() if count > 1)


def _repeated_expiries(contracts: list[OptionContractFlow]) -> list[date]:
    counts = Counter(contract.expiry for contract in contracts)
    return sorted(expiry for expiry, count in counts.items() if count > 1)


def _flow_label(
    *,
    call_premium: float,
    put_premium: float,
    ask_side_call_premium: float,
    bid_side_put_premium: float,
    unusual_call_volume: float | None,
    unusual_put_volume: float | None,
) -> FlowLabel:
    total_premium = call_premium + put_premium
    if total_premium == 0:
        return "neutral"

    call_share = call_premium / total_premium
    two_sided_unusual = (
        (unusual_call_volume or 0.0) >= 2.0
        and (unusual_put_volume or 0.0) >= 2.0
        and 0.4 <= call_share <= 0.6
    )
    if two_sided_unusual:
        return "volatility"

    bullish_side_premium = ask_side_call_premium + bid_side_put_premium
    if bullish_side_premium / total_premium >= 0.6:
        return "bullish"
    if call_share >= 0.6:
        return "bullish"
    if call_share <= 0.4:
        return "bearish"
    return "neutral"


__all__ = [
    "FlowLabel",
    "OptionFlowFeatureSnapshot",
    "OptionFlowFeatures",
]
