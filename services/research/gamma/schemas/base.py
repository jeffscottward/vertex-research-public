"""Base schema contracts shared across the pipeline."""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from typing import Annotated, Any, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Confidence = Annotated[float, Field(ge=0.0, le=1.0)]
NonEmptyString = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
TickerSymbol = NonEmptyString
NonNegativeFloat = Annotated[float, Field(ge=0.0)]
PositiveFloat = Annotated[float, Field(gt=0.0)]
NonNegativeIntValue = Annotated[int, Field(ge=0)]
PositiveIntValue = Annotated[int, Field(gt=0)]


class SchemaModel(BaseModel):
    """Base model for hot-swappable module contracts."""

    model_config = ConfigDict(extra="forbid")

    def to_json_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible dict for storage, cache, and reports."""
        return self.model_dump(mode="json", round_trip=True)

    def to_json(self, *, indent: int | None = None) -> str:
        """Return a JSON string for storage, cache, and reports."""
        return self.model_dump_json(indent=indent, round_trip=True)

    def to_artifact_hash(self) -> str:
        """Return a deterministic SHA-256 hash of this schema artifact."""
        return artifact_hash(self)

    def to_input_hash(self) -> str:
        """Return this schema's deterministic input artifact hash."""
        return input_artifact_hash(self)

    def to_output_hash(self) -> str:
        """Return this schema's deterministic output artifact hash."""
        return output_artifact_hash(self)

    @classmethod
    def from_json(cls, payload: str | bytes | bytearray) -> Self:
        """Validate a JSON payload back into this schema."""
        return cls.model_validate_json(payload)


def canonical_artifact_json(payload: Any) -> str:
    """Return canonical JSON for structured input/output artifacts."""
    return json.dumps(
        _json_ready(payload),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def artifact_hash(payload: Any) -> str:
    """Return a deterministic SHA-256 hash for an artifact payload."""
    return hashlib.sha256(_artifact_bytes(payload)).hexdigest()


def input_artifact_hash(payload: Any) -> str:
    """Return a deterministic SHA-256 hash for a stage input artifact."""
    return artifact_hash(payload)


def output_artifact_hash(payload: Any) -> str:
    """Return a deterministic SHA-256 hash for a stage output artifact."""
    return artifact_hash(payload)


def _artifact_bytes(payload: Any) -> bytes:
    if isinstance(payload, bytes):
        return payload
    if isinstance(payload, bytearray):
        return bytes(payload)
    if isinstance(payload, str):
        return payload.encode("utf-8")
    return canonical_artifact_json(payload).encode("utf-8")


def _json_ready(payload: Any) -> Any:
    if isinstance(payload, BaseModel):
        return payload.model_dump(mode="json", round_trip=True)
    if isinstance(payload, dict):
        return {str(key): _json_ready(value) for key, value in payload.items()}
    if isinstance(payload, list | tuple):
        return [_json_ready(value) for value in payload]
    if isinstance(payload, datetime | date):
        return payload.isoformat()
    return payload


class SourceRef(SchemaModel):
    source_type: str
    title: str | None = None
    url: str | None = None
    timestamp: datetime | None = None
    excerpt: str | None = None
    confidence: Confidence | None = None
    raw: dict[str, Any] | None = None
