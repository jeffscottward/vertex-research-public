"""Bounded JSON Schema input subset exported by the pinned Zod source.

Unsupported keywords are unavailable, never ignored as permissive validation.
Annotations do not change acceptance. URI predicates use the pinned WHATWG
backend; missing or unsupported parsing support fails authority construction.
"""

import re

from .codec import (ContractError, ContractUnavailable, MAX_DEPTH, MAX_NODES,
                    TIMESTAMP_PATTERN, canonical_encode, epoch_ns)
from .whatwg import public_https

_KEYWORDS = frozenset({"$schema", "$id", "$ref", "$defs", "type", "properties",
    "required", "additionalProperties", "items", "prefixItems", "minItems",
    "maxItems", "uniqueItems", "minProperties", "maxProperties", "minLength",
    "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum",
    "exclusiveMaximum", "multipleOf", "const", "enum", "anyOf", "oneOf", "allOf",
    "not", "title", "description", "default", "examples", "readOnly", "deprecated"})
_TYPES = frozenset({"null", "boolean", "integer", "number", "string", "array", "object"})
# Exact finite pattern support for the source-bound v1 profile. These are not
# schemas or acceptance rules: structural schemas still come from Zod. Unknown
# patterns require a reviewed profile update instead of exposing an unbounded
# Python backtracking engine to newly introduced regex programs.
_SOURCE_PATTERNS = frozenset({
    TIMESTAMP_PATTERN,
    r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$",
    r"^[0-9a-f]{64}$",
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$",
    r"^(?:0|-?(?:[1-9]\d{0,29}(?:\.\d{0,17}[1-9])?|0\.\d{0,17}[1-9]))$",
    r"^(?:0|[1-9]\d{0,29})(?:\.\d{0,17}[1-9])?$",
    r"^[A-Z]{3}$",
    r"^[^\u0000-\u001f\u007f\ud800-\udfff]*$",
    r"^replay-manifest-[0-9a-f]{24}$",
    r"^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$",
    r"^[^\ud800-\udfff]*$",
    r"^event-[0-9a-f]{64}$",
    r"^(0|[1-9]\d{0,29})$",
    r"^[1-9][0-9]{0,29}$",
    r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
    r"^[1-9]\d{0,29}$",
    r"^[A-Z][A-Z0-9_]{0,127}$",
})




def _equal(left, right) -> bool:
    return canonical_encode(left) == canonical_encode(right)


class SchemaValidator:
    def __init__(self, schema):
        self.root = schema
        self.patterns: dict[str, re.Pattern] = {}
        self._inspect(schema, 0, [0])

    def _reference(self, ref):
        if type(ref) is not str or not ref.startswith("#/$defs/") or len(ref) > 2048:
            raise ContractUnavailable("Only bounded document-local schema references are supported")
        if len(ref[2:].split("/")) != 2:
            raise ContractUnavailable("Only direct $defs schema references are supported")
        node = self.root
        for segment in ref[2:].split("/"):
            if re.search(r"~(?![01])", segment):
                raise ContractUnavailable("Malformed local schema reference escape")
            segment = segment.replace("~1", "/").replace("~0", "~")
            if type(node) is not dict or segment not in node:
                raise ContractUnavailable("Unresolved local schema reference")
            node = node[segment]
        if type(node) not in (bool, dict):
            raise ContractUnavailable("Reference target is not a schema")
        return node

    def _inspect(self, schema, depth, count):
        count[0] += 1
        if depth > MAX_DEPTH or count[0] > MAX_NODES:
            raise ContractUnavailable("Schema budget exceeded")
        if type(schema) is bool:
            return
        if type(schema) is not dict or not set(schema) <= _KEYWORDS:
            raise ContractUnavailable("Unsupported schema keyword or node")
        if "$schema" in schema and schema["$schema"] != "https://json-schema.org/draft/2020-12/schema":
            raise ContractUnavailable("Unsupported JSON Schema dialect")
        if "$ref" in schema:
            self._reference(schema["$ref"])
        if "type" in schema:
            types = schema["type"] if type(schema["type"]) is list else [schema["type"]]
            if not types or any(type(item) is not str or item not in _TYPES for item in types):
                raise ContractUnavailable("Unsupported schema type")
        if "format" in schema and schema["format"] != "uri":
            raise ContractUnavailable("Unsupported schema format")
        if "pattern" in schema:
            pattern = schema["pattern"]
            if type(pattern) is not str or len(pattern) > 8192:
                raise ContractUnavailable("Unbounded schema pattern")
            if pattern not in _SOURCE_PATTERNS:
                raise ContractUnavailable("Pattern is outside the source-bound native profile")
            if re.search(r"\\[1-9]|\(\?[=!<]|\(\?P", pattern):
                raise ContractUnavailable("Unsupported regex feature")
            # JavaScript's digit shorthand is ASCII, unlike Python's default.
            # The source uses no multiline regex mode; terminal anchors are exact.
            portable = pattern[:-1] + r"\Z" if pattern.endswith("$") else pattern
            try:
                self.patterns[pattern] = re.compile(portable, re.ASCII)
            except re.error as exc:
                raise ContractUnavailable("Unsupported schema pattern") from exc
        for keyword in ("minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"):
            if keyword in schema and (type(schema[keyword]) is not int or schema[keyword] < 0):
                raise ContractUnavailable("Invalid schema bound")
        for keyword in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"):
            if keyword in schema and type(schema[keyword]) is not int:
                raise ContractUnavailable("Native schema numerical bounds must be integers")
        if "multipleOf" in schema and schema["multipleOf"] <= 0:
            raise ContractUnavailable("Invalid multipleOf")
        for keyword in ("uniqueItems",):
            if keyword in schema and type(schema[keyword]) is not bool:
                raise ContractUnavailable("Invalid schema boolean")
        if "required" in schema:
            required = schema["required"]
            if type(required) is not list or any(type(key) is not str for key in required) or len(set(required)) != len(required):
                raise ContractUnavailable("Invalid required field declaration")
        if "enum" in schema and (type(schema["enum"]) is not list or not schema["enum"]):
            raise ContractUnavailable("Invalid schema enum")
        for keyword in ("properties", "$defs"):
            if keyword in schema:
                if type(schema[keyword]) is not dict:
                    raise ContractUnavailable("Invalid schema map")
                for child in schema[keyword].values():
                    self._inspect(child, depth + 1, count)
        for keyword in ("items", "additionalProperties", "not"):
            if keyword in schema:
                self._inspect(schema[keyword], depth + 1, count)
        for keyword in ("prefixItems", "anyOf", "oneOf", "allOf"):
            if keyword in schema:
                if type(schema[keyword]) is not list or (keyword != "prefixItems" and not schema[keyword]):
                    raise ContractUnavailable("Invalid schema alternatives")
                for child in schema[keyword]:
                    self._inspect(child, depth + 1, count)

    def validate(self, value):
        budget = [0]

        def visit(schema, item, depth):
            budget[0] += 1
            if depth > MAX_DEPTH or budget[0] > 16_000_000:
                raise ContractError("Schema evaluation budget exceeded")
            if type(schema) is bool:
                return schema
            if "$ref" in schema and not visit(self._reference(schema["$ref"]), item, depth + 1):
                return False
            if "type" in schema:
                types = schema["type"] if type(schema["type"]) is list else [schema["type"]]
                actual = {type(None): "null", bool: "boolean", int: "integer", str: "string", list: "array", dict: "object"}.get(type(item))
                if actual not in types and not (actual == "integer" and "number" in types):
                    return False
            if "const" in schema and not _equal(item, schema["const"]):
                return False
            if "enum" in schema and not any(_equal(item, candidate) for candidate in schema["enum"]):
                return False
            if "anyOf" in schema and not any(visit(child, item, depth + 1) for child in schema["anyOf"]):
                return False
            if "oneOf" in schema and sum(visit(child, item, depth + 1) for child in schema["oneOf"]) != 1:
                return False
            if "allOf" in schema and not all(visit(child, item, depth + 1) for child in schema["allOf"]):
                return False
            if "not" in schema and visit(schema["not"], item, depth + 1):
                return False
            if type(item) is dict:
                if any(key not in item for key in schema.get("required", [])):
                    return False
                if len(item) < schema.get("minProperties", 0) or len(item) > schema.get("maxProperties", MAX_NODES):
                    return False
                properties = schema.get("properties", {})
                for key, child in item.items():
                    if not visit(properties.get(key, schema.get("additionalProperties", True)), child, depth + 1):
                        return False
            if type(item) is list:
                if len(item) < schema.get("minItems", 0) or len(item) > schema.get("maxItems", MAX_NODES):
                    return False
                if schema.get("uniqueItems") and len({canonical_encode(child) for child in item}) != len(item):
                    return False
                prefix = schema.get("prefixItems", [])
                for index, child in enumerate(item):
                    child_schema = prefix[index] if index < len(prefix) else schema.get("items", True)
                    if not visit(child_schema, child, depth + 1):
                        return False
            if type(item) is str:
                length = len(item.encode("utf-16-le")) // 2
                if length < schema.get("minLength", 0) or length > schema.get("maxLength", MAX_NODES * 16):
                    return False
                if "pattern" in schema:
                    if self.patterns[schema["pattern"]].search(item) is None:
                        return False
                    if schema["pattern"] == TIMESTAMP_PATTERN:
                        try:
                            epoch_ns(item)
                        except ContractError:
                            return False
                if "format" in schema and not public_https(item):
                    return False
            if type(item) is int:
                if "minimum" in schema and item < schema["minimum"]:
                    return False
                if "maximum" in schema and item > schema["maximum"]:
                    return False
                if "exclusiveMinimum" in schema and item <= schema["exclusiveMinimum"]:
                    return False
                if "exclusiveMaximum" in schema and item >= schema["exclusiveMaximum"]:
                    return False
                if "multipleOf" in schema and item % schema["multipleOf"]:
                    return False
            return True

        if not visit(self.root, value, 0):
            raise ContractError("Structural contract validation rejected input")
