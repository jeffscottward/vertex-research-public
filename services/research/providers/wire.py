"""Provider HTTP JSON only, NOT the Vertex canonical artifact codec.

JSON numeric strike tokens are emitted from exact Decimal text; never binary float.
The authoritative canonical codec remains mandatory for all artifact identities.
"""
from __future__ import annotations

from decimal import Decimal
import json
from typing import Any

from .boundary import BoundaryError, exact_decimal


def encode_provider_request(value: dict[str, Any], *, maximum_bytes: int = 32_000) -> bytes:
    visited: set[int] = set()
    count = 0
    def encode(node: Any, depth: int) -> str:
        nonlocal count
        count += 1
        if count > 4000 or depth > 16:
            raise BoundaryError("provider-request-structure-budget")
        if node is None:
            return "null"
        if isinstance(node, bool):
            return "true" if node else "false"
        if isinstance(node, (int, Decimal)):
            return exact_decimal(node)
        if isinstance(node, str):
            if len(node) > 4000 or any(0xD800 <= ord(char) <= 0xDFFF for char in node):
                raise BoundaryError("provider-request-string-budget")
            return json.dumps(node, ensure_ascii=False)
        if not isinstance(node, (dict, list)) or id(node) in visited:
            raise BoundaryError("provider-request-type-or-cycle")
        visited.add(id(node))
        try:
            if isinstance(node, list):
                return "[" + ",".join(encode(child, depth + 1) for child in node) + "]"
            if any(not isinstance(key, str) for key in node):
                raise BoundaryError("provider-request-key-type")
            return "{" + ",".join(encode(key, depth + 1) + ":" + encode(node[key], depth + 1) for key in sorted(node)) + "}"
        finally:
            visited.remove(id(node))
    result = encode(value, 0).encode("utf-8")
    if len(result) > maximum_bytes:
        raise BoundaryError("provider-request-byte-budget")
    return result
