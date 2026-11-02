"""Exact journal arithmetic; kernel performs pricing/risk. No binary floats."""
from datetime import datetime, timedelta, timezone
import re

from .ports import ExecutionError

_SCALE = 10 ** 18
_LIMIT = 10 ** 48
_PATTERN = re.compile(r"^(?:0|-?(?:[1-9][0-9]{0,29}(?:\.[0-9]{0,17}[1-9])?|0\.[0-9]{0,17}[1-9]))$")


def units(value: str) -> int:
    if not isinstance(value, str) or _PATTERN.fullmatch(value) is None:
        raise ExecutionError("noncanonical-decimal")
    negative = value.startswith("-")
    whole, _, fraction = value.lstrip("-").partition(".")
    result = int(whole) * _SCALE + int(fraction.ljust(18, "0"))
    return -result if negative else result


def decimal(value: int) -> str:
    if type(value) is not int or abs(value) >= _LIMIT:
        raise ExecutionError("decimal-overflow")
    whole, fraction = divmod(abs(value), _SCALE)
    suffix = ("." + str(fraction).zfill(18).rstrip("0")) if fraction else ""
    return ("-" if value < 0 else "") + str(whole) + suffix


def add(left: str, right: str) -> str:
    return decimal(units(left) + units(right))


def subtract(left: str, right: str) -> str:
    return decimal(units(left) - units(right))


def timestamp(epoch_ns: int) -> str:
    if type(epoch_ns) is not int:
        raise ExecutionError("integer-nanoseconds-required")
    seconds, nanos = divmod(epoch_ns, 1_000_000_000)
    try:
        stamp = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=seconds)
    except OverflowError as error:
        raise ExecutionError("timestamp-overflow") from error
    return stamp.strftime("%Y-%m-%dT%H:%M:%S") + f".{nanos:09d}Z"
