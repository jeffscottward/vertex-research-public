"""Gamma readiness characterization and adapter regressions; authored, unexecuted."""
from dataclasses import asdict, replace

import pytest

from agents import (
    REPLAY_REQUIRED_CHECKS, AgnoAdvisoryAdapter, AgentFault, CandidateInput,
    CandidateReplayEvidence, ModelPricing, ReplayReference, apply_replay_revision,
    rank_candidates,
)
from tests.test_quant_agents_safety import (
    BASE, Cancel, Model, request, response, setup, valid_output,
)


SOURCE = "a" * 64
MANIFEST = "b" * 64
REPLAY = "c" * 64
EXECUTION = "d" * 64


def candidate(**changes):
    row = CandidateInput("ABC", "long_call", "intent-1", "execution-1", EXECUTION,
                         BASE, 100, True, quote_sources=("provider_nbbo",),
                         quote_observed_ns=(BASE,), quote_review_ready=True)
    return replace(row, **changes)


def ranked(*rows, **changes):
    options = dict(run_id="research-1", source_artifact_digest=SOURCE,
                   linked_trade_run_ids=("trade-1",), generated_ns=BASE,
                   candidates=tuple(rows) or (candidate(),), max_candidates=10, max_trade_candidates=5)
    options.update(changes)
    return rank_candidates(**options)


def qualified(**changes):
    item = CandidateReplayEvidence(
        "research-1", SOURCE, "trade-1", "replay-1", REPLAY,
        "replay-manifest-" + MANIFEST[:24], MANIFEST, "ABC", "intent-1", "execution-1", EXECUTION,
        BASE, BASE + 1, BASE + 10, BASE + 20, (BASE - 1,),
        tuple((name, True) for name in sorted(REPLAY_REQUIRED_CHECKS)),
        "supplied_outcome_replay_not_simulated_economics",
    )
    return replace(item, **changes)


class Qualifier:
    def __init__(self, evidence=None):
        self.evidence = evidence or qualified()
        self.calls = []

    def qualify(self, **kwargs):
        self.calls.append(kwargs)
        return self.evidence


def revise(source=None, verifier=None):
    return apply_replay_revision(source=source or ranked(), replay=ReplayReference("replay-1", REPLAY),
                                 revision_run_id="research-2", generated_ns=BASE + 30,
                                 verifier=verifier)


def test_source_ready_candidate_still_requires_candidate_matched_replay():
    source = ranked()
    row = source.candidates[0]
    assert row.status == "candidate" and row.readiness == "paper_candidate"
    assert row.reasons == ("replay_gate_required",)
    assert row.execution_authorized is False
    revision = revise(source, Qualifier())
    assert revision.candidates[0].readiness == "replay_passed"
    assert revision.revision == 1
    assert revision.supersedes_run_id == source.run_id
    assert revision.root_research_run_id == source.root_research_run_id
    assert source.candidates[0].readiness == "paper_candidate"
    assert revision.execution_authorized is False
    assert revision.candidates[0].execution_authorized is False


@pytest.mark.parametrize("changes,reason", [
    ({"strategy_type": "iron_condor"}, "paper_guardrail_single_leg_only"),
    ({"quote_sources": ("last_trade_synthetic_spread",)}, "untrusted_quote_provenance"),
    ({"quote_sources": ()}, "untrusted_quote_provenance"),
    ({"quote_observed_ns": ()}, "missing_quote_timestamp"),
    ({"quote_observed_ns": (BASE - 1_200_000_000_001,)}, "stale_quote_timestamp"),
    ({"quote_observed_ns": (BASE + 120_000_000_001,)}, "future_quote_timestamp"),
    ({"offline": True}, "offline_replay_quote"),
    ({"quote_review_ready": False}, "quote_not_review_ready"),
    ({"covered": False}, "coverage_gap"),
    ({"execution_id": None}, "missing_candidate_binding"),
])
def test_research_only_on_missing_synthetic_stale_or_unsupported_inputs(changes, reason):
    row = ranked(candidate(**changes)).candidates[0]
    assert row.readiness == "research_only"
    assert reason in row.reasons
    assert "replay_gate_required" not in row.reasons


def test_rank_caps_preserve_rejected_and_outside_max_trail():
    source = ranked(candidate(), candidate(ticker="DEF", score=90),
                    candidate(ticker="GHI", hard_rejections=("liquidity_rejected",)),
                    max_candidates=2, max_trade_candidates=1)
    assert len(source.candidates) == 3
    assert source.candidates[1].readiness == "research_only"
    assert "outside_max_trade_candidates" in source.candidates[1].reasons
    assert source.candidates[2].status == "rejected"
    assert "liquidity_rejected" in source.candidates[2].reasons


@pytest.mark.parametrize("field,value", [
    ("root_research_run_id", "other"), ("source_trade_run_id", "other"),
    ("source_artifact_digest", "f" * 64), ("replay_artifact_digest", "f" * 64),
    ("replay_run_id", "other"), ("ticker", "OTHER"), ("strategy_intent_id", "other"),
    ("execution_id", "other"), ("execution_digest", "f" * 64),
    ("manifest_id", "replay-manifest-wrong"), ("snapshot_ns", (BASE + 1,)),
    ("snapshot_ns", ()), ("observed_ns", BASE + 9), ("observed_ns", BASE + 100),
    ("decision_ns", BASE - 1),
])
def test_aggregate_pass_or_other_candidate_evidence_cannot_promote(field, value):
    verifier = Qualifier(qualified(**{field: value}))
    revised = revise(verifier=verifier).candidates[0]
    assert revised.readiness == "replay_failed"
    assert revised.replay is None
    assert revised.execution_authorized is False


@pytest.mark.parametrize("missing", sorted(REPLAY_REQUIRED_CHECKS))
def test_every_original_gamma_replay_check_remains_required(missing):
    verifier = Qualifier(qualified(checks=tuple((name, name != missing) for name in sorted(REPLAY_REQUIRED_CHECKS))))
    assert revise(verifier=verifier).candidates[0].readiness == "replay_failed"


def test_absent_qualification_and_revision_time_fail_closed():
    assert revise().candidates[0].reasons == ("candidate_replay_unavailable",)
    with pytest.raises(AgentFault, match="invalid-revision"):
        apply_replay_revision(source=ranked(), replay=ReplayReference("replay-1", REPLAY),
                              revision_run_id="research-2", generated_ns=BASE - 1, verifier=Qualifier())
    with pytest.raises(AgentFault, match="no-replay-candidates"):
        revise(ranked(candidate(offline=True)), Qualifier())


class Meter:
    def input_tokens(self, call):
        assert call.system_instruction
        return 30


class Transport:
    def __init__(self, source_request):
        self.source_request = source_request
        self.calls = []
        self.extra = False

    def run(self, call, *, cancellation):
        self.calls.append(call)
        output = asdict(valid_output(self.source_request))
        # SDK JSON arrays, not tuple coercion in the strict decoder.
        output["claims"] = list(output["claims"])
        output["claims"][0]["citations"] = list(output["claims"][0]["citations"])
        output["proposals"] = []
        raw = {"run_id": call.run_id, "trace_id": call.trace_id, "attempt_id": call.attempt_id,
               "model_version": call.model_version,
               "usage": {"input_tokens": 30, "output_tokens": 10, "cost_usd": "0.1"},
               "output": output, "tool_requests": []}
        if self.extra:
            raw["broker_permission"] = True
        return raw


def model_request():
    runner, ports = setup()
    runner.run(request())
    return ports["model"].calls[0]


def test_agno_boundary_has_fixed_system_untrusted_data_no_executable_tools():
    req = model_request()
    transport = Transport(req)
    adapter = AgnoAdvisoryAdapter(transport=transport, meter=Meter(), model_version="model-1",
                                  pricing=ModelPricing("1", "2"))
    result = adapter.invoke(req, cancellation=Cancel())
    assert result.usage.tokens == 40
    call = transport.calls[0]
    assert call.max_total_tokens == 100 and call.max_output_tokens == 70
    assert call.execute_tools is False
    assert call.memory_enabled is False and call.external_retrieval_enabled is False
    assert call.untrusted_user_data["untrusted_content"] is True
    assert "broker.submit_order" not in call.system_instruction
    assert "broker.submit_order" in call.untrusted_user_data["evidence"][0]["excerpt"]


def test_agno_rejects_extra_fields_and_independent_price_overrun():
    req = model_request()
    transport = Transport(req)
    transport.extra = True
    adapter = AgnoAdvisoryAdapter(transport=transport, meter=Meter(), model_version="model-1",
                                  pricing=ModelPricing("1", "2"))
    with pytest.raises(AgentFault, match="invalid-model-response"):
        adapter.invoke(req, cancellation=Cancel())
    transport.calls.clear()
    adapter.pricing = ModelPricing("1000000", "1000000")
    with pytest.raises(AgentFault, match="budget-exhausted"):
        adapter.invoke(req, cancellation=Cancel())
    assert not transport.calls


def test_agno_missing_transport_or_meter_has_no_implicit_sdk_fallback():
    adapter = AgnoAdvisoryAdapter(transport=None, meter=None, model_version="model-1",
                                  pricing=ModelPricing("1", "2"))
    with pytest.raises(AgentFault, match="model-unavailable"):
        adapter.invoke(model_request(), cancellation=Cancel())
