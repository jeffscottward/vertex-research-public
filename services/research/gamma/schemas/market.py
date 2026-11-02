"""Market regime schema contracts."""

from __future__ import annotations

from datetime import datetime

from gamma.schemas.base import Confidence, SchemaModel, SourceRef


class MarketRegime(SchemaModel):
    as_of: datetime
    regime_label: str
    confidence: Confidence
    evidence: list[str]
    source_refs: list[SourceRef]
    notes: str | None = None
