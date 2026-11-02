"""Pure canonical data codec. No file, process, environment or network discovery."""

import hashlib
import json
import re


class ContractError(ValueError):
    """Input was rejected; this exception never grants authority."""


class ContractUnavailable(ContractError):
    """The pinned source/profile/schema/semantic support is unavailable."""


# Admission/off-hot-path hard ceilings, not latency or peak-memory guarantees.
# Transport/API boundaries must apply tighter per-contract limits first. Never
# parse maximum-size artifacts in a native market-data/tick callback.
MAX_BUNDLE_BYTES = 8 * 1024 * 1024
MAX_PAYLOAD_BYTES = 64 * 1024 * 1024
MAX_STRING_BYTES = 2 * 1024 * 1024
MAX_NODES = 1_000_000
MAX_DEPTH = 64
MAX_SAFE_INTEGER = 9_007_199_254_740_991
TIMESTAMP_PATTERN = r"^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\.([0-9]{1,9}))?(Z|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))$"
_TIMESTAMP = re.compile(TIMESTAMP_PATTERN, re.ASCII)
_DECIMAL = re.compile(r"(?:0|-?(?:[1-9]\d{0,29}(?:\.\d{0,17}[1-9])?|0\.\d{0,17}[1-9]))", re.ASCII)
_SEQUENCE = re.compile(r"(?:0|[1-9]\d{0,29})", re.ASCII)


def rawSHA256(value: bytes) -> str:
    """Hash original bytes; never confuse Gamma source hashes with canonical hashes."""
    if type(value) is not bytes:
        raise ContractError("rawSHA256 requires bytes")
    return hashlib.sha256(value).hexdigest()


def epoch_ns(timestamp: str) -> int:
    if type(timestamp) is not str or len(timestamp) > 35:
        raise ContractError("Expected bounded timestamp string")
    match = _TIMESTAMP.fullmatch(timestamp)
    if match is None:
        raise ContractError("Expected seconds-qualified timestamp with exact offset")
    year, month, day, hour, minute, second = map(int, match.group(1, 2, 3, 4, 5, 6))
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    months = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if day > months[month - 1]:
        raise ContractError("Invalid Gregorian date")
    previous = year - 1
    days = 365 * previous + previous // 4 - previous // 100 + previous // 400
    days += sum(months[:month - 1]) + day - 1 - 719162
    offset = 0
    if match.group(8) != "Z":
        offset = (int(match.group(10)) * 3600 + int(match.group(11)) * 60)
        if match.group(9) == "-":
            offset = -offset
    seconds = days * 86400 + hour * 3600 + minute * 60 + second - offset
    return seconds * 1_000_000_000 + int((match.group(7) or "").ljust(9, "0"))


def decimal_units(value: str) -> int:
    if type(value) is not str or _DECIMAL.fullmatch(value) is None:
        raise ContractError("Expected canonical bounded decimal string")
    negative = value.startswith("-")
    whole, _, fraction = value.lstrip("-").partition(".")
    units = int(whole) * 10**18 + int(fraction.ljust(18, "0"))
    return -units if negative else units


def sequence_integer(value: str) -> int:
    if type(value) is not str or _SEQUENCE.fullmatch(value) is None:
        raise ContractError("Expected canonical bounded sequence")
    return int(value)


def canonical_encode(value, *, max_bytes: int = MAX_PAYLOAD_BYTES) -> bytes:
    nodes = 0
    size = 0
    pieces: list[bytes] = []
    ancestors: set[int] = set()

    def emit(text: str):
        nonlocal size
        try:
            encoded = text.encode("utf-8", "strict")
        except UnicodeError as exc:
            raise ContractError("Invalid Unicode scalar") from exc
        size += len(encoded)
        if size > max_bytes:
            raise ContractError("Canonical byte budget exceeded")
        pieces.append(encoded)

    def string(text: str):
        if len(text) > MAX_STRING_BYTES:
            raise ContractError("String budget exceeded")
        try:
            length = len(text.encode("utf-8", "strict"))
        except UnicodeError as exc:
            raise ContractError("Invalid Unicode scalar") from exc
        if length > MAX_STRING_BYTES:
            raise ContractError("String budget exceeded")
        emit(json.dumps(text, ensure_ascii=False, separators=(",", ":")))

    def visit(item, depth: int):
        nonlocal nodes
        nodes += 1
        if nodes > MAX_NODES or depth > MAX_DEPTH:
            raise ContractError("Canonical graph budget exceeded")
        kind = type(item)
        if item is None:
            emit("null")
        elif kind is bool:
            emit("true" if item else "false")
        elif kind is int:
            if item.bit_length() > 53 or abs(item) > MAX_SAFE_INTEGER:
                raise ContractError("Numbers must be safe integers")
            emit(str(item))
        elif kind is str:
            string(item)
        elif kind in (list, dict):
            if len(item) > MAX_NODES:
                raise ContractError("Collection budget exceeded")
            identity = id(item)
            if identity in ancestors:
                raise ContractError("Cyclic artifact")
            ancestors.add(identity)
            try:
                if kind is list:
                    emit("[")
                    for index, child in enumerate(item):
                        if index:
                            emit(",")
                        visit(child, depth + 1)
                    emit("]")
                else:
                    if any(type(key) is not str for key in item):
                        raise ContractError("Object keys must be strings")
                    emit("{")
                    for index, key in enumerate(sorted(item)):
                        if index:
                            emit(",")
                        string(key)
                        emit(":")
                        visit(item[key], depth + 1)
                    emit("}")
            finally:
                ancestors.remove(identity)
        else:
            raise ContractError("Only plain JSON builtins are accepted")

    visit(value, 0)
    return b"".join(pieces)


def parse_canonical(data: bytes, *, max_bytes: int = MAX_PAYLOAD_BYTES):
    if type(data) is not bytes or not data or len(data) > max_bytes:
        raise ContractError("Expected bounded nonempty JSON bytes")
    depth = 0
    in_string = False
    escaped = False
    tokens = 0
    for byte in data:
        if in_string:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                in_string = False
        elif byte == 34:
            in_string = True
            tokens += 1
        elif byte in (91, 123):
            depth += 1
            tokens += 1
            if depth > MAX_DEPTH + 1:
                raise ContractError("JSON depth budget exceeded")
        elif byte in (93, 125):
            depth -= 1
        elif byte == 44:
            tokens += 1
        if tokens > MAX_NODES * 2:
            raise ContractError("JSON node budget exceeded")
    if depth != 0 or in_string:
        raise ContractError("Unterminated JSON")

    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                raise ContractError("Duplicate JSON property")
            result[key] = value
        return result

    def integer(text):
        if text == "-0" or len(text) > 17:
            raise ContractError("Noncanonical integer")
        value = int(text)
        if abs(value) > MAX_SAFE_INTEGER:
            raise ContractError("Unsafe integer")
        return value

    def non_integer(_):
        raise ContractError("Floating point and nonfinite JSON numbers are forbidden")

    try:
        value = json.loads(data.decode("utf-8", "strict"), object_pairs_hook=pairs,
                           parse_int=integer, parse_float=non_integer,
                           parse_constant=non_integer)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ContractError("Invalid JSON bytes") from exc
    if canonical_encode(value, max_bytes=max_bytes) != data:
        raise ContractError("Noncanonical JSON encoding")
    return value
