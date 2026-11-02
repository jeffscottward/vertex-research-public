"""Portfolio allocation schema contracts."""

from __future__ import annotations

from typing import Any

from pydantic import Field, model_validator

from gamma.schemas.base import NonNegativeFloat, SchemaModel, TickerSymbol
from gamma.schemas.options import OptionsStrategyIntent
from gamma.schemas.signals import TradeSetup


class RejectedTrade(SchemaModel):
    ticker: TickerSymbol
    reason: str
    stage: str
    setup: TradeSetup | None = None
    strategy_intent: OptionsStrategyIntent | None = None
    details: dict[str, Any] | None = None


class PortfolioAllocation(SchemaModel):
    allocation_id: str
    cash_available: NonNegativeFloat
    max_premium_at_risk: NonNegativeFloat
    max_trade_risk_pct: NonNegativeFloat
    max_theme_exposure_pct: NonNegativeFloat
    max_ticker_exposure_pct: NonNegativeFloat
    accepted_trades: list[OptionsStrategyIntent]
    rejected_trades: list[RejectedTrade]
    trade_sizes: dict[str, NonNegativeFloat] = Field(default_factory=dict)
    risk_summary: dict[str, Any] = Field(default_factory=dict)
    commentary: dict[str, dict[str, str]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_accepted_trade_liquidity(self) -> PortfolioAllocation:
        for trade in self.accepted_trades:
            if _has_failed_liquidity_check(trade.liquidity_checks):
                raise ValueError(
                    "accepted trades cannot include failed liquidity checks"
                )
            if trade.intent_id not in self.trade_sizes:
                raise ValueError("accepted trades require deterministic sizing")
        return self


def _has_failed_liquidity_check(value: Any) -> bool:
    if isinstance(value, bool):
        return not value
    if isinstance(value, dict):
        return any(_has_failed_liquidity_check(item) for item in value.values())
    if isinstance(value, list):
        return any(_has_failed_liquidity_check(item) for item in value)
    return False
