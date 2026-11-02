"""Immutable v1 IBKR history bytes, not a mounted broker connection or dataset.

Concrete same-image binding source lives in services/ibkr-history/nautilus and
opt-in host lifecycle composition; it is NOT built, installed or activated.
Default stays unavailable. The ordinary opaque Python historical constructor
cannot supply its Rust Arc; no second extension/client registry is a substitute.

The trusted owner starts once under explicit current reviewed authority, then
reuses its native runtime/client, maps cancellation to the native token and joins
retained futures. Requests never select endpoints/client IDs or create per-job
clients. Acknowledging a real immutable stage releases retained evidence only;
neither Python cancellation nor local cancel send is a broker acknowledgment.
"""
from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass
from typing import Any, Protocol

from .ports import Content

SCHEMA_VERSION = "1.0.0"
MAX_REQUEST_BYTES = 8192
MAX_CAPTURE_BYTES = 4 * 1024 * 1024
MEDIA_TYPE = "application/vnd.vertex.ibkr-history-capture.v1+json"


class HistoryUnavailable(ValueError):
    pass


class CancellationSignal(Protocol):
    def is_set(self) -> bool: ...
    async def wait(self) -> Any: ...


class HistoryOwnerPort(Protocol):
    """Trusted existing-owner binding only; data in/out, no connection authority.

    request includes its whole-operation deadline budget. Implementations must
    map cancellation to the native token, JOIN cleanup, and return immutable
    capture bytes even on partial/error outcomes when a request was dispatched.
    """
    async def acquire(self, request_json: bytes, *, cancellation: CancellationSignal) -> bytes: ...

    async def acknowledge_capture(self, *, request_sha256: str, capture_sha256: str,
                                  stage_artifact_id: str) -> None:
        """Release retained bytes ONLY after the trusted handler verifies the
        exact original capture's accepted/duplicate immutable-stage receipt.
        A caller digest is not persistence proof; this is not broker authority.
        Unknown/rejected stage, lease loss or returned bytes alone MUST NOT ACK.
        """
        ...


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise HistoryUnavailable("duplicate-json-field")
        result[key] = value
    return result


def _object(data: bytes, maximum: int) -> dict[str, Any]:
    if type(data) is not bytes or len(data) > maximum:
        raise HistoryUnavailable("history-byte-bound")
    try:
        value = json.loads(data, object_pairs_hook=_unique_object,
            parse_constant=lambda _: (_ for _ in ()).throw(HistoryUnavailable("nonfinite-json-number")))
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise HistoryUnavailable("invalid-history-json") from exc
    if type(value) is not dict:
        raise HistoryUnavailable("history-object-required")
    return value


def _keys(value: Any, expected: set[str]) -> None:
    if type(value) is not dict or set(value) != expected:
        raise HistoryUnavailable("unsupported-history-fields")


def _integer(value: Any, minimum: int, maximum: int) -> None:
    if type(value) is not int or not minimum <= value <= maximum:
        raise HistoryUnavailable("invalid-history-integer")


def _identifier(value: Any) -> None:
    if type(value) is not str or not 1 <= len(value) <= 128 or not value.isascii() or any(
        not (char.isalnum() or char in "-_:./") for char in value
    ):
        raise HistoryUnavailable("invalid-history-identity")


@dataclass(frozen=True, slots=True)
class HistoricalRequest:
    data: bytes

    def __post_init__(self) -> None:
        value = _object(self.data, MAX_REQUEST_BYTES)
        _keys(value, {"schema_version", "request_id", "contract_ref", "kind", "limits"})
        if value["schema_version"] != SCHEMA_VERSION:
            raise HistoryUnavailable("unsupported-history-version")
        _identifier(value["request_id"])
        _identifier(value["contract_ref"])
        limits = value["limits"]
        _keys(limits, {"timeout_ms", "max_rows", "max_bytes", "max_events"})
        for key, minimum, maximum in (("timeout_ms", 1000, 60000), ("max_rows", 1, 5000),
            ("max_bytes", 32768, MAX_CAPTURE_BYTES), ("max_events", 1, 256)):
            _integer(limits[key], minimum, maximum)
        kind = value["kind"]
        if type(kind) is not dict or type(kind.get("use_rth")) is not bool:
            raise HistoryUnavailable("explicit-use-rth-required")
        if kind.get("type") == "bars":
            _keys(kind, {"type", "what_to_show", "bar_size", "duration_days", "end_unix_seconds", "use_rth"})
            if kind["bar_size"] not in ("1 min", "1 day"):
                raise HistoryUnavailable("unsupported-bar-size")
            _integer(kind["duration_days"], 1, 1 if kind["bar_size"] == "1 min" else 365)
            if kind["what_to_show"] == "TRADES":
                _integer(kind["end_unix_seconds"], 946684800, 4102444800)
            elif kind["what_to_show"] == "ADJUSTED_LAST":
                if kind["end_unix_seconds"] is not None:
                    raise HistoryUnavailable("adjusted-last-end-unsupported")
            else:
                raise HistoryUnavailable("unsupported-bar-source")
        elif kind.get("type") == "bid_ask_ticks":
            _keys(kind, {"type", "anchor", "anchor_unix_seconds", "number_of_ticks", "use_rth", "ignore_size",
                "session_start_unix_seconds", "session_end_unix_seconds"})
            if kind["anchor"] not in ("start", "end") or kind["ignore_size"] is not False:
                raise HistoryUnavailable("unsupported-tick-form")
            _integer(kind["number_of_ticks"], 1, 1000)
            for key in ("anchor_unix_seconds", "session_start_unix_seconds", "session_end_unix_seconds"):
                _integer(kind[key], 946684800, 4102444800)
            start, end = kind["session_start_unix_seconds"], kind["session_end_unix_seconds"]
            if not start <= kind["anchor_unix_seconds"] < end or end - start > 86400:
                raise HistoryUnavailable("invalid-tick-session-bounds")
        else:
            raise HistoryUnavailable("unsupported-history-kind")

    def decode(self) -> dict[str, Any]:
        return _object(self.data, MAX_REQUEST_BYTES)

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()


@dataclass(frozen=True, slots=True)
class HistoricalCapture:
    """Exact bytes/hash; decode returns a fresh value, never mutable stored state.

    source_response_complete is distinct from capture_complete/data_valid and
    never substitutes for dataset rights, calendar, coverage or PIT qualification.
    """
    content: Content

    def decode(self) -> dict[str, Any]:
        return _object(self.content.data, MAX_CAPTURE_BYTES)

    @classmethod
    def bind(cls, data: bytes, request: HistoricalRequest) -> HistoricalCapture:
        value = _object(data, request.decode()["limits"]["max_bytes"])
        _keys(value, {"schema_version", "request", "request_sha256", "effective_request", "owner", "sdk",
            "qualified_contract", "acquisition", "attempts", "status", "source_response_complete", "data_valid",
            "capture_complete", "market_coverage", "point_in_time_adjustments", "admissible", "cancel_status",
            "owner_slot_quarantined", "provider_window", "records", "events", "limitations"})
        if value["schema_version"] != SCHEMA_VERSION or value["request_sha256"] != request.sha256 or value["request"] != request.decode():
            raise HistoryUnavailable("history-capture-request-mismatch")
        for key in ("sdk", "owner", "effective_request", "qualified_contract", "acquisition", "attempts"):
            if type(value[key]) is not dict:
                raise HistoryUnavailable("invalid-history-result-object")
        if value["sdk"].get("version") != "ibapi=3.3.0" or value["sdk"].get("extension") != "vertex-history-strict-v1":
            raise HistoryUnavailable("history-sdk-mismatch")
        qualified = value["qualified_contract"]
        _keys(qualified, {"decoded_contract", "semantics", "qualification_capture"})
        provenance = qualified["qualification_capture"]
        _keys(provenance, {"encoding", "original_bytes_base64", "sha256", "observed_unix_ns", "raw_wire"})
        if (provenance["encoding"] != "ibapi-serde-json" or provenance["raw_wire"] is not False
                or type(provenance["original_bytes_base64"]) is not str
                or not 0 < len(provenance["original_bytes_base64"]) <= 87_384):
            raise HistoryUnavailable("qualification-original-required")
        try:
            original = base64.b64decode(provenance["original_bytes_base64"], validate=True)
        except (ValueError, TypeError):
            raise HistoryUnavailable("qualification-original-encoding") from None
        details = _object(original, 65_536)
        observed = provenance["observed_unix_ns"]
        started = value["acquisition"].get("started_unix_ns")
        if (base64.b64encode(original).decode("ascii") != provenance["original_bytes_base64"]
                or hashlib.sha256(original).hexdigest() != provenance["sha256"]
                or type(qualified["semantics"]) is not dict
                or qualified["semantics"].get("details_sha256") != provenance["sha256"]
                or details.get("contract") != qualified["decoded_contract"]
                or details.get("price_magnifier") != qualified["semantics"].get("price_magnifier")
                or details.get("time_zone_id") != qualified["semantics"].get("timezone")
                or type(observed) is not str or not observed.isascii() or not observed.isdecimal()
                or type(started) is not str or not started.isascii() or not started.isdecimal()
                or not 0 < int(observed) <= int(started)):
            raise HistoryUnavailable("qualification-original-binding-mismatch")
        for key in ("source_response_complete", "capture_complete", "data_valid", "admissible", "owner_slot_quarantined"):
            if type(value[key]) is not bool:
                raise HistoryUnavailable("invalid-history-result-flags")
        if value["admissible"] is not False or value["market_coverage"] != "unqualified" or value["point_in_time_adjustments"] is not False:
            raise HistoryUnavailable("acquisition-cannot-grant-dataset-admission")
        if (value["capture_complete"] and not value["source_response_complete"]) or (value["data_valid"] and not value["capture_complete"]):
            raise HistoryUnavailable("inconsistent-history-completion")
        if value["source_response_complete"] and (value["status"] != "source-response-complete" or value["owner_slot_quarantined"]):
            raise HistoryUnavailable("inconsistent-history-terminal")
        limits = request.decode()["limits"]
        for key, bound in (("records", limits["max_rows"]), ("events", limits["max_events"])):
            if type(value[key]) is not list or len(value[key]) > bound:
                raise HistoryUnavailable("history-result-bound")
        return cls(Content(data=data, digest=hashlib.sha256(data).hexdigest(), media_type=MEDIA_TYPE))


async def acquire_history(owner: HistoryOwnerPort | None, request: HistoricalRequest,
    *, cancellation: CancellationSignal) -> HistoricalCapture:
    if owner is None:
        raise HistoryUnavailable("existing-ibkr-history-owner-unmounted")
    if cancellation.is_set():
        raise HistoryUnavailable("history-cancelled-before-owner-call")
    # No wait_for/to_thread/async SDK construction: the real owner binding must
    # join native bounded cleanup, including cancellation, before returning bytes.
    data = await owner.acquire(request.data, cancellation=cancellation)
    return HistoricalCapture.bind(data, request)
