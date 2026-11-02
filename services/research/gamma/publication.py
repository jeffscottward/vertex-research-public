"""Public evidence planning only; no persistence, broker tools or canonical fallback.

Main binds the authoritative public validator/codec and transactional artifact
publication port. Native source hashes are retained inside content; the public
ResearchEvidence contentHash covers newly canonicalized projected content.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from typing import Any, Literal, Protocol

from gamma.adapter import NativeResearchArtifact, freeze_native
from gamma.decision_adapter import ResearchDecision, ResearchInputDecision
from gamma.decimal_boundary import FloatDecimalPolicy, json_value, project_native


NATIVE_LIMITATIONS = (
    "Research advisory only; executionAuthorized is false, evidence remains unreviewed, and no cash/shares are reserved.",
    "Source binary64 features and heuristic setup scores are not calibrated probabilities.",
    "Missing optional inputs and native default values do not establish observed zero exposure or complete market data.",
    "Gamma market-structure value area is an OHLCV close-distribution approximation, not a supplied volume profile.",
    "Feature/setup artifacts do not establish feed entitlement, executable prices, margin, fill quality or protective orders.",
)


class CanonicalCodec(Protocol):
    def encode(self, value: Any) -> bytes: ...
    def digest(self, value: Any) -> str: ...


@dataclass(frozen=True, slots=True)
class EvidencePublicationPlan:
    status: Literal["candidate", "unavailable"]
    reasons: tuple[str, ...]
    evidence_id: str | None = None
    record_bytes: bytes | None = None
    record_digest: str | None = None
    content_bytes: bytes | None = None
    content_digest: str | None = None
    native_source_digest: str | None = None
    proposal_only: Literal[True] = True
    execution_authorized: Literal[False] = False


class ImmutableEvidenceStore(Protocol):
    """Injected by control/storage owner; no Python shared-table SQL allowed.

    Publication must atomically bind immutable content and the validated record,
    reject same-id/different-digest writes, and preserve previous generations.
    Implementations authorize caller/scope separately. This module never calls it.
    """

    def publish_evidence(self, *, record_bytes: bytes, record_digest: str, content_bytes: bytes,
                         content_digest: str, expected_previous_digest: str | None) -> str: ...


def _encode(codec: CanonicalCodec, value: Any) -> tuple[bytes, str]:
    content = codec.encode(value)
    digest = codec.digest(value)
    if type(content) is not bytes or not content or len(content) > 16 * 1024 * 1024:
        raise ValueError("invalid or oversized canonical content")
    if type(digest) is not str or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ValueError("invalid canonical digest")
    if hashlib.sha256(content).hexdigest() != digest:
        raise ValueError("canonical codec encode/digest mismatch")
    return content, digest


class GammaPublicationPlanner:
    def __init__(self, *, validate: Callable[..., bool] | None = None, codec: CanonicalCodec | None = None) -> None:
        self._validate = validate
        self._codec = codec

    def native_evidence(self, *, artifact: NativeResearchArtifact, operation: str,
                        qualifications: Mapping[str, ResearchInputDecision], parameters: Mapping[str, str],
                        recipe_sha256: str, metadata: Mapping[str, Any],
                        conversion: FloatDecimalPolicy | None) -> EvidencePublicationPlan:
        """Project the native feature/setup receipt, never cast it to a decision.

        NativeResearchArtifact.identity_sha256 binds the source model hash plus
        module/cutoff/input identities. It is NOT ResearchDecision's differently
        shaped input/output hash envelope. Keep both native bytes and the exact
        native envelope, with review qualification separately attributed.
        """
        if self._validate is None or self._codec is None:
            return EvidencePublicationPlan("unavailable", ("authoritative-contract-codec-unavailable",))
        if conversion is None:
            return EvidencePublicationPlan("unavailable", ("explicit-float-conversion-policy-unavailable",))
        if not isinstance(artifact, NativeResearchArtifact):
            raise ValueError("native feature/setup artifact required")
        from gamma.features.fundamental_catalyst_features import FundamentalCatalystFeatureSnapshot
        from gamma.features.liquidity_features import LiquidityFeatureSnapshot
        from gamma.features.momentum_features import MomentumFeatureSnapshot
        from gamma.features.option_flow_features import OptionFlowFeatureSnapshot
        from gamma.schemas import MarketStructureSnapshot, TradeSetup, VolatilitySnapshot
        from gamma.schemas.base import canonical_artifact_json
        model_type = {
            "momentum": MomentumFeatureSnapshot, "market_structure": MarketStructureSnapshot,
            "volatility": VolatilitySnapshot, "liquidity": LiquidityFeatureSnapshot,
            "fundamental_catalyst": FundamentalCatalystFeatureSnapshot, "option_flow": OptionFlowFeatureSnapshot,
            "identify_setup": TradeSetup,
        }.get(operation)
        expected_module = "setup" if operation == "identify_setup" else operation
        if model_type is None or artifact.module != expected_module:
            raise ValueError("unsupported native feature/setup operation")
        if type(artifact.native_json) is not bytes or hashlib.sha256(artifact.native_json).hexdigest() != artifact.native_sha256:
            raise ValueError("native source output hash mismatch")
        model = model_type.model_validate_json(artifact.native_json)
        if (freeze_native(model) != artifact.payload
                or canonical_artifact_json(model).encode("utf-8") != artifact.native_json):
            raise ValueError("native payload does not match exact source model bytes")
        native_identity = {"module": artifact.module, "as_of": artifact.as_of,
                           "inputs": json_value(artifact.input_identity), "native_sha256": artifact.native_sha256}
        identity_text = canonical_artifact_json(native_identity)
        if hashlib.sha256(identity_text.encode("utf-8")).hexdigest() != artifact.identity_sha256:
            raise ValueError("native feature/setup identity hash mismatch")
        if (not qualifications or set(qualifications) != set(artifact.input_identity)
                or type(recipe_sha256) is not str or re.fullmatch(r"[0-9a-f]{64}", recipe_sha256) is None):
            raise ValueError("native input qualification membership mismatch")
        for role, qualification in qualifications.items():
            source = artifact.input_identity[role]
            if (not isinstance(qualification, ResearchInputDecision) or not isinstance(source, Mapping)
                    or set(source) != {"source_sha256", "observed_at", "available_at"}
                    or qualification.source_sha256 != source["source_sha256"] or not qualification.evidence_id
                    or qualification.permitted is not True or qualification.status != "fresh"
                    or qualification.source_kind not in ("real", "synthetic")
                    or not source["observed_at"] <= source["available_at"] <= artifact.as_of < qualification.valid_until):
                raise ValueError("native input not qualified at cutoff")
        projection = project_native(artifact.payload, conversion)
        content = {
            "artifactKind": "gamma-native-research-proposal",
            "proposalOnly": True, "executionAuthorized": False, "operation": operation,
            "recipeSha256": recipe_sha256, "parameters": dict(parameters),
            "sourceKinds": sorted({item.source_kind for item in qualifications.values()}),
            "nativeOutputHash": artifact.native_sha256,
            "nativeIdentityHash": artifact.identity_sha256,
            "nativeIdentityJson": identity_text,
            "nativeOutputJson": artifact.native_json.decode("utf-8"),
            "inputQualificationJson": canonical_artifact_json({role: asdict(item) for role, item in qualifications.items()}),
            "projectedPayload": json_value(projection.payload),
            "conversion": {
                "policyId": projection.policy_id, "version": projection.policy_version,
                "basis": projection.basis, "rounding": projection.rounding,
                "observations": [asdict(item) for item in projection.observations],
            },
            "limitations": list(NATIVE_LIMITATIONS),
        }
        return self._plan(content=content, metadata=metadata, limitations=NATIVE_LIMITATIONS,
                          operation=operation, native_digest=artifact.native_sha256, conversion=conversion)

    def evidence(self, *, decision: ResearchDecision, metadata: Mapping[str, Any],
                 conversion: FloatDecimalPolicy | None) -> EvidencePublicationPlan:
        if self._validate is None or self._codec is None:
            return EvidencePublicationPlan("unavailable", ("authoritative-contract-codec-unavailable",))
        if conversion is None:
            return EvidencePublicationPlan("unavailable", ("explicit-float-conversion-policy-unavailable",))
        if decision.status == "unavailable" or decision.native_payload is None or decision.native_json is None:
            return EvidencePublicationPlan("unavailable", ("native-decision-unavailable",))
        if decision.proposal_only is not True or decision.execution_authorized is not False:
            raise ValueError("research decision cannot authorize execution")
        if hashlib.sha256(decision.native_json).hexdigest() != decision.native_output_sha256:
            raise ValueError("native source output hash mismatch")
        # Decision shape/hashes remain separate from NativeResearchArtifact.
        from gamma.engines.options_strategy_selector import StrategySelectionResult
        from gamma.schemas.portfolio import PortfolioAllocation
        model_type = {"options-selector": StrategySelectionResult, "portfolio-committee": PortfolioAllocation}.get(decision.operation)
        if model_type is None or freeze_native(model_type.model_validate_json(decision.native_json)) != decision.native_payload:
            raise ValueError("native payload does not match the hashed source model")
        projection = project_native(decision.native_payload, conversion)
        # Identity metadata contains native constraints/possibly floats too. It is
        # preserved as original native canonical JSON bytes, not miscast to wire.
        from gamma.schemas.base import canonical_artifact_json
        identity_text = canonical_artifact_json(json_value(decision.input_identity))
        if hashlib.sha256(identity_text.encode()).hexdigest() != decision.native_input_sha256:
            raise ValueError("native input identity hash mismatch")
        identity_binding = canonical_artifact_json({"inputHash": decision.native_input_sha256, "outputHash": decision.native_output_sha256})
        if hashlib.sha256(identity_binding.encode()).hexdigest() != decision.native_identity_sha256:
            raise ValueError("native decision identity binding mismatch")
        content = {
            "artifactKind": "gamma-research-proposal",
            "proposalOnly": True,
            "executionAuthorized": False,
            "operation": decision.operation,
            "sourceKinds": list(decision.source_kinds),
            "nativeOutputHash": decision.native_output_sha256,
            "nativeInputHash": decision.native_input_sha256,
            "nativeIdentityHash": decision.native_identity_sha256,
            "nativeInputIdentityJson": identity_text,
            "nativeOutputJson": decision.native_json.decode("utf-8"),
            "projectedPayload": json_value(projection.payload),
            "conversion": {
                "policyId": projection.policy_id,
                "version": projection.policy_version,
                "basis": projection.basis,
                "rounding": projection.rounding,
                "observations": [asdict(item) for item in projection.observations],
            },
            "limitations": list(decision.limitations),
        }
        return self._plan(content=content, metadata=metadata, limitations=decision.limitations,
                          operation=decision.operation, native_digest=decision.native_output_sha256, conversion=conversion)

    def _plan(self, *, content: Mapping[str, Any], metadata: Mapping[str, Any], limitations: tuple[str, ...],
              operation: str, native_digest: str, conversion: FloatDecimalPolicy) -> EvidencePublicationPlan:
        try:
            content_bytes, content_digest = _encode(self._codec, content)
        except Exception:
            return EvidencePublicationPlan("unavailable", ("canonical-content-encoding-failed",))
        # Caller provides the existing v1 shape, never an alternate native DTO.
        record = dict(metadata)
        identity = record.get("sourceIdentity")
        if not isinstance(identity, Mapping):
            raise ValueError("public sourceIdentity is required")
        record.update({"schemaVersion": "1.0.0", "sourceType": "derived-analysis", "untrustedContent": True,
                       "acceptanceStatus": "unreviewed", "contentHash": content_digest,
                       "sourceIdentity": {**identity, "contentHash": content_digest}})
        original_limits = record.get("limitations", [])
        if not isinstance(original_limits, list) or any(type(item) is not str for item in original_limits):
            raise ValueError("limitations must be strings")
        record["limitations"] = list(dict.fromkeys([*original_limits, *limitations]))
        if len(record["limitations"]) > 64:
            raise ValueError("too many evidence limitations")
        record["method"] = (
            f"{operation}; native output {native_digest}; "
            f"explicit {conversion.policy_id}@{conversion.version} conversion; "
            "proposal only, no execution or cash reservation. Original binary64 hashes are separate from this content hash."
        )
        try:
            if self._validate("ResearchEvidence", record, schema_version="1.0.0") is not True:
                return EvidencePublicationPlan("unavailable", ("public-research-evidence-invalid",))
            record_bytes, record_digest = _encode(self._codec, record)
        except Exception:
            return EvidencePublicationPlan("unavailable", ("public-research-evidence-validation-failed",))
        return EvidencePublicationPlan("candidate", (), record["evidenceId"], record_bytes, record_digest,
                                       content_bytes, content_digest, native_digest)
