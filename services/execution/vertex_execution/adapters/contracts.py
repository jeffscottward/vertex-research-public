"""Native authority port only; public schemas and canonical rules are not copied."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Protocol


class ContractAuthority(Protocol):
    """Implemented by vertex_contracts.ContractAuthority with a pinned bundle."""

    def validate(self, contract_name: str, payload: Any, schema_version: str = "1.0.0") -> bool: ...

    def encode(self, value: Any) -> bytes: ...

    def digest(self, value: Any) -> str: ...

    def epoch_ns(self, timestamp: str) -> int: ...


class AdapterContractError(ValueError):
    pass


def _bad_number(value: str) -> None:
    raise AdapterContractError("floating-point and nonfinite JSON numbers are forbidden")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise AdapterContractError("duplicate JSON key")
        result[key] = value
    return result


def decode_record(payload: bytes, maximum_bytes: int) -> dict[str, Any]:
    """Private wire framing only; never substitutes for public validation."""
    if type(payload) is not bytes or not 0 < len(payload) <= maximum_bytes:
        raise AdapterContractError("wire bytes exceed configured bounds")
    try:
        value = json.loads(
            payload.decode("utf-8"), parse_float=_bad_number, parse_constant=_bad_number,
            object_pairs_hook=_unique_object,
        )
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise AdapterContractError("invalid exact JSON record") from exc
    if type(value) is not dict:
        raise AdapterContractError("wire record must be an object")
    return value


def canonical_record(authority: ContractAuthority, value: Any, maximum_bytes: int) -> tuple[bytes, str]:
    """Capture using the authority, then prove bytes/digest and stable round-trip.

    SHA-256 here checks the supplied canonical bytes; it does not independently
    serialize or implement the public canonicalization profile.
    """
    encoded = authority.encode(value)
    captured = decode_record(encoded, maximum_bytes)
    digest = authority.digest(captured)
    if type(digest) is not str or hashlib.sha256(encoded).hexdigest() != digest:
        raise AdapterContractError("native canonical digest disagrees with encoded bytes")
    if authority.encode(captured) != encoded:
        raise AdapterContractError("native canonical bytes are not stable")
    return encoded, digest
