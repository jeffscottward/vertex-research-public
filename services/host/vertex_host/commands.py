"""Exact private SubmitCommand codec; public validation remains native-owned.

No IO, clock reads, loaders, qualification flags or economic defaults. The three
runtime dispatch fields are deliberately absent from the sealed recipe. All
other simulator fields participate in its canonical inverse.
"""
from __future__ import annotations

from dataclasses import fields, is_dataclass
from decimal import Decimal
import json
from typing import Any, Mapping, Protocol

from vertex_execution.exact import units
from vertex_execution.ports import ContractAuthority, ExecutionError
from vertex_execution.simulator import (
    AdmittedLimits,
    ExpirySchedule,
    OptionTerms,
    QualifiedInstrument,
    QualifiedLeg,
    SessionModel,
    SubmitCommand,
)

RECIPE_VERSION = "vertex.host-submit.v1"
_MAX_BYTES = 2_000_000
_DISPATCH = frozenset(("submission_key", "payload_hash", "submitted_at_ns"))
_DECIMALS = frozenset((
    "strike", "deliverable_units", "tick_size", "lot_size", "multiplier",
    "ratio", "limit_price", "maximum_quantity", "maximum_gross_notional",
    "maximum_total_fees", "maximum_legging_quantity", "participation_rate",
    "depth_fraction", "maximum_fill_quantity", "fee_per_unit", "fee_rate",
    "minimum_fee", "slippage_bps",
))
_RECORDS = (ExpirySchedule, OptionTerms, QualifiedInstrument, QualifiedLeg,
            AdmittedLimits, SessionModel, SubmitCommand)


class CommandEvidence(Protocol):
    def check_recipe(self, recipe: Mapping[str, Any], *, now_ns: int) -> None: ...


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise ExecutionError(reason)


def exact_ns(value: Any) -> int:
    """Simulator nanoseconds have the explicit signed-64 upper bound."""
    _require(type(value) is str and value.isascii() and value.isdecimal()
             and 0 < len(value) <= 19 and (value == "0" or not value.startswith("0")),
             "host-command-nanoseconds-required")
    number = int(value)
    _require(number <= (1 << 63) - 1, "host-command-nanoseconds-overflow")
    return number


def exact_decimal(value: Any) -> Decimal:
    units(value)
    return Decimal(value)


def decimal_text(value: Decimal) -> str:
    _require(type(value) is Decimal and value.is_finite(), "host-command-decimal-required")
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if value == 0:
        text = "0"
    units(text)
    return text


def record_payload(record: Any) -> dict[str, Any]:
    """Serialize only the closed set of private immutable simulator records."""
    _require(type(record) in _RECORDS and is_dataclass(record), "host-command-record-required")
    result: dict[str, Any] = {}
    for field in fields(record):
        name, value = field.name, getattr(record, field.name)
        if name in _DECIMALS:
            result[name] = decimal_text(value)
        elif name.endswith("_ns"):
            _require(type(value) is int, "host-command-clock-required")
            exact_ns(str(value))
            result[name] = str(value)
        elif name == "closed_dates":
            _require(type(value) is tuple and all(type(x) is str for x in value),
                     "host-command-closed-dates-required")
            result[name] = list(value)
        elif name == "legs":
            _require(type(value) is tuple, "host-command-legs-required")
            result[name] = [record_payload(leg) for leg in value]
        elif name in ("instrument", "schedule", "admitted_limits", "option"):
            result[name] = None if name == "option" and value is None else record_payload(value)
        elif name in ("fixing_utc_offset_seconds", "slippage_ticks"):
            _require(type(value) is int, "host-command-integer-required")
            result[name] = value
        else:
            _require(type(value) is str, "host-command-text-required")
            result[name] = value
    return result


def record_from_payload(kind: type, value: Any) -> Any:
    """No dataclass default is ever used, including SessionModel.acceptance."""
    _require(kind in _RECORDS and type(value) is dict, "host-command-object-required")
    _require(set(value) == {field.name for field in fields(kind)}, "host-command-field-set-mismatch")
    result: dict[str, Any] = {}
    nested = {"instrument": QualifiedInstrument, "schedule": ExpirySchedule,
              "admitted_limits": AdmittedLimits, "option": OptionTerms}
    try:
        for name, item in value.items():
            if name in _DECIMALS:
                result[name] = exact_decimal(item)
            elif name.endswith("_ns"):
                result[name] = exact_ns(item)
            elif name == "closed_dates":
                _require(type(item) is list and len(item) <= 366
                         and all(type(x) is str for x in item), "host-command-closed-dates-required")
                result[name] = tuple(item)
            elif name == "legs":
                _require(type(item) is list and 1 <= len(item) <= 8, "host-command-leg-bound")
                result[name] = tuple(record_from_payload(QualifiedLeg, leg) for leg in item)
            elif name in nested:
                result[name] = None if name == "option" and item is None else record_from_payload(nested[name], item)
            elif name in ("fixing_utc_offset_seconds", "slippage_ticks"):
                _require(type(item) is int, "host-command-integer-required")
                result[name] = item
            else:
                _require(type(item) is str, "host-command-text-required")
                result[name] = item
        return kind(**result)
    except (TypeError, ValueError, ArithmeticError) as error:
        raise ExecutionError("host-command-invalid-simulator-record") from error


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        _require(key not in result, "host-command-duplicate-key")
        result[key] = value
    return result


def _no_float(_: str) -> None:
    raise ExecutionError("host-command-binary-number-forbidden")


def canonical_object(authority: ContractAuthority, payload: bytes) -> dict[str, Any]:
    _require(type(payload) is bytes and 0 < len(payload) <= _MAX_BYTES, "host-command-byte-bound")
    try:
        value = json.loads(payload, object_pairs_hook=_pairs, parse_float=_no_float, parse_constant=_no_float)
        _require(type(value) is dict and authority.encode(value) == payload, "host-command-noncanonical")
        return value
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise ExecutionError("host-command-invalid-json") from error


def command_recipe(command: SubmitCommand) -> dict[str, Any]:
    _require(type(command) is SubmitCommand, "host-command-submit-required")
    result = record_payload(command)
    for name in _DISPATCH:
        del result[name]
    return {"recipe_version": RECIPE_VERSION, **result}


def command_from_recipe(recipe: Mapping[str, Any], *, submission_key: str,
                        payload_sha256: str, now_ns: int) -> SubmitCommand:
    _require(type(recipe) is dict and recipe.get("recipe_version") == RECIPE_VERSION,
             "host-command-recipe-version-unavailable")
    expected = {field.name for field in fields(SubmitCommand)} - _DISPATCH
    _require(set(recipe) == expected | {"recipe_version"}, "host-command-recipe-field-set-mismatch")
    _require(type(now_ns) is int and now_ns >= 0, "host-command-dispatch-clock-required")
    value = {name: item for name, item in recipe.items() if name != "recipe_version"}
    value.update(submission_key=submission_key, payload_hash=payload_sha256, submitted_at_ns=str(now_ns))
    command = record_from_payload(SubmitCommand, value)
    _require(command.maximum_quantity <= command.admitted_limits.maximum_quantity
             and command.expires_at_ns <= command.admitted_limits.valid_until_ns,
             "host-command-admitted-bound-mismatch")
    return command


class QualifiedCommandDecoder:
    """Exact inverse plus selected immutable provenance recheck before decode."""

    def __init__(self, *, authority: ContractAuthority, evidence: CommandEvidence) -> None:
        self._authority, self._evidence = authority, evidence

    def decode(self, *, command_bytes: bytes, submission_key: str,
               payload_sha256: str, now_ns: int) -> SubmitCommand:
        recipe = canonical_object(self._authority, command_bytes)
        command = command_from_recipe(recipe, submission_key=submission_key,
                                      payload_sha256=payload_sha256, now_ns=now_ns)
        self._evidence.check_recipe(recipe, now_ns=now_ns)
        _require(self.encode(command) == command_bytes, "host-command-roundtrip-mismatch")
        return command

    def encode(self, command: SubmitCommand) -> bytes:
        # Historical checkpoint encoding is immutable and does not renew rights.
        result = self._authority.encode(command_recipe(command))
        _require(0 < len(result) <= _MAX_BYTES, "host-command-byte-bound")
        return result
