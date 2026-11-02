"""Internal Gamma feature/setup schemas; execution envelope intentionally omitted."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from gamma.schemas.base import Confidence, SchemaModel, TickerSymbol
from gamma.schemas.options import OptionFlowSnapshot, StrategyType
from gamma.schemas.research import ResearchBrief


class MarketStructureSnapshot(SchemaModel):
    ticker: TickerSymbol
    as_of: datetime
    timeframe: str
    trend_label: Literal["uptrend", "downtrend", "range", "transition", "unknown"]
    vwap_relation: Literal[
        "above_vwap",
        "below_vwap",
        "reclaiming_vwap",
        "rejecting_vwap",
        "unknown",
    ]
    value_area_relation: Literal[
        "inside_value",
        "above_value",
        "below_value",
        "accepting_above",
        "rejecting_above",
        "accepting_below",
        "rejecting_below",
        "unknown",
    ]
    breakout_status: Literal[
        "pre_breakout",
        "breakout",
        "failed_breakout",
        "retest",
        "none",
    ]
    relative_volume: float | None = None
    atr_percent: float | None = None
    support_levels: list[float]
    resistance_levels: list[float]
    notes: str | None = None
    raw: dict[str, Any] | None = None


class VolatilitySnapshot(SchemaModel):
    ticker: TickerSymbol
    as_of: datetime
    iv_rank: float | None = None
    iv_percentile: float | None = None
    front_iv: float | None = None
    back_iv: float | None = None
    term_structure_label: Literal["contango", "backwardation", "flat", "unknown"]
    skew_label: Literal["call_skew", "put_skew", "balanced", "unknown"]
    iv_change_label: Literal["expanding", "contracting", "stable", "unknown"] = (
        "unknown"
    )
    event_risk: list[str]
    notes: str | None = None
    raw: dict[str, Any] | None = None


class TradeSetup(SchemaModel):
    setup_id: str
    ticker: TickerSymbol
    direction: Literal[
        "bullish",
        "bearish",
        "neutral",
        "vol_expansion",
        "vol_contraction",
    ]
    thesis: str
    research_brief: ResearchBrief | None = None
    flow_snapshot: OptionFlowSnapshot | None = None
    market_structure: MarketStructureSnapshot | None = None
    volatility: VolatilitySnapshot | None = None
    setup_score: float
    score_components: dict[str, float] = Field(default_factory=dict)
    confidence: Confidence
    invalidation: str
    target_window: str
    preferred_strategy_types: list[StrategyType]
    rejection_reasons: list[str]
