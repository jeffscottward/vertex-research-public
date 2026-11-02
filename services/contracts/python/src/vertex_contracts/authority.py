"""Explicitly injected, source-bound native validation authority.

This is validation authority only, never spending/trading authority. Callers must
obtain the expected bundle SHA256 from an independently trusted release record,
not compute it from an untrusted bundle. Construction performs no file discovery.
"""

import re
from typing import Literal

from .codec import (ContractError, ContractUnavailable, MAX_BUNDLE_BYTES,
                    canonical_encode, epoch_ns, parse_canonical, rawSHA256)
from .schema import SchemaValidator
from .whatwg import require_whatwg_backend
from .semantics import SemanticPrograms
from .binary import MAX_REPLAY_WIRE_BYTES
from .replay import validate_replay_artifacts

_HASH = re.compile(r"[0-9a-f]{64}", re.ASCII)
_SOURCE_FILES = frozenset({
    "packages/api/src/contracts/vertex.ts",
    "packages/api/src/contracts/vertex-control.ts",
    "packages/api/src/contracts/vertex-native-facts.ts",
    "packages/api/src/contracts/vertex-worker.ts",
    "packages/api/src/contracts/vertex-worker-experiment.ts",
    "packages/api/src/contracts/vertex-policy.ts",
    "packages/api/src/contracts/vertex-model-use.ts",
    "packages/api/src/contracts/vertex-worker-epoch.ts",
    "packages/shared/src/vertex/index.ts",
    "scripts/vertex-native-contracts/invariants-v1.json",
})
_FIELDS = frozenset({"bundleFormat", "schemaVersion", "hashProfile", "semanticProfile",
                     "sources", "schemas", "programs", "contractRules",
                     "programDigest", "sourceDigest"})


class ContractAuthority:
    """Frozen port: validate returns literal True, never a coerced/stripped record."""

    __slots__ = ("_schemas", "_programs", "_contract_rules")

    def __init__(self, bundle: bytes, expected_sha256: str):
        if type(expected_sha256) is not str or _HASH.fullmatch(expected_sha256) is None:
            raise ContractUnavailable("Expected independently pinned lowercase bundle SHA256")
        if type(bundle) is not bytes or not bundle or len(bundle) > MAX_BUNDLE_BYTES:
            raise ContractUnavailable("Missing or unbounded contract bundle")
        if rawSHA256(bundle) != expected_sha256:
            raise ContractUnavailable("Contract bundle SHA256 mismatch")
        require_whatwg_backend()
        try:
            document = parse_canonical(bundle, max_bytes=MAX_BUNDLE_BYTES)
            if type(document) is not dict or set(document) != _FIELDS:
                raise ContractUnavailable("Unsupported bundle shape")
            profiles = {
                "bundleFormat": "vertex-native-contract-bundle-v1",
                "schemaVersion": "1.0.0",
                "hashProfile": "gamma-json-utf8-safe-integer-v1",
                "semanticProfile": "vertex-invariants-v1",
            }
            if any(document[key] != value for key, value in profiles.items()):
                raise ContractUnavailable("Unsupported bundle profile/version")
            sources = document["sources"]
            if type(sources) is not dict or set(sources) != _SOURCE_FILES:
                raise ContractUnavailable("Missing authoritative source bindings")
            if any(type(value) is not str or _HASH.fullmatch(value) is None for value in sources.values()):
                raise ContractUnavailable("Invalid source rawSHA256 binding")
            for field, content in (("sourceDigest", sources), ("programDigest", document["programs"])):
                expected = document[field]
                if type(expected) is not str or _HASH.fullmatch(expected) is None:
                    raise ContractUnavailable("Missing canonical digest binding")
                if rawSHA256(canonical_encode(content, max_bytes=MAX_BUNDLE_BYTES)) != expected:
                    raise ContractUnavailable("Bundle content digest mismatch")
            schemas, rules = document["schemas"], document["contractRules"]
            if type(schemas) is not dict or not schemas or len(schemas) > 512:
                raise ContractUnavailable("Missing or unbounded schemas")
            if type(rules) is not dict or set(rules) != set(schemas):
                raise ContractUnavailable("Every schema requires explicit complete semantic support")
            programs = SemanticPrograms(document["programs"])
            if any(type(rule) is not str or rule not in document["programs"] for rule in rules.values()):
                raise ContractUnavailable("Unavailable contract semantic rule")
            validators = {}
            for name, schema in schemas.items():
                if type(name) is not str or not name or len(name) > 160:
                    raise ContractUnavailable("Invalid contract name")
                validators[name] = SchemaValidator(schema)
            self._schemas = validators
            self._programs = programs
            self._contract_rules = rules
        except ContractUnavailable:
            raise
        except (ContractError, KeyError, TypeError, ValueError, RecursionError) as exc:
            raise ContractUnavailable("Contract bundle cannot be safely loaded") from exc

    def validate(self, contract_name: str, payload, schema_version: str = "1.0.0") -> Literal[True]:
        if schema_version != "1.0.0" or type(schema_version) is not str:
            raise ContractUnavailable("Unsupported contract schema version")
        if type(contract_name) is not str or contract_name not in self._schemas:
            raise ContractUnavailable("Contract unavailable")
        # Canonical round-trip rejects exotic Python objects and snapshots mutable
        # input before any structural/semantic acceptance checks. Byte inputs must
        # already be canonical; duplicate keys, whitespace and numeric aliases fail.
        if contract_name == "NativeOutboxReplay":
            data = payload if type(payload) is bytes else canonical_encode(payload, max_bytes=MAX_REPLAY_WIRE_BYTES)
            value = parse_canonical(data, max_bytes=MAX_REPLAY_WIRE_BYTES)
        else:
            data = payload if type(payload) is bytes else self.encode(payload)
            value = parse_canonical(data)
        self._schemas[contract_name].validate(value)
        self._programs.validate(self._contract_rules[contract_name], value)
        if contract_name == "NativeOutboxReplay":
            validate_replay_artifacts(self, value, schema_version)
        return True

    def validate_native_journal_proof(self, projection, proof_bytes: bytes,
                                      schema_version: str = "1.0.0") -> Literal[True]:
        """Bind original canonical journal bytes to a complete fact projection.

        Replay identity is not publisher authentication or permission. Callers
        still require authenticated native emitter provenance, current grants,
        native ownership and their own atomic storage transaction.
        """
        if type(proof_bytes) is not bytes or not 0 < len(proof_bytes) <= 1_048_576:
            raise ContractError("Native journal proof must be bounded original bytes")
        projection_bytes = projection if type(projection) is bytes else self.encode(projection)
        self.validate("NativeFactProjection", projection_bytes, schema_version)
        fact = parse_canonical(projection_bytes)
        if rawSHA256(proof_bytes) != fact["proof"]["sha256"]:
            raise ContractError("Native journal proof raw SHA256 mismatch")
        self.validate("NativeJournalProof", proof_bytes, schema_version)
        proof = parse_canonical(proof_bytes, max_bytes=1_048_576)
        # This private expression program is generated from the source paired
        # helper. No copied public shape or handwritten cross-binding fallback.
        self._programs.validate("NativeJournalProofBinding", {"projection": fact, "proof": proof})
        return True

    def encode(self, value) -> bytes:
        return canonical_encode(value)

    def digest(self, value) -> str:
        return rawSHA256(self.encode(value))

    def epoch_ns(self, timestamp: str) -> int:
        return epoch_ns(timestamp)
