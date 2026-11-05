"""Market regime schema contracts."""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from gamma.schemas.base import Confidence, SchemaModel, SourceRef


class MarketRegime(SchemaModel):
    as_of: datetime
    regime_label: str
    confidence: Confidence
    evidence: list[str]
    source_refs: list[SourceRef]
    notes: str | None = None


SectorQuadrant = Literal["leading", "weakening", "lagging", "improving"]
SectorSymbol = Annotated[str, StringConstraints(pattern=r"^[A-Z0-9][A-Z0-9.\-]{0,15}$")]
SectorName = Annotated[str, StringConstraints(max_length=80)]
FiniteFloat = Annotated[float, Field(allow_inf_nan=False)]


class _SectorRotationModel(SchemaModel):
    """Accepts the camelCase keys of the TypeScript contract and the snake_case names."""

    model_config = ConfigDict(
        extra="forbid", alias_generator=to_camel, populate_by_name=True, frozen=True)


class SectorRotationTransition(_SectorRotationModel):
    """One quadrant change of one symbol on one date."""

    symbol: SectorSymbol
    name: SectorName | None
    date: date
    from_quadrant: SectorQuadrant = Field(alias="from")
    to_quadrant: SectorQuadrant = Field(alias="to")


class SectorRotationSector(_SectorRotationModel):
    """Current quadrant of one sector vs the benchmark (relative strength and momentum)."""

    symbol: SectorSymbol
    name: SectorName | None
    quadrant: SectorQuadrant
    ratio: FiniteFloat
    momentum: FiniteFloat
    date: date
    since: date
    periods: Annotated[int, Field(ge=1)]


class SectorRotationSnapshot(_SectorRotationModel):
    """Versioned sector rotation input (mirrors SectorRotationSnapshotSchema in packages/api).

    Research data for the regime desk, not an instruction. Both sides parse the shared
    fixture packages/api/src/fixtures/sector-rotation-snapshot.v1.json.
    """

    schema_version: Literal[1]
    as_of: date
    previous_date: date | None
    timeframe: Literal["daily", "weekly"]
    benchmark: SectorSymbol
    sectors: list[SectorRotationSector]
    changes: list[SectorRotationTransition]
    recent_transitions: Annotated[list[SectorRotationTransition], Field(max_length=20)]
