"""Internal trace encoding preparation, never an alternative canonical codec."""
from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any


def internal_value(value: Any, *, key: str = "") -> Any:
    """Keep nanosecond integers exact as decimal strings outside public schemas.

    Public records are never routed through this helper. Canonical bytes/hashes
    still come exclusively from the injected authoritative codec.
    """
    if is_dataclass(value) and not isinstance(value, type):
        return internal_value(asdict(value))
    if isinstance(value, dict):
        return {name: internal_value(item, key=name) for name, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [internal_value(item, key=key) for item in value]
    if key.endswith("_ns") and type(value) is int:
        return str(value)
    return value
