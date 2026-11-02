"""Internal immutable envelopes, not duplicate Vertex public schemas.

Public shape/canonical identity belongs to packages/api/src/contracts/vertex.civet
and packages/shared/src/vertex/index.civet. There is deliberately no native
validator or canonicalization fallback here. Nothing opens files or a transport.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol


class PortUnavailable(RuntimeError):
    """Required authoritative integration has not been injected."""


class ContractRejected(ValueError):
    """The injected public authority rejected a record or inconsistent codec."""


class ContractValidator(Protocol):
    def validate(
        self, contract_name: str, payload: Mapping[str, Any],
        schema_version: str = "1.0.0",
    ) -> bool: ...


class CanonicalCodec(Protocol):
    def encode(self, value: Any) -> bytes: ...
    def digest(self, value: Any) -> str: ...


def require_hash(value: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("lowercase SHA256 required")
    return value


def require_id(value: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", value) is None:
        raise ValueError("bounded immutable identity required")
    return value


def utc(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timezone-aware timestamp required")
    return value.astimezone(UTC)


def _pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _constant(_: str) -> None:
    raise ValueError("nonfinite JSON value")


def decode_json(payload: bytes) -> Any:
    return json.loads(payload, object_pairs_hook=_pairs, parse_constant=_constant)


def _same_json(left: Any, right: Any) -> bool:
    # Python equality otherwise equates True, 1 and 1.0. Canonical boundaries
    # may reorder keys but must never coerce JSON scalar types or values.
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(_same_json(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(_same_json(a, b) for a, b in zip(left, right, strict=True))
    return left == right


def capture_json(value: Any, *, maximum_bytes: int = 8_000_000) -> bytes:
    """Internal lossless JSON capture only; NEVER a Vertex canonical identity.

    A detached bounded input snapshot permits rejected attempts to be retained
    even when the public validator/codec is absent. Floats here remain native
    evidence and are not promoted into public exact-decimal values.
    """
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > maximum_bytes:
        raise ValueError("input byte budget exceeded")
    decode_json(raw)
    return raw


@dataclass(frozen=True)
class Artifact:
    contract_name: str
    payload_bytes: bytes
    digest: str

    def __post_init__(self) -> None:
        if not isinstance(self.payload_bytes, bytes):
            raise ValueError("artifact bytes must be immutable")
        require_hash(self.digest)
        if hashlib.sha256(self.payload_bytes).hexdigest() != self.digest:
            raise ValueError("artifact bytes and canonical digest disagree")

    def decode(self) -> Any:
        """Return a fresh graph; callers cannot mutate stored lineage."""
        return decode_json(self.payload_bytes)


class PublicBoundary:
    def __init__(
        self, *, validator: ContractValidator | None, codec: CanonicalCodec | None,
        maximum_bytes: int = 8_000_000,
    ) -> None:
        if type(maximum_bytes) is not int or not 1 <= maximum_bytes <= 64_000_000:
            raise ValueError("invalid boundary byte budget")
        self.validator = validator
        self.codec = codec
        self.maximum_bytes = maximum_bytes

    @property
    def missing_ports(self) -> tuple[str, ...]:
        return tuple(name for name, port in (
            ("authoritative-contract-validator", self.validator),
            ("vertex-canonical-codec", self.codec),
        ) if port is None)

    def internal(self, name: str, value: Any) -> Artifact:
        """Seal an internal plan with the injected codec; no public validation claim."""
        if self.codec is None:
            raise PortUnavailable("vertex-canonical-codec")
        detached = decode_json(capture_json(value, maximum_bytes=self.maximum_bytes))
        before = capture_json(detached, maximum_bytes=self.maximum_bytes)
        encoded = self.codec.encode(detached)
        digest = self.codec.digest(detached)
        if not isinstance(encoded, bytes) or len(encoded) > self.maximum_bytes:
            raise ContractRejected("codec byte budget or type mismatch")
        if capture_json(detached, maximum_bytes=self.maximum_bytes) != before:
            raise ContractRejected("codec mutated its input")
        if not _same_json(decode_json(encoded), decode_json(before)):
            raise ContractRejected("codec changed artifact values")
        return Artifact(name, encoded, digest)

    def public(self, name: str, value: Mapping[str, Any]) -> Artifact:
        if self.missing_ports:
            raise PortUnavailable(",".join(self.missing_ports))
        detached = decode_json(capture_json(value, maximum_bytes=self.maximum_bytes))
        before = capture_json(detached, maximum_bytes=self.maximum_bytes)
        if self.validator is None or self.validator.validate(name, detached, schema_version="1.0.0") is not True:
            raise ContractRejected("authoritative contract rejected " + name)
        if capture_json(detached, maximum_bytes=self.maximum_bytes) != before:
            raise ContractRejected("validator mutated input")
        return self.internal(name, detached)


@dataclass(frozen=True)
class ResourceBudget:
    """Requested sandbox limits; enforcing isolation belongs to the engine host.

    The planner itself never starts a sandbox/process or permits network access.
    An engine result must report matching limits and a pinned isolation receipt.
    """
    maximum_input_bytes: int = 8_000_000
    maximum_events: int = 250_000
    maximum_candidates: int = 512
    maximum_folds: int = 64
    maximum_trials: int = 256
    maximum_memory_bytes: int = 512_000_000
    maximum_cpu_ms: int = 30_000
    maximum_wall_ms: int = 60_000
    network_allowed: bool = False
    execution_allowed: bool = False

    def __post_init__(self) -> None:
        for value, ceiling in (
            (self.maximum_input_bytes, 64_000_000), (self.maximum_events, 2_000_000),
            (self.maximum_candidates, 10_000), (self.maximum_folds, 256),
            (self.maximum_trials, 10_000), (self.maximum_memory_bytes, 8_000_000_000),
            (self.maximum_cpu_ms, 3_600_000), (self.maximum_wall_ms, 3_600_000),
        ):
            if type(value) is not int or not 1 <= value <= ceiling:
                raise ValueError("invalid sandbox resource budget")
        if self.network_allowed is not False or self.execution_allowed is not False:
            raise ValueError("research plans forbid network and execution authority")
