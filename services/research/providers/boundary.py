"""Fail-closed boundary utilities; public acceptance ALWAYS uses the injected validator."""
from __future__ import annotations

import hashlib
import json
import re
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlsplit

from .ports import CanonicalCodec, Content, RightRequest, RightsDecision, RightsPort, ValidatedRecord, Validator


class BoundaryError(ValueError):
    pass


_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}")
_DIGEST = re.compile(r"[0-9a-f]{64}")
_TIME = re.compile(r"([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\.([0-9]{1,9}))?(Z|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))")


def identifier(value: Any) -> str:
    if not isinstance(value, str) or _ID.fullmatch(value) is None:
        raise BoundaryError("invalid-identity")
    return value


def epoch_ns(value: str) -> int:
    match = _TIME.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise BoundaryError("invalid-timestamp")
    year, month, day, hour, minute, second = map(int, match.group(1, 2, 3, 4, 5, 6))
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    lengths = (31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    if day > lengths[month - 1]:
        raise BoundaryError("invalid-calendar-date")
    previous = year - 1
    days = 365 * previous + previous // 4 - previous // 100 + previous // 400 - 719162
    days += sum(lengths[:month - 1]) + day - 1
    offset = 0 if match.group(8) == "Z" else (int(match.group(10)) * 3600 + int(match.group(11)) * 60) * (-1 if match.group(9) == "-" else 1)
    return ((days * 86400 + hour * 3600 + minute * 60 + second - offset) * 1_000_000_000
            + int((match.group(7) or "").ljust(9, "0")))


def exact_decimal(value: Any, *, nonnegative: bool = False) -> str:
    # Reject binary floats even when integral: their original precision is lost.
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        raise BoundaryError("decimal-needs-exact-input")
    text = str(value)
    if len(text) > 128 or re.fullmatch(r"-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?", text) is None:
        raise BoundaryError("invalid-decimal")
    try:
        number = Decimal(text)
    except InvalidOperation as error:
        raise BoundaryError("invalid-decimal") from error
    if not number.is_finite() or number.adjusted() > 29 or (number != 0 and number.as_tuple().exponent < -128):
        raise BoundaryError("decimal-out-of-bounds")
    if nonnegative and number < 0:
        raise BoundaryError("negative-value")
    canonical = format(number, "f")
    if "." in canonical:
        canonical = canonical.rstrip("0").rstrip(".")
    if number == 0:
        canonical = "0"
    if re.fullmatch(r"(?:0|-?(?:[1-9][0-9]{0,29}(?:\.[0-9]{0,17}[1-9])?|0\.[0-9]{0,17}[1-9]))", canonical) is None:
        raise BoundaryError("decimal-out-of-bounds")
    return canonical


def public_uri(value: str) -> str:
    uri = urlsplit(value)
    if (not isinstance(value, str) or len(value) > 2048 or uri.scheme != "https" or not uri.hostname
            or uri.username or uri.password or uri.query or uri.fragment
            or any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in value)):
        raise BoundaryError("source-uri-needs-public-canonical-locator")
    return value


def plain_text(value: str, maximum: int = 2000) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise BoundaryError("invalid-bounded-text")
    return value


def parse_json(data: bytes, *, maximum_bytes: int = 2_000_000, maximum_nodes: int = 100_000, maximum_depth: int = 24) -> Any:
    if not isinstance(data, bytes) or len(data) > maximum_bytes:
        raise BoundaryError("response-byte-budget")
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise BoundaryError("duplicate-json-key")
            result[key] = value
        return result
    def reject_constant(value: str) -> None:
        raise BoundaryError("nonfinite-json-number")
    try:
        parsed = json.loads(data.decode("utf-8", errors="strict"), parse_float=Decimal, object_pairs_hook=pairs, parse_constant=reject_constant)
    except (UnicodeError, ValueError, RecursionError) as error:
        raise BoundaryError("invalid-json") from error
    count = 0
    def clean(value: Any, depth: int) -> Any:
        nonlocal count
        count += 1
        if count > maximum_nodes or depth > maximum_depth:
            raise BoundaryError("response-structure-budget")
        if isinstance(value, Decimal):
            return exact_decimal(value)
        if isinstance(value, int) and not isinstance(value, bool) and abs(value) > 9_007_199_254_740_991:
            return exact_decimal(value)
        if isinstance(value, dict):
            return {key: clean(child, depth + 1) for key, child in value.items()}
        if isinstance(value, list):
            return [clean(child, depth + 1) for child in value]
        if isinstance(value, str) and any(0xD800 <= ord(c) <= 0xDFFF for c in value):
            raise BoundaryError("invalid-unicode")
        return value
    return clean(parsed, 0)


def raw_sha256(data: bytes) -> str:
    """Raw source identity is not canonical artifact identity."""
    if not isinstance(data, bytes):
        raise BoundaryError("raw-hash-needs-bytes")
    return hashlib.sha256(data).hexdigest()


class Boundary:
    def __init__(self, validator: Validator | None, codec: CanonicalCodec | None):
        self.validator = validator
        self.codec = codec

    def require(self) -> None:
        if self.validator is None or self.codec is None:
            raise BoundaryError("authoritative-contract-runtime-unavailable")

    def content(self, data: bytes, media_type: str) -> Content:
        self.require()
        if not isinstance(data, bytes):
            raise BoundaryError("content-must-be-immutable-bytes")
        return Content(data, raw_sha256(data), media_type)

    def encode(self, value: Any) -> bytes:
        self.require()
        encoded = self.codec.encode(value)
        if not isinstance(encoded, bytes):
            raise BoundaryError("invalid-codec-bytes")
        return encoded

    def record(self, contract_name: str, value: dict[str, Any]) -> ValidatedRecord:
        self.require()
        data = self.encode(value)
        detached = json.loads(data)
        if not isinstance(detached, dict) or self.validator.validate(contract_name, detached, schema_version="1.0.0") is not True:
            raise BoundaryError("public-contract-rejected")
        if self.encode(detached) != data:
            raise BoundaryError("validator-mutated-payload")
        digest = self.codec.digest(json.loads(data))
        if not isinstance(digest, str) or _DIGEST.fullmatch(digest) is None or digest != raw_sha256(data):
            raise BoundaryError("canonical-codec-digest-mismatch")
        return ValidatedRecord(contract_name, data, digest)

    def recheck(self, record: ValidatedRecord) -> dict[str, Any]:
        value = record.decode()
        checked = self.record(record.contract_name, value)
        if checked != record:
            raise BoundaryError("immutable-record-mismatch")
        return value


def authorize(port: RightsPort | None, request: RightRequest) -> RightsDecision:
    if port is None:
        raise BoundaryError("rights-port-unavailable")
    decision = port.decide(request)
    if (decision.scope_id != request.scope_id or decision.policy_id != request.policy_id
            or decision.operation != request.operation or decision.status != "granted"
            or decision.checked_at != request.evaluated_at or decision.expires_at is None
            or epoch_ns(decision.expires_at) <= epoch_ns(request.evaluated_at)
            or set(decision.source_ids) != set(request.source_ids) or not decision.revision):
        raise BoundaryError("rights-denied-expired-or-revoked")
    return decision
