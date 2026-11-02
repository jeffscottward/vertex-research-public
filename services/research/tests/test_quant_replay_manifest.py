"""Synthetic characterization fixtures only. Authored, deliberately unexecuted."""
from dataclasses import replace
from datetime import UTC, datetime
import hashlib

import pytest

from backtesting.causality import validate_source_cutoffs
from backtesting.manifest import (
    ReplayExecutionBinding, ReplayHorizon, ReplayManifestQualification,
    ReplayOutcomeArtifact, ReplayOutcomeObservation, ReplaySourceManifest, ReplaySourceSnapshot,
)
from backtesting.ports import ResourceBudget, capture_json
from backtesting.replay import (
    CandidateRevision, CapturedReplayExecution, CapturedSource, ReplayRequest, ReplayRunner,
    SUPPLIED_OUTCOME_REPLAY_LABEL,
)
from gamma.schemas.base import artifact_hash

DECISION = datetime(2026, 1, 2, 14, tzinfo=UTC)
ENTRY = datetime(2026, 1, 2, 15, tzinfo=UTC)
EXIT = datetime(2026, 1, 5, 15, tzinfo=UTC)
OBSERVED = datetime(2026, 1, 5, 16, tzinfo=UTC)


def synthetic_request() -> ReplayRequest:
    candidate = {"candidate_id": "candidate-a", "revision": "revision-1", "ticker": "SYN"}
    intent = {"intent_id": "intent-a", "ticker": "SYN"}
    replay_execution = {"execution_id": "replay-execution-a", "strategy_intent": intent}
    source_execution = {"execution_id": "execution-a", "strategy_intent": intent}
    outcome = ReplayOutcomeObservation(
        ticker="SYN", strategy_intent_id="intent-a", execution_id="execution-a",
        observed_at=OBSERVED, realized_pnl=12.5, unrealized_pnl=0,
        position_state="closed", entry_at=ENTRY, horizon_end_at=EXIT, exit_policy="explicit-close",
    )
    outcome_artifact = ReplayOutcomeArtifact(
        artifact_id="outcome-a", source_trade_run_id="source-a", persisted_at=OBSERVED,
        outcomes=(outcome,),
    )
    captured = (
        ("trade_artifact", "trade_artifact:source-a", {"run_id": "source-a", "candidates": [candidate]}),
        ("quantdata", "quantdata:SYN", {"observed_at": DECISION.isoformat(), "value": 1}),
        ("strategy_intent", "strategy_intent:intent-a", intent),
        ("execution_intent", "execution_intent:execution-a", source_execution),
        ("outcome", "outcome:outcome-a", outcome_artifact.to_json_dict()),
    )
    sources = tuple(CapturedSource(
        provider, key, "SYN", capture_json(payload), hashlib.sha256(capture_json(payload)).hexdigest(), artifact_hash(payload),
    ) for provider, key, payload in captured)
    snapshots = tuple(ReplaySourceSnapshot(
        ticker="SYN", provider=source.provider, manifest_key=source.manifest_key,
        source_timestamp=OBSERVED if source.provider == "outcome" else DECISION,
        snapshot_date=(OBSERVED if source.provider == "outcome" else DECISION).date(),
        payload_hash=source.original_gamma_hash,
    ) for source in sources)
    manifest = ReplaySourceManifest(
        source_trade_run_id="source-a", artifact_generated_at=DECISION, decision_at=DECISION,
        snapshots=snapshots, outcomes=(outcome,),
        horizon=ReplayHorizon(entry_at=ENTRY, exit_at=EXIT, exit_policy="explicit-close"),
        strategy_intent_ids=("intent-a",), execution_ids=("execution-a",),
        execution_bindings=(ReplayExecutionBinding(
            execution_id="execution-a", strategy_intent_id="intent-a", ticker="SYN",
            replay_execution_id="replay-execution-a", replay_payload_hash=artifact_hash(replay_execution),
        ),), outcome_artifact_hash=artifact_hash(outcome_artifact),
    )
    return ReplayRequest(
        "replay-a", "source-a", DECISION, manifest.to_json().encode(), sources,
        (CandidateRevision("candidate-a", "revision-1", "revision-1", ("candidates", 0), ("revision",),
                           capture_json(candidate), artifact_hash(candidate), DECISION),),
        (CapturedReplayExecution("replay-execution-a", "intent-a", "SYN", capture_json(replay_execution)),),
        ResourceBudget(),
    )


def test_manifest_original_hash_excludes_only_manifest_id_and_hash():
    request = synthetic_request()
    manifest = ReplaySourceManifest.model_validate_json(request.manifest_bytes)
    expected = artifact_hash(manifest.model_dump(mode="json", round_trip=True, exclude={"manifest_id", "manifest_hash"}))
    assert manifest.manifest_hash == expected
    assert manifest.manifest_id == "replay-manifest-" + expected[:24]
    assert ReplaySourceManifest.model_validate_json(manifest.to_json()) == manifest
    with pytest.raises(ValueError):
        ReplaySourceManifest.model_validate({**manifest.to_json_dict(), "manifest_hash": "0" * 64})


def test_supplied_outcome_replay_never_claims_simulation_economics():
    result = ReplayRunner().plan(synthetic_request())
    assert result.status == "replay-evidence"
    assert result.manifest_qualification.qualifying
    assert result.replay_engine_label == SUPPLIED_OUTCOME_REPLAY_LABEL
    assert result.economics_simulated is False
    assert result.realism_qualified is False
    assert result.execution_authorized is False
    assert result.original_output_hash == result.manifest.outcome_artifact_hash
    assert result.gamma_provenance()["manifestHash"] == result.manifest.manifest_hash


def test_rejected_candidate_revision_retains_all_input_artifacts():
    request = synthetic_request()
    mismatched = replace(request, candidates=(replace(request.candidates[0], selected_revision="revision-2"),))
    result = ReplayRunner().plan(mismatched)
    assert result.status == "rejected"
    assert result.request == mismatched
    assert result.manifest_qualification.qualifying is False
    assert result.gamma_provenance() is None


def test_replay_identity_missing_manifest_and_binding_fail_closed():
    request = synthetic_request()
    missing = ReplayRunner().plan(replace(request, manifest_bytes=None))
    assert missing.status == "inconclusive"
    assert missing.manifest_qualification == ReplayManifestQualification.missing_manifest()
    assert ReplayRunner().plan(replace(request, source_trade_run_id="different-source")).status == "rejected"
    assert ReplayRunner().plan(replace(request, replay_executions=())).status == "rejected"
    assert ReplayRunner().plan(replace(request, sources=request.sources[:-1])).status == "rejected"
    assert ReplayRunner().plan(replace(request, candidates=())).status == "rejected"


def test_resource_budget_blocks_before_replay_and_preserves_request():
    request = replace(synthetic_request(), budget=ResourceBudget(maximum_input_bytes=64))
    result = ReplayRunner().plan(request)
    assert result.status == "rejected"
    assert result.request is request


def test_original_source_byte_and_gamma_hashes_are_independent():
    request = synthetic_request()
    source = request.sources[1]
    with pytest.raises(ValueError):
        replace(source, source_bytes_sha256="0" * 64)
    with pytest.raises(ValueError):
        replace(source, original_gamma_hash="0" * 64)
    with pytest.raises(ValueError):
        replace(source, payload_bytes=b'{"changed":true}')


@pytest.mark.parametrize("key", ["observed_at", "publishedAt", "available_at", "revisionAt", "vintage_at"])
def test_cutoff_rejects_event_publication_availability_and_revision_lookahead(key):
    with pytest.raises(ValueError):
        validate_source_cutoffs({"nested": [{key: "2026-01-02T14:00:01Z"}]}, DECISION)
    validate_source_cutoffs({key: "2026-01-02T14:00:00Z"}, DECISION)


@pytest.mark.parametrize("payload", [
    {"time": "2026-01-02T13:00:00"}, {"time": "not-a-timestamp"},
    {"time": {"hidden": "2027-01-01T00:00:00Z"}},
    {"option_chain_latest_retry": True},
    {"price_history": [{"date": "2026-01-02"}]},
])
def test_source_scan_rejects_naive_malformed_latest_and_same_day_end_of_day_data(payload):
    with pytest.raises(ValueError):
        validate_source_cutoffs(payload, DECISION)


def test_source_scan_bounded_depth_and_zero_effect_flag():
    payload = {"valid": 1}
    for _ in range(34):
        payload = {"nested": payload}
    with pytest.raises(ValueError):
        validate_source_cutoffs(payload, DECISION)
    validate_source_cutoffs({"option_chain_latest_retry": False}, DECISION)


def test_horizon_preserves_gamma_market_holiday_and_closed_outcome_rules():
    horizon = ReplayHorizon(
        entry_at=datetime(2026, 7, 2, 14, tzinfo=UTC), holding_period_sessions=1,
        exit_policy="one-market-session",
    )
    assert horizon.horizon_end_at == datetime(2026, 7, 6, 14, tzinfo=UTC)
    with pytest.raises(ValueError):
        ReplayHorizon(entry_at=ENTRY, exit_at=EXIT, holding_period_sessions=1, exit_policy="both")
    result = ReplayRunner().plan(synthetic_request())
    outcome = result.manifest.outcomes[0].to_json_dict()
    with pytest.raises(ValueError):
        ReplayOutcomeObservation.model_validate({**outcome, "unrealized_pnl": 1})
    with pytest.raises(ValueError):
        ReplayOutcomeObservation.model_validate({**outcome, "observed_at": ENTRY.isoformat()})
