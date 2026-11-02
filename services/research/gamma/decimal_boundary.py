"""Explicit conversion of Gamma binary64 research values, never execution prices.

Gamma source hashes continue to cover original native JSON. A projected payload
has a NEW identity from the injected Vertex canonical codec. No projection is a
claim that a source float was an exact market observation. Callers must enumerate
field patterns and tolerances; there is intentionally no default money policy.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN, localcontext
from fnmatch import fnmatchcase
from types import MappingProxyType
from typing import Any

from pydantic import BaseModel

MAX_SAFE_INTEGER = 9_007_199_254_740_991


def _decimal(value: str, label: str) -> Decimal:
    if type(value) is not str or not value or len(value) > 128:
        raise ValueError(f"{label} must be a bounded explicit decimal string")
    try:
        number = Decimal(value)
    except InvalidOperation as error:
        raise ValueError(f"invalid {label}") from error
    if not number.is_finite():
        raise ValueError(f"{label} must be finite")
    return number


def _plain(value: Decimal) -> str:
    if value.is_zero():
        return "0"
    return format(value, "f").rstrip("0").rstrip(".") if value.as_tuple().exponent < 0 else format(value, "f")


@dataclass(frozen=True, slots=True)
class DecimalFieldRule:
    """Path uses slash-separated keys/indexes; wildcard matching is explicit."""

    path_pattern: str
    quantum: str
    maximum_absolute_error: str

    def __post_init__(self) -> None:
        if not self.path_pattern.startswith("/") or len(self.path_pattern) > 256:
            raise ValueError("a bounded absolute field pattern is required")
        quantum = _decimal(self.quantum, "quantum")
        tolerance = _decimal(self.maximum_absolute_error, "maximum_absolute_error")
        if quantum <= 0 or tolerance < 0:
            raise ValueError("quantum must be positive and tolerance nonnegative")
        if quantum.normalize().as_tuple().digits != (1,) or not -18 <= quantum.adjusted() <= 18:
            raise ValueError("quantum must be a power of ten between 1e-18 and 1e18")


@dataclass(frozen=True, slots=True)
class FloatDecimalPolicy:
    policy_id: str
    version: str
    rules: tuple[DecimalFieldRule, ...]
    basis: str = "binary64-shortest-roundtrip-decimal"
    rounding: str = "ROUND_HALF_EVEN"

    def __post_init__(self) -> None:
        if not self.policy_id or not self.version or len(self.policy_id) > 160:
            raise ValueError("conversion policy requires a stable id and version")
        if self.basis != "binary64-shortest-roundtrip-decimal" or self.rounding != "ROUND_HALF_EVEN":
            raise ValueError("unsupported conversion policy")
        if type(self.rules) is not tuple or not self.rules or len(self.rules) > 256:
            raise ValueError("conversion policy requires explicit bounded immutable field rules")
        if any(not isinstance(rule, DecimalFieldRule) for rule in self.rules):
            raise ValueError("invalid decimal field rule")
        if len({rule.path_pattern for rule in self.rules}) != len(self.rules):
            raise ValueError("duplicate conversion field rule")


@dataclass(frozen=True, slots=True)
class ConversionObservation:
    path: str
    binary64_repr: str
    decimal_value: str
    absolute_error: str
    quantum: str


@dataclass(frozen=True, slots=True)
class DecimalProjection:
    payload: Any
    policy_id: str
    policy_version: str
    basis: str
    rounding: str
    observations: tuple[ConversionObservation, ...]


def project_native(value: Any, policy: FloatDecimalPolicy) -> DecimalProjection:
    """Detach/project all floats with auditable, non-overlapping field policies.

    The error is measured against the shortest round-trip decimal spelling,
    NOT the real economic value or the full binary expansion. Currency/tick
    suitability needs the public validator and instrument identity separately.
    """
    if not isinstance(policy, FloatDecimalPolicy):
        raise ValueError("explicit float conversion policy unavailable")
    observations: list[ConversionObservation] = []
    active: set[int] = set()
    nodes = 0

    def visit(item: Any, path: str, depth: int) -> Any:
        nonlocal nodes
        nodes += 1
        if depth > 48 or nodes > 100_000:
            raise ValueError("conversion graph exceeds bounds")
        if item is None or type(item) in (str, bool):
            return item
        if type(item) is int:
            if abs(item) > MAX_SAFE_INTEGER:
                raise ValueError("unsafe public integer; caller must use a typed decimal field")
            return item
        if type(item) is float:
            if not math.isfinite(item):
                raise ValueError("nonfinite native float")
            matches = [rule for rule in policy.rules if fnmatchcase(path, rule.path_pattern)]
            if len(matches) != 1:
                raise ValueError(f"float field needs exactly one explicit policy: {path}")
            rule = matches[0]
            number = Decimal(repr(item))
            with localcontext() as context:
                context.prec = 360
                quantum = Decimal(rule.quantum).normalize()
                converted = number.quantize(quantum, rounding=ROUND_HALF_EVEN)
                error = abs(number - converted)
                if error > Decimal(rule.maximum_absolute_error):
                    raise ValueError(f"float conversion exceeds error budget: {path}")
            rendered = _plain(converted)
            if len(rendered) > 128:
                raise ValueError("projected decimal exceeds public bounds")
            observations.append(ConversionObservation(path, repr(item), rendered, _plain(error), rule.quantum))
            return rendered
        if type(item) is datetime:
            if item.tzinfo is None or item.utcoffset() is None:
                raise ValueError("native timestamp requires explicit timezone")
            return item.astimezone(UTC).isoformat().replace("+00:00", "Z")
        if type(item) is date:
            return item.isoformat()
        identity = id(item)
        if identity in active:
            raise ValueError("cyclic conversion graph")
        active.add(identity)
        try:
            if isinstance(item, BaseModel):
                return visit(item.model_dump(mode="python"), path, depth + 1)
            if isinstance(item, Mapping):
                if any(type(key) is not str for key in item):
                    raise ValueError("conversion object keys must be strings")
                # Escape path segments so an embedded slash cannot select another field's rule.
                return MappingProxyType({key: visit(child, path + "/" + key.replace("~", "~0").replace("/", "~1"), depth + 1) for key, child in item.items()})
            if isinstance(item, (tuple, list)):
                return tuple(visit(child, f"{path}/{index}", depth + 1) for index, child in enumerate(item))
            raise ValueError("unsupported conversion value")
        finally:
            active.remove(identity)

    payload = visit(value, "", 0)
    return DecimalProjection(payload, policy.policy_id, policy.version, policy.basis, policy.rounding, tuple(observations))


def json_value(value: Any) -> Any:
    """Produce a detached JSON graph for the authoritative codec; no encoding here."""
    if isinstance(value, Mapping):
        return {key: json_value(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [json_value(item) for item in value]
    return value
