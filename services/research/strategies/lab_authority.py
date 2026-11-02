"""Pure lab admission contracts; no resolver, persistence or permissive fallback.

A host must select a reviewed verifier implementation AND configuration pin. Its
verify method must resolve current StateAuth/rights/review identities and check
source semantics against the exact originals. Echoing this request, a model
opinion, an AcceptedReview DTO or a caller's boolean is not that implementation.
Receipts are request/time scoped, not reusable authorization or promotion grants.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass
from datetime import datetime
from hashlib import sha256
import json
from typing import Protocol

from agents.types import AcceptedReview
from backtesting.lineage import Pin, time_ns
from .core import digest_text, identity, instant
from .publication import AuthoritativeValidator, CanonicalCodec, Unavailable, encode_authoritatively


@dataclass(frozen=True)
class LabScope:
    actor_id: str
    account_alias: str
    collection_id: str
    snapshot_id: str
    authorization_digest: str
    environment: str = "research"

    def __post_init__(self) -> None:
        for value in (self.actor_id, self.account_alias, self.collection_id, self.snapshot_id):
            identity(value)
        digest_text(self.authorization_digest)
        if self.environment != "research":
            raise ValueError("Lab mapping has research scope only")


def timestamp(value: datetime) -> str:
    return instant(value).isoformat().replace("+00:00", "Z")


def epoch_ns(value: datetime) -> int:
    return time_ns(instant(value))


def text(value: str, maximum: int = 4000) -> str:
    if (type(value) is not str or not value.strip() or len(value) > maximum
            or any(ord(c) < 32 and c not in "\n\t" or ord(c) == 127
                   or 0xD800 <= ord(c) <= 0xDFFF for c in value)):
        raise ValueError("Bounded literal text required")
    return value


def bounded_tuple(value: tuple, maximum: int, *, minimum: int = 0) -> None:
    if type(value) is not tuple or not minimum <= len(value) <= maximum:
        raise ValueError("Bounded immutable tuple required")


def original_record(original: bytes, *, codec: CanonicalCodec, maximum: int = 700_000) -> dict:
    if type(original) is not bytes or not 1 <= len(original) <= maximum:
        raise ValueError("Original immutable artifact byte budget")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate artifact field")
            result[key] = value
        return result
    def invalid_constant(value):
        raise ValueError("Nonfinite JSON is not evidence")
    value = json.loads(original, object_pairs_hook=pairs, parse_constant=invalid_constant)
    if type(value) is not dict:
        raise ValueError("Artifact object required")
    encoded, _ = encode_authoritatively(value, codec)
    if encoded != original:
        raise ValueError("Original canonical bytes must not be rewritten")
    return value


def public_record(original: bytes, name: str, *, codec: CanonicalCodec,
                  validator: AuthoritativeValidator) -> dict:
    value = original_record(original, codec=codec)
    if validator.validate(name, deepcopy(value), schema_version="1.0.0") is not True:
        raise ValueError("Authoritative public validation unavailable")
    return value


@dataclass(frozen=True)
class ReviewedEvidence:
    """Original ResearchEvidence plus an expected, not self-authorizing, review."""
    original_bytes: bytes
    artifact_hash: str
    current_review: AcceptedReview

    def __post_init__(self) -> None:
        digest_text(self.artifact_hash)
        if (type(self.original_bytes) is not bytes or not 1 <= len(self.original_bytes) <= 262_144
                or sha256(self.original_bytes).hexdigest() != self.artifact_hash
                or type(self.current_review) is not AcceptedReview):
            raise ValueError("Exact original evidence and expected review required")


def evidence_record(evidence: ReviewedEvidence, *, scope: LabScope, as_of: datetime,
                    codec: CanonicalCodec, validator: AuthoritativeValidator) -> tuple[dict, dict]:
    value = public_record(evidence.original_bytes, "ResearchEvidence", codec=codec, validator=validator)
    review, now = evidence.current_review, epoch_ns(as_of)
    if ((review.actor_id, review.account_alias, review.environment, review.collection_id,
         review.snapshot_id, review.evidence_id, review.artifact_digest, review.rights_policy_id,
         review.purpose) != (scope.actor_id, scope.account_alias, scope.environment,
         scope.collection_id, scope.snapshot_id, value["evidenceId"], evidence.artifact_hash,
         value["rightsPolicyId"], "research")
            or (value["collectionId"], value["snapshotId"]) != (scope.collection_id, scope.snapshot_id)
            or review.status != "accepted" or review.current is not True
            or review.superseded is not False or review.rights_authorized is not True
            or type(review.revision) is not int or review.revision < 1
            or any(type(at) is not int for at in (review.effective_ns, review.expires_ns,
                   review.resolved_ns, review.rights_valid_until_ns))
            or review.resolved_ns != now or not review.effective_ns <= now < review.expires_ns
            or now >= review.rights_valid_until_ns):
        raise ValueError("Exact current scoped review required; source status is not authority")
    identity(review.review_id)
    if (time_ns(value["capturedAt"]) > now
            or value["publishedAt"] is not None and time_ns(value["publishedAt"]) > time_ns(value["capturedAt"])):
        raise ValueError("Current review cannot admit future evidence")
    # Nanoseconds stay decimal strings in the JSON boundary, never unsafe numbers.
    pin = asdict(review)
    for key in ("effective_ns", "expires_ns", "resolved_ns", "rights_valid_until_ns"):
        pin[key] = str(pin[key])
    return value, {"artifactHash": evidence.artifact_hash, "review": pin}


@dataclass(frozen=True)
class LabVerifierPin:
    implementation: Pin
    configuration_hash: str

    def __post_init__(self) -> None:
        if type(self.implementation) is not Pin:
            raise ValueError("Reviewed verifier implementation pin required")
        digest_text(self.configuration_hash)


@dataclass(frozen=True)
class LabVerificationRequest:
    purpose: str
    request_hash: str
    canonical_bytes: bytes
    originals: tuple[bytes, ...]


@dataclass(frozen=True)
class LabVerificationReceipt:
    verifier: LabVerifierPin
    request_hash: str
    resolved_at: datetime
    expires_at: datetime
    verified: bool


class LabVerifier(Protocol):
    def verify(self, request: LabVerificationRequest) -> LabVerificationReceipt | None:
        """Resolve authority/current reviews and verify source semantics, not pass gates.

        paper-claim-map: independent page extraction/quote, version, attribution,
        supplied statement/falsification/assumptions and mapping review.
        paper-experiment: frozen dependencies, PIT/cost/code/window/budget/OOS
        semantics and the exact reviewed mapping (no generated strategy approval).
        experiment-gates: committed handoff, preregistered criteria, current review
        of every original, genuine measurements/units/time/provenance and explicit
        contamination/limitations. Model opinions/simulated forward data fail.
        experiment-backtest: committed-only experiment read in this scope, exact
        dependency identities and explicit engine/model/lineage/resource bindings.

        Implementations must fail on unknown, changed or revoked authority. No
        concrete implementation or automatic receipt issuer is supplied here.
        """
        ...


def verify_binding(purpose: str, binding: dict, originals: tuple[bytes, ...], *,
                   scope: LabScope, as_of: datetime, codec: CanonicalCodec,
                   verifier: LabVerifier | None, verifier_pin: LabVerifierPin | None,
                   valid_until_ns: int | None = None) -> LabVerificationReceipt | Unavailable:
    if verifier is None or verifier_pin is None:
        return Unavailable(("pinned-lab-authority-verifier-unavailable",))
    if purpose not in {"paper-claim-map", "paper-experiment", "experiment-gates", "experiment-backtest"}:
        raise ValueError("Unknown lab verification purpose")
    bounded_tuple(originals, 256, minimum=1)
    if any(type(value) is not bytes or not value for value in originals) or sum(map(len, originals)) > 16_000_000:
        raise ValueError("Lab original input byte budget")
    now = epoch_ns(as_of)
    if valid_until_ns is not None and (type(valid_until_ns) is not int or valid_until_ns <= now):
        return Unavailable(("lab-current-review-expired",))
    request_bytes, request_hash = encode_authoritatively({
        "format": "vertex-lab-verification-v1", "purpose": purpose,
        "verifier": asdict(verifier_pin), "scope": asdict(scope), "asOf": timestamp(as_of),
        "binding": binding, "originalHashes": [sha256(value).hexdigest() for value in originals],
    }, codec)
    request = LabVerificationRequest(purpose, request_hash, request_bytes, originals)
    try:
        receipt = verifier.verify(request)
        if (type(receipt) is not LabVerificationReceipt or receipt.verifier != verifier_pin
                or receipt.request_hash != request_hash or receipt.verified is not True
                or instant(receipt.resolved_at) != instant(as_of)
                or instant(receipt.expires_at) <= instant(as_of)
                or valid_until_ns is not None and epoch_ns(receipt.expires_at) > valid_until_ns):
            return Unavailable(("lab-authority-or-source-semantics-unverified",))
    except Exception:
        return Unavailable(("lab-authority-verifier-unavailable",))
    return receipt


def receipt_record(receipt: LabVerificationReceipt) -> dict:
    return {"verifier": asdict(receipt.verifier), "requestHash": receipt.request_hash,
            "resolvedAt": timestamp(receipt.resolved_at), "expiresAt": timestamp(receipt.expires_at),
            "verified": receipt.verified}
