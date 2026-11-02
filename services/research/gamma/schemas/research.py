"""Research schema contracts."""

from __future__ import annotations

from typing import Annotated

from pydantic import Field

from gamma.schemas.base import (
    Confidence,
    NonNegativeFloat,
    SchemaModel,
    SourceRef,
    TickerSymbol,
)


class CandidateCompany(SchemaModel):
    ticker: TickerSymbol
    company_name: str | None = None
    theme_ids: list[str]
    why_it_fits: str
    discovery_score: float
    liquidity_score: float | None = None
    market_cap: NonNegativeFloat | None = None
    avg_volume: NonNegativeFloat | None = None
    options_available: bool | None = None
    options_volume: NonNegativeFloat | None = None
    options_open_interest: NonNegativeFloat | None = None
    is_etf: bool | None = None
    score_signals: dict[
        str,
        Annotated[float, Field(ge=0.0, le=1.0)],
    ] | None = None
    notes: str | None = None


class ResearchBrief(SchemaModel):
    ticker: TickerSymbol
    themes: list[str]
    bull_case: str
    bear_case: str
    key_catalysts: list[str]
    key_risks: list[str]
    what_would_change_our_mind: list[str]
    confidence: Confidence
    source_refs: list[SourceRef]
