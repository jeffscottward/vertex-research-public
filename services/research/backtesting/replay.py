"""Manifest-bound replay evidence, not a simulator or execution authority.

Source behavior: Gamma backtesting/replay.py (SHA256
493b41ca09e7dcfbf183b7bac689930c1d9af2fff694956307be6f8390b1c1a4).
The temporary ledger, filesystem reports, execution-intent builder and implicit
Nautilus adapter are deliberately excluded. All payloads are supplied immutable
captures; simulator economics belong to the injected planner engine boundary.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from gamma.schemas.base import artifact_hash

from .causality import validate_source_cutoffs
from .manifest import ReplayManifestQualification, ReplayOutcomeArtifact, ReplaySourceManifest
from .ports import ResourceBudget, capture_json, decode_json, require_hash, require_id, utc

SUPPLIED_OUTCOME_REPLAY_LABEL = "supplied_outcome_replay_not_simulated_economics"
LEGACY_REPLAY_LABEL = "temporary_replay_ledger_not_production_equivalent"


@dataclass(frozen=True)
class CapturedSource:
    """The wire-byte hash and original Gamma semantic hash are different identities."""
    provider: str
    manifest_key: str
    ticker: str
    payload_bytes: bytes
    source_bytes_sha256: str
    original_gamma_hash: str

    def __post_init__(self) -> None:
        if not isinstance(self.payload_bytes, bytes) or len(self.payload_bytes) > 8_000_000:
            raise ValueError("source capture exceeds immutable byte budget")
        require_hash(self.source_bytes_sha256)
        require_hash(self.original_gamma_hash)
        if hashlib.sha256(self.payload_bytes).hexdigest() != self.source_bytes_sha256:
            raise ValueError("source wire-byte hash mismatch")
        if artifact_hash(decode_json(self.payload_bytes)) != self.original_gamma_hash:
            raise ValueError("original Gamma source hash mismatch")

    def decode(self) -> Any:
        return decode_json(self.payload_bytes)


@dataclass(frozen=True)
class CandidateRevision:
    """Exact captured candidate, located in the immutable source trade artifact.

    Paths are sequences of object keys/list indexes, never executable expressions.
    The revision value at revision_path must equal BOTH the captured and selected
    revisions. A revised candidate cannot silently replace the source selection.
    """
    candidate_id: str
    captured_revision: str
    selected_revision: str
    candidate_path: tuple[str | int, ...]
    revision_path: tuple[str | int, ...]
    payload_bytes: bytes
    original_gamma_hash: str
    available_at: datetime
    identity_path: tuple[str | int, ...] = ("candidate_id",)

    def __post_init__(self) -> None:
        require_id(self.candidate_id)
        require_id(self.captured_revision)
        require_id(self.selected_revision)
        require_hash(self.original_gamma_hash)
        if not isinstance(self.payload_bytes, bytes) or len(self.payload_bytes) > 1_000_000:
            raise ValueError("candidate bytes invalid")
        object.__setattr__(self, "candidate_path", tuple(self.candidate_path))
        object.__setattr__(self, "revision_path", tuple(self.revision_path))
        object.__setattr__(self, "identity_path", tuple(self.identity_path))
        for path in (self.candidate_path, self.revision_path, self.identity_path):
            if not path or len(path) > 32 or any(type(key) not in (str, int) for key in path):
                raise ValueError("bounded candidate path required")
        object.__setattr__(self, "available_at", utc(self.available_at))


@dataclass(frozen=True)
class CapturedReplayExecution:
    """Previously captured replay binding; this is not a dispatchable order."""
    replay_execution_id: str
    strategy_intent_id: str
    ticker: str
    payload_bytes: bytes

    def __post_init__(self) -> None:
        require_id(self.replay_execution_id)
        require_id(self.strategy_intent_id)
        if not isinstance(self.payload_bytes, bytes) or len(self.payload_bytes) > 1_000_000:
            raise ValueError("replay execution capture invalid")
        decode_json(self.payload_bytes)


@dataclass(frozen=True)
class ReplayRequest:
    run_id: str
    source_trade_run_id: str
    decision_at: datetime
    manifest_bytes: bytes | None
    sources: tuple[CapturedSource, ...]
    candidates: tuple[CandidateRevision, ...]
    replay_executions: tuple[CapturedReplayExecution, ...]
    budget: ResourceBudget

    def __post_init__(self) -> None:
        require_id(self.run_id)
        require_id(self.source_trade_run_id)
        object.__setattr__(self, "decision_at", utc(self.decision_at))
        object.__setattr__(self, "sources", tuple(self.sources))
        object.__setattr__(self, "candidates", tuple(self.candidates))
        object.__setattr__(self, "replay_executions", tuple(self.replay_executions))
        if self.manifest_bytes is not None and not isinstance(self.manifest_bytes, bytes):
            raise ValueError("manifest capture must be immutable bytes")


@dataclass(frozen=True)
class ReplayResult:
    request: ReplayRequest
    status: str
    replay_engine_label: str
    manifest_qualification: ReplayManifestQualification
    manifest: ReplaySourceManifest | None
    supplied_outcome_artifact: ReplayOutcomeArtifact | None
    original_input_hash: str | None
    original_output_hash: str | None
    rejected_reasons: tuple[str, ...]
    realism_qualified: bool = False
    economics_simulated: bool = False
    execution_authorized: bool = False

    def gamma_provenance(self) -> dict[str, Any] | None:
        """Unvalidated public-shaped candidate; seal through PublicBoundary first."""
        if self.manifest is None or self.original_input_hash is None or self.original_output_hash is None:
            return None
        return {
            "schemaVersion": "1.0.0", "replaySchemaVersion": 2,
            "sourceTradeRunId": self.manifest.source_trade_run_id,
            "replayManifestId": self.manifest.manifest_id,
            "manifestHash": self.manifest.manifest_hash,
            "inputHash": self.original_input_hash, "outputHash": self.original_output_hash,
        }


def _at(value: Any, path: tuple[str | int, ...]) -> Any:
    for key in path:
        if type(key) is int and isinstance(value, list) and 0 <= key < len(value):
            value = value[key]
        elif isinstance(key, str) and isinstance(value, dict) and key in value:
            value = value[key]
        else:
            raise ValueError("candidate source path does not resolve")
    return value


class ReplayRunner:
    """A pure planning operation. Rejections keep all original captures intact."""

    def plan(self, request: ReplayRequest) -> ReplayResult:
        if request.manifest_bytes is None:
            return ReplayResult(
                request, "inconclusive", SUPPLIED_OUTCOME_REPLAY_LABEL,
                ReplayManifestQualification.missing_manifest(), None, None, None, None,
                ("missing-source-manifest",),
            )
        manifest: ReplaySourceManifest | None = None
        try:
            count = sum(len(item.payload_bytes) for item in request.sources)
            count += sum(len(item.payload_bytes) for item in request.candidates)
            count += sum(len(item.payload_bytes) for item in request.replay_executions)
            count += len(request.manifest_bytes)
            if count > request.budget.maximum_input_bytes:
                raise ValueError("replay input byte budget exceeded")
            if len(request.candidates) > request.budget.maximum_candidates:
                raise ValueError("replay candidate budget exceeded")
            manifest = ReplaySourceManifest.model_validate(decode_json(request.manifest_bytes))
            if manifest.source_trade_run_id != request.source_trade_run_id:
                raise ValueError("source run mismatch")
            if manifest.decision_at != request.decision_at:
                raise ValueError("source decision cutoff mismatch")
            sources = {item.manifest_key: item for item in request.sources}
            if len(sources) != len(request.sources):
                raise ValueError("duplicate source capture")
            if set(sources) != {item.manifest_key for item in manifest.snapshots}:
                raise ValueError("source captures must cover the manifest exactly")
            scan_budget = [0, min(request.budget.maximum_events, 250_000)]
            for snapshot in manifest.snapshots:
                source = sources[snapshot.manifest_key]
                if (source.provider, source.ticker, source.original_gamma_hash) != (
                    snapshot.provider, snapshot.ticker, snapshot.payload_hash,
                ):
                    raise ValueError("manifest source identity mismatch")
                # Re-establish identity at the operation boundary, even when a
                # caller constructed a frozen object using low-level mutation.
                if artifact_hash(source.decode()) != snapshot.payload_hash:
                    raise ValueError("Gamma source payload mismatch")
                if hashlib.sha256(source.payload_bytes).hexdigest() != source.source_bytes_sha256:
                    raise ValueError("source wire-byte identity mismatch")
                if snapshot.provider != "outcome":
                    validate_source_cutoffs(source.decode(), request.decision_at, scan_budget=scan_budget)
            trade = sources["trade_artifact:" + request.source_trade_run_id]
            trade_payload = trade.decode()
            if not request.candidates:
                raise ValueError("captured candidate revisions required")
            if len({item.candidate_id for item in request.candidates}) != len(request.candidates):
                raise ValueError("duplicate candidate identity")
            for candidate in request.candidates:
                if candidate.available_at > request.decision_at:
                    raise ValueError("candidate unavailable at decision cutoff")
                payload = decode_json(candidate.payload_bytes)
                if artifact_hash(payload) != candidate.original_gamma_hash:
                    raise ValueError("candidate Gamma hash mismatch")
                if artifact_hash(_at(trade_payload, candidate.candidate_path)) != candidate.original_gamma_hash:
                    raise ValueError("candidate is not the captured source revision")
                if _at(payload, candidate.identity_path) != candidate.candidate_id:
                    raise ValueError("candidate identity differs from captured source")
                if candidate.captured_revision != candidate.selected_revision:
                    raise ValueError("candidate revision changed since source decision")
                if _at(payload, candidate.revision_path) != candidate.captured_revision:
                    raise ValueError("candidate revision identity mismatch")
                validate_source_cutoffs(payload, request.decision_at, scan_budget=scan_budget)
            executions = {item.replay_execution_id: item for item in request.replay_executions}
            if len(executions) != len(request.replay_executions):
                raise ValueError("duplicate captured replay execution")
            if set(executions) != {item.replay_execution_id for item in manifest.execution_bindings}:
                raise ValueError("replay execution identities do not match manifest")
            for binding in manifest.execution_bindings:
                execution = executions[binding.replay_execution_id]
                payload = decode_json(execution.payload_bytes)
                validate_source_cutoffs(payload, request.decision_at, scan_budget=scan_budget)
                if (execution.strategy_intent_id, execution.ticker) != (binding.strategy_intent_id, binding.ticker):
                    raise ValueError("replay strategy binding mismatch")
                if artifact_hash(payload) != binding.replay_payload_hash:
                    raise ValueError("replay execution source hash mismatch")
                if not isinstance(payload, dict) or payload.get("execution_id") != binding.replay_execution_id:
                    raise ValueError("captured execution payload identity mismatch")
                intent = payload.get("strategy_intent")
                if not isinstance(intent, dict) or (intent.get("intent_id"), intent.get("ticker")) != (
                    binding.strategy_intent_id, binding.ticker,
                ):
                    raise ValueError("captured execution strategy identity mismatch")
            outcome_source = next(item for item in request.sources if item.provider == "outcome")
            outcome_artifact = ReplayOutcomeArtifact.model_validate(outcome_source.decode())
            if outcome_artifact.source_trade_run_id != manifest.source_trade_run_id:
                raise ValueError("outcome source run mismatch")
            if outcome_artifact.outcomes != manifest.outcomes:
                raise ValueError("supplied outcomes do not match source manifest")
            # No sums, return curves, portfolio reservations or cash transitions
            # are manufactured from externally supplied outcome observations.
            return ReplayResult(
                request, "replay-evidence", SUPPLIED_OUTCOME_REPLAY_LABEL,
                ReplayManifestQualification.from_manifest(manifest), manifest,
                outcome_artifact, trade.original_gamma_hash, outcome_source.original_gamma_hash, (),
            )
        except (ValueError, TypeError, KeyError, StopIteration, RecursionError, OverflowError):
            # Do not stringify exceptions: validation errors can contain source
            # payloads. The retained request is the explicit diagnostic artifact.
            reasons = ("source-replay-integrity-or-causality-rejected",)
            return ReplayResult(
                request, "rejected", SUPPLIED_OUTCOME_REPLAY_LABEL,
                ReplayManifestQualification(qualifying=False, failure_reasons=reasons),
                manifest, None, None, None, reasons,
            )

    def run(self, *, request: ReplayRequest) -> ReplayResult:
        """Compatibility entry point; performs only plan(), never simulation."""
        return self.plan(request)
