"""Authoritative-public-contract boundary with no installed runtime adapters.

These internal blueprints are not replacement public schemas. Only the injected
Civet-derived validator may accept StrategySpec v1. No permissive validator, JSON
canonicalizer, transport, or mutable database fallback exists here.
"""
from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from decimal import Decimal
import hashlib
from typing import Any, Protocol

from .core import SLEEVES, Rule, digest_text, identity, public_decimal


class AuthoritativeValidator(Protocol):
    def validate(self, contract_name: str, payload: Any, schema_version: str = "1.0.0") -> bool: ...


class CanonicalCodec(Protocol):
    def encode(self, value: Any) -> bytes: ...
    def digest(self, value: Any) -> str: ...


@dataclass(frozen=True)
class Unavailable:
    reasons: tuple[str, ...]
    state: str = "unavailable"


@dataclass(frozen=True)
class StrategyBlueprint:
    """Internal authoring plan; caller supplies all policy and cost assumptions."""
    strategy_id: str
    version: str
    sleeve: str
    hypothesis: str
    universe: tuple[str, ...]
    calendar_id: str
    interval: str
    entry_rules: tuple[Rule, ...]
    exit_rules: tuple[Rule, ...]
    risk_limits: Mapping[str, Any]
    required_data: tuple[Mapping[str, Any], ...]
    cost_model: Mapping[str, Any]
    code_digest: str

    def public_candidate(self) -> dict:
        if self.sleeve not in SLEEVES:
            raise ValueError("StrategySpec only supports the five existing sleeves")
        return _public_tree({
            "schemaVersion": "1.0.0", "strategyId": self.strategy_id,
            "version": self.version, "sleeve": self.sleeve, "hypothesis": self.hypothesis,
            "universe": list(self.universe),
            "signalSchedule": {"calendar": self.calendar_id, "timezone": "UTC", "interval": self.interval},
            "entryRules": [rule.public_value() for rule in self.entry_rules],
            "exitRules": [rule.public_value() for rule in self.exit_rules],
            "riskLimits": dict(self.risk_limits), "requiredData": [dict(item) for item in self.required_data],
            "costModel": dict(self.cost_model), "codeDigest": self.code_digest,
        })


def _public_tree(value: Any, depth: int = 0) -> Any:
    if depth > 32:
        raise ValueError("Artifact nesting exceeds boundary limit")
    if isinstance(value, Decimal):
        return public_decimal(value)
    if value is None or type(value) in (str, bool):
        return value
    if type(value) is int:
        if abs(value) > 9_007_199_254_740_991:
            raise ValueError("Unsafe public integer")
        return value
    if isinstance(value, Mapping):
        if any(type(key) is not str for key in value):
            raise TypeError("Artifact keys must be strings")
        return {key: _public_tree(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_public_tree(item, depth + 1) for item in value]
    raise TypeError("Unsupported public artifact value, including float")


def encode_authoritatively(value: Any, codec: CanonicalCodec) -> tuple[bytes, str]:
    """Cross-check the injected codec, never manufacture a canonical fallback."""
    snapshot = deepcopy(value)
    encoded = codec.encode(deepcopy(snapshot))
    digest = codec.digest(deepcopy(snapshot))
    if type(encoded) is not bytes or not encoded:
        raise ValueError("Canonical codec must produce nonempty immutable bytes")
    digest_text(digest)
    if hashlib.sha256(encoded).hexdigest() != digest:
        raise ValueError("Canonical codec digest/bytes disagree")
    if len(encoded) > 1_048_576:
        raise ValueError("Research artifact exceeds bounded publication size")
    return encoded, digest


@dataclass(frozen=True)
class ImmutablePublicationPlan:
    contract_name: str
    schema_version: str
    artifact_id: str
    content_hash: str
    canonical_bytes: bytes
    executable: bool = False

    def __post_init__(self):
        identity(self.artifact_id)
        digest_text(self.content_hash)
        if self.contract_name != "StrategySpec" or self.schema_version != "1.0.0":
            raise ValueError("This boundary publishes only authoritative StrategySpec v1")
        if type(self.canonical_bytes) is not bytes or hashlib.sha256(self.canonical_bytes).hexdigest() != self.content_hash:
            raise ValueError("Immutable publication bytes/hash mismatch")
        if self.executable is not False:
            raise ValueError("Research publication cannot authorize execution")


def plan_publication(blueprint: StrategyBlueprint, *, validator: AuthoritativeValidator | None,
                     codec: CanonicalCodec | None) -> ImmutablePublicationPlan | Unavailable:
    missing = tuple(name for name, port in (("authoritative-validator-unavailable", validator),
                                           ("authoritative-canonical-codec-unavailable", codec)) if port is None)
    if missing:
        return Unavailable(missing)
    candidate = blueprint.public_candidate()
    # Validators may inspect their copy; mutation cannot change the hashed plan.
    if validator.validate("StrategySpec", deepcopy(candidate), schema_version="1.0.0") is not True:
        raise ValueError("Authoritative StrategySpec validator did not return literal True")
    encoded, digest = encode_authoritatively(candidate, codec)
    artifact_id = f"{blueprint.strategy_id}:{blueprint.version}"
    return ImmutablePublicationPlan("StrategySpec", "1.0.0", artifact_id, digest, encoded)


@dataclass(frozen=True)
class PublicationReceipt:
    artifact_id: str
    content_hash: str
    state: str


class ImmutableStrategyStore(Protocol):
    def put_if_absent(self, plan: ImmutablePublicationPlan) -> PublicationReceipt:
        """Atomically insert or return identical existing bytes; reject version collisions.

        Adapter must preserve the unique (contract, schema version, artifact ID)
        identity and immutable content, never replace an earlier strategy version.
        """
        ...


def publish_plan(plan: ImmutablePublicationPlan, *, store: ImmutableStrategyStore | None,
                 validator: AuthoritativeValidator | None,
                 codec: CanonicalCodec | None) -> PublicationReceipt | Unavailable:
    """Explicit store boundary; no store is installed/imported by this package.

    Revalidate decoded bytes at point of publication so hand-constructed plan
    instances cannot bypass authoritative contract validation.
    """
    if store is None or validator is None or codec is None:
        return Unavailable(("immutable-store-validator-or-codec-unavailable",))
    import json
    candidate = json.loads(plan.canonical_bytes)
    if validator.validate("StrategySpec", deepcopy(candidate), schema_version=plan.schema_version) is not True:
        raise ValueError("Authoritative validation failed at publication")
    encoded, digest = encode_authoritatively(candidate, codec)
    if encoded != plan.canonical_bytes or digest != plan.content_hash:
        raise ValueError("Plan is not authoritative canonical content")
    if f"{candidate['strategyId']}:{candidate['version']}" != plan.artifact_id:
        raise ValueError("Publication identity does not bind payload")
    receipt = store.put_if_absent(plan)
    if receipt.artifact_id != plan.artifact_id or receipt.content_hash != plan.content_hash:
        raise ValueError("Immutable store receipt identity mismatch")
    if receipt.state not in {"created", "already-present"}:
        raise ValueError("Store did not confirm immutable publication")
    return receipt
